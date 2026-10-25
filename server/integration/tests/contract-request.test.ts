import assert from "node:assert/strict";
import { test } from "node:test";
import { profileFactRules } from "../profile-facts.js";
import { evaluationCases } from "../evaluation.js";

test("real public-chat modal requests do not become contract-existence assertions", () => {
  const input = evaluationCases()[0].input;
  for (const prefix of ["Нужно уточнить", "Необходимо уточнить", "Необходимо запросить", "Нужно запросить", "Следует выяснить", "Следует проверить", "Для оценки влияния решения Банка России на компанию нужно уточнить"])
    assert.deepEqual(profileFactRules(prefix + " условия действующих кредитных договоров и параметры потенциального нового финансирования.", input), []);
  assert.ok(profileFactRules("Условия действующих кредитных договоров изменились.", input).includes("Product flags do not establish debt or contract terms"));
  input.profile.bank_products.loan = false;
  assert.ok(profileFactRules("Нужно уточнить условия действующих договоров. В профиле loan=true.", input).includes("Product mark contradicts the snapshot"));
  assert.ok(profileFactRules("Нужно уточнить условия действующих договоров, однако компания использует лизинг.", input).includes("Product flags do not establish debt or contract terms"));
});
