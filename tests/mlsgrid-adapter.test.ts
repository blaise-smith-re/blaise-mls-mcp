import { describe, expect, it, vi } from 'vitest';
import { MlsGridAdapter, PROVIDER_REQUEST_CAP } from '../src/provider/mlsgrid/adapter.js';
import { DEFAULT_SERVER_FILTERABLE_FIELDS } from '../src/provider/mlsgrid/odata.js';

const BASE = 'https://api.mlsgrid.com/v2';

interface Call {
  url: string;
  filter: string | null;
  top: string | null;
  expand: string | null;
}

/** A minimal OData server simulator: records requests and serves scripted pages. */
function makeApi(pages: Array<{ value: unknown[]; next?: string; count?: number }>) {
  const calls: Call[] = [];
  let index = 0;
  const fetchFn = vi.fn(async (input: string | URL) => {
    const url = new URL(String(input));
    calls.push({
      url: url.toString(),
      filter: url.searchParams.get('$filter'),
      top: url.searchParams.get('$top'),
      expand: url.searchParams.get('$expand')
    });
    const page = pages[Math.min(index, pages.length - 1)];
    index += 1;
    const body: Record<string, unknown> = { value: page?.value ?? [] };
    if (page?.next) body['@odata.nextLink'] = page.next;
    if (page?.count !== undefined) body['@odata.count'] = page.count;
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

function record(n: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ListingKey: `K${n}`,
    ListingId: `NST${n}`,
    OriginatingSystemName: 'northstar',
    StandardStatus: 'Active',
    PropertyType: 'Residential',
    PropertySubType: 'SingleFamilyResidence',
    City: 'Woodbury',
    PostalCode: '55125',
    ListPrice: 400_000 + n,
    BedroomsTotal: 3,
    LivingArea: 2000,
    YearBuilt: 2005,
    ModificationTimestamp: '2026-08-01T10:00:00Z',
    ...overrides
  };
}

function adapter(fetchFn: typeof fetch, overrides: Record<string, unknown> = {}) {
  return new MlsGridAdapter({
    apiBase: BASE,
    token: 'test-token-value-1234',
    originatingSystem: 'northstar',
    fetchFn,
    minRequestIntervalMs: 0,
    sleepFn: async () => undefined,
    now: () => new Date('2026-08-30T12:00:00Z'),
    ...overrides
  });
}

describe('MLS Grid request construction', () => {
  it('enforces OriginatingSystemName on every request', async () => {
    const { fetchFn, calls } = makeApi([{ value: [record(1)] }]);
    await adapter(fetchFn).searchListings({ limit: 10 });
    expect(calls[0]!.filter).toContain("OriginatingSystemName eq 'northstar'");
  });

  it('pushes allowlisted predicates server-side and keeps the rest in-process', async () => {
    const { fetchFn, calls } = makeApi([{ value: [record(1)] }]);
    const result = await adapter(fetchFn).searchListings({
      statuses: ['Active', 'Pending'],
      property_types: ['Residential'],
      cities: ['Woodbury'],
      min_price: 100_000,
      limit: 10
    });
    expect(calls[0]!.filter).toContain("(StandardStatus eq 'Active' or StandardStatus eq 'Pending')");
    expect(calls[0]!.filter).toContain("PropertyType eq 'Residential'");
    // City is not in the conservative default allowlist, so it stays client-side.
    expect(calls[0]!.filter).not.toContain('City eq');
    expect(result.server_side_filters).toEqual(expect.arrayContaining(['originating_system', 'statuses', 'property_types']));
    expect(result.client_side_filters).toEqual(expect.arrayContaining(['cities', 'min_price']));
  });

  it('pushes geography server-side once the allowlist is widened', async () => {
    const { fetchFn, calls } = makeApi([{ value: [record(1)] }]);
    const result = await adapter(fetchFn, {
      serverFilterFields: [...DEFAULT_SERVER_FILTERABLE_FIELDS, 'City']
    }).searchListings({ cities: ['Woodbury'], limit: 10 });
    expect(calls[0]!.filter).toContain("City eq 'Woodbury'");
    expect(result.server_side_filters).toContain('cities');
    expect(result.client_side_filters).not.toContain('cities');
  });

  it('escapes a quote-injection attempt in a server-side filter value', async () => {
    const { fetchFn, calls } = makeApi([{ value: [] }]);
    await adapter(fetchFn, {
      serverFilterFields: [...DEFAULT_SERVER_FILTERABLE_FIELDS, 'City']
    }).searchListings({ cities: ["Woodbury' or ListPrice gt 0 or City eq 'x"], limit: 10 });
    const filter = calls[0]!.filter!;
    expect(filter).toContain("City eq 'Woodbury'' or ListPrice gt 0 or City eq ''x'");
    expect(filter.match(/'/g)!.length % 2).toBe(0);
  });

  it('reduces the page size when media is expanded', async () => {
    const { fetchFn, calls } = makeApi([{ value: [] }]);
    await adapter(fetchFn, { pageSize: 5000 }).searchListings({ include_media: true, limit: 10 });
    expect(calls[0]!.expand).toBe('Media');
    expect(Number(calls[0]!.top)).toBe(1000);
  });

  it('tries ListingId then ListingKey for an exact lookup', async () => {
    const { fetchFn, calls } = makeApi([{ value: [] }, { value: [record(7)] }]);
    const found = await adapter(fetchFn).getListing('K7');
    expect(calls[0]!.filter).toContain("ListingId eq 'K7'");
    expect(calls[1]!.filter).toContain("ListingKey eq 'K7'");
    expect(found?.listing_key).toBe('K7');
  });

  it('returns null for a genuine non-match', async () => {
    const { fetchFn } = makeApi([{ value: [] }]);
    expect(await adapter(fetchFn).getListing('NOPE')).toBeNull();
  });
});

describe('MLS Grid pagination and completeness', () => {
  it('follows nextLink and deduplicates by listing key', async () => {
    const { fetchFn, calls } = makeApi([
      { value: [record(1), record(2)], next: `${BASE}/Property?$skip=2` },
      // Page two repeats K2 (a real hazard when records shift between pages).
      { value: [record(2), record(3)] }
    ]);
    const result = await adapter(fetchFn, { pageSize: 2 }).searchListings({ limit: 100 });
    expect(calls).toHaveLength(2);
    expect(result.records.map((r) => r.listing_key)).toEqual(['K1', 'K2', 'K3']);
    expect(result.pages_fetched).toBe(2);
    expect(result.capped).toBe(false);
    expect(result.has_more).toBe(false);
  });

  it('stops at the page cap and reports the result as incomplete', async () => {
    const { fetchFn } = makeApi([
      { value: [record(1)], next: `${BASE}/Property?$skip=1` },
      { value: [record(2)], next: `${BASE}/Property?$skip=2` },
      { value: [record(3)], next: `${BASE}/Property?$skip=3` }
    ]);
    const result = await adapter(fetchFn, { pageSize: 1, maxPagesPerQuery: 2 }).searchListings({ limit: 100 });
    expect(result.pages_fetched).toBe(2);
    expect(result.capped).toBe(true);
    expect(result.has_more).toBe(true);
    expect(result.cap_reason).toMatch(/page cap reached/);
  });

  it('detects a full page with no continuation link at the documented provider cap', async () => {
    const full = Array.from({ length: PROVIDER_REQUEST_CAP }, (_, i) => record(i));
    const { fetchFn } = makeApi([{ value: full }]);
    const result = await adapter(fetchFn, {
      pageSize: PROVIDER_REQUEST_CAP,
      maxPagesPerQuery: 5,
      maxRecordsPerQuery: PROVIDER_REQUEST_CAP * 2
    }).searchListings({ limit: PROVIDER_REQUEST_CAP + 100 });
    expect(result.capped).toBe(true);
    expect(result.has_more).toBe(true);
    expect(result.cap_reason).toMatch(/provider request cap/);
  });

  it('stops at the requested record limit', async () => {
    const { fetchFn } = makeApi([
      { value: [record(1), record(2), record(3)], next: `${BASE}/Property?$skip=3` }
    ]);
    const result = await adapter(fetchFn, { pageSize: 3 }).searchListings({ limit: 2 });
    expect(result.records).toHaveLength(2);
    expect(result.capped).toBe(true);
    expect(result.cap_reason).toMatch(/record limit reached \(2\)/);
  });

  it('captures a server-reported total when the feed provides one', async () => {
    const { fetchFn } = makeApi([{ value: [record(1)], count: 1 }]);
    const result = await adapter(fetchFn).searchListings({ limit: 10 });
    expect(result.total_known).toBe(1);
  });

  it('reports a null total when the feed provides none', async () => {
    const { fetchFn } = makeApi([{ value: [record(1)] }]);
    expect((await adapter(fetchFn).searchListings({ limit: 10 })).total_known).toBeNull();
  });

  it('drops unusable records rather than inventing keys for them', async () => {
    const { fetchFn } = makeApi([{ value: [record(1), { City: 'Woodbury' }, null, 'garbage'] }]);
    const result = await adapter(fetchFn).searchListings({ limit: 10 });
    expect(result.records.map((r) => r.listing_key)).toEqual(['K1']);
  });

  it('refuses to follow a nextLink pointing off the configured origin', async () => {
    const { fetchFn } = makeApi([
      { value: [record(1)], next: 'https://evil.example.com/v2/Property?$skip=1' }
    ]);
    await expect(adapter(fetchFn, { pageSize: 1 }).searchListings({ limit: 100 })).rejects.toMatchObject({
      code: 'VALIDATION'
    });
  });
});

describe('MLS Grid capability honesty', () => {
  it('reports address lookup unsupported under the conservative default allowlist', async () => {
    const { fetchFn } = makeApi([{ value: [] }]);
    const a = adapter(fetchFn);
    expect(a.capabilities().address_lookup).toBe('unsupported');
    await expect(a.getListingsByAddress('123 Main St')).rejects.toMatchObject({
      code: 'UNSUPPORTED_CAPABILITY'
    });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('attempts address lookup once the allowlist confirms the field', async () => {
    const { fetchFn, calls } = makeApi([{ value: [record(1, { UnparsedAddress: '1 A St' })] }]);
    const a = adapter(fetchFn, { serverFilterFields: [...DEFAULT_SERVER_FILTERABLE_FIELDS, 'UnparsedAddress'] });
    expect(a.capabilities().address_lookup).toBe('unverified');
    const found = await a.getListingsByAddress('1 A St');
    expect(calls[0]!.filter).toContain("UnparsedAddress eq '1 A St'");
    expect(found).toHaveLength(1);
  });

  it('marks documentation-derived capabilities unverified rather than supported', () => {
    const { fetchFn } = makeApi([{ value: [] }]);
    const caps = adapter(fetchFn).capabilities();
    expect(caps.listing_lookup_by_id).toBe('unverified');
    expect(caps.server_totals).toBe('unverified');
    expect(caps.listing_history_events).toBe('unsupported');
    expect(caps.notes.join(' ')).toMatch(/documentation-derived and unconfirmed/i);
  });

  it('withholds private remarks by default', async () => {
    const { fetchFn } = makeApi([{ value: [record(1, { PrivateRemarks: 'agent only' })] }]);
    const result = await adapter(fetchFn).searchListings({ limit: 10 });
    expect(result.records[0]!.private_remarks).toBeNull();
  });
});

describe('MLS Grid member, office and open house retrieval', () => {
  it('queries the Member resource with the originating system enforced', async () => {
    const { fetchFn, calls } = makeApi([
      { value: [{ MemberKey: 'M1', MemberMlsId: '502777', MemberFullName: 'A B', OriginatingSystemName: 'northstar' }] }
    ]);
    const member = await adapter(fetchFn).getMember('502777');
    expect(calls[0]!.url).toContain('/Member');
    expect(calls[0]!.filter).toContain("OriginatingSystemName eq 'northstar'");
    expect(member?.full_name).toBe('A B');
  });

  it('queries the Office resource', async () => {
    const { fetchFn, calls } = makeApi([
      { value: [{ OfficeKey: 'O1', OfficeMlsId: 'RMXR01', OfficeName: 'Test Office', OriginatingSystemName: 'northstar' }] }
    ]);
    const office = await adapter(fetchFn).getOffice('RMXR01');
    expect(calls[0]!.url).toContain('/Office');
    expect(office?.name).toBe('Test Office');
  });

  it('queries the OpenHouse resource and filters the start window in-process', async () => {
    const { fetchFn, calls } = makeApi([
      {
        value: [
          { OpenHouseKey: 'OH1', ListingKey: 'K1', OpenHouseStartTime: '2026-09-06T17:00:00Z', OriginatingSystemName: 'northstar' },
          { OpenHouseKey: 'OH2', ListingKey: 'K1', OpenHouseStartTime: '2026-09-20T17:00:00Z', OriginatingSystemName: 'northstar' }
        ]
      }
    ]);
    const result = await adapter(fetchFn).getOpenHouses({ listing_key: 'K1', starts_to: '2026-09-10T00:00:00Z' });
    expect(calls[0]!.url).toContain('/OpenHouse');
    expect(calls[0]!.filter).toContain("ListingKey eq 'K1'");
    expect(result.records.map((r) => r.open_house_key)).toEqual(['OH1']);
    expect(result.client_side_filters).toContain('starts_to');
  });
});
