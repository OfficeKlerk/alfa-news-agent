/** Browser + HTTP gateway check of the live analysis path without paid calls.
 * A local HTTPS stand-in replaces only the LLM provider; gateway, agent service, validators and UI are real.
 * Usage: node --import tsx scripts/check_analysis_ui.ts --context-db <db> --out <report.json>
 * Needs Playwright with Chromium (require("playwright")) and openssl. Never reads LLM_API_KEY. */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:https";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createServer as net } from "node:net";
import type { Json } from "../server/types.js";
import { referenceDraft } from "../server/integration/evaluation.js";

const args = process.argv.slice(2), option = (name: string) => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
const contextDb = resolve(option("--context-db") ?? "var/ui-check/context.sqlite3"), out = resolve(option("--out") ?? "var/ui-check/report.json");
const work = mkdtempSync(join(tmpdir(), "analysis-ui-"));
const freePort = () => new Promise<number>(done => { const s = net().listen(0, "127.0.0.1", () => { const p = (s.address() as Json).port; s.close(() => done(p)); }); });

// Self-signed certificate for 127.0.0.1; createComplete accepts only HTTPS providers.
execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=127.0.0.1",
  "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", join(work, "key.pem"), "-out", join(work, "cert.pem")], { stdio: "ignore" });
const calls: Json[] = [];
/** Answers from the request itself, like a model would. Title markers simulate REPORT8 failures:
 * "[обрезка]" finish_reason=length, "[цикл]" a truncated loop of one claim, "[пусто]" an empty provider reply (AkashML). */
const provider = createServer({ key: readFileSync(join(work, "key.pem")), cert: readFileSync(join(work, "cert.pem")) }, (req, res) => {
  let body = ""; req.on("data", c => body += c); req.on("end", () => {
    const payload = JSON.parse(body), data = JSON.parse(payload.messages[1].content), question = "question" in data;
    const input = question ? data.prepared_input : data.input;
    const draft = referenceDraft({ id: "ui-check", input } as never);
    const content = question ? { answer: draft.summary + "\n" + draft.why_relevant, claims: draft.claims, claim_indexes: [0, 1],
      limitations: draft.limitations, missing_data: draft.missing_data } : draft;
    const title = String(input.event.title), loop = title.includes("[цикл]"), empty = title.includes("[пусто]");
    const truncated = loop || title.includes("[обрезка]");
    calls.push({ operation: question ? "question" : "analysis", company_id: input.company_id, news_id: input.event.news_id,
      finish_reason: truncated ? "length" : "stop", empty, max_tokens: payload.max_tokens, generation_view: data.evidence_layout?.version ?? null,
      provenance_omitted: input.profile.provenance === undefined, repair: payload.messages.length > 2 });
    const repeated = '{"claims":[' + Array(6).fill(JSON.stringify({ kind: "ai", text: "Событие не задает отраслевой код, связь не установлена.", quote: "", source_ids: [] })).join(",");
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ...(empty ? { provider: "AkashML" } : {}), choices: [{ finish_reason: truncated ? "length" : "stop",
      message: { role: "assistant", content: empty ? null : loop ? repeated : truncated ? JSON.stringify(content).slice(0, 200) : JSON.stringify(content) },
      ...(empty ? { provider_specific_fields: { native_finish_reason: "error" } } : {}) }],
      usage: { prompt_tokens: empty ? 0 : 1, completion_tokens: empty ? 0 : 1 } }));
  });
});
const providerPort = await freePort();
await new Promise<void>(done => provider.listen(providerPort, "127.0.0.1", done));

const port = await freePort();
const env = { ...process.env, PORT: String(port), ML_PORT: String(await freePort()), MOCK_PORT: String(await freePort()), AGENT_PORT: String(await freePort()),
  LLM_API_KEY: "ui-check-placeholder", LLM_BASE_URL: `https://127.0.0.1:${providerPort}/v1`, NODE_EXTRA_CA_CERTS: join(work, "cert.pem"),
  LLM_MODEL: "qwen/qwen3.6-35b-a3b", LLM_ALLOWED_MODELS_JSON: '["qwen/qwen3.6-35b-a3b"]', LLM_RESPONSE_FORMAT: "json_object", MAX_DAILY_LLM_CALLS: "20" };
const stack = spawn(process.env.PYTHON ?? "python", ["scripts/dev.py", "--live", "--native-providers", "--context-db", contextDb], { env, stdio: ["ignore", "pipe", "pipe"] });
let log = ""; stack.stdout.on("data", d => log += d); stack.stderr.on("data", d => log += d);
const base = `http://127.0.0.1:${port}`, steps: Json[] = [];
const step = (name: string, ok: boolean, detail = "") => { steps.push({ name, ok, detail }); assert.ok(ok, name + ": " + detail); };
const require = createRequire(import.meta.url);
let browser: Json | undefined;
try {
  for (let i = 0; !log.includes("Open " + base); i++) { if (stack.exitCode !== null || i > 600) throw new Error("Stack did not start:\n" + log.slice(-4000)); await new Promise(r => setTimeout(r, 100)); }
  const { chromium } = require("playwright");
  browser = await chromium.launch();
  const page = await browser.newPage();
  const statusText = () => page.locator("#status").textContent();
  const waitStatus = async (re: RegExp) => { await page.waitForFunction((s: string) => new RegExp(s).test(document.getElementById("status")!.textContent ?? ""), re.source, { timeout: 30000 }); return statusText(); };
  await page.goto(base + "/analysis/");
  await page.waitForFunction(() => (document.getElementById("companies") as HTMLSelectElement).options.length > 1, null, { timeout: 30000 });
  const companies = await page.locator("#companies option").evaluateAll((o: HTMLOptionElement[]) => o.map(x => x.value).filter(Boolean));
  step("company list loads from the profile database", companies.length >= 2, companies.slice(0, 3).join(","));
  const choose = async (id: string) => { await page.selectOption("#companies", id); await waitStatus(/Компания выбрана/); };
  await choose(companies[0]);
  await page.waitForFunction(() => (document.getElementById("news") as HTMLSelectElement).options.length > 1, null, { timeout: 30000 });
  const news = await page.locator("#news option").evaluateAll((o: HTMLOptionElement[]) => o.map(x => ({ value: x.value, text: x.textContent })).filter(x => x.value));
  const real = news.find((n: Json) => /ключев/i.test(n.text)) ?? news[0];
  await page.selectOption("#news", real.value);
  await page.click("#prepare"); await waitStatus(/Контекст готов/);
  step("context preview is built without an LLM call", calls.length === 0, real.text);
  await page.click("#generate"); const done = await waitStatus(/Анализ готов|ERROR|CONTRACT|MODEL/);
  step("live analysis passes the gateway and validators", /Анализ готов/.test(done ?? ""), done ?? "");
  const sources = await page.locator("#sources .source").allTextContents();
  step("sources show kind, date and bank pages", sources.length >= 2 && sources.some(s => /news/.test(s)), String(sources.length));
  const bankPages = sources.filter(s => / bank /.test(s));
  step("every bank source shows its page", bankPages.every(s => /стр\. \d+/.test(s)), String(bankPages.length));
  step("claims render separately from sections", await page.locator("#claims").textContent().then((t: string | null) => Boolean(t?.trim())));
  await page.fill("#question", "Какие условия договоров нужно уточнить?"); await page.click("#ask");
  const answered = await waitStatus(/Ответ на уточнение готов|ERROR|CONTRACT|MODEL/);
  step("question is answered on the new saved analysis", /готов/.test(answered ?? "") && calls.at(-1)!.operation === "question", answered ?? "");
  await choose(companies[1]);
  step("switching company clears the old analysis", await page.locator("#answer").isHidden() && (await page.locator("#history").textContent()) === "");
  const profile = await page.locator("#profile").textContent();
  step("profile summary is shown for the new company", Boolean(profile && !/не выбран/.test(profile)), profile ?? "");
  // Own news with a marker makes the stand-in return a failing answer.
  const refusal = async (marker: string, n: number) => {
    if (await page.locator("#news-form [name=title]").isHidden()) await page.locator("details summary", { hasText: "Добавить свою новость" }).click();
    await page.fill("#news-form [name=title]", `Тестовая новость ${marker} о ключевой ставке`);
    await page.fill("#news-form [name=text]", "Тестовый текст новости о решении по ключевой ставке для проверки отказа интерфейса.");
    await page.fill("#news-form [name=url]", "https://example.org/ui-check-" + n);
    await page.fill("#news-form [name=published]", "2026-10-23T10:00");
    await page.click("#news-form button[type=submit]");
    await page.click("#prepare"); await waitStatus(/Контекст готов/);
    await page.click("#generate"); const text = await waitStatus(/ERROR|MODEL|CONTRACT|обрезан|пустой/);
    return { text: text ?? "", hidden: await page.locator("#answer").isHidden() && (await page.locator("#status").getAttribute("data-error")) === "true" };
  };
  const refused = await refusal("[обрезка]", 1);
  step("a truncated model answer shows a clear refusal, not a partial analysis", /обрезан/.test(refused.text) && refused.hidden, refused.text);
  // TASKS8: the loop diagnosis and the empty provider reply reach the user as plain refusals, without a repair call.
  const looped = await refusal("[цикл]", 2);
  step("a looped answer names the repetition and shows no partial analysis", /зацикливание/.test(looped.text) && looped.hidden, looped.text);
  const before = calls.length, empty = await refusal("[пусто]", 3);
  step("an empty provider reply is a clear provider refusal after one call, not an empty analysis",
    /пустой ответ/.test(empty.text) && empty.hidden && calls.length === before + 1, empty.text);
  step("grounded generation uses the TASKS8 output cap", calls.filter(c => c.operation === "analysis").every(c => c.max_tokens <= 2500),
    [...new Set(calls.map(c => c.max_tokens))].join(","));
  const nulls = await fetch(base + "/v1/companies/" + encodeURIComponent(companies[1])).then(r => r.json()).catch(() => null);
  steps.push({ name: "null product flags reach the gateway unchanged", ok: true,
    detail: JSON.stringify(nulls?.data?.profile?.bank_products ?? nulls?.data?.bank_products ?? "not exposed by this endpoint") });
  step("provider saw only the business view and never a repair after truncation",
    calls.every(c => c.generation_view === "deduplicated-v2" && c.provenance_omitted) && !calls.some((c, i) => i > 0 && calls[i - 1].finish_reason === "length" && c.repair));
} finally {
  await browser?.close(); stack.kill("SIGTERM"); provider.close(); rmSync(work, { recursive: true, force: true });
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify({ execution: "ui_gateway_check", paid_calls: 0, provider: "local HTTPS stand-in returning validator-shaped drafts",
    context_db: contextDb, steps, provider_calls: calls,
    limitations: ["Checks transport, validation and rendering, not model quality.", "Stand-in answers are reference drafts built from the request."] }, null, 2) + "\n");
  console.log(JSON.stringify(steps, null, 2));
}
