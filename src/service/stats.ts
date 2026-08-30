import type { NormalizedListing } from '../models/normalized.js';

/**
 * Market statistics engine.
 *
 * Every number here is computed in-process from retrieved MLS records using a
 * stated formula. Nothing is estimated, modeled, or inferred. Each metric
 * reports its own sample size and how many records were excluded for a missing
 * input, so a thin sample can never masquerade as a market fact.
 */

export interface MetricResult {
  value: number | null;
  sample_size: number;
  excluded_missing_input: number;
  definition: string;
}

export interface PriceBand {
  lower: number;
  /** Exclusive upper bound. */
  upper: number;
  count: number;
}

export interface CohortStats {
  cohort: 'active' | 'pending' | 'closed';
  cohort_definition: string;
  record_count: number;
  metrics: Record<string, MetricResult>;
  price_bands: PriceBand[];
  price_band_field: string;
  price_band_size: number;
}

export interface StatsMethodology {
  median: string;
  mean: string;
  null_handling: string;
  ratios: string;
  price_per_sqft: string;
  price_bands: string;
  rounding: string;
  data_scope: string;
}

export const METHODOLOGY: StatsMethodology = {
  median:
    'Values sorted ascending; for an odd sample the middle value, for an even sample the arithmetic mean of the two central values.',
  mean: 'Arithmetic mean of the non-null sample.',
  null_handling:
    'A record missing an input for a metric is excluded from that metric only, and counted in excluded_missing_input. Missing values are never imputed, defaulted, or carried forward.',
  ratios:
    'Ratios are computed per record and then medianed/averaged across records — not computed as a ratio of aggregates. Records missing either side of the ratio, or with a non-positive denominator, are excluded.',
  price_per_sqft:
    'Price divided by living area for each record with both values present and living area greater than zero. Closed cohorts use close price; active and pending cohorts use list price.',
  price_bands:
    'Records bucketed by floor(price / band_size) * band_size over the cohort price field. Records missing the price field are excluded from banding.',
  rounding: 'Currency metrics rounded to whole dollars; ratios to 4 decimals; other metrics to 2 decimals.',
  data_scope:
    'All metrics are computed strictly from the records retrieved by the stated query. If the retrieval was capped or incomplete, the statistics describe only the retrieved subset.'
};

function round(value: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

type Extractor = (l: NormalizedListing) => number | null;

interface MetricSpec {
  key: string;
  definition: string;
  extract: Extractor;
  aggregate: 'median' | 'mean';
  decimals: number;
}

function computeMetric(records: NormalizedListing[], spec: MetricSpec): MetricResult {
  const values: number[] = [];
  let excluded = 0;
  for (const r of records) {
    const v = spec.extract(r);
    if (v === null || !Number.isFinite(v)) excluded += 1;
    else values.push(v);
  }
  const raw = spec.aggregate === 'median' ? median(values) : mean(values);
  return {
    value: raw === null ? null : round(raw, spec.decimals),
    sample_size: values.length,
    excluded_missing_input: excluded,
    definition: spec.definition
  };
}

function ratio(numerator: number | null, denominator: number | null): number | null {
  if (numerator === null || denominator === null || denominator <= 0) return null;
  return numerator / denominator;
}

function priceBands(records: NormalizedListing[], field: Extractor, bandSize: number): PriceBand[] {
  const buckets = new Map<number, number>();
  for (const r of records) {
    const v = field(r);
    if (v === null || !Number.isFinite(v)) continue;
    const lower = Math.floor(v / bandSize) * bandSize;
    buckets.set(lower, (buckets.get(lower) ?? 0) + 1);
  }
  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([lower, count]) => ({ lower, upper: lower + bandSize, count }));
}

const ACTIVE_METRICS: MetricSpec[] = [
  {
    key: 'median_list_price',
    definition: 'Median ListPrice across active records with a list price.',
    extract: (l) => l.list_price,
    aggregate: 'median',
    decimals: 0
  },
  {
    key: 'average_list_price',
    definition: 'Mean ListPrice across active records with a list price.',
    extract: (l) => l.list_price,
    aggregate: 'mean',
    decimals: 0
  },
  {
    key: 'median_days_on_market',
    definition: 'Median DaysOnMarket across active records reporting DOM.',
    extract: (l) => l.days_on_market,
    aggregate: 'median',
    decimals: 2
  },
  {
    key: 'average_days_on_market',
    definition: 'Mean DaysOnMarket across active records reporting DOM.',
    extract: (l) => l.days_on_market,
    aggregate: 'mean',
    decimals: 2
  },
  {
    key: 'median_price_per_finished_sqft',
    definition: 'Median of (ListPrice / LivingArea) per record, for records with both values and positive area.',
    extract: (l) => ratio(l.list_price, l.living_area_sqft),
    aggregate: 'median',
    decimals: 2
  },
  {
    key: 'median_living_area_sqft',
    definition: 'Median LivingArea across active records reporting living area.',
    extract: (l) => l.living_area_sqft,
    aggregate: 'median',
    decimals: 2
  },
  {
    key: 'average_living_area_sqft',
    definition: 'Mean LivingArea across active records reporting living area.',
    extract: (l) => l.living_area_sqft,
    aggregate: 'mean',
    decimals: 2
  }
];

const CLOSED_METRICS: MetricSpec[] = [
  {
    key: 'median_sale_price',
    definition: 'Median ClosePrice across closed records with a close price.',
    extract: (l) => l.close_price,
    aggregate: 'median',
    decimals: 0
  },
  {
    key: 'average_sale_price',
    definition: 'Mean ClosePrice across closed records with a close price.',
    extract: (l) => l.close_price,
    aggregate: 'mean',
    decimals: 0
  },
  {
    key: 'median_list_price',
    definition: 'Median ListPrice across closed records with a list price.',
    extract: (l) => l.list_price,
    aggregate: 'median',
    decimals: 0
  },
  {
    key: 'median_days_on_market',
    definition: 'Median DaysOnMarket across closed records reporting DOM.',
    extract: (l) => l.days_on_market,
    aggregate: 'median',
    decimals: 2
  },
  {
    key: 'average_days_on_market',
    definition: 'Mean DaysOnMarket across closed records reporting DOM.',
    extract: (l) => l.days_on_market,
    aggregate: 'mean',
    decimals: 2
  },
  {
    key: 'median_price_per_finished_sqft',
    definition: 'Median of (ClosePrice / LivingArea) per record, for records with both values and positive area.',
    extract: (l) => ratio(l.close_price, l.living_area_sqft),
    aggregate: 'median',
    decimals: 2
  },
  {
    key: 'median_sale_to_list_ratio',
    definition: 'Median of (ClosePrice / ListPrice) per record, for records with both values.',
    extract: (l) => ratio(l.close_price, l.list_price),
    aggregate: 'median',
    decimals: 4
  },
  {
    key: 'median_sale_to_original_list_ratio',
    definition: 'Median of (ClosePrice / OriginalListPrice) per record, for records with both values.',
    extract: (l) => ratio(l.close_price, l.original_list_price),
    aggregate: 'median',
    decimals: 4
  },
  {
    key: 'median_seller_concessions',
    definition:
      'Median ConcessionsAmount across closed records that report a concessions amount. Records with no reported concessions are excluded rather than treated as zero, because the feed does not distinguish "none" from "not reported".',
    extract: (l) => l.concessions_amount,
    aggregate: 'median',
    decimals: 0
  },
  {
    key: 'median_living_area_sqft',
    definition: 'Median LivingArea across closed records reporting living area.',
    extract: (l) => l.living_area_sqft,
    aggregate: 'median',
    decimals: 2
  }
];

const PENDING_METRICS: MetricSpec[] = [
  {
    key: 'median_list_price',
    definition: 'Median ListPrice across pending records with a list price.',
    extract: (l) => l.list_price,
    aggregate: 'median',
    decimals: 0
  },
  {
    key: 'average_list_price',
    definition: 'Mean ListPrice across pending records with a list price.',
    extract: (l) => l.list_price,
    aggregate: 'mean',
    decimals: 0
  },
  {
    key: 'median_days_on_market',
    definition: 'Median DaysOnMarket across pending records reporting DOM.',
    extract: (l) => l.days_on_market,
    aggregate: 'median',
    decimals: 2
  },
  {
    key: 'median_price_per_finished_sqft',
    definition: 'Median of (ListPrice / LivingArea) per record, for records with both values and positive area.',
    extract: (l) => ratio(l.list_price, l.living_area_sqft),
    aggregate: 'median',
    decimals: 2
  }
];

export const ACTIVE_STATUSES = ['Active'] as const;
export const PENDING_STATUSES = ['Pending', 'ActiveUnderContract'] as const;
export const CLOSED_STATUSES = ['Closed'] as const;

export function partitionByCohort(records: NormalizedListing[]): {
  active: NormalizedListing[];
  pending: NormalizedListing[];
  closed: NormalizedListing[];
  unclassified: NormalizedListing[];
} {
  const active: NormalizedListing[] = [];
  const pending: NormalizedListing[] = [];
  const closed: NormalizedListing[] = [];
  const unclassified: NormalizedListing[] = [];
  for (const r of records) {
    const s = r.standard_status;
    if (s === 'Active') active.push(r);
    else if (s === 'Pending' || s === 'ActiveUnderContract') pending.push(r);
    else if (s === 'Closed') closed.push(r);
    else unclassified.push(r);
  }
  return { active, pending, closed, unclassified };
}

export function computeCohortStats(
  cohort: 'active' | 'pending' | 'closed',
  records: NormalizedListing[],
  bandSize: number
): CohortStats {
  const specs = cohort === 'closed' ? CLOSED_METRICS : cohort === 'pending' ? PENDING_METRICS : ACTIVE_METRICS;
  const metrics: Record<string, MetricResult> = {};
  for (const spec of specs) metrics[spec.key] = computeMetric(records, spec);

  const bandField: Extractor = cohort === 'closed' ? (l) => l.close_price : (l) => l.list_price;
  const definitions: Record<typeof cohort, string> = {
    active: 'StandardStatus = Active.',
    pending: 'StandardStatus in (Pending, ActiveUnderContract).',
    closed: 'StandardStatus = Closed.'
  };

  return {
    cohort,
    cohort_definition: definitions[cohort],
    record_count: records.length,
    metrics,
    price_bands: priceBands(records, bandField, bandSize),
    price_band_field: cohort === 'closed' ? 'close_price' : 'list_price',
    price_band_size: bandSize
  };
}

/**
 * Months of supply = active inventory / average monthly closed sales over the
 * measured window. Only defensible when a closed window of known length was
 * explicitly queried; otherwise null with a stated reason.
 */
export function monthsSupply(
  activeCount: number,
  closedCount: number,
  windowMonths: number | null
): { value: number | null; definition: string; reason: string | null } {
  const definition =
    'Active listing count divided by the average monthly closed-sale count over the explicitly queried closed window.';
  if (windowMonths === null || windowMonths <= 0) {
    return {
      value: null,
      definition,
      reason:
        'Not calculated: months of supply requires an explicit closed-date window of known length (closed_from and closed_to).'
    };
  }
  if (closedCount === 0) {
    return { value: null, definition, reason: 'Not calculated: zero closed sales in the window (division by zero).' };
  }
  if (activeCount === 0) {
    // A query bounded by close dates structurally cannot return active listings,
    // so a zero here would report "0 months of supply" for what is really an
    // unmeasured numerator. Refuse rather than emit a misleading figure.
    return {
      value: null,
      definition,
      reason:
        'Not calculated: the retrieved dataset contains no active listings. A query bounded by close dates ' +
        'excludes active inventory by construction, so active count cannot be read from it. Use ' +
        'get_market_snapshot, which measures active inventory and closed sales with separate queries.'
    };
  }
  const perMonth = closedCount / windowMonths;
  return { value: round(activeCount / perMonth, 2), definition, reason: null };
}

/** Whole-month span between two ISO dates, used only for months-of-supply. */
export function windowMonths(from: string | undefined, to: string | undefined): number | null {
  if (!from || !to) return null;
  const start = new Date(`${from.slice(0, 10)}T00:00:00Z`);
  const end = new Date(`${to.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
  const days = (end.getTime() - start.getTime()) / 86_400_000 + 1;
  if (days <= 0) return null;
  return round(days / 30.4375, 4);
}

/** Percent change between two comparable metric values. */
export function periodChange(
  current: number | null,
  prior: number | null
): { absolute: number | null; percent: number | null } {
  if (current === null || prior === null || prior === 0) return { absolute: null, percent: null };
  return { absolute: round(current - prior, 2), percent: round(((current - prior) / prior) * 100, 2) };
}
