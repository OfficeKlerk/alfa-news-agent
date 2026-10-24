/** Keep a qualification local: a warning before "но" cannot license the next assertion. */
export function assertionClauses(text: string): string[] {
  return text.split(/(?<=[.!?;])\s+|\n|\s*,?\s+(?:но|однако|зато|тем не менее)\s+/iu);
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

/** Recognize explicit snapshot statements, not balances or contract existence. */
export function productMark(text: string, product: string): boolean | undefined {
  const local = text.split(/[,;\n]/).find(part => aliases[product].test(part) && /отмечен[а-яё]*/iu.test(part));
  if (local) text = local;
  const assignment = new RegExp(`(?<![a-z_])${product}\\s*=\\s*(true|false|0|1)\\b`, "iu").exec(text);
  if (assignment) return /^(true|1)$/i.test(assignment[1]);
  if (/(?:отсутству[а-яё]*|нет)\s+отметк[а-яё]*|не\s+отмечен[а-яё]*|отметк[а-яё]*[^.!?;]{0,30}отсутству[а-яё]*/iu.test(text)) return false;
  if (/отмечен[а-яё]*/iu.test(text)) return true;
  return undefined;
}
