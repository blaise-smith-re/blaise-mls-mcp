import type { NormalizedListing } from '../models/normalized.js';
import type { ListingQuery } from './types.js';

/**
 * In-process predicate evaluation over normalized listings. Used by the fixture
 * adapter for all predicates and by the MLS Grid adapter for predicates the
 * source API cannot filter server-side. Records with a null value for a
 * filtered field are EXCLUDED (a bound cannot be proven satisfied) — this is
 * deliberate and documented, never a guess.
 */

export interface PredicateResult {
  /** Names of predicates evaluated client-side, for completeness metadata. */
  applied: string[];
  filter: (l: NormalizedListing) => boolean;
}

function norm(s: string): string {
  return s.trim().toLowerCase();
}

export function buildClientPredicates(
  query: ListingQuery,
  opts: { skip?: Set<keyof ListingQuery> } = {}
): PredicateResult {
  const skip = opts.skip ?? new Set<keyof ListingQuery>();
  const applied: string[] = [];
  const checks: Array<(l: NormalizedListing) => boolean> = [];

  const active = (k: keyof ListingQuery): boolean => query[k] !== undefined && !skip.has(k);

  if (active('statuses') && query.statuses!.length > 0) {
    applied.push('statuses');
    const set = new Set(query.statuses!.map(norm));
    checks.push((l) => l.standard_status !== null && set.has(norm(l.standard_status)));
  }
  if (active('cities') && query.cities!.length > 0) {
    applied.push('cities');
    const set = new Set(query.cities!.map(norm));
    checks.push((l) => l.address.city !== null && set.has(norm(l.address.city)));
  }
  if (active('postal_codes') && query.postal_codes!.length > 0) {
    applied.push('postal_codes');
    const set = new Set(query.postal_codes!.map(norm));
    checks.push((l) => l.address.postal_code !== null && set.has(norm(l.address.postal_code)));
  }
  if (active('counties') && query.counties!.length > 0) {
    applied.push('counties');
    const set = new Set(query.counties!.map(norm));
    checks.push((l) => l.address.county !== null && set.has(norm(l.address.county)));
  }
  if (active('property_types') && query.property_types!.length > 0) {
    applied.push('property_types');
    const set = new Set(query.property_types!.map(norm));
    checks.push((l) => l.property_type !== null && set.has(norm(l.property_type)));
  }
  if (active('property_sub_types') && query.property_sub_types!.length > 0) {
    applied.push('property_sub_types');
    const set = new Set(query.property_sub_types!.map(norm));
    checks.push((l) => l.property_sub_type !== null && set.has(norm(l.property_sub_type)));
  }

  const priceField = query.price_field ?? 'list';
  const priceOf = (l: NormalizedListing): number | null =>
    priceField === 'close' ? l.close_price : l.list_price;
  if (active('min_price')) {
    applied.push('min_price');
    checks.push((l) => priceOf(l) !== null && priceOf(l)! >= query.min_price!);
  }
  if (active('max_price')) {
    applied.push('max_price');
    checks.push((l) => priceOf(l) !== null && priceOf(l)! <= query.max_price!);
  }

  if (active('min_beds')) {
    applied.push('min_beds');
    checks.push((l) => l.bedrooms_total !== null && l.bedrooms_total >= query.min_beds!);
  }
  if (active('max_beds')) {
    applied.push('max_beds');
    checks.push((l) => l.bedrooms_total !== null && l.bedrooms_total <= query.max_beds!);
  }
  if (active('min_baths')) {
    applied.push('min_baths');
    checks.push((l) => l.bathrooms_total !== null && l.bathrooms_total >= query.min_baths!);
  }

  if (active('min_living_area_sqft')) {
    applied.push('min_living_area_sqft');
    checks.push((l) => l.living_area_sqft !== null && l.living_area_sqft >= query.min_living_area_sqft!);
  }
  if (active('max_living_area_sqft')) {
    applied.push('max_living_area_sqft');
    checks.push((l) => l.living_area_sqft !== null && l.living_area_sqft <= query.max_living_area_sqft!);
  }
  if (active('min_year_built')) {
    applied.push('min_year_built');
    checks.push((l) => l.year_built !== null && l.year_built >= query.min_year_built!);
  }
  if (active('max_year_built')) {
    applied.push('max_year_built');
    checks.push((l) => l.year_built !== null && l.year_built <= query.max_year_built!);
  }

  // Date comparisons operate on ISO date strings (lexicographically ordered).
  const datePrefix = (v: string | null): string | null => (v ? v.slice(0, 10) : null);
  if (active('listed_from')) {
    applied.push('listed_from');
    checks.push((l) => {
      const d = datePrefix(l.listing_contract_date);
      return d !== null && d >= query.listed_from!.slice(0, 10);
    });
  }
  if (active('listed_to')) {
    applied.push('listed_to');
    checks.push((l) => {
      const d = datePrefix(l.listing_contract_date);
      return d !== null && d <= query.listed_to!.slice(0, 10);
    });
  }
  if (active('closed_from')) {
    applied.push('closed_from');
    checks.push((l) => {
      const d = datePrefix(l.close_date);
      return d !== null && d >= query.closed_from!.slice(0, 10);
    });
  }
  if (active('closed_to')) {
    applied.push('closed_to');
    checks.push((l) => {
      const d = datePrefix(l.close_date);
      return d !== null && d <= query.closed_to!.slice(0, 10);
    });
  }
  if (active('modified_since')) {
    applied.push('modified_since');
    checks.push((l) => l.modification_timestamp !== null && l.modification_timestamp >= query.modified_since!);
  }

  return {
    applied,
    filter: (l) => checks.every((c) => c(l))
  };
}
