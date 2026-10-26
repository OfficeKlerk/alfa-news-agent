import { developmentAccess } from "../access.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { IncomingMessage, ServerResponse } from "node:http";
import { Duplex } from "node:stream";
import type { Socket } from "node:net";
import { loadSettings, type Settings } from "../../config.js";
import type { Json } from "../../types.js";
import { createGateway } from "../gateway.js";
import { envelope } from "../contracts.js";
import type { ContractClient } from "../client.js";

function gateway(settings?: Settings) {
  let reads = 0;
  const unexpected = async () => { throw new Error("External model or retrieval must not run"); };
  const ml = { call: async (_url: string, _schema: string, id: string) => {
    reads++; return envelope({ items: [], offset: 0, limit: 20 }, id, "live");
  } } as ContractClient;
  const app = createGateway({access:developmentAccess, ml, retrieval: { search: unexpected, rag: unexpected, resolve: unexpected },
    agent: { analyze: unexpected, answer: unexpected }, settings, analysisEnabled: false });
  return { app, get reads() { return reads; } };
}

// Real Express/HTTP request and response objects over an in-memory socket: no
// listening port, DNS or provider call is needed to exercise the whole boundary.
async function request(app: ReturnType<typeof createGateway>, headers: Record<string, string>, method = "GET", path = "/v1/companies") {
  const chunks: Buffer[] = [];
  const socket = new Duplex({ read() {}, write(chunk, _encoding, done) { chunks.push(Buffer.from(chunk)); done(); } });
  const req = new IncomingMessage(socket as Socket);
  req.method = method; req.url = path; req.headers = headers;
  const res = new ServerResponse(req); res.assignSocket(socket as Socket);
  const completed = new Promise<{ status: number; body: Json }>((resolve, reject) => {
    res.once("error", reject);
    res.once("finish", () => {
      try {
        const raw = Buffer.concat(chunks).toString();
        resolve({ status: res.statusCode, body: JSON.parse(raw.slice(raw.indexOf("\r\n\r\n") + 4)) });
      } catch (error) { reject(error); }
    });
  });
  app(req, res); req.push(null);
  try { return await completed; } finally { socket.destroy(); }
}

const local = (host = "127.0.0.1") => loadSettings({ HOST: host, LIVE_PIPELINE_ENABLED: "1", NEWS_SEED_MODE: "none" });

test("local live gateway refuses rebinding Host for GET and same-origin POST before any company or model access", async () => {
  const f = gateway(local());
  for (const method of ["GET", "POST"]) {
    const reply = await request(f.app, { host: "rebound.example:8000", origin: "http://rebound.example:8000" }, method);
    assert.equal(reply.status, 403); assert.equal(reply.body.error.code, "FORBIDDEN");
  }
  assert.equal(f.reads, 0);
  assert.equal((await request(f.app, { host: "rebound.example", "x-forwarded-host": "localhost" })).status, 403);
});

test("local live gateway accepts loopback names and legal ports, rejecting ambiguous or missing Host", async () => {
  const f = gateway(local("::1"));
  for (const host of ["localhost", "LOCALHOST:8000", "127.0.0.1:1", "127.0.0.1:65535", "[::1]", "[::1]:8000"])
    assert.equal((await request(f.app, { host })).status, 200, host);
  for (const host of ["", "localhost:0", "localhost:65536", "localhost:abc", "localhost.evil.example", "localhost@evil.example", "127.0.0.1, evil.example", "0.0.0.0:8000"])
    assert.equal((await request(f.app, { host })).status, 403, host);
  assert.equal((await request(f.app, {})).status, 403);
  assert.equal(f.reads, 6);
  assert.equal((await request(f.app, { host: "localhost:8000", origin: "https://evil.example" }, "POST")).status, 403,
    "allowing the local Host does not bypass the existing Origin check");
});

test("Compose and existing non-live gateway configurations retain hostname routing", async () => {
  for (const settings of [undefined, local("0.0.0.0"), { ...local(), liveEnabled: false }]) {
    const f = gateway(settings);
    assert.equal((await request(f.app, { host: "gateway:8000" })).status, 200);
    assert.equal(f.reads, 1);
  }
});
