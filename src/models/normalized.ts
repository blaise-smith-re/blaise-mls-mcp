/**
 * Normalized internal models. Provider adapters map raw source payloads into
 * these shapes. A missing/invalid source value is ALWAYS null — never guessed.
 */

export type StandardStatus =
  | 'Active'
  | 'ActiveUnderContract'
  | 'Pending'
  | 'Closed'
  | 'Canceled'
  | 'Expired'
  | 'Withdrawn'
  | 'ComingSoon'
  | 'Hold';

export const STANDARD_STATUSES: readonly StandardStatus[] = [
  'Active',
  'ActiveUnderContract',
  'Pending',
  'Closed',
  'Canceled',
  'Expired',
  'Withdrawn',
  'ComingSoon',
  'Hold'
];

export interface SourceProvenance {
  /** Adapter that produced the record, e.g. "mlsgrid" or "fixture". */
  provider: string;
  originating_system: string;
  /** Source resource, e.g. "Property". */
  resource: string;
  /** When this server fetched the record (ISO 8601 UTC). */
  fetched_at: string;
  /** Source-reported ModificationTimestamp, when available. */
  record_modification_timestamp: string | null;
}

export interface ListingAddress {
  unparsed: string | null;
  street_number: string | null;
  street_name: string | null;
  unit: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
  county: string | null;
}

export interface MediaRef {
  url: string;
  order: number | null;
  description: string | null;
}

export interface NormalizedListing {
  /** Stable provider-wide unique key (RESO ListingKey). Dedupe key. */
  listing_key: string;
  /** MLS number (RESO ListingId). */
  listing_id: string | null;
  originating_system: string;

  standard_status: StandardStatus | null;
  mls_status: string | null;
  property_type: string | null;
  property_sub_type: string | null;

  address: ListingAddress;
  latitude: number | null;
  longitude: number | null;

  list_price: number | null;
  original_list_price: number | null;
  close_price: number | null;

  bedrooms_total: number | null;
  bathrooms_total: number | null;
  bathrooms_full: number | null;
  bathrooms_half: number | null;

  living_area_sqft: number | null;
  above_grade_finished_area_sqft: number | null;
  below_grade_finished_area_sqft: number | null;
  lot_size_acres: number | null;
  lot_size_sqft: number | null;
  year_built: number | null;

  days_on_market: number | null;
  cumulative_days_on_market: number | null;

  /** ISO dates as reported by the source. */
  listing_contract_date: string | null;
  purchase_contract_date: string | null;
  close_date: string | null;

  concessions_amount: number | null;
  concessions_comments: string | null;

  public_remarks: string | null;
  /**
   * Populated ONLY when the licensed feed legitimately exposes private remarks
   * AND MLSGRID_EXPOSE_PRIVATE_REMARKS is explicitly enabled. Default: null.
   */
  private_remarks: string | null;

  list_agent_key: string | null;
  list_agent_mls_id: string | null;
  list_office_key: string | null;
  list_office_mls_id: string | null;

  media: MediaRef[] | null;

  modification_timestamp: string | null;
  source: SourceProvenance;
}

export interface NormalizedMember {
  member_key: string;
  member_mls_id: string | null;
  full_name: string | null;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  phone: string | null;
  office_key: string | null;
  office_mls_id: string | null;
  modification_timestamp: string | null;
  source: SourceProvenance;
}

export interface NormalizedOffice {
  office_key: string;
  office_mls_id: string | null;
  name: string | null;
  phone: string | null;
  address: ListingAddress | null;
  modification_timestamp: string | null;
  source: SourceProvenance;
}

export interface NormalizedOpenHouse {
  open_house_key: string;
  listing_key: string | null;
  listing_id: string | null;
  /** ISO 8601 timestamps as reported by the source. */
  start_time: string | null;
  end_time: string | null;
  remarks: string | null;
  status: string | null;
  modification_timestamp: string | null;
  source: SourceProvenance;
}
