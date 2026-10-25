import { lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { Readable } from "node:stream";
import { AppError } from "./types.js";

export const NEWS_USER_AGENT = "AlfaNewsCollector/3.0";
/** Reject local, private, multicast, documentation and transition address space. */
export function publicAddress(address: string): boolean {
  const clean = address.replace(/^\[|\]$/g, "").toLowerCase();
  if (isIP(clean) === 4) {
    const [a,b,c] = clean.split(".").map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31
      || a === 192 && (b === 168 || b === 0 || b === 2) || a === 100 && b >= 64 && b <= 127
      || a === 198 && (b === 18 || b === 19 || b === 51 && c === 100) || a === 203 && b === 0 && c === 113);
  }
  // IPv4-mapped addresses and tunnels are rejected rather than decoded ambiguously.
  const normalized = isIP(clean) === 6 ? new URL(`https://[${clean}]/`).hostname.slice(1,-1) : "";
  return /^2[0-9a-f]{3}:/.test(normalized) && !/^2001:(?:db8:|0:|10:|20:|:)/i.test(normalized) && !/^2002:/i.test(normalized);
}
export function safeNewsUrl(value: string, allowedHosts?: string[]): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new AppError("Некорректный адрес источника", 502); }
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (url.protocol !== "https:" || url.username || url.password || url.port && url.port !== "443"
      || host === "localhost" || !host.includes(".") || /\.(?:localhost|local|internal|lan|home|test|invalid)$/.test(host)
      || isIP(host) && !publicAddress(host)) throw new AppError("Запрещённый адрес источника: требуется публичный HTTPS без учётных данных", 502);
  if (allowedHosts && !allowedHosts.map(h => h.toLowerCase()).includes(host)) throw new AppError("Источник перенаправил за пределы разрешённых доменов", 502);
  url.hash = "";
  return url;
}

/** DNS is resolved once and pinned to the TLS socket; no second lookup/rebinding. */
async function pinnedFetch(url: URL, signal: AbortSignal, headers: Record<string,string>): Promise<Response> {
  const addresses = await lookup(url.hostname, { all: true });
  signal.throwIfAborted();
  if (!addresses.length || addresses.some(({ address }) => !publicAddress(address))) throw new AppError("DNS источника указывает на непубличный адрес", 502);
  const address = addresses.find(item => item.family === 4) ?? addresses[0];
  return new Promise((resolve, reject) => {
    const req = httpsRequest(url, { signal, headers, agent: false, lookup: (_host, options, callback) => (callback as any)(null, options.all ? [address] : address.address, address.family) }, response => {
      const responseHeaders = new Headers();
      for (const [key,value] of Object.entries(response.headers)) if (value !== undefined) responseHeaders.set(key, Array.isArray(value) ? value.join(", ") : value);
      const empty = [204,205,304].includes(response.statusCode ?? 502);
      if (empty) response.resume();
      resolve(new Response(empty ? null : Readable.toWeb(response) as ReadableStream<Uint8Array>, { status: response.statusCode ?? 502, headers: responseHeaders }));
    });
    req.on("error", reject); req.end();
  });
}

export function robotsAllowed(text: string, path: string): boolean {
  const groups: { agents: string[]; rules: { allow: boolean; path: string }[] }[] = [];
  let group = { agents: [] as string[], rules: [] as { allow: boolean; path: string }[] };
  let sawDirective = false;
  for (const raw of text.split(/\r?\n/)) {
    const match = raw.replace(/#.*/, "").trim().match(/^([\w-]+)\s*:\s*(.*)$/);
    if (!match) continue;
    const key = match[1].toLowerCase(), value = match[2].trim();
    if (key === "user-agent") {
      if (sawDirective) { groups.push(group); group = { agents: [], rules: [] }; sawDirective=false; }
      group.agents.push(value.toLowerCase());
    } else if ((key === "allow" || key === "disallow") && group.agents.length) { sawDirective=true; if (value) group.rules.push({ allow: key === "allow", path: value }); }
  }
  groups.push(group);
  const specific = groups.filter(g => g.agents.some(a => a !== "*" && NEWS_USER_AGENT.toLowerCase().startsWith(a)));
  const rules = (specific.length ? specific : groups.filter(g => g.agents.includes("*"))).flatMap(g => g.rules);
  const matching = rules.filter(rule => {
    const expr = rule.path.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\\\$$/, "$");
    return new RegExp("^" + expr).test(path);
  }).sort((a,b) => b.path.length - a.path.length || Number(b.allow) - Number(a.allow));
  return matching[0]?.allow ?? true;
}

export class NewsHttp {
  private readonly robots = new Map<string, Promise<{ expires: number; text: string }>>();
  private readonly robotsFailures = new Map<string,{ expires:number; error:unknown }>();
  constructor(private readonly request?: typeof fetch, private readonly timeoutMs = 15000) {}
  async read(value: string, options: { hosts?: string[]; maxBytes?: number; signal?: AbortSignal; robots?: boolean; accept?: string } = {}): Promise<{ text: string; url: string; contentType: string }> {
    const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(this.timeoutMs)]) : AbortSignal.timeout(this.timeoutMs);
    let url = safeNewsUrl(value, options.hosts);
    for (let redirects = 0; redirects <= 3; redirects++) {
      signal.throwIfAborted();
      if (options.robots && !await this.allowed(url, signal)) throw new AppError("Полный текст запрещён robots.txt", 502);
      const headers = { "User-Agent": NEWS_USER_AGENT, Accept: options.accept ?? "text/html,application/xhtml+xml", "Accept-Encoding": "identity" };
      // Injected transports are deterministic test adapters. Production always pins DNS.
      const response = this.request ? await this.request(url.toString(), { signal, headers, redirect: "manual" }) : await pinnedFetch(url, signal, headers);
      if ([301,302,303,307,308].includes(response.status)) {
        await response.body?.cancel();
        const location = response.headers.get("location");
        if (!location || redirects === 3) throw new AppError("Слишком много перенаправлений источника", 502);
        url = safeNewsUrl(new URL(location, url).toString(), options.hosts ?? [url.hostname]); continue;
      }
      if (!response.ok || !response.body) { await response.body?.cancel(); throw new AppError("Источник вернул HTTP " + response.status, 502); }
      const limit = options.maxBytes ?? 3000000, reader = response.body.getReader(), chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) { signal.throwIfAborted(); const {done,value} = await reader.read(); if (done) break; size += value.byteLength;
          if (size > limit) throw new AppError("Ответ источника превышает допустимый размер", 502); chunks.push(value); }
      } finally { await reader.cancel(); }
      const charset = response.headers.get("content-type")?.match(/charset\s*=\s*["']?([^\s;"']+)/i)?.[1] ?? "utf-8";
      let text: string;
      try { text = new TextDecoder(charset).decode(Buffer.concat(chunks)); } catch { throw new AppError("Неподдерживаемая кодировка источника", 502); }
      return { text, url: url.toString(), contentType: response.headers.get("content-type") ?? "" };
    }
    throw new AppError("Не удалось загрузить источник", 502);
  }
  private async allowed(url: URL, signal: AbortSignal): Promise<boolean> {
    const failed = this.robotsFailures.get(url.origin);
    if (failed && failed.expires > Date.now()) throw failed.error;
    let pending = this.robots.get(url.origin);
    if (pending && (await pending).expires <= Date.now()) pending = undefined;
    if (!pending) {
      pending = (async () => {
        try { const result = await this.read(url.origin + "/robots.txt", { maxBytes: 256000, signal, hosts: [url.hostname], accept: "text/plain" });
          return { expires: Date.now() + 3600000, text: result.text }; }
        catch (error) { if (error instanceof AppError && /HTTP (404|410)$/.test(error.message)) return { expires: Date.now() + 3600000, text: "" }; throw error; }
      })();
      this.robots.set(url.origin, pending);
      void pending.catch(error => { this.robots.delete(url.origin); if (!signal.aborted) this.robotsFailures.set(url.origin,{expires:Date.now()+60000,error}); });
    }
    return robotsAllowed((await pending).text, url.pathname + url.search);
  }
}
