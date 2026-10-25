import assert from "node:assert/strict";
import { test } from "node:test";
import { once } from "node:events";
import express from "express";
import { accessFromEnv } from "../access.js";
import { boundary, errorBoundary } from "../gateway.js";

const env = { AUTH_MODE: "public", LLM_MODE: "live", PUBLIC_BASE_URL: "https://showcase.example",
  PUBLIC_COMPANY_IDS_JSON: '["A","B"]', AUTH_COOKIE_KEY: Buffer.alloc(32, 42).toString("base64url"), INTERNAL_API_TOKEN: "x".repeat(43) };
test("public startup requires HTTPS, an explicit company allowlist and private credentials", async () => {
  for (const change of [{ PUBLIC_BASE_URL: "http://showcase.example" }, { PUBLIC_COMPANY_IDS_JSON: "[]" },
    { PUBLIC_COMPANY_IDS_JSON: '["*"]' }, { AUTH_COOKIE_KEY: "" }, { INTERNAL_API_TOKEN: "" }])
    await assert.rejects(accessFromEnv({ ...env, ...change }));
});
test("public visitors retain separate sessions, company scope, admin denial and Origin protection", async () => {
  const app = express(); boundary(app);
  const server = app.listen(0, "127.0.0.1"); await once(server, "listening");
  const base = "http://127.0.0.1:" + (server.address() as { port: number }).port;
  const publicOrigin = base.replace("http:", "https:");
  (await accessFromEnv({ ...env, PUBLIC_BASE_URL: publicOrigin })).install(app);
  app.use((_req, res) => res.json(res.locals.principal ?? { health: true })); app.use(errorBoundary);
  const headers = { Accept: "application/json" };
  try {
    const a = await fetch(base + "/v1/runtime", { headers }), cookie = a.headers.get("set-cookie")!.split(";")[0], principal = await a.json();
    assert.match(a.headers.get("set-cookie")!, /HttpOnly/); assert.match(a.headers.get("set-cookie")!, /Secure/);
    assert.deepEqual(principal.companies, ["A", "B"]); assert.deepEqual(principal.roles, []);
    const b = await (await fetch(base + "/v1/runtime", { headers })).json(); assert.notEqual(b.subject, principal.subject);
    assert.equal((await (await fetch(base + "/v1/runtime", { headers: { ...headers, Cookie: cookie } })).json()).subject, principal.subject);
    assert.equal((await fetch(base + "/v1/companies/A", { headers })).status, 200);
    for (const path of ["/v1/companies/C", "/v1/companies/%43/feed", "/v1/news", "/v1/feeds/refresh", "/v1/learning/status", "/api/companies", "/v1/live/feed"])
      assert.equal((await fetch(base + path, { headers })).status, 403, path);
    assert.equal((await fetch(base + "/v1/companies/A", { headers: { ...headers, "X-Company-ID": "C" } })).status, 403);
    const post = { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: '{"company_id":"A"}' };
    assert.equal((await fetch(base + "/v1/live/scan", post)).status, 403);
    assert.equal((await fetch(base + "/v1/live/scan", { ...post, headers: { ...post.headers, Origin: publicOrigin } })).status, 200);
    assert.equal((await fetch(base + "/v1/live/subscriptions", { ...post, headers: { ...post.headers, Origin: publicOrigin }, body: '{"company_id":"A","enabled":false}' })).status, 403);
  } finally { await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())); }
});
