"""Comparable-sales selection and market statistics.

These are the calculations an agent would otherwise do by hand in a
spreadsheet after exporting listings: median price per square foot, days on
market, sale-to-list ratio, months of supply, and a ranked comparable set.
"""

from __future__ import annotations

import math
from statistics import median as _median
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

EARTH_RADIUS_MILES = 3958.7613


# --- Numeric helpers -------------------------------------------------------


def as_number(value: Any) -> Optional[float]:
    """Coerce a feed value to a float, returning ``None`` when not numeric."""
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value) if math.isfinite(float(value)) else None
    if isinstance(value, str):
        cleaned = value.replace(",", "").replace("$", "").strip()
        if not cleaned:
            return None
        try:
            parsed = float(cleaned)
        except ValueError:
            return None
        return parsed if math.isfinite(parsed) else None
    return None


def median(values: Iterable[Any]) -> Optional[float]:
    numbers = [n for n in (as_number(v) for v in values) if n is not None]
    return _median(numbers) if numbers else None


def average(values: Iterable[Any]) -> Optional[float]:
    numbers = [n for n in (as_number(v) for v in values) if n is not None]
    return sum(numbers) / len(numbers) if numbers else None


def haversine_miles(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Great-circle distance in statute miles."""
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    d_phi = phi2 - phi1
    d_lambda = math.radians(lon2 - lon1)
    a = math.sin(d_phi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(d_lambda / 2) ** 2
    return 2 * EARTH_RADIUS_MILES * math.asin(math.sqrt(min(1.0, a)))


def record_distance_miles(
    record: Dict[str, Any], latitude: Optional[float], longitude: Optional[float]
) -> Optional[float]:
    """Distance from a listing to a reference point, when both have coordinates."""
    if latitude is None or longitude is None:
        return None
    lat = as_number(record.get("Latitude"))
    lon = as_number(record.get("Longitude"))
    if lat is None or lon is None:
        return None
    return haversine_miles(latitude, longitude, lat, lon)


def effective_price(record: Dict[str, Any]) -> Optional[float]:
    """The price that matters for this listing: close price if sold, else list."""
    close = as_number(record.get("ClosePrice"))
    if close:
        return close
    return as_number(record.get("ListPrice"))


def price_per_sqft(record: Dict[str, Any]) -> Optional[float]:
    """Price per square foot of living area, or ``None`` if either is missing."""
    price = effective_price(record)
    area = as_number(record.get("LivingArea"))
    if price is None or area is None or area <= 0:
        return None
    return price / area


def sale_to_list_ratio(record: Dict[str, Any]) -> Optional[float]:
    """Close price divided by list price, for sold listings only."""
    close = as_number(record.get("ClosePrice"))
    listed = as_number(record.get("ListPrice"))
    if close is None or listed is None or listed <= 0:
        return None
    return close / listed


# --- Market statistics -----------------------------------------------------


def summarize_listings(
    records: Sequence[Dict[str, Any]], *, months: Optional[float] = None
) -> Dict[str, Any]:
    """Compute headline market statistics for a set of listings.

    Args:
        records: Listing dicts as returned by the feed.
        months: Length of the closed-sales window, used for months of supply.

    Returns:
        A dict with counts by status and median/average price, price per square
        foot, days on market and sale-to-list ratio. Values are ``None`` when
        the underlying data is absent rather than being reported as zero.
    """
    status_counts: Dict[str, int] = {}
    for record in records:
        status = str(record.get("StandardStatus") or "Unknown")
        status_counts[status] = status_counts.get(status, 0) + 1

    sold = [r for r in records if r.get("StandardStatus") == "Closed"]
    active = [r for r in records if r.get("StandardStatus") in ("Active", "Coming Soon")]

    sold_ppsf = [v for v in (price_per_sqft(r) for r in sold) if v is not None]
    active_ppsf = [v for v in (price_per_sqft(r) for r in active) if v is not None]
    ratios = [v for v in (sale_to_list_ratio(r) for r in sold) if v is not None]

    months_of_supply: Optional[float] = None
    if months and months > 0 and sold:
        monthly_absorption = len(sold) / months
        if monthly_absorption > 0:
            months_of_supply = len(active) / monthly_absorption

    return {
        "listings_analyzed": len(records),
        "status_counts": dict(sorted(status_counts.items())),
        "active_count": len(active),
        "closed_count": len(sold),
        "median_list_price": median(r.get("ListPrice") for r in active) if active else None,
        "median_close_price": median(r.get("ClosePrice") for r in sold) if sold else None,
        "average_close_price": average(r.get("ClosePrice") for r in sold) if sold else None,
        "median_close_price_per_sqft": _median(sold_ppsf) if sold_ppsf else None,
        "median_list_price_per_sqft": _median(active_ppsf) if active_ppsf else None,
        "median_days_on_market_sold": median(r.get("DaysOnMarket") for r in sold) if sold else None,
        "median_days_on_market_active": (
            median(r.get("DaysOnMarket") for r in active) if active else None
        ),
        "median_sale_to_list_ratio": _median(ratios) if ratios else None,
        "months_of_supply": months_of_supply,
    }


# --- Comparable selection --------------------------------------------------


def _closeness(subject: Optional[float], candidate: Optional[float], tolerance: float) -> float:
    """Score two values 1.0 (identical) to 0.0 (a full tolerance apart or worse).

    Returns a neutral 0.5 when either side is missing, so a listing is neither
    rewarded nor eliminated for incomplete data.
    """
    if subject is None or candidate is None or tolerance <= 0:
        return 0.5
    delta = abs(subject - candidate)
    return max(0.0, 1.0 - delta / tolerance)


def score_comparable(
    subject: Dict[str, Any],
    candidate: Dict[str, Any],
    *,
    max_distance_miles: float = 2.0,
) -> Tuple[float, Dict[str, Any]]:
    """Score how comparable ``candidate`` is to ``subject``.

    The weighting mirrors how an appraiser reasons: living area and location
    dominate, then bedroom/bathroom count, then age of the home.

    Returns:
        A ``(score, detail)`` pair where score runs 0.0-1.0, higher is closer.
    """
    subject_area = as_number(subject.get("LivingArea"))
    candidate_area = as_number(candidate.get("LivingArea"))
    # Compare living area against a tolerance of 30% of the subject's size, so
    # the same absolute delta matters more on a small home than a large one.
    area_tolerance = (subject_area * 0.3) if subject_area else 600.0

    distance = record_distance_miles(
        candidate,
        as_number(subject.get("Latitude")),
        as_number(subject.get("Longitude")),
    )
    distance_score = (
        _closeness(0.0, distance, max_distance_miles) if distance is not None else 0.5
    )

    components = {
        "living_area": (_closeness(subject_area, candidate_area, area_tolerance), 0.30),
        "distance": (distance_score, 0.25),
        "bedrooms": (
            _closeness(
                as_number(subject.get("BedroomsTotal")),
                as_number(candidate.get("BedroomsTotal")),
                2.0,
            ),
            0.15,
        ),
        "bathrooms": (
            _closeness(
                as_number(subject.get("BathroomsTotalInteger")),
                as_number(candidate.get("BathroomsTotalInteger")),
                2.0,
            ),
            0.15,
        ),
        "year_built": (
            _closeness(
                as_number(subject.get("YearBuilt")),
                as_number(candidate.get("YearBuilt")),
                25.0,
            ),
            0.15,
        ),
    }

    score = sum(value * weight for value, weight in components.values())
    detail = {
        "similarity_score": round(score, 4),
        "distance_miles": round(distance, 2) if distance is not None else None,
        "living_area_delta": (
            int(candidate_area - subject_area)
            if subject_area is not None and candidate_area is not None
            else None
        ),
        "price_per_sqft": (
            round(price_per_sqft(candidate), 2) if price_per_sqft(candidate) else None
        ),
        "component_scores": {name: round(value, 3) for name, (value, _) in components.items()},
    }
    return score, detail


def rank_comparables(
    subject: Dict[str, Any],
    candidates: Sequence[Dict[str, Any]],
    *,
    limit: int = 10,
    max_distance_miles: float = 2.0,
) -> List[Dict[str, Any]]:
    """Return the ``limit`` most comparable listings, best match first.

    The subject listing is excluded if it appears among the candidates.
    """
    subject_key = subject.get("ListingKey")
    ranked: List[Dict[str, Any]] = []

    for candidate in candidates:
        if subject_key and candidate.get("ListingKey") == subject_key:
            continue
        score, detail = score_comparable(
            subject, candidate, max_distance_miles=max_distance_miles
        )
        enriched = dict(candidate)
        enriched["_comparison"] = detail
        enriched["_score"] = score
        ranked.append(enriched)

    ranked.sort(key=lambda record: record["_score"], reverse=True)
    return ranked[:limit]


def comparable_summary(comparables: Sequence[Dict[str, Any]]) -> Dict[str, Any]:
    """Aggregate a ranked comparable set into a valuation-oriented summary."""
    ppsf = [v for v in (price_per_sqft(c) for c in comparables) if v is not None]
    prices = [v for v in (effective_price(c) for c in comparables) if v is not None]
    return {
        "comparable_count": len(comparables),
        "median_price": _median(prices) if prices else None,
        "price_range": [min(prices), max(prices)] if prices else None,
        "median_price_per_sqft": _median(ppsf) if ppsf else None,
        "price_per_sqft_range": [min(ppsf), max(ppsf)] if ppsf else None,
        "median_days_on_market": median(c.get("DaysOnMarket") for c in comparables),
    }


def estimate_value(
    subject: Dict[str, Any], comparables: Sequence[Dict[str, Any]]
) -> Optional[Dict[str, Any]]:
    """Indicate a value range for the subject from comparable price per sqft.

    This is a mechanical calculation from the comp set, not an appraisal: it
    applies the comps' median and range of price per square foot to the
    subject's living area and makes no condition or upgrade adjustments.
    """
    area = as_number(subject.get("LivingArea"))
    ppsf = [v for v in (price_per_sqft(c) for c in comparables) if v is not None]
    if area is None or area <= 0 or not ppsf:
        return None
    ordered = sorted(ppsf)
    low = ordered[len(ordered) // 4]
    high = ordered[(3 * len(ordered)) // 4] if len(ordered) > 1 else ordered[-1]
    return {
        "living_area": area,
        "median_price_per_sqft": round(_median(ordered), 2),
        "indicated_value": round(_median(ordered) * area),
        "indicated_range": [round(low * area), round(high * area)],
        "basis": f"{len(ordered)} comparables with living area and price",
        "caveat": (
            "Mechanical price-per-square-foot calculation from the comparable set. "
            "No adjustments for condition, upgrades, view or lot. Not an appraisal or CMA."
        ),
    }
