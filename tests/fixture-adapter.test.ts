import { describe, expect, it } from 'vitest';
import { FixtureAdapter } from '../src/provider/fixture/adapter.js';
import { fixtureProperties } from '../src/provider/fixture/dataset.js';

const adapter = new FixtureAdapter();
const ALL = { limit: 5000 } as const;

describe('fixture dataset integrity', () => {
  it('exposes a stable, deterministic record set across constructions', async () => {
    const a = await new FixtureAdapter().searchListings(ALL);
    const b = await new FixtureAdapter().searchListings(ALL);
    expect(a.records.length).toBe(151);
    expect(JSON.stringify(a.records)).toBe(JSON.stringify(b.records));
  });

  it('deduplicates records sharing a listing key', async () => {
    const raw = fixtureProperties().filter((r) => r.ListingKey === 'FX-COERCE');
    expect(raw).toHaveLength(2);
    const result = await adapter.searchListings(ALL);
    expect(result.records.filter((r) => r.listing_key === 'FX-COERCE')).toHaveLength(1);
  });

  it('drops a record with no stable key rather than synthesizing one', async () => {
    const result = await adapter.searchListings(ALL);
    expect(result.records.every((r) => r.listing_key.length > 0)).toBe(true);
    // The keyless raw record exists in the source but never surfaces.
    expect(fixtureProperties().some((r) => r.ListingKey === undefined && r.ListingId === null)).toBe(true);
  });

  it('never returns a record from a different originating system', async () => {
    const result = await adapter.searchListings(ALL);
    expect(result.records.some((r) => r.listing_key === 'FX-OTHERSYS')).toBe(false);
    expect(result.records.every((r) => r.originating_system === adapter.originatingSystem)).toBe(true);
  });

  it('coerces numeric strings without inventing values for nulls', async () => {
    const coerced = await adapter.getListing('FX-COERCE');
    expect(coerced?.close_price).toBe(419000);
    expect(coerced?.living_area_sqft).toBe(1980);
    // An unparseable ModificationTimestamp becomes null, not a fabricated date.
    expect(coerced?.modification_timestamp).toBeNull();

    const nulls = await adapter.getListing('FX-NULLS');
    expect(nulls?.list_price).toBeNull();
    expect(nulls?.bedrooms_total).toBeNull();
    expect(nulls?.year_built).toBeNull();
  });
});

describe('fixture exact lookup', () => {
  it('finds a listing by MLS number and by listing key', async () => {
    const byId = await adapter.getListing('NST6400001');
    const byKey = await adapter.getListing('FX6400001');
    expect(byId?.listing_key).toBe('FX6400001');
    expect(byKey?.listing_id).toBe('NST6400001');
  });

  it('matches case-insensitively and returns null for a genuine non-match', async () => {
    expect((await adapter.getListing('nst6400001'))?.listing_key).toBe('FX6400001');
    expect(await adapter.getListing('NST0000000')).toBeNull();
  });

  it('rejects an empty id rather than returning an arbitrary record', async () => {
    await expect(adapter.getListing('   ')).rejects.toThrow(/must not be empty/);
  });

  it('finds a listing by exact address', async () => {
    const target = (await adapter.searchListings({ limit: 1 })).records[0]!;
    const matches = await adapter.getListingsByAddress(target.address.unparsed!);
    expect(matches.map((m) => m.listing_key)).toContain(target.listing_key);
  });

  it('returns no match for an address that differs in formatting', async () => {
    expect(await adapter.getListingsByAddress('123 Nonexistent Way, Woodbury, MN 55125')).toEqual([]);
  });
});

describe('fixture search filters', () => {
  it('filters by status', async () => {
    const result = await adapter.searchListings({ statuses: ['Closed'], ...ALL });
    expect(result.records.length).toBe(64);
    expect(result.records.every((r) => r.standard_status === 'Closed')).toBe(true);
  });

  it('filters by geography', async () => {
    const result = await adapter.searchListings({ cities: ['Woodbury'], ...ALL });
    expect(result.records.length).toBe(99);
    expect(result.records.every((r) => r.address.city === 'Woodbury')).toBe(true);
  });

  it('combines geography and status conjunctively', async () => {
    const result = await adapter.searchListings({ cities: ['Woodbury'], statuses: ['Closed'], ...ALL });
    expect(result.records.length).toBe(41);
  });

  it('excludes records missing a filtered field instead of assuming they qualify', async () => {
    const result = await adapter.searchListings({ min_price: 0, ...ALL });
    // FX-NULLS has no list price, so it cannot be proven to satisfy min_price >= 0.
    expect(result.records.some((r) => r.listing_key === 'FX-NULLS')).toBe(false);
    expect(result.client_side_filters).toContain('min_price');
  });

  it('excludes an unrecognized status from an explicit status filter', async () => {
    const result = await adapter.searchListings({ statuses: ['Active'], ...ALL });
    expect(result.records.some((r) => r.listing_key === 'FX-UNKNOWNSTATUS')).toBe(false);
  });

  it('applies price bounds against the requested price field', async () => {
    const byList = await adapter.searchListings({ min_price: 900_000, price_field: 'list', ...ALL });
    expect(byList.records.every((r) => r.list_price !== null && r.list_price >= 900_000)).toBe(true);

    const byClose = await adapter.searchListings({ min_price: 900_000, price_field: 'close', ...ALL });
    expect(byClose.records.every((r) => r.close_price !== null && r.close_price >= 900_000)).toBe(true);
  });

  it('applies bed, area and year bounds', async () => {
    const result = await adapter.searchListings({
      min_beds: 3,
      min_living_area_sqft: 2000,
      min_year_built: 2000,
      ...ALL
    });
    expect(result.records.length).toBeGreaterThan(0);
    for (const r of result.records) {
      expect(r.bedrooms_total!).toBeGreaterThanOrEqual(3);
      expect(r.living_area_sqft!).toBeGreaterThanOrEqual(2000);
      expect(r.year_built!).toBeGreaterThanOrEqual(2000);
    }
  });

  it('applies inclusive close-date bounds', async () => {
    const result = await adapter.searchListings({
      statuses: ['Closed'],
      closed_from: '2026-06-01',
      closed_to: '2026-06-30',
      ...ALL
    });
    expect(result.records.length).toBeGreaterThan(0);
    for (const r of result.records) {
      expect(r.close_date! >= '2026-06-01').toBe(true);
      expect(r.close_date! <= '2026-06-30').toBe(true);
    }
  });

  it('reports which predicates were applied in-process', async () => {
    const result = await adapter.searchListings({ cities: ['Woodbury'], statuses: ['Active'], min_price: 100, ...ALL });
    expect(result.client_side_filters).toEqual(expect.arrayContaining(['cities', 'statuses', 'min_price']));
    expect(result.server_side_filters).toContain('originating_system');
  });
});

describe('fixture pagination and caps', () => {
  it('pages through the dataset without duplicating or dropping records', async () => {
    const paged = await new FixtureAdapter({ pageSize: 10, maxPagesPerQuery: 100 }).searchListings(ALL);
    expect(paged.records.length).toBe(151);
    expect(new Set(paged.records.map((r) => r.listing_key)).size).toBe(151);
    expect(paged.pages_fetched).toBe(16);
    expect(paged.capped).toBe(false);
    expect(paged.has_more).toBe(false);
  });

  it('flags a page-capped result as incomplete rather than presenting it as whole', async () => {
    const capped = await new FixtureAdapter({ pageSize: 10, maxPagesPerQuery: 2 }).searchListings(ALL);
    expect(capped.capped).toBe(true);
    expect(capped.has_more).toBe(true);
    expect(capped.cap_reason).toMatch(/page cap reached/);
    expect(capped.total_known).toBeNull();
    expect(capped.records.length).toBe(20);
  });

  it('flags a record-limited result as capped', async () => {
    const limited = await adapter.searchListings({ limit: 5 });
    expect(limited.records).toHaveLength(5);
    expect(limited.capped).toBe(true);
    expect(limited.cap_reason).toMatch(/record limit reached \(5\)/);
    expect(limited.has_more).toBe(true);
  });

  it('detects the simulated provider request cap', async () => {
    const provider = new FixtureAdapter({ pageSize: 20, maxPagesPerQuery: 100, providerRequestCap: 40 });
    const result = await provider.searchListings(ALL);
    expect(result.capped).toBe(true);
    expect(result.cap_reason).toMatch(/provider request cap \(40\)/);
  });

  it('reports a complete, uncapped result with a known total', async () => {
    const result = await adapter.searchListings({ cities: ['Lake Elmo'], ...ALL });
    expect(result.capped).toBe(false);
    expect(result.has_more).toBe(false);
    expect(result.total_known).toBe(result.records.length);
  });
});

describe('fixture member, office and open house lookups', () => {
  it('looks up a member by MLS id and key', async () => {
    expect((await adapter.getMember('502777'))?.full_name).toBe('Fixture Listing Agent');
    expect((await adapter.getMember('FXAGENT-1'))?.member_mls_id).toBe('502777');
    expect(await adapter.getMember('999999')).toBeNull();
  });

  it('looks up an office by MLS id', async () => {
    expect((await adapter.getOffice('RMXR01'))?.name).toBe('Fixture Brokerage Office');
    expect(await adapter.getOffice('NOPE')).toBeNull();
  });

  it('filters open houses by listing and start window', async () => {
    const all = await adapter.getOpenHouses({});
    expect(all.records).toHaveLength(2);

    const scoped = await adapter.getOpenHouses({ listing_key: 'FX6400001' });
    expect(scoped.records).toHaveLength(1);

    const windowed = await adapter.getOpenHouses({ starts_from: '2026-09-10T00:00:00Z' });
    expect(windowed.records).toHaveLength(1);
    expect(windowed.records[0]!.open_house_key).toBe('FXOH-2');
  });
});

describe('fixture capability reporting', () => {
  it('declares event-level listing history unsupported', () => {
    const caps = adapter.capabilities();
    expect(caps.listing_history_events).toBe('unsupported');
    expect(caps.notes.join(' ')).toMatch(/synthetic test data/i);
  });
});
