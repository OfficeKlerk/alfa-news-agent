"use strict";
/**
 * Opt-in адаптер /api → /v1 (роль 4).
 * Включается ?api=v1 (или localStorage alfa-api=v1). Перехватывает те же /api-пути,
 * что зовёт app.js, и отдаёт данные из /v1 в форме, которую ждёт существующий рендер.
 * /api-режим (по умолчанию) не затрагивается. Полный дефолт-cutover пока блокирует
 * отсутствие /v1 для добавления новости и RSS-refresh (нужны роль 3) — они дают понятную ошибку.
 */
(function () {
  const params = new URLSearchParams(location.search);
  const explicit = params.get("api"); // v1 | legacy | api | null
  // Явный выход из /v1-режима: ?api=legacy (или ?api=api) сбрасывает залипание.
  if (explicit === "legacy" || explicit === "api") {
    try {
      localStorage.removeItem("alfa-api");
    } catch {}
    return;
  }
  let mode = explicit;
  try {
    mode = mode || localStorage.getItem("alfa-api");
  } catch {}
  if (mode !== "v1") return; // адаптер не активен — обычный /api
  try {
    localStorage.setItem("alfa-api", "v1");
  } catch {}
  console.info("[alfa] /v1-адаптер активен (вернуться на /api: ?api=legacy)");

  const nowIso = () => new Date().toISOString();
  const ROLE = {
    "Финансовый директор": "cfo",
    "Генеральный директор": "ceo",
    "Руководитель казначейства": "treasury",
  };
  const PRODUCTS = {
    loan: "Кредиты", leasing: "Лизинг", factoring: "Факторинг",
    deposit: "Депозиты", rko: "РКО", guarantee: "Гарантии", payroll: "Зарплатный проект",
  };
  const eventsCache = new Map(); // news_id -> event (для title/флагов в анализе)
  const jobs = new Map(); // job_id -> mapped analysis

  async function v1(path, body, companyId) {
    const r = await fetch(path, {
      method: body === undefined ? "GET" : "POST",
      headers: { "Content-Type": "application/json", ...(companyId ? { "X-Company-ID": companyId } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const v = await r.json();
    if (!r.ok) throw new Error(v.error?.message || "Ошибка /v1 сервера");
    return v;
  }

  function mapProfile(p) {
    const products = Object.entries(p.bank_products || {})
      .filter(([, on]) => on === true)
      .map(([k]) => PRODUCTS[k] || k);
    const cp = (p.counterparties || []).slice(0, 5).map((c) => ({
      id: c.company_id, industry: c.industry?.name || "—", amount: c.pay_amount || 0,
    }));
    return {
      id: p.company_id,
      name: "Компания " + p.company_id,
      industry: p.industry?.name || "—",
      region: p.geography?.region || "—",
      products,
      foreign_trade: p.foreign_trade?.has_fts === true,
      workers: p.scale?.employees_band || "",
      revenue: p.scale?.revenue_raw || 0,
      group_id: p.group?.group_id || "",
      outgoing: { n: p.payment_summary?.outgoing_count || 0 },
      incoming: { n: p.payment_summary?.incoming_count || 0 },
      top_partners: cp,
      data_notes: (p.data_quality?.warnings || []),
    };
  }

  function mapSource(s) {
    return {
      id: s.id, kind: s.kind, page: s.page, title: s.title,
      text: s.excerpt || s.text || "", url: s.url || "",
      published: s.published_at || "", is_demo: s.is_mock === true,
    };
  }

  function mapAnalysis(a, role) {
    const ev = eventsCache.get(a.news_id);
    return {
      id: a.id, news_id: a.news_id, company_id: a.company_id,
      title: ev?.title || a.summary?.slice(0, 80) || "Событие",
      summary: a.summary, why_relevant: a.why_relevant,
      claims: (a.claims || []).map((c) => ({ kind: c.kind, text: c.text, source_ids: c.source_ids || [] })),
      risks: a.risks || [], opportunities: a.opportunities || [],
      actions: a.recommendations || [], limitations: a.limitations || [],
      sources: (a.sources || []).map(mapSource),
      trace: (a.trace || []).map((t, i) => ({
        step: t.step || "шаг " + (i + 1), detail: t.detail || "", elapsed_ms: t.elapsed_ms || 0,
      })),
      mode: a.mode, model: a.mode === "live" ? "v1/live" : "v1", cached: false,
      role, is_demo_news: ev?.is_mock === true,
      validation: "Источники проверены на уровне контракта /v1.",
    };
  }

  // Основной перехватчик: возвращает /api-форму или бросает понятную ошибку.
  async function handle(path, options = {}) {
    const method = (options.method || "GET").toUpperCase();
    const companyId = options.headers?.["X-Company-ID"];
    const [p, qs] = path.split("?");
    const query = new URLSearchParams(qs || "");
    const body = options.body ? JSON.parse(options.body) : {};

    if (p === "/api/bootstrap") {
      const [health, companies] = await Promise.all([v1("/v1/health"), v1("/v1/companies")]);
      const ids = companies.data.items || [];
      return {
        mode: health.meta?.mode === "live" ? "live" : "demo",
        model: "v1/" + (health.meta?.mode || "mock"),
        key_configured: true,
        request_timeout_ms: 120000,
        stats: { companies: ids.length },
        suggestions: ids.slice(0, 5).map((id) => ({ id })),
      };
    }

    if (p === "/api/companies" && method === "GET") {
      const q = (query.get("q") || "").toLowerCase();
      const companies = await v1("/v1/companies");
      const items = (companies.data.items || [])
        .filter((id) => !q || id.toLowerCase().includes(q))
        .map((id) => ({ id, industry: "см. профиль", region: "—" }));
      return { items };
    }

    if (p.startsWith("/api/companies/") && method === "GET") {
      const id = decodeURIComponent(p.slice("/api/companies/".length));
      const r = await v1("/v1/companies/" + encodeURIComponent(id));
      return mapProfile(r.data);
    }

    if (p === "/api/feed") {
      const cid = companyId;
      const asOf = nowIso();
      const search = await v1("/v1/tools/search_news", { query: "", as_of: asOf, limit: 100, news_id: null }, cid);
      const events = search.data.items || [];
      for (const e of events) eventsCache.set(e.news_id, e);
      const rank = await v1("/v1/rank", { company_id: cid, events, as_of: asOf, limit: 100 }, cid);
      const byId = new Map(events.map((e) => [e.news_id, e]));
      const realOnly = query.get("demo") === "0";
      const items = (rank.data.items || [])
        .map((it) => {
          const e = byId.get(it.news_id) || {};
          return {
            id: it.news_id, title: e.title || it.news_id,
            published: e.published_at || asOf,
            // /v1 scores use distinct, uncalibrated scales. Preserve their raw
            // value; the legacy 0..100 index and priority thresholds do not apply.
            score: Number.isFinite(it.score) ? it.score : null,
            score_kind: typeof it.score_kind === "string" ? it.score_kind : null,
            feature_version: it.feature_version ?? null,
            reasons: (it.reasons || []).map((r) => r.text || r.detail || r.reason || "сигнал").slice(0, 3),
            is_demo: e.is_mock === true,
          };
        })
        .filter((n) => (realOnly ? !n.is_demo : true));
      if (!items.length) items.push(...[]); // пусто — рендер покажет пустое состояние
      return { items };
    }

    if (p === "/api/research" && method === "GET") {
      const r = await v1("/v1/tools/rag_bank_analytics", { query: query.get("q") || "", as_of: nowIso(), limit: 20 }, companyId);
      return { items: (r.data.items || []).map(mapSource) };
    }

    if (p === "/api/analysis" && method === "POST") {
      const role = ROLE[body.role] || "cfo";
      const r = await v1("/v1/analyze", { company_id: companyId, news_id: body.news_id, as_of: nowIso(), audience_role: role }, companyId);
      const mapped = mapAnalysis(r.data, body.role || "");
      const jobId = "v1-" + mapped.id;
      jobs.set(jobId, mapped);
      return { job_id: jobId };
    }

    if (p.startsWith("/api/jobs/") && method === "GET") {
      const jobId = decodeURIComponent(p.slice("/api/jobs/".length));
      const result = jobs.get(jobId);
      if (!result) throw new Error("Задача не найдена (/v1 режим)");
      return { status: "completed", result };
    }

    if (p.startsWith("/api/analyses/") && p.endsWith("/questions") && method === "POST") {
      const id = decodeURIComponent(p.slice("/api/analyses/".length, -"/questions".length));
      const r = await v1("/v1/analyses/" + encodeURIComponent(id) + "/questions", { company_id: companyId, question: body.question }, companyId);
      return { answer: r.data.answer };
    }

    if (p.startsWith("/api/analyses/") && method === "GET") {
      const id = decodeURIComponent(p.slice("/api/analyses/".length));
      const r = await v1("/v1/analyses/" + encodeURIComponent(id));
      return mapAnalysis(r.data, "");
    }

    if (p === "/api/news" && method === "POST") {
      const result = await v1("/v1/news", body, companyId);
      return { ...body, ...result.data, id: result.data.news_id };
    }
    if (p === "/api/feeds/refresh" && method === "POST") {
      const result = await v1("/v1/feeds/refresh", {}, companyId);
      return result.data;
    }

    throw new Error("Путь не поддержан /v1-адаптером: " + path);
  }

  window.__V1 = { active: true, handle };
})();
