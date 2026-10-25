/** Explicit public showcase: anonymous private sessions and a fixed company allowlist. */
import { randomUUID } from "node:crypto";
import { EncryptJWT, jwtDecrypt } from "jose";
import { enforceTenant, type Access } from "./access.js";
import { ApiFault } from "./contracts.js";

export function publicAccess(env: NodeJS.ProcessEnv): Access {
  const origin = new URL(env.PUBLIC_BASE_URL ?? "");
  if (origin.protocol !== "https:" || origin.pathname !== "/" || origin.search || origin.hash || origin.username || origin.password)
    throw new Error("Public showcase requires an HTTPS PUBLIC_BASE_URL origin");
  const companies: unknown = JSON.parse(env.PUBLIC_COMPANY_IDS_JSON ?? "[]");
  if (!Array.isArray(companies) || !companies.length || companies.length > 100 || !companies.every(id => typeof id === "string" && /^[A-Za-z0-9_:.\-]{1,160}$/.test(id)))
    throw new Error("Set an explicit PUBLIC_COMPANY_IDS_JSON allowlist");
  const key = Buffer.from(env.AUTH_COOKIE_KEY ?? "", "base64url");
  if (key.length !== 32 || key.toString("base64url") !== env.AUTH_COOKIE_KEY) throw new Error("Public showcase requires a random AUTH_COOKIE_KEY");
  if (!/^[A-Za-z0-9_-]{32,}$/.test(env.INTERNAL_API_TOKEN ?? "")) throw new Error("Public showcase requires INTERNAL_API_TOKEN");
  const name = "__Host-alfa-guest";
  return { secured: true, install(app) {
    app.get("/auth/login", (_req, res) => res.redirect("/"));
    app.use(async (req, res, next) => {
      if (req.method === "GET" && req.path === "/v1/health") return next();
      if (req.get("Host") !== origin.host) throw new ApiFault(403, "FORBIDDEN", "Invalid public Host");
      if (!["GET", "HEAD"].includes(req.method) && req.get("Origin") !== origin.origin)
        throw new ApiFault(403, "FORBIDDEN", "Origin required for public writes");
      let subject: string | undefined;
      const cookies = (req.headers.cookie ?? "").split(";").map(v => v.trim()).filter(v => v.startsWith(name + "="));
      if (cookies.length === 1) {
        try {
          const { payload } = await jwtDecrypt(cookies[0].slice(name.length + 1), key,
            { issuer: origin.origin, audience: "alfa-public", keyManagementAlgorithms: ["dir"], contentEncryptionAlgorithms: ["A256GCM"] });
          if (typeof payload.sub === "string" && /^guest:[a-f0-9-]{36}$/.test(payload.sub)) subject = payload.sub;
        } catch { /* Invalid/expired visitor credentials never grant another visitor's history. */ }
      }
      if (!subject) {
        subject = "guest:" + randomUUID();
        const token = await new EncryptJWT({}).setProtectedHeader({ alg: "dir", enc: "A256GCM" }).setSubject(subject)
          .setIssuer(origin.origin).setAudience("alfa-public").setIssuedAt().setExpirationTime("7d").encrypt(key);
        res.cookie(name, token, { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: 604800000 });
      }
      const principal = { subject, companies: [...new Set(companies as string[])], roles: [] };
      res.locals.principal = principal;
      if (/^\/(?:v1|api)(?:\/|$)/i.test(req.path)) enforceTenant(req, principal);
      if (/^\/v1\/live\/subscriptions\/?$/.test(req.path) && req.method === "POST" && req.body?.enabled === false)
        throw new ApiFault(403, "FORBIDDEN", "Public visitors cannot pause the shared pipeline");
      next();
    });
  } };
}
