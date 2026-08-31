import type {
  NormalizedListing,
  NormalizedMember,
  NormalizedOffice,
  NormalizedOpenHouse,
  StandardStatus
} from '../models/normalized.js';

/**
 * Deterministic, typed listing query. No raw OData strings cross this boundary;
 * adapters translate these predicates into whatever their source supports and
 * report which predicates were served server-side vs client-side.
 */
export interface ListingQuery {
  statuses?: StandardStatus[];
  cities?: string[];
  postal_codes?: string[];
  counties?: string[];
  property_types?: string[];
  property_sub_types?: string[];

  /** Which price field the min/max bounds apply to. Default: 'list'. */
  price_field?: 'list' | 'close';
  min_price?: number;
  max_price?: number;

  min_beds?: number;
  max_beds?: number;
  min_baths?: number;

  min_living_area_sqft?: number;
  max_living_area_sqft?: number;
  min_year_built?: number;
  max_year_built?: number;

  /** ListingContractDate bounds (ISO date, inclusive). */
  listed_from?: string;
  listed_to?: string;
  /** CloseDate bounds (ISO date, inclusive). */
  closed_from?: string;
  closed_to?: string;
  /** ModificationTimestamp lower bound (ISO 8601). */
  modified_since?: string;

  /** Maximum records to return after filtering/dedupe. */
  limit?: number;
  /** Expand media on returned listings (may reduce provider page size). */
  include_media?: boolean;
}

export interface OpenHouseQuery {
  listing_key?: string;
  listing_id?: string;
  starts_from?: string;
  starts_to?: string;
  limit?: number;
}

export type CapabilitySupport = 'supported' | 'unsupported' | 'unverified';

export interface ProviderCapabilities {
  /** Exact lookup by MLS number / listing key. */
  listing_lookup_by_id: CapabilitySupport;
  /** Server-side exact address lookup. */
  address_lookup: CapabilitySupport;
  /** Historical event-level listing history (price changes, status changes). */
  listing_history_events: CapabilitySupport;
  media: CapabilitySupport;
  members: CapabilitySupport;
  offices: CapabilitySupport;
  open_houses: CapabilitySupport;
  /** Server-reported total counts ($count). */
  server_totals: CapabilitySupport;
  /** Human-readable provisos, e.g. "documentation-derived; unconfirmed against live metadata". */
  notes: string[];
}

export interface ProviderCollectionResult<T> {
  records: T[];
  pages_fetched: number;
  has_more: boolean;
  capped: boolean;
  cap_reason: string | null;
  total_known: number | null;
  server_side_filters: string[];
  client_side_filters: string[];
  page_size: number;
}

export interface MlsProvider {
  readonly name: string;
  readonly originatingSystem: string;

  capabilities(): ProviderCapabilities;

  /** Exact lookup by MLS number (ListingId) or ListingKey. Null when not found. */
  getListing(idOrKey: string, opts?: { include_media?: boolean }): Promise<NormalizedListing | null>;

  /**
   * Exact address lookup. Throws MlsError('UNSUPPORTED_CAPABILITY') when the
   * provider cannot serve address lookups deterministically.
   */
  getListingsByAddress(address: string, opts?: { include_media?: boolean }): Promise<NormalizedListing[]>;

  searchListings(query: ListingQuery): Promise<ProviderCollectionResult<NormalizedListing>>;

  getMember(memberMlsId: string): Promise<NormalizedMember | null>;
  getOffice(officeMlsId: string): Promise<NormalizedOffice | null>;
  getOpenHouses(query: OpenHouseQuery): Promise<ProviderCollectionResult<NormalizedOpenHouse>>;
}
