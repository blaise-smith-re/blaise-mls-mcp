import { describe, expect, it } from 'vitest';
import { FixtureAdapter } from '../src/provider/fixture/adapter.js';
import { MlsService } from '../src/service/mls-service.js';

function service(opts: { pageSize?: number; maxPages?: number; maxRecords?: number } = {}) {
  const provider = new FixtureAdapter({
    pageSize: opts.pageSize ?? 50,
    maxPagesPerQuery: opts.maxPages ?? 10,
    maxRecordsPerQuery: opts.maxRecords ?? 2500
  });
  return new MlsService({
    provider,
    defaultTimezone: 'America/Chicago',
    maxRecordsPerQuery: opts.maxRecords ?? 2500,
    maxPages: opts.maxPages ?? 10,
    providerRequestCap: null,
    now: () => new Date('2026-08-30T12:00:00Z')
  });
}

describe('get_listing service behavior', () => {
  it('returns a normalized listing with provenance', async () => {
    const result = await service().getListing({ listing_id: 'NST6400001' });
    expect(result.found).toBe(true);
    expect(result.listing?.listing_key).toBe('FX6400001');
    expect(result.listing?.source.provider).toBe('fixture');
    expect(result.listing?.source.fetched_at).toBe('2026-08-30T12:00:00.000Z');
    expect(result.lookup).toEqual({ by: 'listing_id_or_key', value: 'NST6400001', matches: 1 });
  });

  it('reports a confirmed non-match distinctly from an error', async () => {
    const result = await service().getListing({ listing_id: 'NST0000000' });
    expect(result.found).toBe(false);
    expect(result.listing).toBeNull();
    expect(result.notes.join(' ')).toMatch(/confirmed non-match/);
  });

  it('requires exactly one lookup key', async () => {
    await expect(service().getListing({})).rejects.toThrow(/Provide either listing_id/);
    await expect(service().getListing({ listing_id: 'a', address: 'b' })).rejects.toThrow(/exactly one/);
  });

  it('explains that address matching is exact when nothing matches', async () => {
    const result = await service().getListing({ address: '999 Nowhere Ln, Woodbury, MN 55125' });
    expect(result.found).toBe(false);
    expect(result.notes.join(' ')).toMatch(/exact, not fuzzy/);
  });
});

describe('search completeness metadata', () => {
  it('marks an exhaustive fixture result complete', async () => {
    const result = await service().searchListings({ cities: ['Lake Elmo'], limit: 500 });
    expect(result._completeness.completeness_status).toBe('complete');
    expect(result._completeness.capped).toBe(false);
    expect(result._completeness.has_more).toBe(false);
    expect(result._completeness.returned_count).toBe(result.listings.length);
  });

  it('marks a capped result truncated and says how to narrow it', async () => {
    const result = await service().searchListings({ limit: 5 });
    expect(result._completeness.completeness_status).toBe('truncated');
    expect(result._completeness.capped).toBe(true);
    expect(result._completeness.notes.join(' ')).toMatch(/Result set is incomplete/);
    expect(result._completeness.notes.join(' ')).toMatch(/Narrow the query/);
  });

  it('marks a page-capped result truncated', async () => {
    const result = await service({ pageSize: 10, maxPages: 2 }).searchListings({ limit: 5000 });
    expect(result._completeness.completeness_status).toBe('truncated');
    expect(result._completeness.pages_fetched).toBe(2);
    expect(result._completeness.cap_reason).toMatch(/page cap/);
  });

  it('discloses which predicates ran in-process and why nulls are excluded', async () => {
    const result = await service().searchListings({ cities: ['Woodbury'], min_price: 100, limit: 500 });
    expect(result._completeness.filters_applied.client_side).toEqual(expect.arrayContaining(['cities', 'min_price']));
    expect(result._completeness.notes.join(' ')).toMatch(/cannot be proven satisfied for a null value/);
  });

  it('records the provider, originating system and as-of time', async () => {
    const result = await service().searchListings({ cities: ['Woodbury'], limit: 500 });
    expect(result._completeness.provider).toBe('fixture');
    expect(result._completeness.originating_system).toBe('fixture-northstar');
    expect(result._completeness.as_of).toBe('2026-08-30T12:00:00.000Z');
  });

  it('echoes the effective query, including the ceiling it applied', async () => {
    const result = await service({ maxRecords: 100 }).searchListings({ cities: ['Woodbury'], limit: 9999 });
    expect(result.query.limit).toBe(100);
  });
});

describe('listing history capability', () => {
  it('declines to reconstruct history and says so explicitly', async () => {
    const history = await service().getListingHistory('NST6400001');
    expect(history.capability).toMatchObject({ event_level_history: 'unsupported' });
    expect(String((history.capability as Record<string, string>).explanation)).toMatch(
      /not reconstructed or inferred/
    );
  });

  it('returns only the history-adjacent fields the current record carries', async () => {
    const history = await service().getListingHistory('NST6400001');
    const fields = history.current_state_history_fields as Record<string, unknown>;
    expect(Object.keys(fields)).toEqual(
      expect.arrayContaining(['list_price', 'original_list_price', 'close_price', 'days_on_market', 'source'])
    );
    expect(String(history.notes)).toMatch(/number, size, and dates of those changes are not exposed/);
  });

  it('handles a non-existent listing without fabricating history', async () => {
    const history = await service().getListingHistory('NST0000000');
    expect(history.found).toBe(false);
    expect(history.current_state_history_fields).toBeNull();
  });
});

describe('market statistics', () => {
  it('returns the exact query definition, counts, methodology and completeness', async () => {
    const stats = await service().marketStats({
      query: { cities: ['Woodbury'], statuses: ['Closed'], closed_from: '2026-06-01', closed_to: '2026-08-30', limit: 500 }
    });
    expect(stats.query_definition).toMatchObject({ cities: ['Woodbury'], closed_from: '2026-06-01' });
    expect(stats.record_counts.retrieved).toBeGreaterThan(0);
    expect(stats.methodology.median).toMatch(/arithmetic mean of the two central values/);
    expect(stats._completeness.completeness_status).toBe('complete');
    expect(stats.as_of).toBe('2026-08-30T12:00:00.000Z');
    expect(stats.timezone).toBe('America/Chicago');
  });

  it('flags fixture data as not being real market statistics', async () => {
    const stats = await service().marketStats({ query: { cities: ['Woodbury'], limit: 500 } });
    expect(stats.limitations.join(' ')).toMatch(/FIXTURE PROVIDER/);
  });

  it('warns when statistics rest on a truncated retrieval', async () => {
    const stats = await service().marketStats({ query: { cities: ['Woodbury'], limit: 5 } });
    expect(stats._completeness.completeness_status).toBe('truncated');
    expect(stats.limitations.join(' ')).toMatch(/may not describe the full matching population/);
  });

  it('reports records excluded from every cohort for an unrecognized status', async () => {
    const stats = await service().marketStats({ query: { cities: ['Woodbury'], limit: 500 } });
    expect(stats.record_counts.unclassified).toBeGreaterThan(0);
    expect(stats.limitations.join(' ')).toMatch(/no recognized StandardStatus and are excluded from every cohort/);
  });

  it('calculates months of supply only with an explicit closed window', async () => {
    const withWindow = await service().marketStats({
      query: { cities: ['Woodbury'], closed_from: '2026-06-01', closed_to: '2026-08-30', limit: 500 }
    });
    // A closed-date-bounded query cannot contain active listings, so the numerator
    // is unmeasured — the engine must refuse rather than report a misleading zero.
    expect(withWindow.months_supply.value).toBeNull();
    expect(withWindow.months_supply.reason).toMatch(/excludes active inventory by construction/);
    expect(withWindow.months_supply.reason).toMatch(/get_market_snapshot/);

    const withoutWindow = await service().marketStats({ query: { cities: ['Woodbury'], limit: 500 } });
    expect(withoutWindow.months_supply.reason).toMatch(/requires an explicit closed-date window/);
  });

  it('computes the prior equal-length window when asked', async () => {
    const stats = await service().marketStats({
      query: { cities: ['Woodbury'], statuses: ['Closed'], closed_from: '2026-06-01', closed_to: '2026-06-30', limit: 500 },
      include_prior_period: true
    });
    expect(stats.prior_period?.window).toEqual({ from: '2026-05-02', to: '2026-05-31' });
    expect(stats.prior_period?._completeness).not.toBeNull();
    expect(stats.prior_period?.changes).toBeTruthy();
  });

  it('omits the prior period unless a closed window is supplied', async () => {
    const stats = await service().marketStats({ query: { cities: ['Woodbury'], limit: 500 }, include_prior_period: true });
    expect(stats.prior_period).toBeNull();
  });

  it('is deterministic across identical calls', async () => {
    const q = { cities: ['Woodbury'], statuses: ['Closed' as const], limit: 500 };
    const a = await service().marketStats({ query: q });
    const b = await service().marketStats({ query: q });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe('market snapshot', () => {
  it('returns the three exact queries needed to reproduce it', async () => {
    const snap = await service().marketSnapshot({ cities: ['Woodbury'] });
    const queries = snap.queries as Record<string, Record<string, unknown>>;
    expect(queries.active!.statuses).toEqual(['Active']);
    expect(queries.pending!.statuses).toEqual(['Pending', 'ActiveUnderContract']);
    expect(queries.closed!.statuses).toEqual(['Closed']);
    expect(queries.closed!.closed_from).toBe('2026-06-01');
    expect(queries.closed!.closed_to).toBe('2026-08-30');
  });

  it('reproduces its own composition counts through search_listings', async () => {
    const svc = service();
    const snap = await svc.marketSnapshot({ cities: ['Woodbury'] });
    const composition = snap.composition as Record<string, number>;
    const queries = snap.queries as Record<string, any>;
    const active = await svc.searchListings(queries.active);
    expect(active.listings).toHaveLength(composition.active_count!);
  });

  it('carries separate completeness metadata for each query', async () => {
    const snap = await service().marketSnapshot({ cities: ['Woodbury'] });
    const completeness = snap._completeness as Record<string, { completeness_status: string }>;
    expect(Object.keys(completeness)).toEqual(['active', 'pending', 'closed']);
    expect(completeness.active!.completeness_status).toBe('complete');
  });

  it('requires an explicit geography', async () => {
    await expect(service().marketSnapshot({})).rejects.toThrow(/requires an explicit geography/);
  });
});

describe('comparables through the service', () => {
  it('anchors on the subject and bounds candidates to its own geography', async () => {
    const result = await service().getComparables({ subject_listing_id: 'NST6400009' });
    expect(result.comparables.subject.listing_id).toBe('NST6400009');
    expect(result.retrieval.query.cities).toEqual(['Woodbury']);
    expect(result.retrieval.query.statuses).toEqual(['Closed']);
    expect(result.retrieval._completeness).toBeTruthy();
  });

  it('fails clearly when the subject cannot be found', async () => {
    await expect(service().getComparables({ subject_listing_id: 'NST0000000' })).rejects.toThrow(
      /Subject property was not found/
    );
  });

  it('bounds the closed window to the requested recency', async () => {
    const result = await service().getComparables({
      subject_listing_id: 'NST6400009',
      tolerances: { closed_within_days: 90 }
    });
    expect(result.retrieval.query.closed_from).toBe('2026-06-01');
    expect(result.retrieval.query.closed_to).toBe('2026-08-30');
  });
});

describe('member, office and open house services', () => {
  it('reports found/not-found distinctly', async () => {
    expect((await service().getMember('502777')).found).toBe(true);
    expect((await service().getMember('000')).found).toBe(false);
    expect((await service().getOffice('RMXR01')).found).toBe(true);
    expect((await service().getOffice('NOPE')).found).toBe(false);
  });

  it('returns open houses with completeness metadata', async () => {
    const result = await service().getOpenHouses({});
    expect(result.open_houses).toHaveLength(2);
    expect(result._completeness.completeness_status).toBe('complete');
  });
});
