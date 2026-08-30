import { MlsError } from '../../errors.js';
import type {
  NormalizedListing,
  NormalizedMember,
  NormalizedOffice,
  NormalizedOpenHouse
} from '../../models/normalized.js';
import type { MappingContext } from '../mlsgrid/mapping.js';
import { mapListing, mapMember, mapOffice, mapOpenHouse } from '../mlsgrid/mapping.js';
import { buildClientPredicates } from '../predicates.js';
import type {
  ListingQuery,
  MlsProvider,
  OpenHouseQuery,
  ProviderCapabilities,
  ProviderCollectionResult
} from '../types.js';
import type { RawRecord } from './dataset.js';
import {
  FIXTURE_ORIGINATING_SYSTEM,
  fixtureMembers,
  fixtureOffices,
  fixtureOpenHouses,
  fixtureProperties
} from './dataset.js';

/**
 * Deterministic offline adapter over the synthetic fixture dataset.
 *
 * It reuses the same RESO mapping and predicate code as the live MLS Grid
 * adapter and mirrors its pagination/cap semantics, so contract tests written
 * against fixtures describe real behavior rather than a simplified stand-in.
 *
 * Fixture data is synthetic and must never be presented as real market data.
 */

export interface FixtureAdapterOptions {
  properties?: RawRecord[];
  members?: RawRecord[];
  offices?: RawRecord[];
  openHouses?: RawRecord[];
  originatingSystem?: string;
  pageSize?: number;
  maxPagesPerQuery?: number;
  maxRecordsPerQuery?: number;
  /** Simulated provider per-request record cap, for cap-detection tests. */
  providerRequestCap?: number;
  exposePrivateRemarks?: boolean;
  now?: () => Date;
}

export class FixtureAdapter implements MlsProvider {
  readonly name = 'fixture';
  readonly originatingSystem: string;

  private readonly properties: RawRecord[];
  private readonly members: RawRecord[];
  private readonly offices: RawRecord[];
  private readonly openHouses: RawRecord[];
  private readonly pageSize: number;
  private readonly maxPages: number;
  private readonly maxRecords: number;
  private readonly providerRequestCap: number;
  private readonly exposePrivateRemarks: boolean;
  private readonly now: () => Date;

  constructor(opts: FixtureAdapterOptions = {}) {
    this.originatingSystem = opts.originatingSystem ?? FIXTURE_ORIGINATING_SYSTEM;
    this.properties = opts.properties ?? fixtureProperties();
    this.members = opts.members ?? fixtureMembers();
    this.offices = opts.offices ?? fixtureOffices();
    this.openHouses = opts.openHouses ?? fixtureOpenHouses();
    this.pageSize = opts.pageSize ?? 50;
    this.maxPages = opts.maxPagesPerQuery ?? 10;
    this.maxRecords = opts.maxRecordsPerQuery ?? 2_500;
    this.providerRequestCap = opts.providerRequestCap ?? 5_000;
    this.exposePrivateRemarks = opts.exposePrivateRemarks ?? false;
    this.now = opts.now ?? (() => new Date('2026-08-30T12:00:00Z'));
  }

  capabilities(): ProviderCapabilities {
    return {
      listing_lookup_by_id: 'supported',
      address_lookup: 'supported',
      listing_history_events: 'unsupported',
      media: 'unsupported',
      members: 'supported',
      offices: 'supported',
      open_houses: 'supported',
      server_totals: 'supported',
      notes: [
        'FIXTURE PROVIDER: all records are synthetic test data, not MLS content, and must never be presented as real market data.',
        'Event-level listing history is not modeled; the fixture reports the same capability limitation as the live adapter.'
      ]
    };
  }

  private ctx(): MappingContext {
    return {
      provider: this.name,
      originatingSystem: this.originatingSystem,
      fetchedAt: this.now().toISOString(),
      exposePrivateRemarks: this.exposePrivateRemarks
    };
  }

  /** Records for the configured originating system only, mapped and deduplicated. */
  private mappedListings(): NormalizedListing[] {
    const ctx = this.ctx();
    const seen = new Set<string>();
    const out: NormalizedListing[] = [];
    for (const raw of this.properties) {
      if (raw.OriginatingSystemName !== this.originatingSystem) continue;
      const mapped = mapListing(raw, ctx);
      if (mapped === null) continue;
      if (seen.has(mapped.listing_key)) continue;
      seen.add(mapped.listing_key);
      out.push(mapped);
    }
    return out;
  }

  async getListing(idOrKey: string, _opts: { include_media?: boolean } = {}): Promise<NormalizedListing | null> {
    const trimmed = idOrKey.trim();
    if (trimmed === '') throw new MlsError('VALIDATION', 'Listing id must not be empty');
    const needle = trimmed.toLowerCase();
    return (
      this.mappedListings().find(
        (l) => l.listing_id?.toLowerCase() === needle || l.listing_key.toLowerCase() === needle
      ) ?? null
    );
  }

  async getListingsByAddress(
    addressText: string,
    _opts: { include_media?: boolean } = {}
  ): Promise<NormalizedListing[]> {
    const needle = addressText.trim().toLowerCase().replace(/\s+/g, ' ');
    if (needle === '') throw new MlsError('VALIDATION', 'Address must not be empty');
    return this.mappedListings().filter(
      (l) => l.address.unparsed !== null && l.address.unparsed.toLowerCase().replace(/\s+/g, ' ') === needle
    );
  }

  async searchListings(query: ListingQuery): Promise<ProviderCollectionResult<NormalizedListing>> {
    const predicates = buildClientPredicates(query);
    const limit = Math.min(query.limit ?? this.maxRecords, this.maxRecords);
    const all = this.mappedListings();

    const records: NormalizedListing[] = [];
    let pagesFetched = 0;
    let capped = false;
    let capReason: string | null = null;
    let hasMore = false;
    let offset = 0;

    while (offset < all.length) {
      if (pagesFetched >= this.maxPages) {
        capped = true;
        hasMore = true;
        capReason = `page cap reached (${this.maxPages} pages of up to ${this.pageSize} records)`;
        break;
      }
      const page = all.slice(offset, offset + this.pageSize);
      pagesFetched += 1;
      offset += page.length;

      for (const listing of page) {
        if (!predicates.filter(listing)) continue;
        records.push(listing);
        if (records.length >= limit) {
          capped = true;
          hasMore = offset < all.length;
          capReason = `record limit reached (${limit})`;
          break;
        }
      }
      if (capReason !== null) break;

      if (pagesFetched * this.pageSize >= this.providerRequestCap && offset < all.length) {
        capped = true;
        hasMore = true;
        capReason = `provider request cap (${this.providerRequestCap}) reached`;
        break;
      }
    }

    return {
      records,
      pages_fetched: pagesFetched,
      has_more: hasMore,
      capped,
      cap_reason: capReason,
      // The fixture knows its own universe size; a live feed generally will not.
      total_known: capped ? null : records.length,
      server_side_filters: ['originating_system'],
      client_side_filters: predicates.applied,
      page_size: this.pageSize
    };
  }

  async getMember(memberMlsId: string): Promise<NormalizedMember | null> {
    const needle = memberMlsId.trim().toLowerCase();
    if (needle === '') throw new MlsError('VALIDATION', 'Member id must not be empty');
    const ctx = this.ctx();
    for (const raw of this.members) {
      if (raw.OriginatingSystemName !== this.originatingSystem) continue;
      const mapped = mapMember(raw, ctx);
      if (mapped === null) continue;
      if (mapped.member_mls_id?.toLowerCase() === needle || mapped.member_key.toLowerCase() === needle) {
        return mapped;
      }
    }
    return null;
  }

  async getOffice(officeMlsId: string): Promise<NormalizedOffice | null> {
    const needle = officeMlsId.trim().toLowerCase();
    if (needle === '') throw new MlsError('VALIDATION', 'Office id must not be empty');
    const ctx = this.ctx();
    for (const raw of this.offices) {
      if (raw.OriginatingSystemName !== this.originatingSystem) continue;
      const mapped = mapOffice(raw, ctx);
      if (mapped === null) continue;
      if (mapped.office_mls_id?.toLowerCase() === needle || mapped.office_key.toLowerCase() === needle) {
        return mapped;
      }
    }
    return null;
  }

  async getOpenHouses(query: OpenHouseQuery): Promise<ProviderCollectionResult<NormalizedOpenHouse>> {
    const ctx = this.ctx();
    const clientFilters: string[] = [];
    let records = this.openHouses
      .filter((raw) => raw.OriginatingSystemName === this.originatingSystem)
      .map((raw) => mapOpenHouse(raw, ctx))
      .filter((o): o is NormalizedOpenHouse => o !== null);

    if (query.listing_key) {
      clientFilters.push('listing_key');
      records = records.filter((o) => o.listing_key === query.listing_key);
    }
    if (query.listing_id) {
      clientFilters.push('listing_id');
      records = records.filter((o) => o.listing_id === query.listing_id);
    }
    if (query.starts_from) {
      clientFilters.push('starts_from');
      records = records.filter((o) => o.start_time !== null && o.start_time >= query.starts_from!);
    }
    if (query.starts_to) {
      clientFilters.push('starts_to');
      records = records.filter((o) => o.start_time !== null && o.start_time <= query.starts_to!);
    }

    const limit = Math.min(query.limit ?? 100, this.maxRecords);
    const capped = records.length > limit;
    return {
      records: records.slice(0, limit),
      pages_fetched: 1,
      has_more: capped,
      capped,
      cap_reason: capped ? `record limit reached (${limit})` : null,
      total_known: capped ? null : records.length,
      server_side_filters: ['originating_system'],
      client_side_filters: clientFilters,
      page_size: this.pageSize
    };
  }
}
