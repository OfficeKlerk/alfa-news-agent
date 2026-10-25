"""CSV normalization shared by the loader and profile builder."""

import csv
import hashlib
import re
from decimal import Decimal, InvalidOperation, localcontext
from pathlib import Path

PRODUCTS = {
    "rko": "CL_PRODUCT_RKO_MARK", "guarantee": "CL_PRODUCT_GAR_MARK",
    "loan": "CL_PRODUCT_LOA_MARK", "leasing": "CL_PRODUCT_LEA_MARK",
    "deposit": "CL_PRODUCT_DEP_MARK", "payroll": "CL_PRODUCT_ZPP_MARK",
    "factoring": "FACTORING_MARK",
}
MISSING = {"", "nan", "none", "null", "n/a", "na", "-"}
REVENUE_MULTIPLIERS = {"unknown": None, "rub": 1, "thousand_rub": 1000}


def clean(value):
    value = str(value).strip() if value is not None else ""
    return None if value.casefold() in MISSING else value


def flag(value):
    value = clean(value)
    if value is None:
        return None
    value = value.casefold()
    if value in {"1", "1.0", "true", "да", "yes"}:
        return True
    if value in {"0", "0.0", "false", "нет", "no"}:
        return False
    return None


def number(value):
    value = clean(value)
    if value is None:
        return None
    try:
        result = Decimal(re.sub(r"[\s\u00a0\u202f]", "", value).replace(",", "."))
        return result if result.is_finite() and result >= 0 else None
    except InvalidOperation:
        return None


def numeric(value):
    if value is None:
        return None
    return int(value) if value == value.to_integral() else float(value)


def exact_add(left, right):
    """Add finite Decimal amounts without ambient-context or grouping rounding."""
    precision = max(left.adjusted(), right.adjusted()) - min(left.as_tuple().exponent, right.as_tuple().exponent) + 2
    with localcontext() as context:
        context.prec = max(28, precision)
        return left + right


def exact_sum(values):
    result = Decimal(0)
    for value in values:
        result = exact_add(result, value)
    return result


def decimal_share(amount, total):
    """A JSON float ratio, independent of a caller's lower Decimal precision."""
    if not total:
        return None
    with localcontext() as context:
        context.prec = 28
        return float(amount / total)


def division(code):
    # OKVED codes cross both Python and JavaScript contracts. Python's \d also
    # accepts Unicode digit scripts that JavaScript's \d does not.
    match = re.fullmatch(r"([0-9]{2})(?:\.[0-9]{1,2}){0,2}", code) if isinstance(code, str) else None
    return match.group(1) if match else None


def sector(code):
    value = division(code)
    if value is None:
        return None
    value = int(value)
    for low, high, name in [
        (1, 3, "Сельское хозяйство"), (5, 9, "Добыча полезных ископаемых"),
        (10, 33, "Обрабатывающие производства"), (35, 35, "Энергетика"),
        (36, 39, "Водоснабжение и отходы"), (41, 43, "Строительство"),
        (45, 47, "Торговля"), (49, 53, "Транспорт и хранение"),
        (55, 56, "Гостиницы и общественное питание"), (58, 63, "Информация и связь"),
        (64, 66, "Финансы и страхование"), (68, 68, "Недвижимость"),
        (69, 75, "Профессиональная и научная деятельность"),
        (77, 82, "Административные услуги"), (84, 84, "Государственное управление"),
        (85, 85, "Образование"), (86, 88, "Здравоохранение и социальные услуги"),
        (90, 93, "Культура и спорт"), (94, 96, "Прочие услуги"),
        (97, 98, "Домашние хозяйства"), (99, 99, "Экстерриториальные организации"),
    ]:
        if low <= value <= high:
            return name
    return None


def source_info(path):
    path = Path(path)
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return {"file": path.name, "sha256": digest.hexdigest(), "bytes": path.stat().st_size}


def csv_rows(path, required):
    """Yield logical CSV record numbers (header = 1), including multiline records."""
    path = Path(path)
    # Validate encoding in streaming mode before yielding, so fallback cannot repeat rows.
    encoding = "utf-8-sig"
    try:
        with path.open(encoding=encoding) as stream:
            for _ in stream:
                pass
    except UnicodeDecodeError:
        encoding = "cp1251"
    with path.open(encoding=encoding, newline="") as stream:
        sample = stream.read(65536)
        stream.seek(0)
        try:
            # Sniffer can fail on short Windows CSVs with quoted delimiters.
            # Normalize only its sample; preserve the original stream for parsing.
            dialect = csv.Sniffer().sniff(sample.replace("\r\n", "\n").replace("\r", "\n"), delimiters=";,\t")
        except csv.Error:
            dialect = csv.excel
        reader = csv.DictReader(stream, dialect=dialect)
        headers = [h.strip() for h in (reader.fieldnames or [])]
        if len(set(headers)) != len(headers):
            raise ValueError(f"{path.name}: duplicate CSV column names")
        missing = set(required) - set(headers)
        if missing:
            raise ValueError(f"{path.name}: missing columns: {', '.join(sorted(missing))}")
        reader.fieldnames = headers
        for record, row in enumerate(reader, 2):
            if None in row:
                raise ValueError(f"{path.name}: record {record}: extra CSV fields")
            yield record, {key: clean(value) for key, value in row.items()}
