/** Keep a qualification local: a warning before "но" cannot license the next assertion. */
export function assertionClauses(text: string): string[] {
  const sentences = text.split(/(?<=[.!?;])\s+|\n|\s*,?\s+(?:но|однако|зато|тем не менее)\s+/iu);
  // Split independent subject/predicate pairs, but preserve shared predicates
  // ("кредит и лизинг не отмечены") and the scope of conditional statements.
  const boundary = /(?:,\s*|\s+(?:и|а|либо)\s+)(?=(?:(?:в\s+(?:снимке|профиле|данных)|у\s+компании)\s+)?(?:отметк[а-яё]*|отмечен[а-яё]*|кредитн[а-яё]*\s+продукт|продукт\s+(?:кредитования|лизинга)|лизинг|депозит|факторинг|рко|расч[её]тно[- ]кассов|банковск[а-яё]*\s+гаранти|гаранти|зарплатн[а-яё]*\s+проект|loan|leasing|deposit|factoring|rko|guarantee|payroll|входящ|исходящ|поступлен))/giu;
  const predicate = /отмечен|отсутству|наблюда|имеются|зафиксирован|равны\s+нулю|(?:^|\s)(?:нет|есть)(?:\s|$)|(?:true|false|[01])\s*$/iu;
  return sentences.flatMap(sentence => {
    if (qualifiedAssertion(sentence)) return [sentence];
    const parts: string[] = []; let start = 0;
    for (const match of sentence.matchAll(boundary)) {
      if (!predicate.test(sentence.slice(start, match.index))) continue;
      parts.push(sentence.slice(start, match.index)); start = match.index! + match[0].length;
    }
    parts.push(sentence.slice(start)); return parts;
  });
}

export function qualifiedAssertion(clause: string): boolean {
  return /(?:^|[\s,])если\s|^\s*(?:при условии|уточни[а-яё]*|провер[а-яё]*)(?=\s|[,:]|$)|^\s*не\s+(?:подтвержд[а-яё]*|установлен[а-яё]*|доказан[а-яё]*)\s*,?\s*что\s|не\s+(?:означает|доказывает|следует)|нельзя\s+(?:утверждать|считать)|нет\s+оснований\s+утверждать/iu.test(clause);
}

const aliases: Record<string, RegExp> = {
  rko: /(?<![\p{L}_])(?:rko|рко)(?![\p{L}_])|расч[её]тно[- ]кассов/iu,
  guarantee: /(?<![\p{L}_])guarantee(?![\p{L}_])|гаранти[а-яё]*/iu,
  loan: /(?<![\p{L}_])loan(?![\p{L}_])|кредитн[а-яё]*\s+продукт[а-яё]*|продукт[а-яё]*\s+кредитован[а-яё]*|(?:отметк[а-яё]*|отмечен[а-яё]*)\s+(?:по\s+)?кредит[а-яё]*/iu,
  leasing: /(?<![\p{L}_])leasing(?![\p{L}_])|лизинг[а-яё]*/iu,
  deposit: /(?<![\p{L}_])deposit(?![\p{L}_])|депозит[а-яё]*/iu,
  payroll: /(?<![\p{L}_])payroll(?![\p{L}_])|зарплатн[а-яё]*\s+проект[а-яё]*/iu,
  factoring: /(?<![\p{L}_])factoring(?![\p{L}_])|факторинг[а-яё]*/iu,
};
export function mentionedProducts(text: string): string[] {
  return Object.entries(aliases).filter(([, re]) => re.test(text)).map(([key]) => key);
}

const productSubject = new RegExp(Object.values(aliases).map(re => `(?:${re.source})`).join("|"), "iu");
const productPredicate = /отмечен[а-яё]*|отсутству[а-яё]*|(?<![\p{L}])нет(?![\p{L}])|=\s*(?:true|false|0|1)\b/iu;

/** Recognize explicit snapshot statements, not balances or contract existence. */
export function productMark(text: string, product: string): boolean | undefined {
  const alias = aliases[product];
  if (!alias) return undefined;
  const local = subjectAssertions(text, productSubject, productPredicate)
    .find(part => alias.test(part) && productPredicate.test(part));
  if (!local) return undefined;
  text = local;
  const assignment = new RegExp(`(?<![a-z_])${product}\\s*=\\s*(true|false|0|1)\\b`, "iu").exec(text);
  if (assignment) return /^(true|1)$/i.test(assignment[1]);
  if (/(?:отсутству[а-яё]*|нет)\s+отметк[а-яё]*|не\s+отмечен[а-яё]*|отметк[а-яё]*[^.!?;]{0,30}(?:отсутству[а-яё]*|(?<![\p{L}])нет(?![\p{L}]))/iu.test(text)
    || /(?:—|–|-)\s*нет[.!?]?\s*$/iu.test(text)) return false;
  if (/отмечен[а-яё]*/iu.test(text)) return true;
  return undefined;
}

export function subjectAssertions(text: string, subject: RegExp, predicate: RegExp): string[] {
  const parts: string[] = [];
  let start = 0;
  for (const boundary of text.matchAll(/[,;\n]|\s+(?:и|а|но|однако|зато)\s+/giu)) {
    const left = text.slice(start, boundary.index), right = text.slice(boundary.index + boundary[0].length);
    if (subject.test(left) && predicate.test(left) && subject.test(right) && predicate.test(right)) {
      parts.push(left);
      start = boundary.index + boundary[0].length;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

