"""Conditional cost scenarios and exact search on a bounded action grid.

This is not an empirical causal model. Effect/cost parameters are supplied with
their provenance, never inferred from loan flags or optimized to improve results.
Actions protect DISJOINT fractions of one exposure; sum(fractions) <= 1.
"""

from decimal import Decimal
from itertools import product
import math

from .contracts import finite, text

KINDS = {"rate_change", "fx_change", "commodity_price_change"}
PARAMETERS = ("effectiveness", "fixed_cost_rub", "variable_cost_rub", "liquidity_required_rub")
MAX_COMBINATIONS = 100000


def missing_parameters(case):
    if not isinstance(case, dict):
        raise ValueError("Scenario case must be an object")
    if not isinstance(case.get("actions", []), list):
        raise ValueError("actions must be an array")
    if case.get("shocks") is not None and not isinstance(case["shocks"], list):
        raise ValueError("shocks must be an array")
    missing = []
    for key in ("exposure_side", "horizon_months"):
        if case.get(key) is None:
            missing.append(key)
    for key in ("exposure_rub",):
        if not isinstance(case.get(key), dict) or case[key].get("value") is None:
            missing.append(key)
    if not case.get("shocks"):
        missing.append("shocks")
    else:
        for i, shock in enumerate(case["shocks"]):
            if not isinstance(shock, dict):
                raise ValueError("Each shock must be an object")
            if not isinstance(shock.get("delta"), dict) or shock["delta"].get("value") is None:
                missing.append(f"shocks/{i}/delta")
    for i, action in enumerate(case.get("actions", [])):
        if not isinstance(action, dict):
            raise ValueError("Each action must be an object")
        if action.get("available") is not False:
            for key in PARAMETERS:
                if not isinstance(action.get(key), dict) or action[key].get("value") is None:
                    missing.append(f"actions/{i}/{key}")
    return missing


def datum(value, name, minimum=None, maximum=None):
    if not isinstance(value, dict):
        raise ValueError(f"{name}: expected value, basis, source")
    if value.get("basis") not in {"supplied", "assumption"}:
        raise ValueError(f"{name}.basis must be supplied or assumption")
    text(value.get("source"), name + ".source")
    return finite(value.get("value"), name, minimum, maximum)


def validate_case(case):
    missing = missing_parameters(case)
    if missing:
        raise ValueError("Missing scenario parameters: " + ", ".join(missing))
    if case.get("kind") not in KINDS:
        raise ValueError("Unsupported scenario kind")
    for key in ("company_id", "event_id", "case_id", "base_scenario"):
        text(case.get(key), key)
    if case.get("currency") != "RUB":
        raise ValueError("This version accepts explicit RUB exposure and costs only")
    if case.get("exposure_side") not in {"cost", "revenue"}:
        raise ValueError("exposure_side must be cost or revenue; it cannot be inferred from FTS")
    months = finite(case.get("horizon_months"), "horizon_months", .01, 120)
    datum(case["exposure_rub"], "exposure_rub", 0)
    ids = set()
    if not isinstance(case.get("shocks"), list) or not 1 <= len(case["shocks"]) <= 100:
        raise ValueError("Provide 1..100 shock scenarios")
    for shock in case["shocks"]:
        sid = text(shock.get("id"), "shock.id")
        if sid in ids:
            raise ValueError("Duplicate shock id")
        ids.add(sid)
        # Rate delta is a decimal rate, not percentage points; negative shocks allowed.
        datum(shock["delta"], "shock.delta", -1, 10)
    if case["base_scenario"] not in ids:
        raise ValueError("base_scenario not found")
    actions = case.get("actions", [])
    if not isinstance(actions, list) or len(actions) > 10:
        raise ValueError("Provide at most 10 actions")
    ids = set()
    for action in actions:
        aid = text(action.get("id"), "action.id")
        text(action.get("title"), "action.title")
        if aid in ids:
            raise ValueError("Duplicate action id")
        ids.add(aid)
        if not isinstance(action.get("available"), bool):
            raise ValueError("Action availability must be explicit")
        if not action["available"]:
            continue
        maximum = finite(action.get("max_fraction"), "max_fraction", 0, 1)
        step = finite(action.get("step"), "step", 1e-6, 1)
        if maximum / step > MAX_COMBINATIONS:
            raise ValueError("Action grid is too large")
        finite(action.get("lead_time_months"), "lead_time_months", 0, 120)
        datum(action["effectiveness"], "effectiveness", 0, 1)
        for key in PARAMETERS[1:]:
            datum(action[key], key, 0)
        text(action.get("prerequisites"), "action.prerequisites")
    constraints = case.get("constraints", {})
    if not isinstance(constraints, dict):
        raise ValueError("constraints must be an object")
    finite(constraints.get("budget_rub"), "budget_rub", 0)
    finite(constraints.get("liquidity_limit_rub"), "liquidity_limit_rub", 0)
    finite(constraints.get("min_roi", 0), "min_roi", 0)
    if (isinstance(constraints.get("max_actions"), bool) or not isinstance(constraints.get("max_actions"), int)
            or not 0 <= constraints["max_actions"] <= 10):
        raise ValueError("max_actions must be an integer 0..10")
    if case.get("objective", "base") not in {"base", "robust"}:
        raise ValueError("objective must be base or robust")
    return months


def action_grid(action):
    if not action["available"]:
        return [0.0]
    maximum, step = Decimal(str(action["max_fraction"])), Decimal(str(action["step"]))
    values = [step * i for i in range(int(maximum / step) + 1)]
    if values[-1] != maximum:
        values.append(maximum)
    return [float(value) for value in values]


def _evaluate_plan(case, fractions):
    actions = case.get("actions", [])
    months = case["horizon_months"]
    scale = months / 12 if case["kind"] == "rate_change" else 1.0
    protected, cost, cash = 0.0, 0.0, 0.0
    breakdown = []
    for action in actions:
        fraction = fractions.get(action["id"], 0)
        if not fraction:
            continue
        duration = max(0, 1 - action["lead_time_months"] / months)
        covered = fraction * action["effectiveness"]["value"] * duration
        fixed = action["fixed_cost_rub"]["value"]
        variable = fraction * action["variable_cost_rub"]["value"]
        liquidity = fraction * action["liquidity_required_rub"]["value"]
        protected += covered
        cost += fixed + variable
        cash += liquidity
        breakdown.append({"action_id": action["id"], "title": action["title"], "fraction": fraction,
                          "protected_fraction": covered, "fixed_cost_rub": fixed,
                          "variable_cost_rub": variable, "cost_rub": fixed + variable,
                          "liquidity_required_rub": liquidity, "prerequisites": action["prerequisites"]})
    outcomes = []
    for shock in case["shocks"]:
        sign = 1 if case["exposure_side"] == "cost" else -1
        baseline = sign * case["exposure_rub"]["value"] * shock["delta"]["value"] * scale
        residual = baseline * (1 - protected)
        benefit = baseline - residual
        outcome = {"scenario_id": shock["id"], "baseline_impact_rub": baseline,
                         "residual_impact_rub": residual, "action_cost_rub": cost,
                         "total_impact_and_cost_rub": residual + cost,
                         "net_saving_rub": benefit - cost,
                         "roi": (benefit - cost) / cost if cost else None}
        if any(not math.isfinite(value) for key, value in outcome.items() if key != "scenario_id" and value is not None):
            raise ValueError("Numerical overflow in shock scenario: " + shock["id"])
        outcomes.append(outcome)
    base = next(outcome for outcome in outcomes if outcome["scenario_id"] == case["base_scenario"])
    constraints = case["constraints"]
    violations = []
    if sum(fractions.values()) > 1 + 1e-12:
        violations.append("overlapping_exposure_fractions")
    if len(breakdown) > constraints["max_actions"]:
        violations.append("max_actions")
    if cost > constraints["budget_rub"] + 1e-9:
        violations.append("budget_rub")
    if cash > constraints["liquidity_limit_rub"] + 1e-9:
        violations.append("liquidity_limit_rub")
    worst_gain = min(outcome["net_saving_rub"] for outcome in outcomes)
    gain = worst_gain if case.get("objective") == "robust" else base["net_saving_rub"]
    if breakdown and gain < constraints.get("min_roi", 0) * cost - 1e-9:
        violations.append("minimum_net_roi")
    plan = {"fractions": fractions, "actions": breakdown, "cost_rub": cost,
            "liquidity_required_rub": cash, "base": base, "scenarios": outcomes,
            "worst_net_saving_rub": worst_gain, "objective_net_saving_rub": gain,
            "feasible": not violations, "constraint_violations": violations}
    if not all(math.isfinite(value) for value in (protected, cost, cash, gain)):
        raise ValueError("Numerical overflow in scenario")
    return plan


def evaluate_plan(case, fractions):
    """Evaluate a user's explicit combination; does not execute business actions."""
    validate_case(case)
    if not isinstance(fractions, dict):
        raise ValueError("Action fractions must be an object")
    actions = {action["id"]: action for action in case.get("actions", [])}
    if set(fractions) - set(actions):
        raise ValueError("Unknown action id")
    complete = {aid: finite(fractions.get(aid, 0), aid, 0, action.get("max_fraction", 0) if action["available"] else 0)
                for aid, action in actions.items()}
    return _evaluate_plan(case, complete)


def optimize_actions(case):
    missing = missing_parameters(case)
    if missing:
        return {"status": "needs_parameters", "missing_parameters": missing, "recommendation": None}
    validate_case(case)
    actions = case.get("actions", [])
    grids = [action_grid(action) for action in actions]
    size = math.prod(len(grid) for grid in grids)
    if size > MAX_COMBINATIONS:
        raise ValueError(f"Grid has {size} combinations; maximum is {MAX_COMBINATIONS}")
    if size * len(case["shocks"]) > 500000:
        raise ValueError("Too many combination/scenario evaluations; coarsen the grid")
    baseline = _evaluate_plan(case, {action["id"]: 0.0 for action in actions})
    feasible = []
    for values in product(*grids):
        if sum(values) > 1 + 1e-12 or sum(x > 0 for x in values) > case["constraints"]["max_actions"]:
            continue
        plan = _evaluate_plan(case, dict(zip((action["id"] for action in actions), values)))
        if plan["feasible"]:
            feasible.append(plan)
    # Zero intervention is always feasible and wins ties with costly/unnecessary action.
    feasible.sort(key=lambda p: (-p["objective_net_saving_rub"], p["cost_rub"], len(p["actions"]),
                                 tuple(p["fractions"].values())))
    best = feasible[0]
    near = [plan for plan in feasible if plan["objective_net_saving_rub"] >= .9 * best["objective_net_saving_rub"] - 1e-9]
    economical = min(near, key=lambda p: (p["cost_rub"], -p["objective_net_saving_rub"], len(p["actions"])))
    simple = min(near, key=lambda p: (len(p["actions"]), p["cost_rub"], -p["objective_net_saving_rub"]))
    return {"status": "conditional_scenario", "case_id": case["case_id"],
            "model": "disjoint_protection_of_linear_exposure_v1", "inputs": case,
            "objective": case.get("objective", "base"), "baseline": baseline,
            "recommendation": best, "alternatives": {"lower_cost_90pct": economical, "fewer_actions_90pct": simple},
            "decision_reason": "positive_net_saving_under_supplied_assumptions" if best["actions"] else "no_action_justified_under_supplied_assumptions",
            "search": {"method": "exhaustive_declared_grid", "combinations": size,
                       "feasible_combinations": len(feasible), "optimality_scope": "supplied_model_and_grid_only"},
            "limitations": ["Условный расчёт по заданным параметрам; причинный эффект действий не обучен на реальной истории.",
                            "Коэффициенты эффекта фиксированы. Оптимизатор меняет только доли действий.",
                            "Действия относятся к непересекающимся долям одной экспозиции. Синергия не предполагается.",
                            "Затраты задаются за весь горизонт и включают упущенную выгоду и комиссии, если они применимы.",
                            "Проверка нескольких сценариев не является доверительным интервалом."]}
