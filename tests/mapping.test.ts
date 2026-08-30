import { describe, expect, it } from 'vitest';
import type { MappingContext } from '../src/provider/mlsgrid/mapping.js';
import { isoDate, isoTimestamp, mapListing, mapOpenHouse, num, standardStatus, str } from '../src/provider/mlsgrid/mapping.js';

const ctx: MappingContext = {
  provider: 'mlsgrid',
  originatingSystem: 'northstar',
  fetchedAt: '2026-08-30T12:00:00.000Z',
  exposePrivateRemarks: false
};

describe('scalar coercion', () => {
  it('maps empty and wrong-typed values to null rather than guessing', () => {
    expect(str('')).toBeNull();
    expect(str('   ')).toBeNull();
    expect(str(42)).toBeNull();
    expect(num('')).toBeNull();
    expect(num('abc')).toBeNull();
    expect(num(null)).toBeNull();
    expect(num(Number.POSITIVE_INFINITY)).toBeNull();
  });

  it('accepts numeric strings exactly', () => {
    expect(num('425000')).toBe(425000);
    expect(num(' 1980 ')).toBe(1980);
  });

  it('maps an unparseable timestamp to null', () => {
    expect(isoTimestamp('not-a-timestamp')).toBeNull();
    expect(isoTimestamp('2026-06-20T14:05:00Z')).toBe('2026-06-20T14:05:00.000Z');
  });

  it('keeps a calendar date on its own day rather than shifting it by a zone offset', () => {
    expect(isoDate('2026-06-20')).toBe('2026-06-20');
    expect(isoDate('2026-06-20T23:30:00Z')).toBe('2026-06-20');
  });

  it('maps an unrecognized status to null instead of coercing it', () => {
    expect(standardStatus('Reactivated')).toBeNull();
    expect(standardStatus('Active Under Contract')).toBe('ActiveUnderContract');
    expect(standardStatus('closed')).toBe('Closed');
  });
});

describe('mapListing', () => {
  it('drops a record with no stable key', () => {
    expect(mapListing({ ListingId: null, City: 'Woodbury' }, ctx)).toBeNull();
    expect(mapListing(null, ctx)).toBeNull();
    expect(mapListing('not-an-object', ctx)).toBeNull();
    expect(mapListing([], ctx)).toBeNull();
  });

  it('falls back to ListingId when ListingKey is absent', () => {
    const l = mapListing({ ListingId: 'NST1', City: 'Woodbury' }, ctx);
    expect(l?.listing_key).toBe('NST1');
  });

  it('maps missing numerics to null without substituting zero', () => {
    const l = mapListing(
      { ListingKey: 'K1', ListingId: 'NST1', ListPrice: null, BedroomsTotal: null, LivingArea: null },
      ctx
    );
    expect(l?.list_price).toBeNull();
    expect(l?.bedrooms_total).toBeNull();
    expect(l?.living_area_sqft).toBeNull();
    expect(l?.year_built).toBeNull();
  });

  it('records source provenance including the fetch time', () => {
    const l = mapListing(
      { ListingKey: 'K1', OriginatingSystemName: 'northstar', ModificationTimestamp: '2026-08-01T10:00:00Z' },
      ctx
    );
    expect(l?.source).toEqual({
      provider: 'mlsgrid',
      originating_system: 'northstar',
      resource: 'Property',
      fetched_at: '2026-08-30T12:00:00.000Z',
      record_modification_timestamp: '2026-08-01T10:00:00.000Z'
    });
  });

  it('withholds private remarks unless explicitly enabled', () => {
    const raw = { ListingKey: 'K1', PrivateRemarks: 'agent-only text' };
    expect(mapListing(raw, ctx)?.private_remarks).toBeNull();
    expect(mapListing(raw, { ...ctx, exposePrivateRemarks: true })?.private_remarks).toBe('agent-only text');
  });

  it('composes a street name from its RESO components', () => {
    const l = mapListing(
      { ListingKey: 'K1', StreetDirPrefix: 'N', StreetName: 'Radio', StreetSuffix: 'Dr' },
      ctx
    );
    expect(l?.address.street_name).toBe('N Radio Dr');
  });

  it('maps media references and skips entries without a URL', () => {
    const l = mapListing(
      {
        ListingKey: 'K1',
        Media: [{ MediaURL: 'https://example.invalid/1.jpg', Order: 1 }, { Order: 2 }, 'junk']
      },
      ctx
    );
    expect(l?.media).toEqual([{ url: 'https://example.invalid/1.jpg', order: 1, description: null }]);
  });

  it('returns null media when the source omits the collection', () => {
    expect(mapListing({ ListingKey: 'K1' }, ctx)?.media).toBeNull();
  });
});

describe('mapOpenHouse', () => {
  it('requires an OpenHouseKey', () => {
    expect(mapOpenHouse({ ListingKey: 'K1' }, ctx)).toBeNull();
  });

  it('normalizes start and end instants to ISO 8601 UTC', () => {
    const oh = mapOpenHouse(
      { OpenHouseKey: 'OH1', OpenHouseStartTime: '2026-09-06T17:00:00Z', OpenHouseEndTime: '2026-09-06T19:00:00Z' },
      ctx
    );
    expect(oh?.start_time).toBe('2026-09-06T17:00:00.000Z');
    expect(oh?.end_time).toBe('2026-09-06T19:00:00.000Z');
  });
});
