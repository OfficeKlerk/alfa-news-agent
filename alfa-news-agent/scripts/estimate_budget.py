#!/usr/bin/env python3
"""Оценка расхода LLM-бюджета в рублях по журналу использования токенов.

Закрывает пробел роли 5 (R5-03): перевод usage-токенов в рубли и контроль
дневного лимита 500 ₽/ключ. Бюджет шлюза сбрасывается в 03:00 МСК, что равно
00:00 UTC, поэтому «бюджетный день» = календарная дата по UTC.

ВАЖНО: цены в model_prices.json — ПЛЕЙСХОЛДЕР. Утилита честно считает по
заданному тарифу; официальные цены шлюза нужно уточнить у организаторов.
Пустой или неизвестный тариф для модели даёт стоимость null, а не ноль.

Запуск:
    python demo/tools/estimate_budget.py \
        --usage demo/tools/sample_usage.json \
        --prices demo/tools/model_prices.json

Формат usage: {"calls": [{"timestamp": ISO8601, "model": str,
                           "input_tokens": int, "output_tokens": int}, ...]}
"""

import argparse
import json
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path


def budget_day(ts_iso):
    """Дата бюджетного дня по UTC (= 03:00 МСК). Возвращает 'YYYY-MM-DD'."""
    ts = datetime.fromisoformat(ts_iso.replace("Z", "+00:00")).astimezone(timezone.utc)
    return ts.date().isoformat()


def call_cost(call, prices):
    """Стоимость одного вызова в рублях или None, если тариф модели неизвестен."""
    price = prices.get(call["model"])
    if not price:
        return None
    cost_in = call.get("input_tokens", 0) / 1000 * price["input"]
    cost_out = call.get("output_tokens", 0) / 1000 * price["output"]
    return cost_in + cost_out


def report(usage, price_doc):
    prices = price_doc["prices"]
    budget = price_doc.get("daily_budget_rub", 500)
    days = defaultdict(lambda: {"calls": 0, "input": 0, "output": 0, "rub": 0.0, "priced": True})
    unknown_models = set()
    for call in usage["calls"]:
        day = days[budget_day(call["timestamp"])]
        day["calls"] += 1
        day["input"] += call.get("input_tokens", 0)
        day["output"] += call.get("output_tokens", 0)
        cost = call_cost(call, prices)
        if cost is None:
            day["priced"] = False
            unknown_models.add(call["model"])
        else:
            day["rub"] += cost
    return days, budget, sorted(unknown_models)


def main():
    ap = argparse.ArgumentParser(description="Оценка расхода LLM-бюджета в рублях")
    ap.add_argument("--usage", required=True, type=Path)
    ap.add_argument("--prices", required=True, type=Path)
    args = ap.parse_args()

    usage = json.loads(args.usage.read_text(encoding="utf-8"))
    price_doc = json.loads(args.prices.read_text(encoding="utf-8"))
    days, budget, unknown = report(usage, price_doc)

    if price_doc.get("_warning"):
        print(f"⚠️  {price_doc['_warning']}\n")

    print(f"Дневной лимит: {budget} ₽ (сброс 03:00 МСК = 00:00 UTC)\n")
    header = f"{'Бюджетный день':<16}{'вызовов':>9}{'вход':>10}{'выход':>10}{'₽ (оценка)':>14}{'% лимита':>11}"
    print(header)
    print("-" * len(header))
    total_rub = 0.0
    any_unpriced = False
    for day in sorted(days):
        d = days[day]
        total_rub += d["rub"]
        if d["priced"]:
            rub_str = f"{d['rub']:.2f}"
            pct = d["rub"] / budget * 100 if budget else 0
            pct_str = f"{pct:.0f}%"
            flag = "  ⛔ ПРЕВЫШЕН" if d["rub"] > budget else ("  ⚠️ близко" if pct >= 80 else "")
        else:
            any_unpriced = True
            rub_str, pct_str, flag = "н/д*", "н/д", "  (неизвестный тариф)"
        print(f"{day:<16}{d['calls']:>9}{d['input']:>10}{d['output']:>10}{rub_str:>14}{pct_str:>11}{flag}")

    print("-" * len(header))
    tokens = sum(d["input"] + d["output"] for d in days.values())
    print(f"Итого: {sum(d['calls'] for d in days.values())} вызовов, {tokens} токенов, "
          f"≈ {total_rub:.2f} ₽ (по заданному тарифу)")
    if any_unpriced:
        print("* часть дней без оценки — неизвестен тариф модели")
    if unknown:
        print(f"Модели без цены в тарифе: {', '.join(unknown)}")


if __name__ == "__main__":
    main()
