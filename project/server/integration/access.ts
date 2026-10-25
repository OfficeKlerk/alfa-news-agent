/** OIDC authentication and tenant authorization. No client-supplied company ID grants access. */
import type { Express, Request, Response, NextFunction } from "express";
import * as oidc from "openid-client";
import { createRemoteJWKSet, jwtVerify, EncryptJWT, jwtDecrypt, type JWTPayload, type JWTVerifyGetKey } from "jose";
import { ApiFault } from "./contracts.js";

export interface Principal { subject: string; companies: string[]; roles: string[] }
export interface Access {
  secured: boolean;
  install(app: Express): void;
}
const ID = /^[A-Za-z0-9_:.\-]{1,160}$/;
export function principalFromClaims(payload: JWTPayload, companyClaim = "company_ids", roleClaim = "roles"): Principal {
  const companies = payload[companyClaim], roles = payload[roleClaim] ?? [];
  if (typeof payload.sub !== "string" || !/^[\x21-\x7e]{1,255}$/.test(payload.sub) || !Array.isArray(companies) || companies.length > 10000
    || !companies.every(id => typeof id === "string" && ID.test(id))
    || !Array.isArray(roles) || !roles.every(role => typeof role === "string" && ID.test(role)))
    throw new ApiFault(403, "FORBIDDEN", "Identity has no valid company grants");
  return { subject: payload.sub, companies: [...new Set(companies)].sort(), roles: [...new Set(roles)] };
}
export function authorizeCompany(principal: Principal, id: unknown) {
  if (typeof id !== "string" || !principal.companies.includes(id))
    throw new ApiFault(403, "FORBIDDEN", "Company access denied");
}
/** Shared by API and cookie entry points; requires signed, expiring tokens and fixed issuer/audience. */
export async function verifyIdentity(token: string, keys: JWTVerifyGetKey, issuer: string, audience: string, companyClaim?: string, roleClaim?: string) {
  const { payload } = await jwtVerify(token, keys, { issuer, audience, algorithms: ["RS256", "ES256"], requiredClaims: ["sub", "iat", "exp"], maxTokenAge: "1h", clockTolerance: 5 });
  return principalFromClaims(payload, companyClaim, roleClaim);
}
const cookie = (req: Request, name: string) => {
  const values = (req.headers.cookie ?? "").split(";").map(s => s.trim()).filter(s => s.startsWith(name + "="));
  if (values.length !== 1) return undefined;
  return values[0].slice(name.length + 1);
};
export const developmentAccess: Access = { secured: false, install() {} };
function https(value: string | undefined, name: string) {
  if (!value) throw new Error(name + " is required");
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.hash) throw new Error(name + " must be a trusted HTTPS URL");
  return url;
}
export async function accessFromEnv(env: NodeJS.ProcessEnv): Promise<Access> {
  const mode = env.AUTH_MODE ?? "oidc";
  if (mode === "development") {
    if (env.LLM_MODE === "live") throw new Error("Live runtime requires OIDC; AUTH_MODE=development is only for explicit offline development");
    return developmentAccess;
  }
  if (mode !== "oidc") throw new Error("AUTH_MODE must be oidc or development");
  const issuer = https(env.OIDC_ISSUER, "OIDC_ISSUER");
  const origin = https(env.PUBLIC_BASE_URL, "PUBLIC_BASE_URL");
  if (origin.pathname !== "/" || origin.search) throw new Error("PUBLIC_BASE_URL must be an origin");
  const clientId = env.OIDC_CLIENT_ID, audience = env.OIDC_AUDIENCE;
  if (!clientId || !audience) throw new Error("OIDC_CLIENT_ID and OIDC_AUDIENCE are required");
  const key = Buffer.from(env.AUTH_COOKIE_KEY ?? "", "base64url");
  if (key.length !== 32 || key.toString("base64url") !== env.AUTH_COOKIE_KEY) throw new Error("AUTH_COOKIE_KEY must be a random 32-byte base64url key");
  if (!/^[A-Za-z0-9_-]{32,}$/.test(env.INTERNAL_API_TOKEN ?? "")) throw new Error("INTERNAL_API_TOKEN must have at least 32 characters");
  const config = await oidc.discovery(issuer, clientId, env.OIDC_CLIENT_SECRET || undefined, undefined, { timeout: 10 });
  const jwks = https(config.serverMetadata().jwks_uri, "discovered jwks_uri");
  const keys = createRemoteJWKSet(jwks, { timeoutDuration: 5000, cooldownDuration: 30000, cacheMaxAge: 600000 });
  const callback = new URL("/auth/callback", origin).href;
  const companyClaim = env.OIDC_COMPANY_CLAIM ?? "company_ids", roleClaim = env.OIDC_ROLE_CLAIM ?? "roles";
  const seal = (data: JWTPayload, seconds: number) => new EncryptJWT(data).setProtectedHeader({ alg: "dir", enc: "A256GCM" })
    .setIssuer(origin.origin).setAudience("alfa-browser").setIssuedAt().setExpirationTime(Math.floor(Date.now() / 1000) + seconds).encrypt(key);
  const open = async (token: string) => (await jwtDecrypt(token, key, { issuer: origin.origin, audience: "alfa-browser", keyManagementAlgorithms: ["dir"], contentEncryptionAlgorithms: ["A256GCM"] })).payload;
  const cookieOptions = { httpOnly: true, secure: true, sameSite: "lax" as const, path: "/" };
  return { secured: true, install(app) {
    app.get("/auth/login", async (_req, res) => {
      const verifier = oidc.randomPKCECodeVerifier(), nonce = oidc.randomNonce(), state = oidc.randomState();
      res.cookie("__Host-alfa-flow", await seal({ verifier, nonce, state }, 300), { ...cookieOptions, maxAge: 300000 });
      const url = oidc.buildAuthorizationUrl(config, { redirect_uri: callback, scope: env.OIDC_SCOPES ?? "openid profile", code_challenge_method: "S256", code_challenge: await oidc.calculatePKCECodeChallenge(verifier), nonce, state });
      res.redirect(url.href);
    });
    app.get("/auth/callback", async (req, res) => {
      res.clearCookie("__Host-alfa-flow", cookieOptions);
      try {
        const flow = await open(cookie(req, "__Host-alfa-flow") ?? "");
        const url = new URL(req.originalUrl, origin);
        const tokens = await oidc.authorizationCodeGrant(config, url, { pkceCodeVerifier: String(flow.verifier), expectedState: String(flow.state), expectedNonce: String(flow.nonce), idTokenExpected: true });
        if (!tokens.id_token) throw new Error("Missing ID token");
        const { payload } = await jwtVerify(tokens.id_token, keys, { issuer: config.serverMetadata().issuer!, audience: clientId, algorithms: ["RS256", "ES256"], requiredClaims: ["sub", "exp", "iat"] });
        const principal = principalFromClaims(payload, companyClaim, roleClaim);
        const seconds = Math.min(900, Math.max(0, (payload.exp ?? 0) - Math.floor(Date.now() / 1000)));
        if (!seconds) throw new Error("Expired identity");
        const session = await seal({ principal, purpose: "session" }, seconds);
        if (session.length > 3800) throw new Error("Company grants exceed browser cookie capacity; use the bearer API");
        res.cookie("__Host-alfa-session", session, { ...cookieOptions, maxAge: seconds * 1000 });
        res.redirect(app.locals.live ? "/live/" : "/analysis/");
      } catch { res.status(401).type("text").send("Authentication failed. Restart /auth/login."); }
    });
    app.post("/auth/logout", (req, res) => {
      if (req.get("Origin") !== origin.origin) throw new ApiFault(403, "FORBIDDEN", "Invalid Origin");
      res.clearCookie("__Host-alfa-session", cookieOptions); res.sendStatus(204);
    });
    app.use(async (req: Request, res: Response, next: NextFunction) => {
      if (req.method === "GET" && req.path === "/v1/health") return next();
      if (!req.path.toLowerCase().startsWith("/v1") && !req.path.toLowerCase().startsWith("/api")) {
        // Static UI is public; its data requires authentication. Navigation starts a real OIDC login.
        if (req.method === "GET" && (req.path === "/" || req.path === "/analysis/" || req.path === "/live/" || req.path === "/learning") && !cookie(req, "__Host-alfa-session")) return res.redirect("/auth/login");
        if (req.path === "/" && !app.locals.live && req.query.api !== "v1") return res.redirect("/?api=v1");
        return next();
      }
      let principal: Principal;
      try {
        const authorization = req.get("Authorization");
        if (authorization) {
          if (!/^Bearer [^\s]+$/.test(authorization)) throw new Error("Invalid bearer");
          principal = await verifyIdentity(authorization.slice(7), keys, config.serverMetadata().issuer!, audience, companyClaim, roleClaim);
        } else {
          const session = await open(cookie(req, "__Host-alfa-session") ?? "");
          if (session.purpose !== "session") throw new Error("Not a session");
          const p = session.principal as Principal;
          principal = principalFromClaims({ sub: p.subject, company_ids: p.companies, roles: p.roles });
          if (req.method !== "GET" && req.get("Origin") !== origin.origin) throw new ApiFault(403, "FORBIDDEN", "Origin required for browser writes");
        }
      } catch (error) {
        if (error instanceof ApiFault && error.status === 403) throw error;
        res.set("WWW-Authenticate", 'Bearer realm="alfa-news"'); throw new ApiFault(401, "UNAUTHORIZED", "Authentication required");
      }
      res.locals.principal = principal;
      enforceTenant(req, principal);
      next();
    });
  } };
}
/** Default-deny legacy API and administrative operations; authenticate before consulting IDs. */
export function enforceTenant(req: Request, principal: Principal) {
  const path = req.path.replace(/\/+$/, "");
  if (path.toLowerCase().startsWith("/api")) throw new ApiFault(403, "FORBIDDEN", "Legacy data API is disabled; use /v1");
  if (/^\/v1\/(?:news|feeds\/(?:refresh|status)|learning)(?:\/|$)/i.test(path) && !principal.roles.includes("news_admin"))
    throw new ApiFault(403, "FORBIDDEN", "Administrative role required");
  const companyRoute = /^\/v1\/companies\/([^/]+)(?:\/|$)/i.exec(path);
  const ids = [companyRoute ? decodeURIComponent(companyRoute[1]) : undefined, req.body?.company_id, req.query.company_id, req.get("X-Company-ID")].filter(id => id !== undefined);
  ids.forEach(id => authorizeCompany(principal, id));
  // Every new data route is scoped unless it is explicitly in the shared-public-data API.
  // This also covers a future feed without silently creating an unscoped endpoint.
  const shared = /^\/v1\/(?:health|runtime|companies|tools\/(?:search_news|rag_bank_analytics|resolve_sources)|news|feeds\/(?:refresh|status)|learning\/(?:status|feedback))$/i.test(path);
  if (!shared && !ids.length) throw new ApiFault(403, "FORBIDDEN", "Company scope is required");
}
