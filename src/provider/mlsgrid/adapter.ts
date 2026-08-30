import { MlsError } from '../../errors.js';
import type { Logger } from '../../logging.js';
import { nullLogger } from '../../logging.js';
import type {
  NormalizedListing,
  NormalizedMember,
  NormalizedOffice,
  NormalizedOpenHouse
} from '../../models/normalized.js';
import { buildClientPredicates } from '../predicates.js';
import type {
  ListingQuery,
  MlsProvider,
  OpenHouseQuery,
  ProviderCapabilities,
  ProviderCollectionResult
} from '../types.js';
import { MlsGridHttpClient } from './http.js';
import type { MappingContext } from './mapping.js';
import { mapListing, mapMember, mapOffice, mapOpenHouse } from './mapping.js';
import { DEFAULT_SERVER_FILTERABLE_FIELDS, ODataFilterBuilder } from './odata.js';

/**
 * MLS Grid RESO Web API v2 adapter.
 *
 * PROVISIONAL: every limit and field-capability assumption below is derived from
 * public MLS Grid documentation and has NOT been confirmed against live API
 * metadata or live behavior. `capabilities()` reports these as "unverified"
 * until the certification runbook passes.
 */

/** Documented per-request record cap without $expand (provisional). */
export const PROVIDER_REQUEST_CAP = 5_000;
/** Documented per-request record cap with $expand (provisional). */
export const PROVIDER_REQUEST_CAP_WITH_EXPAND = 1_000;

export interface MlsGridAdapterOptions {
  apiBase: string;
  token: string;
  originatingSystem: string;
  timeoutMs?: number;
  minRequestIntervalMs?: number;
  maxRetries?: number;
  pageSize?: number;
  maxPagesPerQuery?: number;
  maxRecordsPerQuery?: number;
  serverFilterFields?: readonly string[];
  exposePrivateRemarks?: boolean;
  fetchFn?: typeof fetch;
  sleepFn?: (ms: number) => Promise<void>;
  logger?: Logger;
  /** Injectable clock for deterministic tests. */
  now?: () => Date;
}

export class MlsGridAdapter implements MlsProvider {
  readonly name = 'mlsgrid';
  readonly originatingSystem: string;

  private readonly http: MlsGridHttpClient;
  private readonly filterFields: readonly string[];
  private readonly pageSize: number;
  private readonly maxPages: number;
  private readonly maxRecords: number;
  private readonly exposePrivateRemarks: boolean;
  private readonly logger: Logger;
  private readonly now: () => Date;

  constructor(opts: MlsGridAdapterOptions) {
    this.originatingSystem = opts.originatingSystem;
    this.http = new MlsGridHttpClient({
      baseUrl: opts.apiBase,
      token: opts.token,
      timeoutMs: opts.timeoutMs,
      minRequestIntervalMs: opts.minRequestIntervalMs,
      maxRetries: opts.maxRetries,
      fetchFn: opts.fetchFn,
      sleepFn: opts.sleepFn,
      logger: opts.logger
    });
    this.filterFields = opts.serverFilterFields ?? DEFAULT_SERVER_FILTERABLE_FIELDS;
    this.pageSize = opts.pageSize ?? 1_000;
    this.maxPages = opts.maxPagesPerQuery ?? 5;
    this.maxRecords = opts.maxRecordsPerQuery ?? 2_500;
    this.exposePrivateRemarks = opts.exposePrivateRemarks ?? false;
    this.logger = opts.logger ?? nullLogger;
    this.now = opts.now ?? (() => new Date());
  }

  capabilities(): ProviderCapabilities {
    const canFilterAddress =
      this.filterFields.includes('UnparsedAddress') ||
      (this.filterFields.includes('StreetNumber') && this.filterFields.includes('StreetName'));
    return {
      listing_lookup_by_id: 'unverified',
      address_lookup: canFilterAddress ? 'unverified' : 'unsupported',
      // No documented event-level history resource in the licensed feed.
      listing_history_events: 'unsupported',
      media: 'unverified',
      members: 'unverified',
      offices: 'unverified',
      open_houses: 'unverified',
      // MLS Grid documentation does not establish a reliable server-side $count.
      server_totals: 'unverified',
      notes: [
        'All MLS Grid capabilities are documentation-derived and unconfirmed against live $metadata or live behavior.',
        'No live MLS Grid token has been certified for this server; see docs/CERTIFICATION_RUNBOOK.md.',
        canFilterAddress
          ? 'Address lookup will be attempted server-side using the configured filterable-field allowlist.'
          : 'Address fields are not in the server-side filterable allowlist; exact address lookup is unavailable via this adapter.',
        'Private/agent remarks are mapped only when the licensed feed exposes them and MLSGRID_EXPOSE_PRIVATE_REMARKS is enabled.'
      ]
    };
  }

  private mappingContext(): MappingContext {
    return {
      provider: this.name,
      originatingSystem: this.originatingSystem,
      fetchedAt: this.now().toISOString(),
      exposePrivateRemarks: this.exposePrivateRemarks
    };
  }

  private baseFilter(): ODataFilterBuilder {
    // OriginatingSystemName is enforced on every request: exactly one system per query.
    return new ODataFilterBuilder(this.filterFields).where(
      { field: 'OriginatingSystemName', op: 'eq', value: this.originatingSystem },
      'originating_system'
    );
  }

  async getListing(idOrKey: string, opts: { include_media?: boolean } = {}): Promise<NormalizedListing | null> {
    const trimmed = idOrKey.trim();
    if (trimmed === '') throw new MlsError('VALIDATION', 'Listing id must not be empty');

    for (const field of ['ListingId', 'ListingKey'] as const) {
      const filter = this.baseFilter().where({ field, op: 'eq', value: trimmed }, field).build();
      const url = this.http.buildUrl('Property', {
        $filter: filter,
        $top: 2,
        ...(opts.include_media ? { $expand: 'Media' } : {})
      });
      const page = await this.http.getPage(url);
      const ctx = this.mappingContext();
      const mapped = page.value.map((v) => mapListing(v, ctx)).filter((l): l is NormalizedListing => l !== null);
      if (mapped.length > 0) return mapped[0]!;
    }
    return null;
  }

  async getListingsByAddress(
    addressText: string,
    opts: { include_media?: boolean } = {}
  ): Promise<NormalizedListing[]> {
    const trimmed = addressText.trim();
    if (trimmed === '') throw new MlsError('VALIDATION', 'Address must not be empty');

    const builder = this.baseFilter();
    if (!builder.canServe('UnparsedAddress')) {
      throw new MlsError(
        'UNSUPPORTED_CAPABILITY',
        'Exact address lookup is not available: address fields are not in the confirmed server-side ' +
          'filterable allowlist for this feed. Use the certified Northstar/Matrix browser lane, or configure ' +
          'MLSGRID_SERVER_FILTER_FIELDS once live $metadata confirms address filtering.',
        { details: { requested_field: 'UnparsedAddress' } }
      );
    }
    const filter = builder.where({ field: 'UnparsedAddress', op: 'eq', value: trimmed }, 'address').build();
    const url = this.http.buildUrl('Property', {
      $filter: filter,
      $top: 25,
      ...(opts.include_media ? { $expand: 'Media' } : {})
    });
    const page = await this.http.getPage(url);
    const ctx = this.mappingContext();
    return page.value.map((v) => mapListing(v, ctx)).filter((l): l is NormalizedListing => l !== null);
  }

  async searchListings(query: ListingQuery): Promise<ProviderCollectionResult<NormalizedListing>> {
    const builder = this.baseFilter();
    const servedKeys = new Set<keyof ListingQuery>();

    if (query.statuses && query.statuses.length > 0 && builder.canServe('StandardStatus')) {
      builder.whereIn({ field: 'StandardStatus', values: [...query.statuses] }, 'statuses');
      servedKeys.add('statuses');
    }
    if (query.property_types && query.property_types.length > 0 && builder.canServe('PropertyType')) {
      builder.whereIn({ field: 'PropertyType', values: [...query.property_types] }, 'property_types');
      servedKeys.add('property_types');
    }
    if (query.modified_since && builder.canServe('ModificationTimestamp')) {
      builder.where(
        { field: 'ModificationTimestamp', op: 'ge', value: query.modified_since, raw: true },
        'modified_since'
      );
      servedKeys.add('modified_since');
    }
    // City/postal/price/beds/dates are filtered client-side unless live metadata
    // confirms they are searchable; MLSGRID_SERVER_FILTER_FIELDS can widen this.
    if (query.cities && query.cities.length > 0 && builder.canServe('City')) {
      builder.whereIn({ field: 'City', values: [...query.cities] }, 'cities');
      servedKeys.add('cities');
    }
    if (query.postal_codes && query.postal_codes.length > 0 && builder.canServe('PostalCode')) {
      builder.whereIn({ field: 'PostalCode', values: [...query.postal_codes] }, 'postal_codes');
      servedKeys.add('postal_codes');
    }

    const predicates = buildClientPredicates(query, { skip: servedKeys });
    const limit = Math.min(query.limit ?? this.maxRecords, this.maxRecords);
    const includeMedia = query.include_media === true;
    const pageSize = Math.min(
      this.pageSize,
      includeMedia ? PROVIDER_REQUEST_CAP_WITH_EXPAND : PROVIDER_REQUEST_CAP
    );

    const firstUrl = this.http.buildUrl('Property', {
      $filter: builder.build(),
      $top: pageSize,
      ...(includeMedia ? { $expand: 'Media' } : {})
    });

    const seen = new Set<string>();
    const records: NormalizedListing[] = [];
    let pagesFetched = 0;
    let nextUrl: string | null = firstUrl;
    let totalKnown: number | null = null;
    let capped = false;
    let capReason: string | null = null;
    let hasMore = false;

    while (nextUrl !== null) {
      if (pagesFetched >= this.maxPages) {
        capped = true;
        hasMore = true;
        capReason = `page cap reached (${this.maxPages} pages of up to ${pageSize} records)`;
        break;
      }
      const page: { value: unknown[]; nextLink: string | null; count: number | null } =
        await this.http.getPage(nextUrl);
      pagesFetched += 1;
      if (page.count !== null) totalKnown = page.count;

      const ctx = this.mappingContext();
      for (const rawRecord of page.value) {
        const mapped = mapListing(rawRecord, ctx);
        // Records without a stable key are unusable and are dropped rather than guessed.
        if (mapped === null) continue;
        if (seen.has(mapped.listing_key)) continue;
        if (!predicates.filter(mapped)) {
          seen.add(mapped.listing_key);
          continue;
        }
        seen.add(mapped.listing_key);
        records.push(mapped);
        if (records.length >= limit) {
          capped = true;
          hasMore = page.nextLink !== null || page.value.length >= pageSize;
          capReason = `record limit reached (${limit})`;
          break;
        }
      }
      if (capReason !== null) break;

      // A full page with no nextLink means the provider request cap may have
      // silently truncated the result set: never present that as complete.
      if (page.nextLink === null && page.value.length >= pageSize && pageSize >= PROVIDER_REQUEST_CAP) {
        capped = true;
        hasMore = true;
        capReason = `provider request cap (${PROVIDER_REQUEST_CAP}) reached without a continuation link`;
        break;
      }
      nextUrl = page.nextLink;
    }

    this.logger.debug('mlsgrid search complete', {
      pages_fetched: pagesFetched,
      returned: records.length,
      capped
    });

    return {
      records,
      pages_fetched: pagesFetched,
      has_more: hasMore,
      capped,
      cap_reason: capReason,
      total_known: totalKnown,
      server_side_filters: builder.servedPredicates,
      client_side_filters: predicates.applied,
      page_size: pageSize
    };
  }

  async getMember(memberMlsId: string): Promise<NormalizedMember | null> {
    const trimmed = memberMlsId.trim();
    if (trimmed === '') throw new MlsError('VALIDATION', 'Member id must not be empty');
    for (const field of ['MemberMlsId', 'MemberKey'] as const) {
      const filter = this.baseFilter().where({ field, op: 'eq', value: trimmed }, field).build();
      const page = await this.http.getPage(this.http.buildUrl('Member', { $filter: filter, $top: 2 }));
      const ctx = this.mappingContext();
      const mapped = page.value.map((v) => mapMember(v, ctx)).filter((m): m is NormalizedMember => m !== null);
      if (mapped.length > 0) return mapped[0]!;
    }
    return null;
  }

  async getOffice(officeMlsId: string): Promise<NormalizedOffice | null> {
    const trimmed = officeMlsId.trim();
    if (trimmed === '') throw new MlsError('VALIDATION', 'Office id must not be empty');
    for (const field of ['OfficeMlsId', 'OfficeKey'] as const) {
      const filter = this.baseFilter().where({ field, op: 'eq', value: trimmed }, field).build();
      const page = await this.http.getPage(this.http.buildUrl('Office', { $filter: filter, $top: 2 }));
      const ctx = this.mappingContext();
      const mapped = page.value.map((v) => mapOffice(v, ctx)).filter((o): o is NormalizedOffice => o !== null);
      if (mapped.length > 0) return mapped[0]!;
    }
    return null;
  }

  async getOpenHouses(query: OpenHouseQuery): Promise<ProviderCollectionResult<NormalizedOpenHouse>> {
    const builder = this.baseFilter();
    if (query.listing_key && builder.canServe('ListingKey')) {
      builder.where({ field: 'ListingKey', op: 'eq', value: query.listing_key }, 'listing_key');
    } else if (query.listing_id && builder.canServe('ListingId')) {
      builder.where({ field: 'ListingId', op: 'eq', value: query.listing_id }, 'listing_id');
    }

    const limit = Math.min(query.limit ?? 100, this.maxRecords);
    const url = this.http.buildUrl('OpenHouse', { $filter: builder.build(), $top: Math.min(limit, this.pageSize) });
    const page = await this.http.getPage(url);
    const ctx = this.mappingContext();

    const clientFilters: string[] = [];
    let records = page.value
      .map((v) => mapOpenHouse(v, ctx))
      .filter((o): o is NormalizedOpenHouse => o !== null);
    if (query.starts_from) {
      clientFilters.push('starts_from');
      records = records.filter((o) => o.start_time !== null && o.start_time >= query.starts_from!);
    }
    if (query.starts_to) {
      clientFilters.push('starts_to');
      records = records.filter((o) => o.start_time !== null && o.start_time <= query.starts_to!);
    }

    const capped = records.length > limit;
    return {
      records: records.slice(0, limit),
      pages_fetched: 1,
      has_more: page.nextLink !== null || capped,
      capped,
      cap_reason: capped ? `record limit reached (${limit})` : null,
      total_known: page.count,
      server_side_filters: builder.servedPredicates,
      client_side_filters: clientFilters,
      page_size: Math.min(limit, this.pageSize)
    };
  }
}
