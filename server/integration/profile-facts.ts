import type { Json } from "../types.js";

const unknown = (value: unknown) => value === null || value === undefined || value === "unknown" || value === "" || Array.isArray(value) && value.length === 0;
const products = ["rko", "guarantee", "loan", "leasing", "deposit", "payroll", "factoring"] as const;

/** Interpret source fields, never infer balances, contracts, currencies or trade routes. */
export function profileFacts(input: Json) {
  const profile = input.profile, payment = profile.payment_summary ?? {}, trade = profile.foreign_trade ?? {};
  return {
    products: products.map(product => {
      const value = profile.bank_products?.[product];
      return { path: "/bank_products/" + product, value: unknown(value) ? null : value,
        state: value === true ? "marked_in_snapshot" : value === false ? "unmarked_in_snapshot" : "unknown" };
    }),
    trade: { has_fts: trade.has_fts ?? null, direction: trade.trade_direction ?? null, currencies: trade.currencies ?? null },
    payments: { currency: payment.currency ?? null, period: payment.period ?? null,
      incoming_amount: payment.incoming_amount ?? null, outgoing_amount: payment.outgoing_amount ?? null },
    rules: [
      "true — отметка продукта в снимке; false — известное отсутствие отметки; null/unknown — неизвестное значение, не false и не ноль.",
      "Ни один флаг не подтверждает действующий договор, размер долга, валюту, тип ставки или отсутствие всех обязательств. Пиши: «В снимке отмечен продукт лизинга», а не «Компания использует действующий лизинг».",
      "has_fts=false не доказывает отсутствия валютных платежей; has_fts=true и страны не устанавливают импорт/экспорт, маршруты и валюты. Используй отдельные поля direction/currencies; неизвестные сохраняй неизвестными.",
      "Неизвестные валюта, период и суммы платежей не становятся рублями, годом или нулём. Известный числовой ноль остаётся нулём; не заменяй его неизвестностью.",
    ],
  };
}

/** Targeted regressions for observed misreadings; not a general semantic verifier.
 * Called only for generated prose; literal fact/bank quotes are excluded upstream. */
export function profileFactRules(text: string, input: Json): string[] {
  const issues = new Set<string>(), profile = input.profile;
  const payment = profile.payment_summary ?? {}, trade = profile.foreign_trade ?? {};
  for (const clause of text.split(/(?<=[.!?;])\s+|\n/)) {
    // Conditional scenarios, questions and explicit warnings do not assert a fact.
    if (/(?:^|[\s,])если\s|^\s*(?:при условии|уточни[а-яё]*|провер[а-яё]*|неизвест[а-яё]*)(?=\s|[,:]|$)|не\s+(?:означает|доказывает|следует)|нельзя\s+(?:утверждать|считать)|не\s+подтвержд[а-яё]*/iu.test(clause)) continue;
    const absence = /(?:нет|не\s+имеет|отсутству[а-яё]*|не\s+использует)\s+(?:(?:всех|никаких|действующих|кредитных|долговых)\s+){0,3}(?:долг|кредит(?![а-яё]*\s+продукт)|займ|за[её]м|обязательств)/iu.test(clause);
    const marked = /(?:в\s+(?:профиле|снимке)|отметк|отмечен|флаг)/iu.test(clause);
    const actualContract = /(?:компания|предприятие|организация)[^.!?;]{0,35}(?:имеет|использует|обслуживает)[^.!?;]{0,35}(?:кредит|лизинг|долг|за[её]м)/iu.test(clause);
    const actualTerms = /(?:договор[а-яё]*|кредит[а-яё]*|лизинг[а-яё]*)[^.!?;]{0,35}(?:имеют|имеет|предусматрива[а-яё]*|привязан[а-яё]*)[^.!?;]{0,30}(?:плавающ|фиксирован|ключев)/iu.test(clause);
    if (absence || (actualContract && !marked) || actualTerms)
      issues.add("Product flags do not establish debt or contract terms");
    const checkMark = (product: string, asserted: boolean) => {
      const value = profile.bank_products?.[product];
      if (unknown(value)) issues.add("Unknown product flag must remain unknown");
      else if (value !== asserted) issues.add("Product mark contradicts the snapshot");
    };
    for (const product of products) {
      const assignment = new RegExp(`(?<![a-z_])${product}\\s*=\\s*(true|false|0|1)\\b`, "giu");
      for (const match of clause.matchAll(assignment)) checkMark(product, /^(?:true|1)$/i.test(match[1]));
    }
    const loanMark = /кредитный\s+продукт\s+(не\s+)?отмечен/iu.exec(clause);
    const leasingMark = /(?:продукт\s+лизинга|лизинг)\s+(не\s+)?отмечен/iu.exec(clause);
    if (loanMark) checkMark("loan", !loanMark[1]);
    if (leasingMark) checkMark("leasing", !leasingMark[1]);
    const direction = /(?:компания|предприятие|организация)\s+(?:является\s+)?(?:импорт[её]р|экспорт[её]р|импортирует|экспортирует)|компания\s+осуществляет\s+(?:импорт|экспорт)/iu.test(clause);
    const noCurrency = /(?:нет|отсутству[а-яё]*|не\s+имеет)\s+валютн[а-яё]*\s+(?:плат[её]ж|операци|расч[её]т)/iu.test(clause);
    if (unknown(trade.trade_direction) && direction || unknown(trade.currencies) && unknown(payment.currency) && noCurrency)
      issues.add("Trade flags do not establish direction or payment currency");
    const currency = /(?:плат[её]ж[а-яё]*|расч[её]т[а-яё]*|операци[а-яё]*)[^.!?;]{0,25}(?:в|только\s+в|исключительно\s+в)\s+(?:рубл|доллар|евро|юан)/iu.test(clause);
    const period = /годов[а-яё]*\s+(?:плат[её]ж|поступлен)|(?:плат[её]ж|поступлен)[^.!?;]{0,25}за\s+(?:год|месяц|квартал)/iu.test(clause);
    const incomingZero = /входящ[а-яё]*\s+плат[её]ж[а-яё]*\s+(?:равны\s+нулю|отсутствуют)/iu.test(clause);
    const outgoingZero = /исходящ[а-яё]*\s+плат[её]ж[а-яё]*\s+(?:равны\s+нулю|отсутствуют)/iu.test(clause);
    if (unknown(payment.currency) && currency || unknown(payment.period) && period
      || unknown(payment.incoming_amount) && incomingZero || unknown(payment.outgoing_amount) && outgoingZero)
      issues.add("Unknown payment metadata must remain unknown");
  }
  return [...issues];
}
