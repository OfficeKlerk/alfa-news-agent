/** Role 4 browser SDK. Use one origin through the gateway, never call internal service ports. */
export class AlfaApi {
  constructor(base = "") { this.base = base.replace(/\/$/, ""); }
  async request(path, body, signal) {
    const response = await fetch(this.base + path, { method: body === undefined ? "GET" : "POST", signal,
      headers: { "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const value = await response.json();
    if (!response.ok) { const error = new Error(value.error?.message ?? "API error"); error.code = value.error?.code; error.requestId = value.request_id; error.status = response.status; error.diagnostics = value.error?.diagnostics; throw error; }
    return value;
  }
  companies(signal, offset = 0) { return this.request(`/v1/companies?offset=${offset}&limit=100`, undefined, signal); }
  profile(id, signal) { return this.request("/v1/companies/" + encodeURIComponent(id), undefined, signal); }
  search(query, asOf, signal) { return this.request("/v1/tools/search_news", { query, as_of: asOf, limit: 100, news_id: null }, signal); }
  rank(companyId, events, asOf, signal) { return this.request("/v1/rank", { company_id: companyId, events, as_of: asOf, limit: 100 }, signal); }
  analyze(companyId, newsId, asOf, signal) { return this.request("/v1/analyze", { company_id: companyId, news_id: newsId, as_of: asOf, audience_role: "cfo" }, signal); }
  context(body, signal) { return this.request("/v1/analysis-context", body, signal); }
  analyzeEvent(body, signal) { return this.request("/v1/analyze-event", body, signal); }
  question(analysisId, companyId, question, signal) { return this.request(`/v1/analyses/${encodeURIComponent(analysisId)}/questions`, { company_id: companyId, question }, signal); }
}
