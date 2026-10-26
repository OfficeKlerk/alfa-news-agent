import type { RequestHandler } from "express";
import { timingSafeEqual } from "node:crypto";
import { ApiFault } from "./contracts.js";
/** Service credentials are deployment secrets, never accepted as browser identity. */
export function internalAccess(env: NodeJS.ProcessEnv): RequestHandler {
  if (env.AUTH_MODE === "development" && env.LLM_MODE !== "live") return (_req, _res, next) => next();
  const secret = env.INTERNAL_API_TOKEN;
  if (!secret || !/^[A-Za-z0-9_-]{32,}$/.test(secret)) throw new Error("A random INTERNAL_API_TOKEN is required for private services");
  return (req, _res, next) => {
    if (req.method === "GET" && req.path === "/v1/health") return next();
    const actual = Buffer.from(req.get("X-Internal-Token") ?? ""), expected = Buffer.from(secret);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new ApiFault(401, "UNAUTHORIZED", "Service authentication required");
    next();
  };
}
