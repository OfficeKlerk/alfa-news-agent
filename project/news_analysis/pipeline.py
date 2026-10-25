"""Integration entry points for the agent/backend; no remote calls or LLM costs."""

from .contracts import deduplicate, text, timestamp, validated_event_details
from .features import FEATURE_VERSION, DEFAULT_FEATURE_VERSION, feature_names, extract_features, baseline_score, baseline_explain
from .graph import PaymentGraph
from .scenarios import optimize_actions


def prepare_training_rows(store, company_ids, events, as_of, feature_version=FEATURE_VERSION):
    """Export unlabelled, traceable company-event pairs for human annotation."""
    feature_names(feature_version)
    selected, _ = deduplicate(events, as_of)
    rows = []
    if len(set(company_ids)) != len(company_ids):
        raise ValueError("Repeated company_id")
    for uid in company_ids:
        profile = store.get_company_profile(uid)
        graph = PaymentGraph(store, uid)
        for event in selected:
            exposure = graph.exposure(event, feature_version=feature_version)
            features = extract_features(profile, event, as_of, exposure, feature_version=feature_version)
            rows.append({"company_id": uid, "event_id": event["event_id"], "query_id": uid + "@" + as_of,
                         "published_at": event["published_at"], "as_of": as_of,
                         "feature_version": feature_version, "features": features["values"],
                         "label": None, "label_origin": "human", "annotation_reason": "",
                         "annotation_context": {"event": event, "profile": profile, "graph": exposure,
                                                "feature_evidence": features["evidence"]}})
    return rows


def conditional_advice(profile, event, features=None):
    """Questions and conditional next steps, never automatic financial actions."""
    kind = event["event_type"]
    products = profile.get("bank_products", {})
    financing = any(products.get(key) is True for key in ("loan", "leasing", "factoring"))
    details = validated_event_details(event)
    values = (features or {}).get("values", {})
    channel_names = ("rate_financing", "rate_deposit", "fx_trade", "industry_match", "country_match",
                     "region_match", "direct_company_match", "related_company_match", "graph_in_share",
                     "graph_out_share", "target_role_match")
    has_channel = any(values.get(key, 0) > 0 for key in channel_names)
    direct_connection = values.get("direct_company_match", 0) > 0
    indirect_connection = any(values.get(key, 0) > 0 for key in (
        "related_company_match", "graph_in_share", "graph_out_share"))
    mismatch = any(values.get(key, 0) > 0 for key in (
        "industry_target_mismatch", "industry_subject_mismatch", "target_role_mismatch"))
    if event["fact_status"] == "disputed":
        return [{"action": "Сверить противоречащие сообщения с первичным решением до выбора финансовых или операционных действий.",
                 "condition": "Факт отмечен как спорный; высокий приоритет проверки не подтверждает достоверность или величину ущерба.",
                 "required_data": ["первичное решение", "подтверждение спорных параметров", "дата действия"],
                 "profile_evidence": [], "status": "source_verification"}]
    if mismatch and not direct_connection and indirect_connection:
        return [{"action": "Уточнить, передаётся ли влияние через отмеченных контрагентов или связанные компании, и проверить соответствующие договоры.",
                 "condition": "Прямое совпадение профиля с целевой группой не подтверждено. Связь в графе сама по себе не переносит требования или финансовый эффект на компанию.",
                 "required_data": ["затронутые контрагенты и их операции", "договорные условия передачи изменения", "сроки и объёмы соответствующих платежей"],
                 "profile_evidence": ["/payment_summary", "/industry"], "status": "indirect_exposure_check"}]
    if mismatch and not direct_connection:
        return [{"action": "Сначала проверить применимость новости к операциям компании; по имеющемуся профилю прямое совпадение с целевой группой не подтверждено.",
                 "condition": "Известные отраслевые или продуктовые сведения не совпадают с целевой группой. Дополнительные виды деятельности и условия нормы могут отсутствовать в профиле.",
                 "required_data": ["полные условия применимости", "дополнительные виды деятельности", "фактически затронутые операции и договоры"],
                 "profile_evidence": ["/industry", "/bank_products", "/foreign_trade"], "status": "applicability_check"}]
    if kind == "rate_change" and details["direction"] == "unchanged":
        product_names = {"loan": "кредит", "leasing": "лизинг", "factoring": "факторинг", "deposit": "депозит"}
        known_products = [name for key, name in product_names.items() if products.get(key) is True]
        if known_products:
            action = ("Отметить сохранение ключевой ставки и проверить даты пересмотра условий по отмеченным в профиле продуктам: "
                      + ", ".join(known_products) + ".")
            condition = "Сохранение ключевой ставки не подтверждает неизменность ставок договоров, банковских предложений, комиссий или стоимости финансирования; наличие отметки продукта не подтверждает условия договора."
            required = ["условия договоров по отмеченным продуктам, если они есть", "тип ставки и даты пересмотра условий", "актуальные банковские предложения и комиссии"]
        elif any(products.get(key) is None for key in product_names):
            action = "Отметить сохранение ключевой ставки; уточнить наличие чувствительных к ставке договоров, если потребуется оценка воздействия."
            condition = "Сведения о финансировании или депозитах неполны; наличие договоров не предполагается."
            required = ["наличие финансирования и депозитов"]
        else:
            action = "Оставить сообщение о сохранении ставки для наблюдения; по профилю нет оснований предлагать изменение финансовых договоров."
            condition = "Финансирование и депозиты отмечены в профиле как отсутствующие; другие каналы влияния или договоры вне снимка не установлены."
            required = []
        return [{"action": action,
                 "condition": "Новость не содержит нового изменения ключевой ставки и не доказывает неизменность всех условий финансирования. " + condition,
                 "required_data": required,
                 "profile_evidence": ["/bank_products"], "status": "monitoring_only"}]
    if values and not has_channel:
        return [{"action": "Оставить новость для наблюдения; пока нет подтверждённой связи с бизнесом, изменение операций не предлагается.",
                 "condition": "Доступные признаки не показывают отраслевой, продуктовый, географический или контрагентский канал. Это не доказательство отсутствия влияния: профиль и извлечение события могут быть неполными.",
                 "required_data": [], "profile_evidence": ["/industry", "/bank_products", "/geography", "/foreign_trade", "/payment_summary"],
                 "status": "no_confirmed_link"}]
    if details["decision_status"] == "forecast":
        return [{"action": "Проверить подтверждение прогноза и при необходимости рассмотреть его как отдельный условный сценарий.",
                 "condition": "Прогноз не является состоявшимся изменением. Без подтверждённого решения и данных об экспозиции нельзя приписывать компании ущерб или требуемое действие.",
                 "required_data": ["подтверждённое решение и срок действия", "затронутые операции", "параметры условного сценария"],
                 "profile_evidence": ["/bank_products", "/industry", "/foreign_trade"], "status": "scenario_only"}]
    if kind == "rate_change" and details["direction"] == "unknown":
        return [{"action": "Уточнить, изменилась ли ставка, на сколько и с какой даты; затем проверить условия связанных договоров.",
                 "condition": "Тип новости сам по себе не определяет направление изменения и не подтверждает переоценку кредита или депозита.",
                 "required_data": ["направление и величина изменения", "дата действия решения", "условия переоценки договоров"],
                 "profile_evidence": ["/bank_products"], "status": "needs_event_details"}]
    def with_timing(advice):
        if not has_channel or not details["effective_at"]:
            return advice
        # An observed connection and a quoted date justify checking applicability,
        # never asserting a legal obligation or a financial effect.
        return [{"action": "Сверить применимость документа и график затронутых операций с указанной датой действия: " + details["effective_at"][:10] + ".",
                 "condition": "Наблюдаемая связь по профилю или контрагентам не доказывает юридическую обязанность. Нужно подтвердить участие компании в затронутых операциях и условия документа.",
                 "required_data": ["условия применимости документа", "участие в затронутых операциях", "договорные сроки"],
                 "profile_evidence": ["/industry", "/bank_products", "/payment_summary"],
                 "status": "conditional_timing_check"}, *advice]
    rate_advice = []
    if kind == "rate_change" and financing:
        action = ("Проверить, допускает ли договор снижение стоимости финансирования вслед за изменением ставки; сравнить доступные условия с учётом комиссий."
                  if details["direction"] == "decrease" else
                  "Сравнить стоимость сохранения текущих условий и защиты части финансирования от изменения ставки.")
        rate_advice.append({"action": action,
                 "condition": "Договор допускает изменение ставки; известны остаток, сроки и доступные предложения.",
                 "required_data": ["остаток переоцениваемого долга", "изменение ставки по договору", "срок переоценки",
                                   "стоимость и доступность каждого действия"],
                 "profile_evidence": ["/bank_products"], "status": "conditional_direction"})
    if kind == "rate_change" and products.get("deposit") is True:
        rate_advice.append({"action": "Проверить сроки депозитов, условия переоценки и потребность в ликвидности.",
                 "condition": "В профиле отмечен депозит; суммы и договорные условия требуют уточнения.",
                 "required_data": ["сроки и ставки депозитов", "план платежей"],
                 "profile_evidence": ["/bank_products/deposit"], "status": "conditional_direction"})
    if rate_advice:
        return with_timing(rate_advice)
    if kind in {"fx_change", "trade_restriction"}:
        return with_timing([{"action": "Уточнить затронутые валюты, страны, товары и договоры; затем сравнить доступные способы снизить экспозицию.",
                 "condition": "Сведения ФТС сами по себе не подтверждают импорт, экспорт или валютный риск.",
                 "required_data": ["валюты поступлений и выплат", "встречные потоки и уже действующая защита", "условия договоров"],
                 "profile_evidence": ["/foreign_trade"], "status": "conditional_direction"}])
    if kind == "commodity_price_change":
        return with_timing([{"action": "Уточнить, является компания покупателем или продавцом затронутого ресурса, и сравнить условия договоров.",
                 "condition": "ОКВЭД и платежи не определяют знак финансового эффекта.",
                 "required_data": ["объём открытых закупок или продаж", "доля расходов, чувствительная к цене", "доступные цены фиксации"],
                 "profile_evidence": ["/industry", "/payment_summary"], "status": "conditional_direction"}])
    if values.get("industry_subject_match", 0) > 0:
        return with_timing([{"action": "Проверить участие компании в затронутых проектах и наличие соответствующих договоров.",
                 "condition": "Отрасль связана с темой новости. Совпадение отрасли не подтверждает контракты, участие в проектах, получение средств или обязательность требований.",
                 "required_data": ["участие в конкретных проектах", "условия договоров, если они есть", "стадия решения и условия применимости"],
                 "profile_evidence": ["/industry/okved_code", "/industry/okved_division"], "status": "conditional_direction"}])
    return with_timing([{"action": "Проверить, какие операции и договоры компании затрагивает событие.",
             "condition": "Сначала подтвердить связь события с бизнесом.",
             "required_data": ["затронутые операции", "сроки", "доступные альтернативы и их стоимость"],
             "profile_evidence": ["/industry", "/geography"], "status": "conditional_direction"}])


def analyze_news(store, company_id, events, as_of, model=None, cases=(), bank_analytics=(), limit=10,
                 feature_version=None):
    selected_version = feature_version or (model.feature_version if model else DEFAULT_FEATURE_VERSION)
    feature_names(selected_version)
    if model and model.feature_version != selected_version:
        raise ValueError("Requested feature version differs from model artifact")
    if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 100:
        raise ValueError("limit must be 1..100")
    if not isinstance(cases, (list, tuple)) or not isinstance(bank_analytics, (list, tuple)):
        raise ValueError("cases and bank_analytics must be arrays")
    profile = store.get_company_profile(company_id)
    selected, future = deduplicate(events, as_of)
    selected_ids = {event["event_id"] for event in selected}
    by_event = {}
    for case in cases:
        if not isinstance(case, dict):
            raise ValueError("Each case must be an object")
        if case.get("company_id") != company_id or case.get("event_id") not in selected_ids:
            raise ValueError("Scenario must belong to this company and an included event")
        if case["event_id"] in by_event:
            raise ValueError("Only one scenario case per event is supported")
        by_event[case["event_id"]] = case
    bank = {}
    for item in bank_analytics:
        if not isinstance(item, dict):
            raise ValueError("Each bank excerpt must be an object")
        for key in ("event_id", "source", "excerpt"):
            text(item.get(key), "bank_analytics." + key)
        if item["event_id"] not in selected_ids:
            raise ValueError("Bank excerpt must reference an included event")
        if item.get("published_at") is not None and timestamp(item["published_at"]) > timestamp(as_of):
            raise ValueError("Bank excerpt is available after as_of")
        bank.setdefault(item["event_id"], []).append(item)
    graph = PaymentGraph(store, company_id)
    cards = []
    for event in selected:
        exposure = graph.exposure(event, feature_version=selected_version)
        features = extract_features(profile, event, as_of, exposure, feature_version=selected_version)
        score = model.predict(features["values"]) if model else baseline_score(features["values"])
        # Old artifacts keep their exact feature space, but must not disable
        # current applicability checks on advice for newly extracted events.
        advice_features = features if selected_version == DEFAULT_FEATURE_VERSION else extract_features(
            profile, event, as_of, graph.exposure(event, feature_version=DEFAULT_FEATURE_VERSION),
            feature_version=DEFAULT_FEATURE_VERSION)
        case = by_event.get(event["event_id"])
        if case and case.get("kind") != event["event_type"]:
            raise ValueError("Scenario kind must match the event_type")
        scenario = optimize_actions(case) if case else {"status": "not_requested", "recommendation": None}
        bank_view = bank.get(event["event_id"], [])
        checks = []
        if not bank_view:
            checks.append("bank_position_not_provided")
        elif any(item.get("published_at") is None for item in bank_view):
            checks.append("bank_excerpt_date_unknown")
        if event["fact_status"] != "confirmed":
            checks.append("event_requires_source_verification")
        if not model:
            checks.append("ranking_uses_manual_baseline_no_trained_model")
        elif model.metadata.get("label_origin") != "human":
            checks.append("ranker_not_validated_on_human_labels")
        if not case:
            checks.append("financial_effect_not_estimated")
        elif scenario["status"] == "needs_parameters":
            checks.append("scenario_parameters_missing")
        if case:
            checks.append("scenario_is_conditional_not_observed_event_loss")
            if (event.get("event_details") or {}).get("direction") == "unchanged":
                checks.append("unchanged_rate_does_not_supply_a_new_rate_shock")
        checks.extend(profile["data_quality"]["warnings"])
        cards.append({"event_id": event["event_id"], "news_id": event["news_id"], "score": score,
                      "score_kind": "logistic_relevance_uncalibrated" if model else "manual_feature_baseline",
                      "facts": event, "company_evidence": {"profile_provenance": profile["provenance"],
                                                             "features": features, "graph": exposure},
                      "bank_view": bank_view,
                      "model_assessment": {"feature_contributions": model.explain(features) if model else baseline_explain(features),
                                           "intercept": model.intercept if model else None,
                                           "scenario": scenario, "conditional_advice": conditional_advice(profile, event, advice_features)},
                      "self_check": {"warnings": sorted(set(checks)),
                                     "needs_more_data": bool(checks), "position_of_bank_inferred": False}})
    cards.sort(key=lambda card: (-card["score"], card["event_id"]))
    return {"schema_version": "1.0", "company_id": company_id, "as_of": as_of,
            "ranking_model": model.to_dict() if model else None,
            "events_considered": len(cards), "cards": cards[:limit], "truncated": len(cards) > limit,
            "excluded_future_news_ids": future,
            "trace": [{"step": "load_company_profile", "snapshot": store.metadata["built_at"]},
                      {"step": "deduplicate_and_filter_publication_time", "events": len(selected)},
                      {"step": "match_company_and_all_payment_edges", "feature_version": selected_version},
                      {"step": "rank_events", "method": "learned" if model else "manual_baseline"},
                      {"step": "evaluate_conditional_actions", "cases": len(by_event)},
                      {"step": "self_check", "warnings": sorted({w for c in cards for w in c["self_check"]["warnings"]})}],
            "limitations": ["Ранжирование оценивает релевантность, а не вероятность или величину ущерба.",
                            "Прогноз временных рядов и эмпирическое обучение эффекта действий требуют отдельной истории."]}
