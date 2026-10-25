/** Topic classification, not legal applicability, company activity or a learned coefficient. */
export const SUBJECT_TAXONOMY_VERSION = "business-subjects-v1";
const SUBJECT_RULES: { phrase: RegExp; prefixes: string[] }[] = [
  // Broad subject matches identify a sector, never a company's contracts or legal scope.
  { phrase: /(?:транспортн[а-я]*\s+(?:бюджет[а-я]*|систем[а-я]*|комплекс[а-я]*|отрасл[а-я]*|инфраструктур[а-я]*)|развитие\s+транспорта)/i, prefixes: ["49", "50", "51", "52"] },
  { phrase: /электроэнергетик[а-я]*/i, prefixes: ["35"] },
  { phrase: /(?<![а-я])(?:зерн(?:о|а|у|ом|е|ов[а-я]*)(?![а-я])|пшениц[а-я]*|кукуруз[а-я]*|ячмен[а-я]*)/i, prefixes: ["01.11", "46.21"] },
  { phrase: /(?:удобрени[а-я]*|удобрен[а-я]*)/i, prefixes: ["20.15", "46.75"] },
  { phrase: /(?:генерирующ[а-я]*\s+(?:оборудован[а-я]*|мощност[а-я]*|объект[а-я]*)|производств[а-я]*\s+электроэнергии|(?<![а-я])(?:гидро|тепло)?электростанци[а-я]*|электроэнергетическ[а-я]*\s+генераци[а-я]*)/i, prefixes: ["35.11"] },
  { phrase: /(?:электрическ[а-я]*\s+сет[а-я]*|электросет[а-я]*|передач[а-я]*\s+электроэнергии|линий?\s+электропередачи)/i, prefixes: ["35.12", "35.13"] },
  { phrase: /(?:автомобильн[а-я]*\s+(?:транспорт[а-я]*|перевоз[а-я]*)|автоперевоз[а-я]*)/i, prefixes: ["49.3", "49.4"] },
  { phrase: /(?:дорожн[а-я]*\s+хозяйств[а-я]*|строительств[а-я]*\s+автомобильных\s+дорог)/i, prefixes: ["42.11"] },
  { phrase: /(?:(?:морск[а-я]*|речн[а-я]*)\s+(?:суд[а-я]*|транспорт[а-я]*)|судоходств[а-я]*|внутренн[а-я]*\s+водн[а-я]*\s+транспорт[а-я]*)/i, prefixes: ["50"] },
  { phrase: /(?<![а-я])(?:гостиниц[а-я]*|отел[ьяейями]*|услуг[а-я]*\s+(?:временного\s+)?размещени[а-я]*)/i, prefixes: ["55.1"] },
  { phrase: /(?<![а-я])(?:ИТ[-\s]+(?:организаци[а-я]*|компани[а-я]*)|разработк[а-я]*\s+программного\s+обеспечения)/i, prefixes: ["62"] },
  { phrase: /(?:музе[йяеию][а-я]*|музейн[а-я]*)/i, prefixes: ["91.02"] },
  { phrase: /(?:выставк[а-я]*|выставочн[а-я]*)/i, prefixes: ["82.30"] },
  { phrase: /(?:бензин[а-я]*|дизельн[а-я]*\s+топлив[а-я]*|газойл[а-я]*|судов[а-я]*\s+топлив[а-я]*)/i, prefixes: ["19.20", "46.71"] },
];

export function classifyBusinessSubjects(quote: string): string[] {
  return [...new Set(SUBJECT_RULES.filter(rule => rule.phrase.test(quote)).flatMap(rule => rule.prefixes))].sort();
}

export function generalTaxScope(text: string): boolean {
  return /(?:основн[а-я]*\s+ставк[а-я]*\s+НДС|общ[а-я]*\s+ставк[а-я]*\s+НДС|для\s+всех\s+(?:организаци[а-я]*|налогоплательщик[а-я]*))/i.test(text);
}

/** Ceremonial reports mention industries without announcing business exposure. */
export function ceremonialReport(title: string): boolean {
  return /(?:вручил[аи]?\s+(?:[а-я]+\s+){0,3}наград|наградил[аи]?|награждени[а-я]*\s+(?:работник|сотрудник|ветеран|победител)|поздравил[аи]?\s|отметил[аи]?\s+(?:\d+[ -])?летн[а-я]*\s+юбилей|торжеств[а-я]*\s+(?:вручени[а-я]*|награждени[а-я]*))/i.test(title);
}
