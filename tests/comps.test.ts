import { describe, expect, it } from 'vitest';
import type { NormalizedListing } from '../src/models/normalized.js';
import { DEFAULT_TOLERANCES, JUDGMENT_BOUNDARY, selectComparables } from '../src/service/comps.js';

function listing(key: string, overrides: Partial<NormalizedListing> = {}): NormalizedListing {
  return {
    listing_key: key,
    listing_id: `NST${key}`,
    originating_system: 'test',
    standard_status: 'Closed',
    mls_status: null,
    property_type: 'Residential',
    property_sub_type: 'SingleFamilyResidence',
    address: {
      unparsed: `${key} Test St`,
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
    list_price: 500_000,
    original_list_price: 500_000,
    close_price: 495_000,
    bedrooms_total: 4,
    bathrooms_total: 3,
    bathrooms_full: 2,
    bathrooms_half: 1,
    living_area_sqft: 2400,
    above_grade_finished_area_sqft: null,
    below_grade_finished_area_sqft: null,
    lot_size_acres: 0.3,
    lot_size_sqft: null,
    year_built: 2005,
    days_on_market: 20,
    cumulative_days_on_market: null,
    listing_contract_date: '2026-05-01',
    purchase_contract_date: null,
    close_date: '2026-07-01',
    concessions_amount: null,
    concessions_comments: null,
    public_remarks: null,
    private_remarks: null,
    list_agent_key: null,
    list_agent_mls_id: null,
    list_office_key: null,
    list_office_mls_id: null,
    media: null,
    modification_timestamp: '2026-07-01T00:00:00.000Z',
    source: {
      provider: 'test',
      originating_system: 'test',
      resource: 'Property',
      fetched_at: '2026-08-30T12:00:00.000Z',
      record_modification_timestamp: null
    },
    ...overrides
  };
}

const subject = listing('SUBJ', { standard_status: 'Active', close_date: null, close_price: null });
const ctx = { asOfDate: '2026-08-30' };

describe('comparable inclusion', () => {
  it('includes a near-identical closed sale and explains why', () => {
    const result = selectComparables(subject, [listing('A')], DEFAULT_TOLERANCES, ctx);
    expect(result.included).toHaveLength(1);
    expect(result.included[0]!.listing_key).toBe('A');
    expect(result.included[0]!.rejection_reasons).toEqual([]);
    expect(result.included[0]!.similarity_rationale).toMatch(/Within every stated tolerance/);
  });

  it('never returns a valuation conclusion', () => {
    const result = selectComparables(subject, [listing('A')], DEFAULT_TOLERANCES, ctx);
    expect(result.judgment_boundary).toBe(JUDGMENT_BOUNDARY);
    expect(JSON.stringify(result)).not.toMatch(/suggested_(list_)?price|estimated_value|recommended_price/i);
  });

  it('exposes the scoring weights and the coverage floor it applied', () => {
    const result = selectComparables(subject, [listing('A')], DEFAULT_TOLERANCES, ctx);
    expect(result.scoring.weights.living_area_sqft).toBe(0.35);
    expect(result.scoring.minimum_weight_coverage).toBe(0.5);
    expect(result.scoring.method).toMatch(/fraction of its tolerance/);
  });

  it('reports per-dimension differences for an included comp', () => {
    const result = selectComparables(subject, [listing('A', { living_area_sqft: 2600 })], DEFAULT_TOLERANCES, ctx);
    const area = result.included[0]!.differences.find((d) => d.dimension === 'living_area_sqft')!;
    expect(area.subject_value).toBe(2400);
    expect(area.candidate_value).toBe(2600);
    expect(area.difference).toBe(200);
    expect(area.within_tolerance).toBe(true);
  });
});

describe('comparable rejection', () => {
  it('rejects the subject property itself', () => {
    const result = selectComparables(subject, [subject], DEFAULT_TOLERANCES, ctx);
    expect(result.included).toHaveLength(0);
    expect(result.rejected[0]!.rejection_reasons.join(' ')).toMatch(/is the subject property/);
  });

  it('rejects a candidate outside the living-area tolerance and names the numbers', () => {
    const result = selectComparables(subject, [listing('BIG', { living_area_sqft: 4000 })], DEFAULT_TOLERANCES, ctx);
    expect(result.included).toHaveLength(0);
    expect(result.rejected[0]!.rejection_reasons.join(' ')).toMatch(/Living area 4000 sqft is outside ±25%/);
  });

  it('rejects a candidate outside the year-built tolerance', () => {
    const result = selectComparables(subject, [listing('OLD', { year_built: 1960 })], DEFAULT_TOLERANCES, ctx);
    expect(result.rejected[0]!.rejection_reasons.join(' ')).toMatch(/Year built 1960 is outside ±15 years/);
  });

  it('rejects a candidate outside the bedroom tolerance', () => {
    const result = selectComparables(subject, [listing('BEDS', { bedrooms_total: 7 })], DEFAULT_TOLERANCES, ctx);
    expect(result.rejected[0]!.rejection_reasons.join(' ')).toMatch(/Bedroom count 7 is outside ±1/);
  });

  it('rejects a sale outside the close-recency window', () => {
    const result = selectComparables(subject, [listing('OLDSALE', { close_date: '2024-01-01' })], DEFAULT_TOLERANCES, ctx);
    expect(result.rejected[0]!.rejection_reasons.join(' ')).toMatch(/beyond the 365-day close-recency window/);
  });

  it('rejects a status outside the requested set', () => {
    const result = selectComparables(subject, [listing('ACT', { standard_status: 'Active' })], DEFAULT_TOLERANCES, ctx);
    expect(result.rejected[0]!.rejection_reasons.join(' ')).toMatch(/is outside the requested comparable statuses/);
  });

  it('rejects a different property sub type when sub type is required', () => {
    const result = selectComparables(
      subject,
      [listing('TH', { property_sub_type: 'Townhouse' })],
      DEFAULT_TOLERANCES,
      ctx
    );
    expect(result.rejected[0]!.rejection_reasons.join(' ')).toMatch(/Property sub type differs/);
  });

  it('allows a different sub type when the caller relaxes the requirement', () => {
    const result = selectComparables(
      subject,
      [listing('TH', { property_sub_type: 'Townhouse' })],
      { ...DEFAULT_TOLERANCES, require_same_property_sub_type: false },
      ctx
    );
    expect(result.included.map((c) => c.listing_key)).toEqual(['TH']);
  });

  it('rejects an under-evidenced candidate instead of scoring it on thin data', () => {
    const sparse = listing('SPARSE', {
      living_area_sqft: null,
      year_built: null,
      bedrooms_total: null,
      lot_size_acres: null
    });
    const result = selectComparables(subject, [sparse], DEFAULT_TOLERANCES, ctx);
    expect(result.included).toHaveLength(0);
    expect(result.rejected[0]!.rejection_reasons.join(' ')).toMatch(/Insufficient comparable data/);
    expect(result.rejected[0]!.weight_coverage).toBeLessThan(0.5);
  });

  it('marks a dimension unavailable rather than guessing when data is missing on one side', () => {
    const result = selectComparables(subject, [listing('NOYEAR', { year_built: null })], DEFAULT_TOLERANCES, ctx);
    const candidate = [...result.included, ...result.rejected][0]!;
    const year = candidate.differences.find((d) => d.dimension === 'year_built')!;
    expect(year.status).toBe('unavailable');
    expect(year.difference).toBeNull();
    expect(year.within_tolerance).toBeNull();
  });
});

describe('comparable ranking', () => {
  it('ranks closer candidates first and is deterministic', () => {
    const candidates = [
      listing('FAR', { living_area_sqft: 2900 }),
      listing('NEAR', { living_area_sqft: 2410 }),
      listing('MID', { living_area_sqft: 2600 })
    ];
    const first = selectComparables(subject, candidates, DEFAULT_TOLERANCES, ctx);
    const second = selectComparables(subject, [...candidates].reverse(), DEFAULT_TOLERANCES, ctx);
    expect(first.included.map((c) => c.listing_key)).toEqual(['NEAR', 'MID', 'FAR']);
    expect(second.included.map((c) => c.listing_key)).toEqual(first.included.map((c) => c.listing_key));
  });

  it('moves eligible candidates beyond max_comps into rejected with a distinct reason', () => {
    const candidates = [listing('A'), listing('B'), listing('C')];
    const result = selectComparables(subject, candidates, { ...DEFAULT_TOLERANCES, max_comps: 2 }, ctx);
    expect(result.included).toHaveLength(2);
    const overflow = result.rejected.find((c) => c.rejection_reasons.some((r) => r.includes('max_comps')));
    expect(overflow).toBeDefined();
    expect(overflow!.rejection_reasons[0]).toMatch(/eligible but not in the top set/);
  });

  it('counts every candidate it evaluated', () => {
    const result = selectComparables(
      subject,
      [listing('A'), listing('B', { living_area_sqft: 9000 })],
      DEFAULT_TOLERANCES,
      ctx
    );
    expect(result.candidates_evaluated).toBe(2);
    expect(result.included.length + result.rejected.length).toBe(2);
  });

  it('computes price per finished sqft for each candidate', () => {
    const result = selectComparables(subject, [listing('A', { close_price: 480_000, living_area_sqft: 2400 })], DEFAULT_TOLERANCES, ctx);
    expect(result.included[0]!.price_per_finished_sqft).toBe(200);
  });
});
