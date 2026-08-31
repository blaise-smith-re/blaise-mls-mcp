import type {
  ListingAddress,
  MediaRef,
  NormalizedListing,
  NormalizedMember,
  NormalizedOffice,
  NormalizedOpenHouse,
  SourceProvenance,
  StandardStatus
} from '../../models/normalized.js';
import { STANDARD_STATUSES } from '../../models/normalized.js';

/**
 * RESO Web API (MLS Grid) -> normalized model mapping.
 *
 * Rules:
 *  - A missing, null, empty, or wrong-typed source value maps to null. Never guessed.
 *  - Numeric strings that parse exactly are accepted (feeds vary); anything else is null.
 *  - Private/agent remarks are mapped only when explicitly enabled by config.
 *
 * The RESO field names below are documentation-derived and must be reconciled
 * against live $metadata during certification (docs/FIELD_MAPPING.md).
 */

export function str(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

export function num(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    const t = v.trim();
    if (t === '') return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** A fractional value where an integer is expected is treated as unusable, not rounded. */
export function int(v: unknown): number | null {
  const n = num(v);
  if (n === null) return null;
  return Number.isInteger(n) ? n : null;
}

/** Normalize a source timestamp to ISO 8601 UTC. Unparseable values map to null. */
export function isoTimestamp(v: unknown): string | null {
  const s = str(v);
  if (s === null) return null;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

/**
 * Normalize a source date to a plain ISO date (YYYY-MM-DD). RESO date fields are
 * calendar dates without a zone; we never shift them by a timezone offset, which
 * would silently move a close date across a day boundary.
 */
export function isoDate(v: unknown): string | null {
  const s = str(v);
  if (s === null) return null;
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(s);
  if (m) return m[1]!;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

export function standardStatus(v: unknown): StandardStatus | null {
  const s = str(v);
  if (s === null) return null;
  const collapsed = s.replace(/[\s_-]/g, '').toLowerCase();
  for (const known of STANDARD_STATUSES) {
    if (known.toLowerCase() === collapsed) return known;
  }
  return null;
}

function address(raw: Record<string, unknown>): ListingAddress {
  return {
    unparsed: str(raw.UnparsedAddress),
    street_number: str(raw.StreetNumber),
    street_name: [str(raw.StreetDirPrefix), str(raw.StreetName), str(raw.StreetSuffix), str(raw.StreetDirSuffix)]
      .filter((p): p is string => p !== null)
      .join(' ') || null,
    unit: str(raw.UnitNumber),
    city: str(raw.City),
    state: str(raw.StateOrProvince),
    postal_code: str(raw.PostalCode),
    county: str(raw.CountyOrParish)
  };
}

function media(raw: unknown): MediaRef[] | null {
  if (!Array.isArray(raw)) return null;
  const out: MediaRef[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== 'object') continue;
    const m = item as Record<string, unknown>;
    const url = str(m.MediaURL);
    if (url === null) continue;
    out.push({ url, order: int(m.Order), description: str(m.ShortDescription) ?? str(m.LongDescription) });
  }
  return out;
}

export interface MappingContext {
  provider: string;
  originatingSystem: string;
  fetchedAt: string;
  exposePrivateRemarks: boolean;
}

function provenance(ctx: MappingContext, resource: string, raw: Record<string, unknown>): SourceProvenance {
  return {
    provider: ctx.provider,
    originating_system: str(raw.OriginatingSystemName) ?? ctx.originatingSystem,
    resource,
    fetched_at: ctx.fetchedAt,
    record_modification_timestamp: isoTimestamp(raw.ModificationTimestamp)
  };
}

/** Returns null when the record has no usable stable key (unusable record). */
export function mapListing(rawValue: unknown, ctx: MappingContext): NormalizedListing | null {
  if (rawValue === null || typeof rawValue !== 'object' || Array.isArray(rawValue)) return null;
  const raw = rawValue as Record<string, unknown>;

  const listingKey = str(raw.ListingKey) ?? str(raw.ListingId);
  if (listingKey === null) return null;

  return {
    listing_key: listingKey,
    listing_id: str(raw.ListingId),
    originating_system: str(raw.OriginatingSystemName) ?? ctx.originatingSystem,

    standard_status: standardStatus(raw.StandardStatus),
    mls_status: str(raw.MlsStatus),
    property_type: str(raw.PropertyType),
    property_sub_type: str(raw.PropertySubType),

    address: address(raw),
    latitude: num(raw.Latitude),
    longitude: num(raw.Longitude),

    list_price: num(raw.ListPrice),
    original_list_price: num(raw.OriginalListPrice),
    close_price: num(raw.ClosePrice),

    bedrooms_total: int(raw.BedroomsTotal),
    bathrooms_total: num(raw.BathroomsTotalInteger) ?? num(raw.BathroomsTotal),
    bathrooms_full: int(raw.BathroomsFull),
    bathrooms_half: int(raw.BathroomsHalf),

    living_area_sqft: num(raw.LivingArea),
    above_grade_finished_area_sqft: num(raw.AboveGradeFinishedArea),
    below_grade_finished_area_sqft: num(raw.BelowGradeFinishedArea),
    lot_size_acres: num(raw.LotSizeAcres),
    lot_size_sqft: num(raw.LotSizeSquareFeet),
    year_built: int(raw.YearBuilt),

    days_on_market: int(raw.DaysOnMarket),
    cumulative_days_on_market: int(raw.CumulativeDaysOnMarket),

    listing_contract_date: isoDate(raw.ListingContractDate),
    purchase_contract_date: isoDate(raw.PurchaseContractDate),
    close_date: isoDate(raw.CloseDate),

    concessions_amount: num(raw.ConcessionsAmount),
    concessions_comments: str(raw.ConcessionsComments),

    public_remarks: str(raw.PublicRemarks),
    private_remarks: ctx.exposePrivateRemarks ? str(raw.PrivateRemarks) : null,

    list_agent_key: str(raw.ListAgentKey),
    list_agent_mls_id: str(raw.ListAgentMlsId),
    list_office_key: str(raw.ListOfficeKey),
    list_office_mls_id: str(raw.ListOfficeMlsId),

    media: media(raw.Media),

    modification_timestamp: isoTimestamp(raw.ModificationTimestamp),
    source: provenance(ctx, 'Property', raw)
  };
}

export function mapMember(rawValue: unknown, ctx: MappingContext): NormalizedMember | null {
  if (rawValue === null || typeof rawValue !== 'object' || Array.isArray(rawValue)) return null;
  const raw = rawValue as Record<string, unknown>;
  const key = str(raw.MemberKey) ?? str(raw.MemberMlsId);
  if (key === null) return null;
  return {
    member_key: key,
    member_mls_id: str(raw.MemberMlsId),
    full_name: str(raw.MemberFullName),
    first_name: str(raw.MemberFirstName),
    last_name: str(raw.MemberLastName),
    email: str(raw.MemberEmail),
    phone: str(raw.MemberPreferredPhone) ?? str(raw.MemberDirectPhone),
    office_key: str(raw.OfficeKey),
    office_mls_id: str(raw.OfficeMlsId),
    modification_timestamp: isoTimestamp(raw.ModificationTimestamp),
    source: provenance(ctx, 'Member', raw)
  };
}

export function mapOffice(rawValue: unknown, ctx: MappingContext): NormalizedOffice | null {
  if (rawValue === null || typeof rawValue !== 'object' || Array.isArray(rawValue)) return null;
  const raw = rawValue as Record<string, unknown>;
  const key = str(raw.OfficeKey) ?? str(raw.OfficeMlsId);
  if (key === null) return null;
  return {
    office_key: key,
    office_mls_id: str(raw.OfficeMlsId),
    name: str(raw.OfficeName),
    phone: str(raw.OfficePhone),
    address: address(raw),
    modification_timestamp: isoTimestamp(raw.ModificationTimestamp),
    source: provenance(ctx, 'Office', raw)
  };
}

export function mapOpenHouse(rawValue: unknown, ctx: MappingContext): NormalizedOpenHouse | null {
  if (rawValue === null || typeof rawValue !== 'object' || Array.isArray(rawValue)) return null;
  const raw = rawValue as Record<string, unknown>;
  const key = str(raw.OpenHouseKey);
  if (key === null) return null;
  return {
    open_house_key: key,
    listing_key: str(raw.ListingKey),
    listing_id: str(raw.ListingId),
    start_time: isoTimestamp(raw.OpenHouseStartTime),
    end_time: isoTimestamp(raw.OpenHouseEndTime),
    remarks: str(raw.OpenHouseRemarks),
    status: str(raw.OpenHouseStatus),
    modification_timestamp: isoTimestamp(raw.ModificationTimestamp),
    source: provenance(ctx, 'OpenHouse', raw)
  };
}
