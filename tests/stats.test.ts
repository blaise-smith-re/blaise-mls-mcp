import { describe, expect, it } from 'vitest';
import type { NormalizedListing, StandardStatus } from '../src/models/normalized.js';
import {
  computeCohortStats,
  mean,
  median,
  monthsSupply,
  partitionByCohort,
  periodChange,
  windowMonths
} from '../src/service/stats.js';

function listing(overrides: Partial<NormalizedListing> & { listing_key: string }): NormalizedListing {
  return {
    listing_id: overrides.listing_key,
    originating_system: 'test',
    standard_status: 'Closed' as StandardStatus,
    mls_status: null,
    property_type: 'Residential',
    property_sub_type: 'SingleFamilyResidence',
    address: {
      unparsed: null,
      street_number: null,
      street_name: null,
      unit: null,
      city: 'Woodbury',
      state: 'MN',
      postal_code: '55125',
      county: 'Washington'
    },
    latitude: null,
    longitude: null,
    list_price: null,
    original_list_price: null,
    close_price: null,
    bedrooms_total: null,
    bathrooms_total: null,
    bathrooms_full: null,
    bathrooms_half: null,
    living_area_sqft: null,
    above_grade_finished_area_sqft: null,
    below_grade_finished_area_sqft: null,
    lot_size_acres: null,
    lot_size_sqft: null,
    year_built: null,
    days_on_market: null,
    cumulative_days_on_market: null,
    listing_contract_date: null,
    purchase_contract_date: null,
    close_date: null,
    concessions_amount: null,
    concessions_comments: null,
    public_remarks: null,
    private_remarks: null,
    list_agent_key: null,
    list_agent_mls_id: null,
    list_office_key: null,
    list_office_mls_id: null,
    media: null,
    modification_timestamp: null,
    source: {
      provider: 'test',
      originating_system: 'test',
      resource: 'Property',
      fetched_at: '2026-08-30T12:00:00.000Z',
      record_modification_timestamp: null
    },
    ...overrides
  } as NormalizedListing;
}

describe('median and mean', () => {
  it('takes the middle value for an odd sample', () => {
    expect(median([3, 1, 2])).toBe(2);
  });

  it('averages the two central values for an even sample', () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });

  it('returns null for an empty sample rather than zero', () => {
    expect(median([])).toBeNull();
    expect(mean([])).toBeNull();
  });

  it('does not mutate its input', () => {
    const values = [3, 1, 2];
    median(values);
    expect(values).toEqual([3, 1, 2]);
  });
});

describe('cohort partitioning', () => {
  it('groups pending and active-under-contract together and isolates unknown statuses', () => {
    const parts = partitionByCohort([
      listing({ listing_key: 'a', standard_status: 'Active' }),
      listing({ listing_key: 'b', standard_status: 'Pending' }),
      listing({ listing_key: 'c', standard_status: 'ActiveUnderContract' }),
      listing({ listing_key: 'd', standard_status: 'Closed' }),
      listing({ listing_key: 'e', standard_status: null }),
      listing({ listing_key: 'f', standard_status: 'Canceled' })
    ]);
    expect(parts.active.map((l) => l.listing_key)).toEqual(['a']);
    expect(parts.pending.map((l) => l.listing_key)).toEqual(['b', 'c']);
    expect(parts.closed.map((l) => l.listing_key)).toEqual(['d']);
    // A record with no recognized status is never assigned to a cohort.
    expect(parts.unclassified.map((l) => l.listing_key)).toEqual(['e', 'f']);
  });
});

describe('closed cohort metrics', () => {
  const records = [
    listing({ listing_key: '1', close_price: 400_000, list_price: 410_000, original_list_price: 420_000, living_area_sqft: 2000, days_on_market: 10 }),
    listing({ listing_key: '2', close_price: 500_000, list_price: 500_000, original_list_price: 500_000, living_area_sqft: 2500, days_on_market: 20 }),
    listing({ listing_key: '3', close_price: 600_000, list_price: 590_000, original_list_price: 620_000, living_area_sqft: 3000, days_on_market: 30 })
  ];

  it('computes median and average sale price', () => {
    const stats = computeCohortStats('closed', records, 100_000);
    expect(stats.metrics.median_sale_price!.value).toBe(500_000);
    expect(stats.metrics.average_sale_price!.value).toBe(500_000);
    expect(stats.metrics.median_sale_price!.sample_size).toBe(3);
    expect(stats.metrics.median_sale_price!.excluded_missing_input).toBe(0);
  });

  it('computes DOM metrics', () => {
    const stats = computeCohortStats('closed', records, 100_000);
    expect(stats.metrics.median_days_on_market!.value).toBe(20);
    expect(stats.metrics.average_days_on_market!.value).toBe(20);
  });

  it('computes ratios per record rather than as a ratio of aggregates', () => {
    const stats = computeCohortStats('closed', records, 100_000);
    // Per-record: 400/410 = 0.9756, 500/500 = 1, 600/590 = 1.0169 -> median 1.
    expect(stats.metrics.median_sale_to_list_ratio!.value).toBe(1);
    // Sale-to-original-list: 0.9524, 1, 0.9677 -> median 0.9677.
    expect(stats.metrics.median_sale_to_original_list_ratio!.value).toBe(0.9677);
  });

  it('computes price per finished square foot per record', () => {
    const stats = computeCohortStats('closed', records, 100_000);
    // 200, 200, 200 -> 200.
    expect(stats.metrics.median_price_per_finished_sqft!.value).toBe(200);
  });

  it('excludes records missing a metric input and reports the exclusion count', () => {
    const withGaps = [...records, listing({ listing_key: '4', close_price: null, living_area_sqft: null })];
    const stats = computeCohortStats('closed', withGaps, 100_000);
    expect(stats.record_count).toBe(4);
    expect(stats.metrics.median_sale_price!.sample_size).toBe(3);
    expect(stats.metrics.median_sale_price!.excluded_missing_input).toBe(1);
    // The missing value does not drag the median toward zero.
    expect(stats.metrics.median_sale_price!.value).toBe(500_000);
  });

  it('excludes unreported concessions rather than treating them as zero', () => {
    const withConcessions = [
      listing({ listing_key: 'c1', concessions_amount: 5_000 }),
      listing({ listing_key: 'c2', concessions_amount: 7_000 }),
      listing({ listing_key: 'c3', concessions_amount: null })
    ];
    const stats = computeCohortStats('closed', withConcessions, 100_000);
    expect(stats.metrics.median_seller_concessions!.value).toBe(6_000);
    expect(stats.metrics.median_seller_concessions!.sample_size).toBe(2);
    expect(stats.metrics.median_seller_concessions!.definition).toMatch(/not distinguish "none" from "not reported"/);
  });

  it('returns null with a zero sample when no record carries the input', () => {
    const stats = computeCohortStats('closed', [listing({ listing_key: 'x' })], 100_000);
    expect(stats.metrics.median_sale_price!.value).toBeNull();
    expect(stats.metrics.median_sale_price!.sample_size).toBe(0);
  });

  it('bands closed records by close price', () => {
    const stats = computeCohortStats('closed', records, 100_000);
    expect(stats.price_band_field).toBe('close_price');
    expect(stats.price_bands).toEqual([
      { lower: 400_000, upper: 500_000, count: 1 },
      { lower: 500_000, upper: 600_000, count: 1 },
      { lower: 600_000, upper: 700_000, count: 1 }
    ]);
  });

  it('attaches a definition to every metric', () => {
    const stats = computeCohortStats('closed', records, 100_000);
    for (const [key, metric] of Object.entries(stats.metrics)) {
      expect(metric.definition, `metric ${key} needs a definition`).toBeTruthy();
    }
  });
});

describe('active cohort metrics', () => {
  it('bands active records by list price and uses list price for price per sqft', () => {
    const stats = computeCohortStats(
      'active',
      [
        listing({ listing_key: 'a', standard_status: 'Active', list_price: 450_000, living_area_sqft: 1500 }),
        listing({ listing_key: 'b', standard_status: 'Active', list_price: 550_000, living_area_sqft: 2000 })
      ],
      100_000
    );
    expect(stats.price_band_field).toBe('list_price');
    expect(stats.metrics.median_list_price!.value).toBe(500_000);
    // (450000/1500 = 300, 550000/2000 = 275) -> median 287.5
    expect(stats.metrics.median_price_per_finished_sqft!.value).toBe(287.5);
  });
});

describe('months of supply', () => {
  it('calculates supply from an explicit window', () => {
    // 30 active, 30 closed over ~3 months = 10/month = 3 months of supply.
    const result = monthsSupply(30, 30, 3);
    expect(result.value).toBe(3);
    expect(result.reason).toBeNull();
  });

  it('refuses to calculate without an explicit window', () => {
    const result = monthsSupply(30, 30, null);
    expect(result.value).toBeNull();
    expect(result.reason).toMatch(/requires an explicit closed-date window/);
  });

  it('refuses to divide by zero closed sales', () => {
    const result = monthsSupply(30, 0, 3);
    expect(result.value).toBeNull();
    expect(result.reason).toMatch(/zero closed sales/);
  });

  it('refuses to report zero supply when the active numerator was never measured', () => {
    const result = monthsSupply(0, 30, 3);
    expect(result.value).toBeNull();
    expect(result.reason).toMatch(/excludes active inventory by construction/);
  });
});

describe('window months', () => {
  it('measures an inclusive window in months', () => {
    expect(windowMonths('2026-06-01', '2026-06-30')).toBeCloseTo(0.9856, 3);
    // 365 inclusive days / 30.4375 days per average month.
    expect(windowMonths('2026-01-01', '2026-12-31')).toBeCloseTo(11.9918, 3);
  });

  it('returns null for a missing or inverted window', () => {
    expect(windowMonths(undefined, '2026-06-30')).toBeNull();
    expect(windowMonths('2026-06-30', '2026-06-01')).toBeNull();
  });
});

describe('period change', () => {
  it('reports absolute and percent change', () => {
    expect(periodChange(110, 100)).toEqual({ absolute: 10, percent: 10 });
    expect(periodChange(90, 100)).toEqual({ absolute: -10, percent: -10 });
  });

  it('returns nulls rather than a fabricated change when a side is missing or zero', () => {
    expect(periodChange(null, 100)).toEqual({ absolute: null, percent: null });
    expect(periodChange(110, null)).toEqual({ absolute: null, percent: null });
    expect(periodChange(110, 0)).toEqual({ absolute: null, percent: null });
  });
});
