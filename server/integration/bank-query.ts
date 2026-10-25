import type { Json } from "../types.js";
/** Stable query uses the event body and only relevant business channels, not company secrets or IDs. */
export function bankQuery(event: Json, profile: Json): string {
  const topics: Record<string, string> = { rate_change: "ключевая ставка", fx_change: "валютный курс", trade_restriction: "внешняя торговля", commodity_price_change: "сырьевые цены", tax_change: "налоги" };
  const channels: string[] = [topics[event.event_type] ?? ""];
  if (event.event_type === "rate_change") {
    if (["loan", "leasing", "factoring"].some(key => profile.bank_products?.[key] === true)) channels.push("финансирование кредит");
    if (profile.bank_products?.deposit === true) channels.push("депозиты ликвидность");
  }
  const excerpt = String(event.text ?? "").replace(/\s+/g, " ").slice(0, 160);
  return [String(event.title).slice(0, 220), excerpt, ...channels].filter(Boolean).join(" ").slice(0, 500);
}
