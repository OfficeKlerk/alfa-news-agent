import type { Json } from "../types.js";
import { assertionClauses, qualifiedAssertion, mentionedProducts, productMark } from "./assertion-language.js";

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

/** REPORT7/8 null control: null is an unknown value, never "no mark". Checked in every text, including
 * conditions and warnings: "…не доказывает отсутствие обязательств" qualifies the inference, not the misread premise. */
export function nullMarkRules(text: string, input: Json): string[] {
  const values = input.profile?.bank_products ?? {};
  for (const clause of assertionClauses(text)) {
    if (/если\s+бы/iu.test(clause)) continue;
    if (/(?<!не\s)(?:null|unknown)\s*(?:[—=-]\s*)?(?:означает|значит|это|равно|равен)\s+(?:отсутстви[а-яё]*|нет)\s+отметк/iu.test(clause))
      return ["Unknown product flag must remain unknown"];
    const absence = /(?:отсутстви[а-яё]*|отсутству[а-яё]*|нет)\s+((?:[а-яё]+\s+){0,2}?)отметк[а-яё]*|отметк[а-яё]*[^.!?;]{0,30}отсутству[а-яё]*|не\s+отмечен[а-яё]*/iu.exec(clause);
    // A plain hypothetical ("Если в снимке отсутствуют отметки…") stays allowed; the definition above does not.
    if (!absence || /данн|сведени|информаци/iu.test(absence[1] ?? "") || /(?:^|[\s,])если\s/iu.test(clause.slice(0, absence.index))) continue;
    // "null не означает отсутствие отметки" and "неизвестность, а не отсутствие отметки" are correct.
    if (/(?:не\s+(?:означа|явля|равн|знач|следует)[а-яё]*|нельзя\s+[а-яё]+|а\s+не|вместо)\s+(?:[а-яё]+\s+)?$/iu.test(clause.slice(0, absence.index))) continue;
    const named = mentionedProducts(clause);
    const all = Object.values(values);
    if (named.some(product => unknown(values[product])) || !named.length && /продукт/iu.test(clause) && all.length && all.every(unknown))
      return ["Unknown product flag must remain unknown"];
  }
  return [];
}

/** Targeted regressions for observed misreadings; not a general semantic verifier.
 * Called only for generated prose; literal fact/bank quotes are excluded upstream. */
export function profileFactRules(text: string, input: Json): string[] {
  const issues = new Set<string>(nullMarkRules(text, input)), profile = input.profile;
  const payment = profile.payment_summary ?? {}, trade = profile.foreign_trade ?? {};
  for (const clause of assertionClauses(text)) {
    // Conditional scenarios, questions and explicit warnings do not assert a fact.
    if (qualifiedAssertion(clause) || /^\s*неизвест[а-яё]*(?=\s|[,:]|$)/iu.test(clause)) continue;
    const absence = /(?:нет|не\s+имеет|отсутству[а-яё]*|не\s+использует)\s+(?:(?:всех|никаких|действующих|кредитных|долговых)\s+){0,3}(?:долг|кредит(?![а-яё]*\s+продукт)|займ|за[её]м|обязательств)|(?:долг[а-яё]*|кредит[а-яё]*|займ[а-яё]*|за[её]м[а-яё]*|обязательств[а-яё]*)\s+(?:(?:у\s+компании|полностью)\s+)?отсутству[а-яё]*/iu.test(clause);
    const marked = /(?:в\s+(?:профиле|снимке)|отметк|отмечен|флаг)/iu.test(clause);
    const inferredObligation = /(?<!не\s+)(?:указыв[а-яё]*|означа[а-яё]*|подтвержда[а-яё]*|свидетельству[а-яё]*|подразумева[а-яё]*|предполага[а-яё]*)[^.!?;]{0,50}(?:обязательств|долг|действующ[а-яё]*\s+договор|наличи[а-яё]*\s+договорн[а-яё]*\s+экспозиц)/iu.test(clause);
    const noTrade = /внешнеторгов[а-яё]*\s+деятельност[а-яё]*\s+(?:не\s+вед[а-яё]*|не\s+осуществля[а-яё]*|отсутству[а-яё]*)|(?:нет|отсутствует)\s+внешнеторгов[а-яё]*\s+деятельност[а-яё]*|(?:не\s+вед[а-яё]*|не\s+осуществля[а-яё]*)\s+внешнеторгов[а-яё]*\s+деятельност[а-яё]*/iu.test(clause);
    const assertedDebt = /(?:есть|имеются|имеет|подтвержден[а-яё]*)\s+(?:(?:действующ|лизингов|долгов|кредитн)[а-яё]*\s+){0,3}(?:обязательств|долг|договор)/iu.test(clause);
    if (inferredObligation || assertedDebt) issues.add("Product flags do not establish debt or contract terms");
    if (noTrade) issues.add("Trade flags do not establish direction or payment currency");
    const actualContract = /(?:компания|предприятие|организация)[^.!?;]{0,35}(?:имеет|использует|обслуживает)[^.!?;]{0,35}(?:кредит|лизинг|долг|за[её]м)/iu.test(clause);
    const actualTerms = /(?:договор[а-яё]*|кредит[а-яё]*|лизинг[а-яё]*)[^.!?;]{0,35}(?:имеют|имеет|предусматрива[а-яё]*|привязан[а-яё]*)[^.!?;]{0,30}(?:плавающ|фиксирован|ключев)/iu.test(clause);
    if (absence || (actualContract && !marked) || actualTerms)
      issues.add("Product flags do not establish debt or contract terms");
    // REPORT8 metal-borrower: "использует продукты финансирования (loan, leasing)" turns a mark into usage.
    const usage = /(?<!не\s)(?:использует|пользуется|применяет|обслуживает|привлекает|имеет)\s+((?:[\p{L}\d.,()-]+\s+){0,3}?)(?:продукт[а-яё]*\s+(?:финансирован|кредитован|лизинг)|кредитн[а-яё]*\s+(?:продукт|договор|лини)|кредит(?:ы|ов|ом|ам|а|у)?(?![а-яё])|лизинг|займ|за[её]м|финансировани|loan|leasing|factoring|факторинг)/iu.exec(clause);
    if (usage && !/отметк|отмечен|флаг/iu.test(usage[1])) issues.add("Product flags do not establish debt or contract terms");
    // REPORT8 rate-up-borrower-no-rag: "параметры действующих договоров" presumes contracts that a mark does not show;
    // "действующий договор неизвестен" does not.
    const presumed = /(?:параметр|услови|обслуживани|ставк|срок|остат|тип|чувствительност)[а-яё]*\s+(?:[а-яё]+\s+)?(?:по\s+)?действующ[а-яё]*\s+(?:(?:кредитн|лизингов|долгов)[а-яё]*\s+)?(?:кредит|лизинг|договор|обязательств|займ|за[её]м)/iu.exec(clause);
    // A modal data request has the same meaning as the already permitted imperative
    // "Уточнить условия..."; it does not assert contract existence. Only this
    // presupposition check is exempted; flag contradictions and usage assertions still run.
    const contractRequest = presumed && /(?:нужно|необходимо|следует|требуется)\s+(?:уточнить|проверить|запросить|выяснить|получить)\s*$/iu.test(clause.slice(0, presumed.index));
    if (presumed && !contractRequest && !/наличи|существ|есть\s+ли|при\s+условии/iu.test(clause.slice(0, presumed.index))
      && !/если\s+они\s+(?:есть|существуют|имеются)|при\s+их\s+наличии/iu.test(clause.slice(presumed.index)))
      issues.add("Product flags do not establish debt or contract terms");
    // REPORT8 trade-foreign: an FTS mark is not proven foreign-trade activity.
    if (/(?<!не\s)(?:осуществля[а-яё]*|вед[её]т|занима[а-яё]*с[яь]|участву[а-яё]*\s+в)\s+(?:[а-яё]+\s+)?(?:внешнеторгов|внешнеэкономическ|внешн[а-яё]*\s+торговл|вэд(?![а-яё]))/iu.test(clause))
      issues.add("Trade flags do not establish direction or payment currency");
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
    for (const product of mentionedProducts(clause)) {
      const mark = productMark(clause, product);
      if (mark !== undefined) checkMark(product, mark);
    }
    const direction = /(?:компания|предприятие|организация)\s+(?:является\s+)?(?:импорт[её]р|экспорт[её]р|импортирует|экспортирует)|компания\s+осуществляет\s+(?:импорт|экспорт)/iu.test(clause);
    const noCurrency = /(?:нет|отсутству[а-яё]*|не\s+имеет)\s+валютн[а-яё]*\s+(?:плат[её]ж|операци|расч[её]т)|валютн[а-яё]*\s+(?:плат[её]ж[а-яё]*|операци[а-яё]*|расч[её]т[а-яё]*)\s+(?:(?:у\s+компании|полностью)\s+)?отсутству[а-яё]*/iu.test(clause);
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
