"""Safe construction of OData v4 query strings for RESO Web API feeds.

Every value that reaches a ``$filter`` expression passes through
:func:`quote_literal`, and every field name through :func:`validate_field`.
This keeps caller-supplied text (city names, keyword searches, agent names)
from breaking out of a string literal and rewriting the query.
"""

from __future__ import annotations

import re
from datetime import date, datetime, timezone
from typing import Any, Iterable, List, Optional, Sequence, Union

# RESO/OData identifiers are alphanumeric; '/' allows navigation properties
# such as "Media/MediaURL" and '.' allows namespace-qualified casts.
_FIELD_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*(?:[/.][A-Za-z_][A-Za-z0-9_]*)*$")

COMPARISON_OPERATORS = {"eq", "ne", "gt", "ge", "lt", "le"}

Number = Union[int, float]


class ODataError(ValueError):
    """Raised when a query cannot be built safely."""


def validate_field(name: str) -> str:
    """Return ``name`` if it is a syntactically valid OData field path.

    Raises:
        ODataError: If the name contains anything but identifier characters,
            which would allow arbitrary expressions to be injected.
    """
    if not isinstance(name, str) or not _FIELD_RE.match(name):
        raise ODataError(
            f"Invalid field name {name!r}. Field names must look like "
            "'ListPrice' or 'Media/MediaURL' — letters, digits and underscores only."
        )
    return name


def quote_literal(value: str) -> str:
    """Escape and quote a string for use as an OData literal.

    OData escapes a single quote by doubling it, so ``O'Brien`` becomes
    ``'O''Brien'``. Control characters are stripped because no MLS field
    legitimately contains them and some gateways mishandle them.
    """
    if not isinstance(value, str):
        raise ODataError(f"Expected a string literal, got {type(value).__name__}")
    cleaned = "".join(ch for ch in value if ch == "\t" or ch >= " ")
    return "'" + cleaned.replace("'", "''") + "'"


def format_number(value: Number) -> str:
    """Render a number as an OData numeric literal (never scientific notation)."""
    if isinstance(value, bool):  # bool is a subclass of int; reject it explicitly
        raise ODataError("Booleans are not numeric literals; use format_boolean")
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        return f"{value:.6f}".rstrip("0").rstrip(".") or "0"
    raise ODataError(f"Expected a number, got {type(value).__name__}")


def format_boolean(value: bool) -> str:
    return "true" if value else "false"


def format_datetime(value: Union[str, date, datetime]) -> str:
    """Render a date or datetime as an ``Edm.DateTimeOffset`` literal.

    RESO timestamp fields (``ModificationTimestamp``, ``CloseDate`` on some
    feeds) are DateTimeOffset, which OData v4 writes unquoted and in UTC.
    """
    if isinstance(value, str):
        parsed = parse_datetime(value)
    elif isinstance(value, datetime):
        parsed = value
    elif isinstance(value, date):
        parsed = datetime(value.year, value.month, value.day, tzinfo=timezone.utc)
    else:
        raise ODataError(f"Expected a date, got {type(value).__name__}")
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def format_date(value: Union[str, date, datetime]) -> str:
    """Render a value as a bare ``Edm.Date`` literal (``2024-01-31``)."""
    if isinstance(value, str):
        parsed = parse_datetime(value)
    elif isinstance(value, datetime):
        parsed = value
    elif isinstance(value, date):
        return value.isoformat()
    else:
        raise ODataError(f"Expected a date, got {type(value).__name__}")
    return parsed.date().isoformat()


def parse_datetime(value: str) -> datetime:
    """Parse an ISO-8601 date or datetime string, tolerating a trailing ``Z``."""
    text = value.strip()
    if not text:
        raise ODataError("Empty date string")
    normalized = text[:-1] + "+00:00" if text.endswith("Z") else text
    try:
        return datetime.fromisoformat(normalized)
    except ValueError:
        pass
    try:
        return datetime.combine(date.fromisoformat(text), datetime.min.time(), timezone.utc)
    except ValueError as exc:
        raise ODataError(
            f"Could not parse {value!r} as a date. Use ISO-8601, "
            "for example '2024-01-31' or '2024-01-31T00:00:00Z'."
        ) from exc


def compare(field: str, operator: str, literal: str) -> str:
    """Build a single comparison clause from an already-formatted literal."""
    if operator not in COMPARISON_OPERATORS:
        raise ODataError(
            f"Unsupported operator {operator!r}. "
            f"Use one of: {', '.join(sorted(COMPARISON_OPERATORS))}"
        )
    return f"{validate_field(field)} {operator} {literal}"


def eq_string(field: str, value: str) -> str:
    return compare(field, "eq", quote_literal(value))


def compare_number(field: str, operator: str, value: Number) -> str:
    return compare(field, operator, format_number(value))


def compare_datetime(field: str, operator: str, value: Union[str, date, datetime]) -> str:
    return compare(field, operator, format_datetime(value))


def eq_boolean(field: str, value: bool) -> str:
    return compare(field, "eq", format_boolean(value))


def contains(field: str, value: str) -> str:
    """Case-sensitive substring match. Feeds vary on collation."""
    return f"contains({validate_field(field)},{quote_literal(value)})"


def any_of(field: str, values: Iterable[str]) -> str:
    """Match a field against several string values.

    Rendered as ``(F eq 'a' or F eq 'b')`` rather than the OData ``in``
    operator, because ``in`` is optional in the RESO Web API Core spec and
    several production feeds reject it.
    """
    clauses = [eq_string(field, value) for value in values]
    if not clauses:
        raise ODataError(f"any_of({field!r}) needs at least one value")
    if len(clauses) == 1:
        return clauses[0]
    return group(" or ".join(clauses))


def group(expression: str) -> str:
    return f"({expression})"


def combine(clauses: Sequence[str], operator: str = "and") -> Optional[str]:
    """Join non-empty clauses, parenthesising when mixing operators."""
    if operator not in {"and", "or"}:
        raise ODataError("combine() operator must be 'and' or 'or'")
    parts = [clause for clause in clauses if clause]
    if not parts:
        return None
    if len(parts) == 1:
        return parts[0]
    return f" {operator} ".join(parts)


def build_query(
    *,
    filter_expression: Optional[str] = None,
    select: Optional[Sequence[str]] = None,
    order_by: Optional[str] = None,
    top: Optional[int] = None,
    skip: Optional[int] = None,
    count: bool = False,
    expand: Optional[str] = None,
) -> dict:
    """Assemble the ``$``-prefixed OData system query options."""
    params: dict = {}
    if filter_expression:
        params["$filter"] = filter_expression
    if select:
        params["$select"] = ",".join(validate_field(name) for name in select)
    if order_by:
        params["$orderby"] = validate_order_by(order_by)
    if top is not None:
        params["$top"] = str(int(top))
    if skip:
        params["$skip"] = str(int(skip))
    if count:
        params["$count"] = "true"
    if expand:
        params["$expand"] = expand
    return params


def validate_order_by(order_by: str) -> str:
    """Validate an ``$orderby`` clause such as ``ListPrice desc,City asc``."""
    normalized: List[str] = []
    for term in order_by.split(","):
        parts = term.strip().split()
        if not parts or len(parts) > 2:
            raise ODataError(
                f"Invalid $orderby term {term!r}. Use 'FieldName' or 'FieldName desc'."
            )
        field = validate_field(parts[0])
        if len(parts) == 1:
            normalized.append(field)
            continue
        direction = parts[1].lower()
        if direction not in {"asc", "desc"}:
            raise ODataError(
                f"Invalid sort direction {parts[1]!r} in {term!r}. Use 'asc' or 'desc'."
            )
        normalized.append(f"{field} {direction}")
    if not normalized:
        raise ODataError("Empty $orderby clause")
    return ",".join(normalized)


def range_clauses(
    field: str,
    minimum: Optional[Any] = None,
    maximum: Optional[Any] = None,
    kind: str = "number",
) -> List[str]:
    """Build ``>=`` / ``<=`` clauses for an inclusive range.

    Args:
        field: RESO field name, e.g. ``ListPrice``.
        minimum: Lower bound, inclusive. Ignored when ``None``.
        maximum: Upper bound, inclusive. Ignored when ``None``.
        kind: ``"number"`` or ``"datetime"``.
    """
    if kind not in {"number", "datetime"}:
        raise ODataError("range_clauses kind must be 'number' or 'datetime'")
    builder = compare_number if kind == "number" else compare_datetime
    clauses: List[str] = []
    if minimum is not None:
        clauses.append(builder(field, "ge", minimum))
    if maximum is not None:
        clauses.append(builder(field, "le", maximum))
    return clauses
