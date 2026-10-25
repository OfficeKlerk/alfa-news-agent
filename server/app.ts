import express, {
  type Request,
  type Response,
  type NextFunction,
} from "express";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { ROLES, type Settings } from "./config.js";
import { Store } from "./db.js";
import { Retrieval } from "./retrieval.js";
import { Agent, VERSION } from "./agent.js";
import { createComplete, type Complete } from "./llm.js";
import { saveNews } from "./news.js";
import { NewsCollector } from "./news-collector.js";
import { AppError, ModelError, type Json } from "./types.js";

class AnalysisQueue {
  private waiting: (() => Promise<void>)[] = [];
  private active = 0;
  private idleListeners: (() => void)[] = [];
  get size() {
    return this.active + this.waiting.length;
  }
  add(task: () => Promise<void>) {
    this.waiting.push(task);
    this.pump();
  }
  private pump() {
    while (this.active < 2 && this.waiting.length) {
      const task = this.waiting.shift()!;
      this.active++;
      setImmediate(() => {
        void task()
          .catch(() => console.error("Ошибка сохранения фоновой задачи"))
          .finally(() => {
            this.active--;
            this.pump();
            if (!this.size)
              this.idleListeners.splice(0).forEach((resolve) => resolve());
          });
      });
    }
  }
  async idle() {
    if (this.size)
      await new Promise<void>((resolve) => this.idleListeners.push(resolve));
  }
}
export async function createApplication(
  settings: Settings,
  override?: { complete?: Complete; request?: typeof fetch },
) {
  const db = new Store(settings);
  try {
    await db.initialize();
  } catch (error) {
    db.close();
    throw error;
  }
  db.run(
    "UPDATE jobs SET status='failed',error='Сервер был перезапущен. Запустите анализ заново.' WHERE status IN ('pending','running')",
  );
  const retrieval = new Retrieval(db),
    agent = new Agent(
      settings,
      db,
      retrieval,
      override?.complete ?? createComplete(settings, db, override?.request),
    );
  const queue = new AnalysisQueue(),
    app = express();
  const collector = new NewsCollector(settings, db, { request: override?.request });
  app.disable("x-powered-by");
  app.use((req, res, next) => {
    res.set({
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-store",
      "Content-Security-Policy":
        "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'",
    });
    if (req.method === "POST" && req.get("Origin")) {
      try {
        if (new URL(req.get("Origin")!).host !== req.get("Host"))
          throw new Error();
      } catch {
        next(new AppError("Недопустимый Origin", 403));
        return;
      }
    }
    next();
  });
  app.use(express.json({ limit: 80000, strict: true }));
  app.use((req, _res, next) => {
    if (
      req.method === "POST" &&
      (!req.is("application/json") ||
        !req.body ||
        typeof req.body !== "object" ||
        Array.isArray(req.body))
    )
      next(
        new AppError("Ожидается JSON-объект с Content-Type application/json"),
      );
    else next();
  });
  const companyId = (req: Request) => {
    const id = req.get("X-Company-ID");
    if (!id) throw new AppError("Не выбрана компания");
    db.company(id);
    return id;
  };
  app.get("/api/health", (_req, res) => {
    res.json({ ok: true, mode: settings.mode, version: VERSION });
  });
  app.get("/api/bootstrap", (_req, res) => {
    const stats = Object.fromEntries(
      ["companies", "payments", "research", "news"].map((table) => [
        table,
        db.get("SELECT count(*) n FROM " + table)!.n,
      ]),
    );
    const suggestions = ["24.", "41.", "46.", "62.", "47."]
      .map((code) =>
        db.get(
          "SELECT id,industry,region,revenue FROM companies WHERE json_extract(payload,'$.MAINOKVED_CODE') LIKE ? ORDER BY revenue DESC LIMIT 1",
          code + "%",
        ),
      )
      .filter(Boolean);
    const calls = db.get(
      "SELECT count(*) n,coalesce(sum(prompt_tokens+completion_tokens),0) tokens FROM llm_calls",
    )!;
    res.json({
      mode: settings.mode,
      model: settings.model,
      key_configured: Boolean(settings.apiKey),
      stats,
      suggestions,
      roles: ROLES,
      llm_calls: calls.n,
      tokens_used: calls.tokens,
      request_timeout_ms: settings.timeout + 10000,
    });
  });
  app.get("/api/companies", (req, res) => {
    const q = String(req.query.q ?? "").slice(0, 120),
      rawOffset = Number(req.query.offset ?? 0);
    if (!Number.isSafeInteger(rawOffset))
      throw new AppError("offset должен быть целым числом");
    const offset = Math.max(0, Math.min(100000, rawOffset)),
      query = "%" + q + "%";
    res.json({
      items: db.all(
        "SELECT id,industry,region,revenue FROM companies WHERE id LIKE ? OR industry LIKE ? OR region LIKE ? ORDER BY revenue DESC LIMIT 30 OFFSET ?",
        query,
        query,
        query,
        offset,
      ),
      offset,
      limit: 30,
    });
  });
  app.get("/api/companies/:id", (req, res) => {
    res.json(db.company(req.params.id));
  });
  app.get("/api/feed", (req, res) => {
    res.json({ items: retrieval.feed(companyId(req), req.query.demo !== "0") });
  });
  app.get("/api/research", (req, res) => {
    res.json({
      items: retrieval.research(
        String(req.query.q ?? "ставка инфляция спрос").slice(0, 500),
        10,
      ),
    });
  });
  app.get("/api/jobs/:id", (req, res) => {
    const row = db.get(
      "SELECT * FROM jobs WHERE id=? AND company_id=?",
      req.params.id,
      companyId(req),
    );
    if (!row) throw new AppError("Задача не найдена для компании", 404);
    res.json({
      id: row.id,
      status: row.status,
      result: row.payload ? JSON.parse(row.payload) : null,
      error: row.error,
    });
  });
  app.get("/api/analyses/:id", (req, res) => {
    const row = db.get(
      "SELECT payload FROM analyses WHERE cache_key=? AND company_id=?",
      req.params.id,
      companyId(req),
    );
    if (!row) throw new AppError("Анализ не найден для компании", 404);
    res.json(JSON.parse(row.payload));
  });
  app.post("/api/news", (req, res) => {
    res.status(201).json(saveNews(db, req.body));
  });
  app.post("/api/feeds/refresh", async (_req, res) => {
    res.json(await collector.refresh());
  });
  app.get("/api/feeds/status", (_req, res) => res.json(collector.status()));
  app.post("/api/analysis", (req, res) => {
    if (settings.analysisEnabled === false) throw new AppError("Генерация выключена. Настройте ключ LLM и запустите с --with-llm; сбор и ранжирование уже доступны.", 503);
    const cid = companyId(req),
      nid = String(req.body.news_id ?? ""),
      role = req.body.role ?? ROLES[0];
    db.news(nid);
    if (!ROLES.includes(role)) throw new AppError("Неизвестная роль");
    if (req.body.force !== undefined && typeof req.body.force !== "boolean")
      throw new AppError("force должен быть boolean");
    if (settings.mode === "live" && !settings.apiKey)
      throw new ModelError("LLM_MODE=live, но LLM_API_KEY не настроен.");
    if (queue.size >= 10)
      throw new AppError("Очередь заполнена. Повторите позже.", 429);
    const id = randomUUID().replaceAll("-", "");
    db.run(
      "INSERT INTO jobs(id,company_id,status) VALUES(?,?,'pending')",
      id,
      cid,
    );
    queue.add(async () => {
      try {
        db.run("UPDATE jobs SET status='running' WHERE id=?", id);
        const result = await agent.analyze(
          cid,
          nid,
          role,
          req.body.force ?? false,
        );
        db.run(
          "UPDATE jobs SET status='completed',payload=? WHERE id=?",
          JSON.stringify(result),
          id,
        );
      } catch (error) {
        db.run(
          "UPDATE jobs SET status='failed',error=? WHERE id=?",
          error instanceof AppError
            ? error.message
            : "Внутренняя ошибка анализа.",
          id,
        );
      }
    });
    res.status(202).json({ job_id: id });
  });
  app.post("/api/analyses/:id/questions", async (req, res) => {
    if (settings.analysisEnabled === false) throw new AppError("Генерация выключена. Запустите с --with-llm после настройки ключа LLM.", 503);
    const cid = companyId(req),
      question = String(req.body.question ?? "").trim();
    if (question.length < 3 || question.length > 2000)
      throw new AppError("Вопрос должен содержать от 3 до 2000 символов");
    res.json(await agent.answer(cid, req.params.id, question));
  });
  app.use("/api", (_req, _res, next) => {
    next(new AppError("Метод не найден", 404));
  });
  app.use(
    express.static(resolve(settings.root, "frontend"), {
      dotfiles: "deny",
      fallthrough: true,
    }),
  );
  app.use((_req, _res, next) => {
    next(new AppError("Не найдено", 404));
  });
  app.use((error: Json, _req: Request, res: Response, _next: NextFunction) => {
    const status =
      error instanceof AppError
        ? error.status
        : error.type === "entity.too.large"
          ? 413
          : error.type === "entity.parse.failed"
            ? 400
            : 500;
    const message =
      error instanceof AppError
        ? error.message
        : status === 413
          ? "Недопустимый размер запроса"
          : status === 400
            ? "Некорректный JSON"
            : "Внутренняя ошибка сервера";
    res.status(status).json({ error: message });
  });
  collector.start();
  return {
    app,
    db,
    agent,
    retrieval,
    queue,
    collector,
    async close() {
      await collector.stop();
      await queue.idle();
      db.close();
    },
  };
}
