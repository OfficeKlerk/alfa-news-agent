import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluationCases, referenceDraft } from "../evaluation.js";
import { prepareContext } from "../context.js";
import { hasFinancialFigure, validateGrounding, validateQuestionGrounding } from "../grounding.js";

function transportCase(code = "49.42") {
  const scenario = evaluationCases()[0];
  Object.assign(scenario.input.profile.industry, {
    okved_code: code, okved_division: code.slice(0, 2), name: "Предоставление услуг по перевозкам",
  });
  const draft = referenceDraft(scenario);
  // A mechanical fixture for the observed false positive, not a claim about public funding.
  const text = `Компания работает в отрасли (ОКВЭД ${code}), финансируемой из бюджета. Применимость требует проверки.`;
  draft.claims[1].text = draft.why_relevant = text;
  draft.claims[1].profile_paths = ["/industry/okved_code"];
  draft.recommendations = [];
  draft.grounding.recommendations = [];
  return { draft, context: prepareContext(scenario.input) };
}

test("grounding accepts the observed OKVED 49.42 false positive in a claim and section", () => {
  const { draft, context } = transportCase();
  validateGrounding(draft, context);
  draft.limitations.push("ОКВЭД 49.42 не доказывает получение финансирования.");
  validateGrounding(draft, context);
  validateQuestionGrounding({ answer: draft.why_relevant, claims: draft.claims,
    claim_indexes: [0, 1], limitations: draft.limitations, missing_data: draft.missing_data }, context);
});

test("grounding accepts a full multi-part OKVED only through its selected code field", () => {
  const { draft, context } = transportCase("46.69.9");
  validateGrounding(draft, context);
  draft.claims[1].profile_paths = ["/industry/name"];
  assert.throws(() => validateGrounding(draft, context), /Unsupported numeric assertion/);
});

test("code-looking numbers from an untyped field do not gain a financial exemption", () => {
  const { draft, context } = transportCase();
  context.input.profile.industry.name = "Перевозки, ОКВЭД 49.42";
  draft.claims[1].profile_paths = ["/industry/name"];
  assert.throws(() => validateGrounding(draft, context), /AI financial figures/);
});

test("unverified OKVED and financial reuse of a code stay blocked", () => {
  const { draft, context } = transportCase();
  draft.claims[1].text = draft.why_relevant = "Компания работает в отрасли (ОКВЭД 49.43), финансируемой из бюджета.";
  assert.throws(() => validateGrounding(draft, context), /Unsupported numeric assertion/);
  draft.claims[1].text = draft.why_relevant = "Компания потеряет 49.42% выручки (ОКВЭД 49.42).";
  assert.throws(() => validateGrounding(draft, context), /AI financial figures/);
  draft.claims[1].text = draft.why_relevant = "Компания потеряет 14% выручки.";
  assert.throws(() => validateGrounding(draft, context));
});

test("only a complete labelled and verified classification code is exempt", () => {
  for (const [code, label] of [["49", "ОКВЭД"], ["49.42", "ОКВЭД:"], ["46.69.9", "OKVED"]]) {
    assert.equal(hasFinancialFigure(`Код ${label} ${code}, финансирование требует проверки.`, [code]), false);
  }
  for (const text of [
    "Расходы (ОКВЭД 49.43) требуют проверки.",
    "Расходы (ОКВЭД 49.42.1) требуют проверки.",
    "Расходы (псевдоОКВЭД 49.42) требуют проверки.",
    "Расходы 49.42 требуют проверки.",
    "Потери ОКВЭД 49.42 млн рублей.",
    "Расходы ОКВЭД 49.42,1 требуют проверки.",
  ]) assert.equal(hasFinancialFigure(text, ["49.42"]), true, text);
  assert.equal(hasFinancialFigure("ОКВЭД 49.42, финансируемая отрасль."), true);
});

test("verified OKVED cannot hide money, percentages, rates or unsupported dates", () => {
  for (const text of [
    "ОКВЭД 49.42, компания потеряет 14% выручки.",
    "ОКВЭД 49.42, компания потеряет 49.42% выручки.",
    "ОКВЭД 49.42, расходы 49.42 рубля.",
    "ОКВЭД 49.42, ставка вырастет на 25 б.п.",
    "ОКВЭД 49.42, потери 100000.",
    "ОКВЭД 49.42% выручки.",
    "ОКВЭД 49.42, расходы к 2037 году.",
  ]) assert.equal(hasFinancialFigure(text, ["49.42"]), true, text);
  const { draft, context } = transportCase();
  draft.claims[1].text = draft.why_relevant = "ОКВЭД 49.42, применимость к 2037 году требует проверки.";
  assert.throws(() => validateGrounding(draft, context), /Unsupported numeric assertion/);
});
