// Incrementing revision prevents late responses from a previous company/news overwriting the screen.
export class AnalysisState {
  revision = 0; controller = null; preview = null; result = null;
  reset() { this.controller?.abort(); this.revision++; this.preview = null; this.result = null; }
  start() { this.controller?.abort(); this.controller = new AbortController(); return { revision: this.revision, signal: this.controller.signal }; }
  current(job) { return job.revision === this.revision && !job.signal.aborted; }
}
export function safeUrl(value) {
  try { const u = new URL(value); return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password ? u.href : null; }
  catch { return null; }
}
export function sourceAnchor(sourceId) {
  const id = 'source-' + sourceId;
  return { id, href: '#' + encodeURIComponent(id) };
}
