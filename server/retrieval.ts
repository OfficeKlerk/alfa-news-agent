import type { Store } from "./db.js";
import type { Company, News, Json } from "./types.js";
import { newsArticlesAsOf, normalizePublicationDate } from "./news-events.js";
const THEMES: Record<string, string[]> = {
  rates: ["ставк", "кредит", "долг", "финансирован", "облигац", "лизинг", "денежно"],
  trade: ["импорт", "экспорт", "валют", "тамож", "логист", "постав", "внешнеторгов"],
  inflation: ["инфляц", "цен", "издерж", "себестоим", "затрат"],
  consumer: ["потреблен", "рознич", "спрос", "доход", "торгов"],
  metals: ["металл", "сталь", "золот", "сырь", "добыч", "руда"],
  labor: ["труд", "кадр", "зарплат", "работник", "безработ"],
  construction: ["строй", "строит", "недвиж", "ипотек", "жиль"],
  it: ["программ", "компьютер", "цифров", "информацион", "технолог"],
};
export const tokens = (text: string): string[] => (text.toLowerCase().match(/[а-яёa-z0-9]{3,}/g) ?? []).map((x) => x.slice(0, 7));
export const tags = (text: string): string[] =>
  Object.entries(THEMES)
    .filter(([, stems]) => stems.some((s) => text.toLowerCase().includes(s)))
    .map(([key]) => key);
const intersection = (a: Iterable<string>, b: Iterable<string>) => {
  const right = new Set(b);
  return [...new Set(a)].filter((x) => right.has(x));
};
export class Retrieval {
  constructor(private db: Store) {}
  research(query: string, limit = 5, asOf?: string): Json[] {
    const words = tokens(query),
      themes = tags(query),
      chunks: Json[] = [];
    for (const row of this.db.all("SELECT payload FROM research")) {
      const doc = JSON.parse(row.payload);
      if (asOf) {
        const publishedAt = normalizePublicationDate(doc.published_at ?? doc.published ?? doc.date).value;
        if (!publishedAt || Date.parse(publishedAt) > Date.parse(asOf)) continue;
      }
      for (let start = 0; start < doc.text.length; start += 1400) {
        const text = doc.text.slice(Math.max(0, start - 150), start + 1600),
          terms = new Set(tokens(text));
        const score =
          intersection(words, terms).length / Math.sqrt(Math.max(1, terms.size)) + 0.3 * intersection(themes, tags(text)).length;
        if (score > 0)
          chunks.push({
            ...doc,
            id: doc.id + ":c" + start,
            text,
            score: Math.round(score * 1000) / 1000,
          });
      }
    }
    chunks.sort((a, b) => b.score - a.score);
    // Show the strongest matching chunk from each document before extra context.
    // This ordering is independent of limit, so a larger request preserves its prefix.
    if (limit <= 0) return [];
    const pages = new Map<string, number>(),
      documents = new Set<string>(),
      selected = new Set<string>(),
      out: Json[] = [];
    const documentKey = (doc: Json) => doc.document_id ?? doc.filename ?? doc.id.split(":c")[0];
    const append = (doc: Json) => {
      const page = JSON.stringify([documentKey(doc), doc.page]),
        count = pages.get(page) ?? 0;
      if (selected.has(doc.id) || count >= 2) return;
      out.push(doc);
      selected.add(doc.id);
      pages.set(page, count + 1);
    };
    for (const doc of chunks) {
      const key = documentKey(doc);
      if (documents.has(key)) continue;
      documents.add(key);
      append(doc);
      if (out.length >= limit) return out;
    }
    // Small corpora still provide additional chunks, with at most two per page.
    for (const doc of chunks) {
      append(doc);
      if (out.length >= limit) break;
    }
    return out;
  }
  rank(company: Company, news: News) {
    const interest = new Set(tags(company.industry));
    if (company.foreign_trade) interest.add("trade");
    if (company.products.some((p) => ["Кредиты", "Лизинг", "Депозиты"].includes(p))) interest.add("rates");
    interest.add("inflation");
    for (const partner of company.top_partners) for (const theme of tags(partner.industry)) interest.add(theme);
    const match = new Set(intersection(interest, news.tags)),
      reasons: string[] = [];
    if (match.has("rates"))
      reasons.push(
        "Есть продукты, чувствительные к условиям финансирования: " +
          company.products.filter((p) => ["Кредиты", "Лизинг", "Депозиты"].includes(p)).join(", "),
      );
    if (match.has("trade") && company.foreign_trade) reasons.push("В данных компании есть признак внешнеторговой деятельности");
    if (intersection(match, tags(company.industry)).length) reasons.push("Тема связана с видом деятельности компании");
    if (company.top_partners.some((p) => intersection(tags(p.industry), news.tags).length))
      reasons.push("Тема связана с отраслью одного из платёжных контрагентов; характер поставок неизвестен");
    if (!reasons.length) reasons.push("Общий макроэкономический контекст; прямое влияние пока не подтверждено");
    const relevance = Math.min(
      95,
      20 + match.size * 18 + Number(match.has("rates")) * 8 + Number(match.has("trade") && company.foreign_trade) * 12,
    );
    return {
      ...news,
      relevance,
      reasons,
      priority: relevance >= 60 ? "Высокий" : relevance >= 38 ? "Средний" : "Низкий",
    };
  }
  feed(id: string, includeDemo = true) {
    const company = this.db.company(id);
    return newsArticlesAsOf(this.db, new Date().toISOString())
      .filter((n) => includeDemo || !n.is_demo)
      .filter(n => { const published = normalizePublicationDate(n.published).value; return published !== null && Date.parse(published) <= Date.now() && (!n.available_at || Date.parse(n.available_at) <= Date.now()) && (n.is_demo || Boolean(n.url)); })
      .sort((a, b) => Date.parse(normalizePublicationDate(b.published).value!) - Date.parse(normalizePublicationDate(a.published).value!))
      .slice(0, 200)
      .map((n) => this.rank(company, n))
      .sort((a, b) => b.relevance - a.relevance || a.id.localeCompare(b.id));
  }
}
