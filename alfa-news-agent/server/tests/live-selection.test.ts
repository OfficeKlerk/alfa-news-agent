import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Json } from '../types.js';
import { articleToEvent } from '../news-events.js';
import { selectReason } from '../integration/live-selection.js';

const profile = (overrides: Json = {}): Json => ({ company_id: 'U1', industry: { okved_code: '46.21', okved_division: '46' }, bank_products: { loan: true, leasing: false, deposit: false, factoring: false }, foreign_trade: { has_fts: true, countries: ['ИНДИЯ'] }, geography: { region: 'Ростовская область' }, ...overrides });
const filler = 'Публикация содержит описание принятого решения и условий его применения. Компаниям необходимо проверить относящиеся к ним условия и сведения о действующих договорах.';
function event(title: string, body: string, overrides: Json = {}): Json {
  return articleToEvent({ id: 'news-1', title, text: body + ' ' + filler, published: '2026-10-23T10:30:00Z', url: 'https://example.org/article', is_demo: false, content_scope: 'article_full', ...overrides })!;
}
function ranked(item: Json, features: Record<string, number> = {}, score = 0.8): Json {
  return { news_id: item.news_id, event_id: item.event_id, score, score_kind: 'manual_feature_baseline', feature_contributions: Object.entries(features).map(([feature, value]) => ({ feature, value, source_ids: item.sources.map((source: Json) => source.id), profile_paths: [], coefficient: 1, contribution: value, scale: 'raw_score' })) };
}
const rateTitle = 'Банк России принял решение сохранить ключевую ставку на уровне 14,00% годовых';

test('official CBR key-rate hold is useful for an unfinanced company even below the score threshold', () => {
  const item = event(rateTitle, rateTitle + '. ' + filler, { url: 'https://www.cbr.ru/press/PR/?file=23102026_133000key.htm' });
  const noFinance = profile({ industry: { okved_code: '35.11', okved_division: '35' }, bank_products: { loan: false, leasing: false, deposit: false, factoring: false } });
  assert.deepEqual(selectReason(item, ranked(item, { freshness: 0.8 }, 0.08), noFinance, 0.2), { eligible: true, reason: 'official_key_rate_context_for_all_companies' });
});

test('a press announcement embedded as a secondary cluster source retains universal CBR evidence', () => {
  const item = event('Ставка регулятора сохранена', rateTitle + '.', { url: 'https://publisher.example.org/news' });
  item.sources.push({ ...item.sources[0], id: 'official-source', url: 'https://www.cbr.ru/press/PR/', excerpt: rateTitle + '.' });
  item.content.warnings = ['cluster_has_partial_secondary_sources'];
  assert.equal(selectReason(item, ranked(item, {}, 0.08), profile(), 0.2).reason, 'official_key_rate_context_for_all_companies');
});

test('a fake official hostname and generic rate mentions do not become universal news', () => {
  const item = event(rateTitle, rateTitle + '.', { url: 'https://cbr.ru.fake.example/press/' });
  const noFinance = profile({ bank_products: { loan: false, leasing: false, deposit: false, factoring: false } });
  assert.equal(selectReason(item, ranked(item, {}, 0.08), noFinance, 0.2).eligible, false);
  const coins = event('Банк России выпустил памятную монету', 'Банк России выпустил памятную монету. В заметке также упоминается ключевая ставка как справочный термин.', { url: 'https://www.cbr.ru/press/PR/coins' });
  assert.equal(selectReason(coins, ranked(coins, {}, 0.9), noFinance, 0.2).eligible, false);
});

test('real regression: analyst stock forecast cannot borrow relevance from an incidental historical rate decision', () => {
  const item = event('«Бычьи» сигналы: аналитики спрогнозировали рост российского рынка акций',
    'Аналитики ожидают улучшения биржевой ситуации на следующей неделе. Оценка является прогнозом. ' + rateTitle + '. Компании пересмотрели инвестиционные планы.');
  assert.equal(item.event_type, 'rate_change');
  assert.deepEqual(selectReason(item, ranked(item, { rate_financing: 1 }, 1), profile(), 0.2), { eligible: false, reason: 'forecast_or_proposal_requires_review' });
});

test('a confirmed rate mentioned deep in another article is background, not a fresh financial event', () => {
  const item = event('Обзор положения на фондовом рынке', filler.repeat(5) + ' ' + rateTitle + '. Компании увеличили инвестиции.');
  assert.equal(selectReason(item, ranked(item, { rate_financing: 1 }, 1), profile(), 0.2).reason, 'rate_topic_is_background');
});

test('real regression: personal political rhetoric cannot borrow counterparty exposure from an old fuel deal', () => {
  const item = event('"Ты клоун": советник Трампа вышел из себя из-за критики сделки с Россией',
    'ВАШИНГТОН, 23 окт – ПРАЙМ. Советник президента США публично назвал конгрессмена клоуном после того, как законодатель раскритиковал сделку между США и Россией по дизельному топливу. '
    + 'Поводом стало внесение законопроекта, который требует лишить минфин права снимать ограничения без согласия конгресса. '
    + 'Президент России и Трамп 9 октября достигли договоренности о поставках российского дизтоплива. '
    + 'Ряд законодателей выразили обеспокоенность тем, что ради снижения цен на заправках администрация пошла вразрез с действующими внешнеторговыми ограничениями.');
  const roadCompany = profile({ industry: { okved_code: '42.11', okved_division: '42' } });
  assert.deepEqual(selectReason(item, ranked(item, { graph_out_share: 0.3 }), roadCompany, 0.2), { eligible: false, reason: 'personal_rhetoric_without_business_event' });
  const argument = event('Депутаты устроили перепалку из-за экспорта топлива',
    'Депутаты обменялись оскорблениями во время заседания. Спор касается высказываний в социальных сетях. Ранее правительство увеличило экспорт дизельного топлива.');
  assert.equal(selectReason(argument, ranked(argument, { graph_out_share: 0.3 }), roadCompany, 0.2).eligible, false);
});

test('political decisions, quoted economic reports and concrete economic changes alongside rhetoric remain eligible', () => {
  const roadCompany = profile({ industry: { okved_code: '42.11', okved_division: '42' } });
  const items = [
    event('Правительство ввело ограничения на экспорт топлива', 'Правительство ввело ограничения на экспорт дизельного топлива. Решение вступило в силу сегодня.'),
    event('«Цены выросли»: министр сообщил об изменении рынка топлива', 'Цены на дизельное топливо выросли на внутреннем рынке. Министерство подтвердило изменение стоимости.'),
    event('Перепалка в парламенте: правительство повысило пошлины на топливо', 'Депутаты обменялись резкими репликами во время заседания. Правительство повысило пошлины на импорт дизельного топлива.'),
    event('Министр оскорбил оппонента на обсуждении топливного рынка', 'Правительство ввело ограничения на экспорт топлива. Министр оскорбил оппонента при обсуждении принятого решения.'),
  ];
  for (const item of items) assert.equal(selectReason(item, ranked(item, { graph_out_share: 0.3 }), roadCompany, 0.2).eligible, true, item.title);
});

test('real regression: a multi-topic weekly digest needs separate events, while one weekly grain observation remains usable', () => {
  const digest = event('Самое интересное за неделю с 19 по 25 октября', 'Цены на пшеницу выросли. Подробнее. Правительство предложило новые субсидии. Подробнее. Компания открыла завод по переработке продукции.');
  assert.equal(selectReason(digest, ranked(digest, { industry_match: 1, graph_out_share: 0.5 }), profile(), 0.2).reason, 'multi_event_roundup_requires_extraction');
  const single = event('Цены на пшеницу за неделю выросли', 'Цены на пшеницу выросли на внутреннем рынке. Торговые организации зафиксировали изменение стоимости зерна.');
  assert.equal(selectReason(single, ranked(single, { industry_match: 1, industry_subject_match: 1 }), profile(), 0.2).eligible, true);
});

test('a budget proposal does not inherit confirmed business exposure from incidental history', () => {
  const item = event('Минтранс представил в Госдуме проект трехлетнего транспортного бюджета', 'Министерство представило проект бюджета на рассмотрение. В прошлом году компании открыли новые дороги и увеличили перевозки.');
  assert.equal(selectReason(item, ranked(item, { industry_match: 1, graph_in_share: 0.3 }), profile(), 0.2).reason, 'forecast_or_proposal_requires_review');
});

test('real regression: geopolitical expectations cannot borrow confirmed historical trade relevance', () => {
  for (const verb of ['ждет', 'ждёт', 'ожидает', 'надеется на']) {
    const item = event(`Министр: Турция ${verb} прекращения огня в ближайшее время`, 'Министр высказал надежду на прекращение огня. В прошлом году компании увеличили поставки зерна через морские порты.');
    assert.equal(selectReason(item, ranked(item, {country_match:1,graph_out_share:0.8}), profile({foreign_trade:{has_fts:true,countries:['ТУРЦИЯ']}}), 0.2).reason, 'forecast_or_proposal_requires_review');
  }
});

test('real regression: personal asset declarations and award ceremonies are not energy-sector changes', () => {
  const power = profile({ industry: { okved_code: '35.11', okved_division: '35' } });
  const declaration = event('Экс-генпрокурор задекларировал тепловую электростанцию', 'Бывший прокурор сообщил сведения о личном имуществе. В справочном описании указано, что электростанция увеличила производство в прошлые годы.');
  assert.equal(selectReason(declaration, ranked(declaration, { industry_match: 1 }), power, 0.2).reason, 'peripheral_or_ceremonial_topic');
  const ceremony = event('Президент наградил работников электроэнергетики', 'Работники получили награды. В выступлении упомянули, что электростанции увеличили производство.');
  assert.equal(selectReason(ceremony, ranked(ceremony, { industry_match: 1 }), power, 0.2).eligible, false);
});

test('full-text completeness gates partial feeds, while meaningful full inline RSS content is usable', () => {
  const item = event('Введена экспортная квота на пшеницу', 'Правительство ввело квоту на экспорт пшеницы. Решение изменяет действующие условия поставки зерна.', { content_scope: 'feed_content' });
  assert.equal(selectReason(item, ranked(item, { industry_match: 1 }), profile(), 0.2).eligible, true);
  item.content.scope = 'feed_excerpt';
  assert.equal(selectReason(item, ranked(item, { industry_match: 1 }), profile(), 0.2).reason, 'awaiting_full_text');
  item.content.scope = 'article_full'; item.content.warnings = ['source_text_truncated_18000'];
  assert.equal(selectReason(item, ranked(item, { industry_match: 1 }), profile(), 0.2).reason, 'source_text_truncated');
});

test('freshness or a high model score alone cannot establish relevance; fabricated feature sources are ignored', () => {
  const item = event('Предприятие увеличило производство электроэнергии', 'Предприятие увеличило производство электроэнергии на электростанции после запуска дополнительного оборудования.');
  assert.equal(selectReason(item, ranked(item, { freshness: 1 }, 0.99), profile(), 0.2).eligible, false);
  const grain = event('Введена экспортная квота на пшеницу', 'Правительство ввело квоту на экспорт пшеницы. Решение изменяет действующие условия поставки зерна.');
  const result = ranked(grain, { industry_match: 1 }); result.feature_contributions[0].source_ids = ['unrelated-source'];
  assert.equal(selectReason(grain, result, profile(), 0.2).reason, 'no_verified_company_exposure');
});

test('known contrary profile facts win over feature values and properly sourced counterparty exposure is conditional', () => {
  const item = event('Изменились поставки зерна', 'Правительство ввело квоту на экспорт пшеницы. Компании сократили поставки зерна.');
  const unrelated = profile({ industry: { okved_code: '35.11', okved_division: '35' } });
  assert.equal(selectReason(item, ranked(item, { industry_match: 1 }), unrelated, 0.2).reason, 'explicit_industry_mismatch');
  assert.equal(selectReason(item, ranked(item, { graph_out_share: 0.3 }), unrelated, 0.2).reason, 'verified_counterparty_exposure_check');
});
