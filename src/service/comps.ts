import type { NormalizedListing, StandardStatus } from '../models/normalized.js';

/**
 * Comparable evidence engine.
 *
 * This engine RETRIEVES and RANKS evidence against objective, caller-visible
 * tolerances. It does not produce an opinion of value, a suggested list price,
 * or an adjusted value conclusion — that judgment stays with Blaise and the
 * controlling CMA workflow. Every candidate is reported with the exact reason
 * it was included or rejected.
 */

export interface CompTolerances {
  living_area_tolerance_pct: number;
  year_built_tolerance_years: number;
  bed_tolerance: number;
  bath_tolerance: number;
  closed_within_days: number;
  require_same_property_sub_type: boolean;
  statuses: StandardStatus[];
  max_comps: number;
}

export const DEFAULT_TOLERANCES: CompTolerances = {
  living_area_tolerance_pct: 0.25,
  year_built_tolerance_years: 15,
  bed_tolerance: 1,
  bath_tolerance: 1,
  closed_within_days: 365,
  require_same_property_sub_type: true,
  statuses: ['Closed'],
  max_comps: 8
};

export interface DimensionDifference {
  dimension: string;
  subject_value: number | string | null;
  candidate_value: number | string | null;
  difference: number | null;
  /** Fraction of the tolerance consumed (0 = identical, 1 = at the limit). */
  normalized_distance: number | null;
  within_tolerance: boolean | null;
  status: 'compared' | 'unavailable';
}

export interface CompCandidate {
  listing_key: string;
  listing_id: string | null;
  address: string | null;
  standard_status: StandardStatus | null;
  close_date: string | null;
  close_price: number | null;
  list_price: number | null;
  living_area_sqft: number | null;
  bedrooms_total: number | null;
  bathrooms_total: number | null;
  year_built: number | null;
  price_per_finished_sqft: number | null;
  differences: DimensionDifference[];
  /** 0 = identical on every compared dimension; higher = less similar. Ranking only. */
  similarity_distance: number | null;
  /** Share of the scoring weight that had data available on both sides. */
  weight_coverage: number;
  included: boolean;
  rejection_reasons: string[];
  similarity_rationale: string;
}

export interface CompResult {
  subject: {
    listing_key: string | null;
    listing_id: string | null;
    address: string | null;
    living_area_sqft: number | null;
    bedrooms_total: number | null;
    bathrooms_total: number | null;
    year_built: number | null;
    property_sub_type: string | null;
  };
  tolerances: CompTolerances;
  candidates_evaluated: number;
  included: CompCandidate[];
  rejected: CompCandidate[];
  scoring: {
    weights: Record<string, number>;
    method: string;
    minimum_weight_coverage: number;
  };
  judgment_boundary: string;
}

/** Deterministic scoring weights. Exposed in every response. */
export const SCORING_WEIGHTS: Record<string, number> = {
  living_area_sqft: 0.35,
  close_recency: 0.15,
  year_built: 0.15,
  bedrooms_total: 0.15,
  bathrooms_total: 0.1,
  lot_size_acres: 0.1
};

/** A candidate scored on less than this share of the weight is rejected as under-evidenced. */
export const MIN_WEIGHT_COVERAGE = 0.5;

export const JUDGMENT_BOUNDARY =
  'This is comparable EVIDENCE retrieval and objective ranking only. Similarity distance measures how close a ' +
  'candidate is to the subject on the stated dimensions — it is not an adjusted value, an opinion of value, or a ' +
  'recommended list price. Pricing judgment remains with the controlling CMA workflow.';

function daysBetween(fromIso: string, toIso: string): number | null {
  const a = new Date(`${fromIso.slice(0, 10)}T00:00:00Z`).getTime();
  const b = new Date(`${toIso.slice(0, 10)}T00:00:00Z`).getTime();
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((b - a) / 86_400_000);
}

function compareNumeric(
  dimension: string,
  subjectValue: number | null,
  candidateValue: number | null,
  tolerance: number | null
): DimensionDifference {
  if (subjectValue === null || candidateValue === null) {
    return {
      dimension,
      subject_value: subjectValue,
      candidate_value: candidateValue,
      difference: null,
      normalized_distance: null,
      within_tolerance: null,
      status: 'unavailable'
    };
  }
  const difference = candidateValue - subjectValue;
  const normalized = tolerance !== null && tolerance > 0 ? Math.abs(difference) / tolerance : null;
  return {
    dimension,
    subject_value: subjectValue,
    candidate_value: candidateValue,
    difference: Math.round(difference * 1000) / 1000,
    normalized_distance: normalized === null ? null : Math.round(normalized * 10_000) / 10_000,
    within_tolerance: normalized === null ? null : normalized <= 1,
    status: 'compared'
  };
}

export interface CompEvaluationContext {
  /** Date the comparison is anchored to, for close-recency scoring (ISO date). */
  asOfDate: string;
}

function evaluateCandidate(
  subject: NormalizedListing,
  candidate: NormalizedListing,
  tol: CompTolerances,
  ctx: CompEvaluationContext
): CompCandidate {
  const reasons: string[] = [];
  const differences: DimensionDifference[] = [];

  // --- Hard eligibility gates ---
  if (candidate.listing_key === subject.listing_key) {
    reasons.push('Candidate is the subject property.');
  }
  if (candidate.standard_status === null) {
    reasons.push('Candidate has no recognized StandardStatus; status eligibility cannot be proven.');
  } else if (!tol.statuses.includes(candidate.standard_status)) {
    reasons.push(
      `Status ${candidate.standard_status} is outside the requested comparable statuses (${tol.statuses.join(', ')}).`
    );
  }
  if (
    tol.require_same_property_sub_type &&
    (subject.property_sub_type === null ||
      candidate.property_sub_type === null ||
      subject.property_sub_type.toLowerCase() !== candidate.property_sub_type.toLowerCase())
  ) {
    reasons.push(
      `Property sub type differs or is unknown (subject: ${subject.property_sub_type ?? 'unknown'}, ` +
        `candidate: ${candidate.property_sub_type ?? 'unknown'}).`
    );
  }

  // --- Close recency ---
  let recencyDays: number | null = null;
  if (tol.statuses.includes('Closed')) {
    if (candidate.close_date === null) {
      if (candidate.standard_status === 'Closed') {
        reasons.push('Closed candidate has no CloseDate; close recency cannot be verified.');
      }
      differences.push({
        dimension: 'close_recency_days',
        subject_value: ctx.asOfDate,
        candidate_value: null,
        difference: null,
        normalized_distance: null,
        within_tolerance: null,
        status: 'unavailable'
      });
    } else {
      recencyDays = daysBetween(candidate.close_date, ctx.asOfDate);
      const normalized = recencyDays === null ? null : Math.abs(recencyDays) / tol.closed_within_days;
      differences.push({
        dimension: 'close_recency_days',
        subject_value: ctx.asOfDate,
        candidate_value: candidate.close_date,
        difference: recencyDays,
        normalized_distance: normalized === null ? null : Math.round(normalized * 10_000) / 10_000,
        within_tolerance: normalized === null ? null : normalized <= 1,
        status: recencyDays === null ? 'unavailable' : 'compared'
      });
      if (recencyDays !== null && recencyDays > tol.closed_within_days) {
        reasons.push(
          `Closed ${recencyDays} days ago, beyond the ${tol.closed_within_days}-day close-recency window.`
        );
      }
    }
  }

  // --- Scored dimensions ---
  const areaTolerance =
    subject.living_area_sqft !== null ? subject.living_area_sqft * tol.living_area_tolerance_pct : null;
  const areaDiff = compareNumeric('living_area_sqft', subject.living_area_sqft, candidate.living_area_sqft, areaTolerance);
  differences.push(areaDiff);
  if (areaDiff.within_tolerance === false) {
    reasons.push(
      `Living area ${candidate.living_area_sqft} sqft is outside ±${Math.round(
        tol.living_area_tolerance_pct * 100
      )}% of the subject's ${subject.living_area_sqft} sqft.`
    );
  }

  const yearDiff = compareNumeric('year_built', subject.year_built, candidate.year_built, tol.year_built_tolerance_years);
  differences.push(yearDiff);
  if (yearDiff.within_tolerance === false) {
    reasons.push(
      `Year built ${candidate.year_built} is outside ±${tol.year_built_tolerance_years} years of the subject's ${subject.year_built}.`
    );
  }

  const bedDiff = compareNumeric('bedrooms_total', subject.bedrooms_total, candidate.bedrooms_total, tol.bed_tolerance);
  differences.push(bedDiff);
  if (bedDiff.within_tolerance === false) {
    reasons.push(
      `Bedroom count ${candidate.bedrooms_total} is outside ±${tol.bed_tolerance} of the subject's ${subject.bedrooms_total}.`
    );
  }

  const bathDiff = compareNumeric(
    'bathrooms_total',
    subject.bathrooms_total,
    candidate.bathrooms_total,
    tol.bath_tolerance
  );
  differences.push(bathDiff);
  if (bathDiff.within_tolerance === false) {
    reasons.push(
      `Bathroom count ${candidate.bathrooms_total} is outside ±${tol.bath_tolerance} of the subject's ${subject.bathrooms_total}.`
    );
  }

  const lotTolerance = subject.lot_size_acres !== null ? Math.max(subject.lot_size_acres * 0.5, 0.05) : null;
  const lotDiff = compareNumeric('lot_size_acres', subject.lot_size_acres, candidate.lot_size_acres, lotTolerance);
  differences.push(lotDiff);

  // --- Weighted similarity distance over available dimensions only ---
  const dimensionScores: Array<[string, number | null]> = [
    ['living_area_sqft', areaDiff.normalized_distance],
    ['close_recency', differences.find((d) => d.dimension === 'close_recency_days')?.normalized_distance ?? null],
    ['year_built', yearDiff.normalized_distance],
    ['bedrooms_total', bedDiff.normalized_distance],
    ['bathrooms_total', bathDiff.normalized_distance],
    ['lot_size_acres', lotDiff.normalized_distance]
  ];

  let weightedSum = 0;
  let availableWeight = 0;
  for (const [key, value] of dimensionScores) {
    const weight = SCORING_WEIGHTS[key];
    if (weight === undefined) continue;
    // A dimension not requested (e.g. close recency for an active comparison)
    // contributes no weight rather than a penalty.
    if (key === 'close_recency' && !tol.statuses.includes('Closed')) continue;
    if (value === null) continue;
    weightedSum += weight * value;
    availableWeight += weight;
  }

  const totalPossibleWeight = Object.entries(SCORING_WEIGHTS).reduce(
    (sum, [key, w]) => (key === 'close_recency' && !tol.statuses.includes('Closed') ? sum : sum + w),
    0
  );
  const coverage = totalPossibleWeight > 0 ? availableWeight / totalPossibleWeight : 0;
  const distance = availableWeight > 0 ? Math.round((weightedSum / availableWeight) * 10_000) / 10_000 : null;

  if (coverage < MIN_WEIGHT_COVERAGE) {
    reasons.push(
      `Insufficient comparable data: only ${Math.round(coverage * 100)}% of the scoring dimensions had values on ` +
        `both the subject and the candidate (minimum ${Math.round(MIN_WEIGHT_COVERAGE * 100)}%).`
    );
  }

  const compared = differences.filter((d) => d.status === 'compared');
  const unavailable = differences.filter((d) => d.status === 'unavailable').map((d) => d.dimension);
  const rationale =
    reasons.length === 0
      ? `Within every stated tolerance on ${compared.length} compared dimension(s); weighted similarity distance ` +
        `${distance ?? 'n/a'} (0 = identical on compared dimensions).` +
        (unavailable.length > 0 ? ` Not compared for missing data: ${unavailable.join(', ')}.` : '')
      : `Rejected: ${reasons.join(' ')}`;

  const pricePerSqft =
    candidate.close_price !== null && candidate.living_area_sqft !== null && candidate.living_area_sqft > 0
      ? Math.round((candidate.close_price / candidate.living_area_sqft) * 100) / 100
      : candidate.list_price !== null && candidate.living_area_sqft !== null && candidate.living_area_sqft > 0
        ? Math.round((candidate.list_price / candidate.living_area_sqft) * 100) / 100
        : null;

  return {
    listing_key: candidate.listing_key,
    listing_id: candidate.listing_id,
    address: candidate.address.unparsed,
    standard_status: candidate.standard_status,
    close_date: candidate.close_date,
    close_price: candidate.close_price,
    list_price: candidate.list_price,
    living_area_sqft: candidate.living_area_sqft,
    bedrooms_total: candidate.bedrooms_total,
    bathrooms_total: candidate.bathrooms_total,
    year_built: candidate.year_built,
    price_per_finished_sqft: pricePerSqft,
    differences,
    similarity_distance: distance,
    weight_coverage: Math.round(coverage * 10_000) / 10_000,
    included: reasons.length === 0,
    rejection_reasons: reasons,
    similarity_rationale: rationale
  };
}

export function selectComparables(
  subject: NormalizedListing,
  candidates: NormalizedListing[],
  tolerances: CompTolerances,
  ctx: CompEvaluationContext
): CompResult {
  const evaluated = candidates.map((c) => evaluateCandidate(subject, c, tolerances, ctx));

  const included = evaluated
    .filter((c) => c.included)
    // Deterministic ordering: closest first, then listing key to break ties stably.
    .sort((a, b) => {
      const da = a.similarity_distance ?? Number.POSITIVE_INFINITY;
      const db = b.similarity_distance ?? Number.POSITIVE_INFINITY;
      if (da !== db) return da - db;
      return a.listing_key.localeCompare(b.listing_key);
    });

  const overflow = included.slice(tolerances.max_comps).map((c) => ({
    ...c,
    included: false,
    rejection_reasons: [
      `Ranked beyond the requested max_comps (${tolerances.max_comps}); eligible but not in the top set.`
    ]
  }));

  const rejected = [...evaluated.filter((c) => !c.included), ...overflow].sort((a, b) =>
    a.listing_key.localeCompare(b.listing_key)
  );

  return {
    subject: {
      listing_key: subject.listing_key,
      listing_id: subject.listing_id,
      address: subject.address.unparsed,
      living_area_sqft: subject.living_area_sqft,
      bedrooms_total: subject.bedrooms_total,
      bathrooms_total: subject.bathrooms_total,
      year_built: subject.year_built,
      property_sub_type: subject.property_sub_type
    },
    tolerances,
    candidates_evaluated: evaluated.length,
    included: included.slice(0, tolerances.max_comps),
    rejected,
    scoring: {
      weights: SCORING_WEIGHTS,
      method:
        'Each dimension is normalized to the fraction of its tolerance consumed, then averaged using the stated ' +
        'weights across only the dimensions with data on both sides. Lower is closer. Ties break on listing key.',
      minimum_weight_coverage: MIN_WEIGHT_COVERAGE
    },
    judgment_boundary: JUDGMENT_BOUNDARY
  };
}
