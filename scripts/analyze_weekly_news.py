"""Run the real offline Data/ML pipeline and export results without republishing articles.

The private input is produced by ingest_weekly_news.ts. Original text stays in
the cache; public outputs contain source URLs/hashes, exact scores, feature
contributions, and the actual conditional_advice returned by analyze_news.
No model call, reference answer, manual industry tag or relevance label is used.
"""
from __future__ import annotations

import argparse
from datetime import datetime
import hashlib
import json
import math
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
COMPANIES = {"U_34911": "Оптовая торговля зерном; кредиты и сведения ФТС",
             "U_99262": "Дорожное строительство; кредиты и лизинг",
             "U_4909": "Тепловая генерация; группа и платёжные связи"}
# Reader-facing paraphrases only. They are never passed to extraction or ranking.
TITLES = {
    "cbr_hold_20261023": "ЦБ оставил ключевую ставку на уровне 14%",
    "grain_spot_20261020": "НТБ меняет документы и базисы зернового спот-рынка с 26 октября",
    "grain_auction_20261023": "НТБ опубликовала сведения о закупочных торгах 29 октября",
    "grain_rules_20261023": "Новые правила закупочных интервенций начинают действовать 29 октября",
    "power_standards_20261023": "Энергетический комитет обсудил разработку новых ГОСТов",
    "power_plan_20261020": "Проект развития энергосистем предусматривает новые мощности до 2032 года",
    "power_network_20261022": "В Новосибирской области расширили применение технологии управления сетью",
    "transport_budget_20261022": "Минтранс представил проект транспортного бюджета на 2027–2029 годы",
    "transport_awards_20261023": "В Минтрансе прошла церемония награждения работников",
    "ship_rules_20261022": "Минтранс предложил обновить порядок идентификации судов",
}


def digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()).hexdigest()


def write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + "\n", encoding="utf-8")


def public_evidence(value):
    """Keep provenance while removing verbatim source text from publishable results."""
    if isinstance(value, list):
        return [public_evidence(v) for v in value]
    if not isinstance(value, dict):
        return value
    result = {}
    for key, item in value.items():
        if key in {"quote", "excerpt", "text", "title"} and isinstance(item, str):
            result[key + "_sha256"] = hashlib.sha256(item.encode()).hexdigest()
        else:
            result[key] = public_evidence(item)
    return result


def table_text(value):
    return str(value).replace("|", "\\|").replace("\n", " ")


def score_reason(card):
    """Describe observed feature values, without inventing relevance labels."""
    values = card['features']['values']
    labels = {
        'industry_match': 'совпадение отраслевой темы',
        'rate_financing': 'отмечено финансирование',
        'rate_deposit': 'отмечен депозит',
        'rate_hold_financing': 'сохранение ставки уменьшает вклад финансирования',
        'rate_hold_deposit': 'сохранение ставки уменьшает вклад депозита',
        'graph_in_share': 'есть входящие платежи от отраслевых контрагентов',
        'graph_out_share': 'есть исходящие платежи отраслевым контрагентам',
        'applicable_deadline_30d': 'дата действия в ближайшие 30 дней',
        'direct_company_match': 'прямое упоминание компании',
        'related_company_match': 'упоминание связанной компании',
        'region_match': 'совпадение региона',
        'country_match': 'совпадение страны',
        'fx_trade': 'валютное событие и сведения ФТС',
    }
    reasons = [label for name, label in labels.items() if values.get(name, 0) > 0]
    if not reasons:
        reasons = ['балл только за свежесть; бизнес-канал не найден']
    return '; '.join(reasons)


def report(data, previous=None):
    lines = ["# Проверка на новостях недели 19–24 октября 2026 года", "",
             f"Время среза: `{data['as_of']}`. Проверено {data['article_count']} оригинальных публикаций и {len(data['companies'])} реальных обезличенных профиля из базы организаторов.", "",
             "Использован действующий код загрузки SQLite, извлечения событий, графа, ранжирования и условных советов Python. Внешняя LLM не вызывалась по выбору пользователя. Это результаты baseline, без обучения новых весов и без подстановки подготовленных ответов.", "",
             "Балл — сумма вкладов признаков для приоритета внимания. Он не является процентом, вероятностью ущерба, суммой потерь или уверенностью в достоверности новости. Равные баллы дают условный порядок; интервал мест показывает ничью. Независимой человеческой разметки этой недели нет, метрика качества на ней не заявляется.", "",
             "## Проверки загрузки", "", "```json", json.dumps(data['ingestion_checks'], ensure_ascii=False, indent=2), "```", "",
             "Все тексты взяты из первоисточников, без AI-пересказа на входе. HTML-навигация удалена при извлечении основного текста. Даты без подтверждённого часового пояса обозначены концом дня UTC. Оригиналы остаются в локальном кеше; ниже опубликованы ссылки, хеши и результаты программы.", "",
             "## Источники", "", "| ID | Публикация | Новость |", "|---|---|---|"]
    for source in data['sources']:
        lines.append(f"| {source['article_id']} | {source['published_at'][:10]} | [{TITLES[source['article_id']]}]({source['url']}) |")
    for company in data['companies']:
        uid = company['company_id']
        lines += ["", f"## {uid}: {COMPANIES[uid]}", "",
                  f"ОКВЭД: `{company['profile_summary']['okved']}`. Продукты: `{json.dumps(company['profile_summary']['bank_products'], ensure_ascii=False)}`.", "",
                  "| Место | Новость | Балл | Равные места | Основание балла | Вид совета |", "|---:|---|---:|---|---|---|"]
        for card in company['cards']:
            statuses = ', '.join(sorted({a.get('status', 'conditional') for a in card['conditional_advice']}))
            lines.append(f"| {card['position']} | [{TITLES[card['article_id']]}]({card['url']}) | {card['score']:.6f} | {card['tie_positions'][0]}–{card['tie_positions'][1]} | {table_text(score_reason(card))} | {statuses} |")
        lines += ["", "Условные действия для первых трёх позиций, дословно из `conditional_advice` программы:"]
        for card in company['cards'][:3]:
            lines += ["", f"### {TITLES[card['article_id']]}", "",
                      "Главные ненулевые вклады: " + "; ".join(f"`{c['feature']}`: {c['contribution']:+.4f}" for c in card['feature_contributions'][:5]) + ".", ""]
            for advice in card['conditional_advice']:
                lines += ["- " + advice['action'], "  Условие: " + advice['condition'],
                          "  Нужны данные: " + "; ".join(advice.get('required_data', [])) + "."]
        if previous:
            old = next(c for c in previous['companies'] if c['company_id'] == uid)
            lookup = {c['article_id']: c for c in old['cards']}
            lines += ["", "Позиции до исправлений и после на тех же исходных текстах. Перемещение внутри равного балла не является улучшением:", "",
                      "| Новость | До → после | Балл до → после |", "|---|---:|---:|"]
            for card in company['cards']:
                prior = lookup[card['article_id']]
                lines.append(f"| {TITLES[card['article_id']]} | {prior['position']} → {card['position']} | {prior['score']:.6f} → {card['score']:.6f} |")
    lines += ["", "## Обнаруженные ограничения на этих публикациях", "",
              "- Правила закупочных интервенций от 23 октября: в самом тексте нет слова «зерно», а участие оптовика в описанных операциях не подтверждено. Правила извлечения не находят отраслевой канал. Возможную связь нужно проверить по документу и операциям компании; автоматически объявлять новость нерелевантной нельзя.",
              "- Проекты транспортного бюджета и развития энергосистем, обсуждение ГОСТов распознаны по отраслевой теме, но статус принятого решения не подтверждён: `event_type=other`, `decision_status=unknown`. Условные советы общие; программа не устанавливает новые обязанности и не обещает заказы или экономию.",
              "- Для дорожной и энергетической компаний подтверждённых совпадений меньше трёх. Третья строка общего ранжирования не становится значимой только из-за позиции. В таблицах намеренно показаны все новости, включая отсутствие связи и ничьи по свежести.",
              "- Правила уточнялись по ошибкам этой подборки. Она служит для отладки и проверки регрессий; для независимой оценки нужны новые новости и человеческие оценки.", "",
              "## Границы проверки", "",
              "Профили обезличены: публичные названия и адресные новости о членах группы нельзя надёжно связать с этими ID. Дата наблюдения исходных полей неизвестна; это текущая проверка с доступным снимком, не исторический backtest. Наличие ФТС не доказывает направление торговли; платёж не устанавливает договорную роль. Условия кредитов, участие в торгах, фактические площадки и оборудование требуют уточнения.", "",
              "Банковские аналитические материалы в этом прогоне не подключались. Финансовые сценарии не рассчитывались без параметров экспозиции; финансовые потери и эффект действий не оценивались. Ответы внешней LLM и их смысловое качество этим прогоном не проверены."]
    return '\n'.join(lines) + '\n'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--events', type=Path, required=True, help='Private ingestion result')
    parser.add_argument('--database', type=Path, required=True)
    parser.add_argument('--module-root', type=Path, default=ROOT)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--report', type=Path)
    parser.add_argument('--previous', type=Path)
    args = parser.parse_args()
    if args.previous and args.previous.resolve() == args.out.resolve():
        raise ValueError('Do not overwrite the before snapshot')
    if args.report and args.report.resolve() == args.out.resolve():
        raise ValueError('Result JSON and report require separate paths')
    sys.path.insert(0, str(args.module_root.resolve()))
    from company_context.store import ContextStore
    from news_analysis.pipeline import analyze_news

    bundle = json.loads(args.events.read_text(encoding='utf-8'))
    if bundle.get('input_kind') != 'original_primary_article_text':
        raise ValueError('Original primary text required')
    mappings = {r['news_id']: r for r in bundle['articles']}
    if len(mappings) != len(bundle['articles']) or {r['article_id'] for r in mappings.values()} != set(TITLES):
        raise ValueError('Unexpected, missing or duplicate news IDs')
    events = bundle['events']
    if len(events) != len(mappings) or {e['news_id'] for e in events} != set(mappings):
        raise ValueError('Incomplete or unexpectedly clustered corpus')
    for event in events:
        if not '2026-10-19' <= event['published_at'][:10] <= '2026-10-24' or event.get('is_mock'):
            raise ValueError('Out-of-week or synthetic article')
        if datetime.fromisoformat(event['published_at'].replace('Z', '+00:00')) > datetime.fromisoformat(bundle['as_of'].replace('Z', '+00:00')):
            raise ValueError('Future article')
    result = {'schema_version': 'weekly_news_results_v1', 'as_of': bundle['as_of'], 'llm_calls': 0,
              'input_kind': bundle['input_kind'], 'article_count': len(events), 'ranking': 'manual_feature_baseline',
              'external_llm_quality': 'not_evaluated_user_requested_offline', 'ingestion_checks': bundle['checks'],
              'source_input_sha256': bundle['input_sha256'], 'extraction_code_hashes': bundle['code_hashes'],
              'analysis_code_hashes': {n: hashlib.sha256((args.module_root / n).read_bytes()).hexdigest()
                                       if (args.module_root / n).is_file() else None
                                       for n in ['news_analysis/features.py', 'news_analysis/graph.py', 'news_analysis/pipeline.py', 'news_analysis/scenarios.py',
                                                 'company_context/io.py', 'company_context/store.py', 'company_context/exposure.py', 'company_context/signals.py']},
              'sources': [], 'companies': []}
    for event in events:
        mapping = mappings[event['news_id']]
        result['sources'].append({'article_id': mapping['article_id'], 'url': mapping['url'], 'published_at': event['published_at'],
                                  'content_sha256': mapping['content_sha256'], 'extracted_event': public_evidence(event)})
    with ContextStore(args.database) as store:
        result['company_source_provenance'] = store.metadata['sources']
        for uid in COMPANIES:
            profile = store.get_company_profile(uid)
            analysis = analyze_news(store, uid, events, bundle['as_of'], model=None, cases=(), bank_analytics=(),
                                    limit=len(events), feature_version='company_event_v2')
            if (len(analysis['cards']) != len(events) or analysis['excluded_future_news_ids']
                    or {card['news_id'] for card in analysis['cards']} != set(mappings)):
                raise ValueError('Unexpected missing cards')
            company = {'company_id': uid, 'profile_sha256': digest(profile),
                       'profile_summary': {'okved': profile['industry'].get('okved_code'), 'bank_products': profile['bank_products'],
                                           'foreign_trade': profile['foreign_trade'], 'geography': profile['geography']},
                       'cards': [], 'limitations': analysis['limitations']}
            scores = [c['score'] for c in analysis['cards']]
            for position, card in enumerate(analysis['cards'], 1):
                if not math.isfinite(card['score']) or card['score_kind'] != 'manual_feature_baseline':
                    raise ValueError('Invalid priority score')
                if card['model_assessment']['scenario']['status'] != 'not_requested':
                    raise ValueError('Unrequested financial scenario')
                item = mappings[card['news_id']]
                contributions = sorted([c for c in card['model_assessment']['feature_contributions'] if c['contribution']], key=lambda c: -abs(c['contribution']))
                if not math.isclose(sum(c['contribution'] for c in contributions), card['score'], rel_tol=1e-9, abs_tol=1e-9):
                    raise ValueError('Feature contributions do not explain the score')
                company['cards'].append({'article_id': item['article_id'], 'url': item['url'], 'position': position,
                    'score': card['score'], 'score_kind': card['score_kind'],
                    'tie_positions': [1 + sum(s > card['score'] for s in scores), sum(s >= card['score'] for s in scores)],
                    'event_type': card['facts']['event_type'], 'features': public_evidence(card['company_evidence']['features']),
                    'graph': public_evidence(card['company_evidence']['graph']), 'feature_contributions': public_evidence(contributions),
                    'conditional_advice': card['model_assessment']['conditional_advice'], 'financial_effect': 'not_estimated',
                    'self_check': card['self_check']})
            result['companies'].append(company)
    result['content_sha256'] = digest(result)
    previous = json.loads(args.previous.read_text(encoding='utf-8')) if args.previous else None
    if previous:
        if digest({k: v for k, v in previous.items() if k != 'content_sha256'}) != previous['content_sha256']:
            raise ValueError('Before snapshot integrity check failed')
        old_profiles = {c['company_id']: c['profile_sha256'] for c in previous['companies']}
        new_profiles = {c['company_id']: c['profile_sha256'] for c in result['companies']}
        old_articles = {s['article_id']: s['content_sha256'] for s in previous['sources']}
        new_articles = {s['article_id']: s['content_sha256'] for s in result['sources']}
        if (previous['source_input_sha256'] != result['source_input_sha256'] or previous['as_of'] != result['as_of']
                or old_profiles != new_profiles or old_articles != new_articles
                or previous['company_source_provenance'] != result['company_source_provenance']):
            raise ValueError('Before/after require identical articles, company profiles, provenance and cutoff')
        for company in previous['companies']:
            if (len(company['cards']) != len(events)
                    or {c['article_id'] for c in company['cards']} != set(TITLES)):
                raise ValueError('Before snapshot has incomplete or duplicate cards')
    report_text = report(result, previous) if args.report else None
    # Validation and rendering must finish before either publishable file changes.
    write(args.out, result)
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(report_text, encoding='utf-8')
    print(json.dumps({'companies': len(result['companies']), 'articles': len(events), 'cards': sum(len(c['cards']) for c in result['companies']), 'llm_calls': 0, 'out': str(args.out)}, ensure_ascii=False))


if __name__ == '__main__':
    main()
