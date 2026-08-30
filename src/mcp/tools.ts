import { z } from 'zod';
import type { ListingQuery } from '../provider/types.js';
import type { MlsService } from '../service/mls-service.js';

/**
 * MCP tool inventory.
 *
 * Every tool is READ-ONLY. There is no add/edit/delete surface, no arbitrary
 * URL fetch, no raw OData passthrough, and no generic HTTP proxy tool. Tool
 * handlers are plain async functions so they can be exercised directly in
 * tests without an MCP transport.
 */

export interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: z.ZodRawShape;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

const statusEnum = z.enum([
  'Active',
  'ActiveUnderContract',
  'Pending',
  'Closed',
  'Canceled',
  'Expired',
  'Withdrawn',
  'ComingSoon',
  'Hold'
]);

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be an ISO calendar date (YYYY-MM-DD)');

const isoDateTime = z
  .string()
  .regex(
    /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?)?$/,
    'Must be an ISO 8601 date or datetime'
  );

/** Shared listing-query filters. Only these typed filters exist — no raw OData. */
const listingFilterShape = {
  statuses: z.array(statusEnum).min(1).max(9).optional()
    .describe('Explicit StandardStatus values. Always state statuses explicitly rather than relying on a default.'),
  cities: z.array(z.string().min(1)).max(10).optional().describe('City names, exact match, case-insensitive.'),
  postal_codes: z.array(z.string().min(1)).max(10).optional(),
  counties: z.array(z.string().min(1)).max(10).optional(),
  property_types: z.array(z.string().min(1)).max(10).optional().describe('RESO PropertyType, e.g. "Residential".'),
  property_sub_types: z.array(z.string().min(1)).max(10).optional()
    .describe('RESO PropertySubType, e.g. "SingleFamilyResidence", "Townhouse", "Condominium".'),
  price_field: z.enum(['list', 'close']).optional()
    .describe('Which price the min/max bounds apply to. Defaults to list price.'),
  min_price: z.number().nonnegative().optional(),
  max_price: z.number().nonnegative().optional(),
  min_beds: z.number().int().nonnegative().optional(),
  max_beds: z.number().int().nonnegative().optional(),
  min_baths: z.number().nonnegative().optional(),
  min_living_area_sqft: z.number().nonnegative().optional(),
  max_living_area_sqft: z.number().nonnegative().optional(),
  min_year_built: z.number().int().optional(),
  max_year_built: z.number().int().optional(),
  listed_from: isoDate.optional().describe('ListingContractDate lower bound, inclusive.'),
  listed_to: isoDate.optional().describe('ListingContractDate upper bound, inclusive.'),
  closed_from: isoDate.optional().describe('CloseDate lower bound, inclusive.'),
  closed_to: isoDate.optional().describe('CloseDate upper bound, inclusive.'),
  modified_since: isoDateTime.optional().describe('ModificationTimestamp lower bound.')
};

function toListingQuery(args: Record<string, unknown>): ListingQuery {
  const keys = Object.keys(listingFilterShape) as Array<keyof typeof listingFilterShape>;
  const query: Record<string, unknown> = {};
  for (const k of keys) {
    if (args[k] !== undefined) query[k] = args[k];
  }
  if (typeof args.limit === 'number') query.limit = args.limit;
  return query as ListingQuery;
}

const COMPLETENESS_NOTE =
  'Collection responses carry _completeness metadata (returned_count, pages_fetched, has_more, capped, ' +
  'completeness_status, filters applied server-side vs in-process). A completeness_status other than "complete" ' +
  'means the result describes only the retrieved subset — never report such a count as a market total.';

export function buildTools(service: MlsService): ToolDefinition[] {
  return [
    {
      name: 'get_capabilities',
      title: 'Get MLS capabilities and limitations',
      description:
        'Report which MLS capabilities this server can actually serve, which provider is configured, and the ' +
        'current limitations. Call this before relying on address lookup, listing history, or media, and whenever ' +
        'a result needs to be qualified. A capability marked "unverified" is documentation-derived and has not ' +
        'been confirmed against live API behavior.',
      inputSchema: {},
      handler: async () => service.capabilities()
    },

    {
      name: 'get_listing',
      title: 'Get one listing',
      description:
        'Retrieve one listing by MLS number / listing key, or by exact address. Returns normalized property facts ' +
        'plus source provenance (provider, originating system, resource, fetch time, record modification ' +
        'timestamp). Address matching is exact, not fuzzy; prefer the MLS number when you have it. Fields absent ' +
        'from the source are null and are never inferred.',
      inputSchema: {
        listing_id: z.string().min(1).optional().describe('MLS number (ListingId) or ListingKey.'),
        address: z.string().min(1).optional().describe('Exact unparsed address string. Use only without listing_id.'),
        include_media: z.boolean().optional().describe('Request media references where the feed exposes them.')
      },
      handler: async (args) =>
        service.getListing({
          listing_id: args.listing_id as string | undefined,
          address: args.address as string | undefined,
          include_media: args.include_media as boolean | undefined
        })
    },

    {
      name: 'search_listings',
      title: 'Search listings',
      description:
        'Search listings with explicit, deterministic filters. There is no free-text or raw query passthrough: ' +
        'only the typed filters below are accepted. Records missing a filtered field are excluded, because a ' +
        'bound cannot be proven satisfied for a null value. ' +
        COMPLETENESS_NOTE,
      inputSchema: {
        ...listingFilterShape,
        limit: z.number().int().positive().max(5000).optional().describe('Maximum records to return after filtering.'),
        include_media: z.boolean().optional()
      },
      handler: async (args) => {
        const query = toListingQuery(args);
        if (args.include_media === true) query.include_media = true;
        return service.searchListings(query);
      }
    },

    {
      name: 'get_listing_history',
      title: 'Get listing history (capability-limited)',
      description:
        'Report what listing history this server can legitimately provide for one listing. The licensed feed ' +
        'exposes current-state records rather than an event-level history resource, so price-change and ' +
        'status-change timelines are NOT available here and are never reconstructed or inferred. Returns the ' +
        'history-adjacent fields the current record does carry (original list price, list price, close price, ' +
        'contract/close dates, DOM/CDOM) plus an explicit capability statement.',
      inputSchema: {
        listing_id: z.string().min(1).describe('MLS number (ListingId) or ListingKey.')
      },
      handler: async (args) => service.getListingHistory(args.listing_id as string)
    },

    {
      name: 'get_comparables',
      title: 'Retrieve comparable evidence',
      description:
        'Retrieve and objectively rank comparable candidates for a subject property. Returns the included set, ' +
        'the rejected candidates with the exact reason each was rejected, per-dimension differences, the scoring ' +
        'weights, and the retrieval query. Similarity distance is a ranking measure over stated tolerances — it ' +
        'is NOT an adjusted value, an opinion of value, or a recommended list price. Pricing judgment stays with ' +
        'the controlling CMA workflow.',
      inputSchema: {
        subject_listing_id: z.string().min(1).optional().describe('Subject MLS number or listing key.'),
        subject_address: z.string().min(1).optional().describe('Exact subject address, if no MLS number is known.'),
        cities: z.array(z.string().min(1)).max(10).optional()
          .describe('Candidate geography. Defaults to the subject record\'s own city.'),
        postal_codes: z.array(z.string().min(1)).max(10).optional(),
        statuses: z.array(statusEnum).min(1).max(9).optional().describe('Candidate statuses. Defaults to Closed.'),
        living_area_tolerance_pct: z.number().positive().max(2).optional().describe('Default 0.25 (±25%).'),
        year_built_tolerance_years: z.number().int().nonnegative().max(200).optional().describe('Default 15.'),
        bed_tolerance: z.number().int().nonnegative().max(10).optional().describe('Default 1.'),
        bath_tolerance: z.number().nonnegative().max(10).optional().describe('Default 1.'),
        closed_within_days: z.number().int().positive().max(3650).optional().describe('Default 365.'),
        require_same_property_sub_type: z.boolean().optional().describe('Default true.'),
        max_comps: z.number().int().positive().max(50).optional().describe('Default 8.'),
        candidate_limit: z.number().int().positive().max(5000).optional()
          .describe('Maximum candidates to retrieve before ranking. Default 500.')
      },
      handler: async (args) => {
        const tolerances: Record<string, unknown> = {};
        for (const key of [
          'living_area_tolerance_pct',
          'year_built_tolerance_years',
          'bed_tolerance',
          'bath_tolerance',
          'closed_within_days',
          'require_same_property_sub_type',
          'max_comps'
        ]) {
          if (args[key] !== undefined) tolerances[key] = args[key];
        }
        if (args.statuses !== undefined) tolerances.statuses = args.statuses;
        return service.getComparables({
          subject_listing_id: args.subject_listing_id as string | undefined,
          subject_address: args.subject_address as string | undefined,
          cities: args.cities as string[] | undefined,
          postal_codes: args.postal_codes as string[] | undefined,
          candidate_limit: args.candidate_limit as number | undefined,
          tolerances
        });
      }
    },

    {
      name: 'market_stats',
      title: 'Calculate market statistics',
      description:
        'Calculate market statistics directly from the MLS records matching an explicit query. Returns the exact ' +
        'query definition, per-cohort metrics (active / pending / closed) with each metric\'s definition, sample ' +
        'size and count of records excluded for a missing input, price-band distribution, calculation methodology, ' +
        'limitations, and retrieval completeness. Optionally computes the immediately prior equal-length closed ' +
        'window for period-over-period change. Months of supply is calculated only when an explicit closed window ' +
        'is supplied. No figure here is estimated or modeled. ' +
        COMPLETENESS_NOTE,
      inputSchema: {
        ...listingFilterShape,
        limit: z.number().int().positive().max(5000).optional(),
        price_band_size: z.number().positive().optional().describe('Price-band width in dollars. Default 100000.'),
        include_prior_period: z.boolean().optional()
          .describe('Also compute the immediately prior equal-length closed window. Requires closed_from and closed_to.')
      },
      handler: async (args) =>
        service.marketStats({
          query: toListingQuery(args),
          price_band_size: args.price_band_size as number | undefined,
          include_prior_period: args.include_prior_period as boolean | undefined
        })
    },

    {
      name: 'get_market_snapshot',
      title: 'Get a market composition snapshot',
      description:
        'Compose a current inventory / pending / closed snapshot for an explicit geography from three bounded ' +
        'queries. Returns the composition counts, per-cohort statistics, months of supply, and the three exact ' +
        'queries used, so any figure can be reproduced through search_listings. Each query reports its own ' +
        'completeness; a truncated query makes its count a floor rather than a total.',
      inputSchema: {
        cities: z.array(z.string().min(1)).max(10).optional(),
        postal_codes: z.array(z.string().min(1)).max(10).optional(),
        property_types: z.array(z.string().min(1)).max(10).optional(),
        property_sub_types: z.array(z.string().min(1)).max(10).optional(),
        min_price: z.number().nonnegative().optional(),
        max_price: z.number().nonnegative().optional(),
        closed_window_days: z.number().int().positive().max(1095).optional().describe('Default 90.'),
        limit_per_query: z.number().int().positive().max(5000).optional().describe('Default 1000.')
      },
      handler: async (args) =>
        service.marketSnapshot({
          cities: args.cities as string[] | undefined,
          postal_codes: args.postal_codes as string[] | undefined,
          property_types: args.property_types as string[] | undefined,
          property_sub_types: args.property_sub_types as string[] | undefined,
          min_price: args.min_price as number | undefined,
          max_price: args.max_price as number | undefined,
          closed_window_days: args.closed_window_days as number | undefined,
          limit_per_query: args.limit_per_query as number | undefined
        })
    },

    {
      name: 'lookup_member_or_office',
      title: 'Look up an MLS member or office',
      description:
        'Look up one MLS member (agent) or office by its MLS id or key. Read-only directory reference for ' +
        'attributing a listing to its listing agent or brokerage.',
      inputSchema: {
        type: z.enum(['member', 'office']),
        id: z.string().min(1).describe('MemberMlsId/MemberKey, or OfficeMlsId/OfficeKey.')
      },
      handler: async (args) =>
        args.type === 'member'
          ? service.getMember(args.id as string)
          : service.getOffice(args.id as string)
    },

    {
      name: 'get_open_houses',
      title: 'Get open houses',
      description:
        'Retrieve scheduled open houses, optionally scoped to one listing or a start-time window. Times are ' +
        'returned as ISO 8601 instants exactly as the source reports them.',
      inputSchema: {
        listing_id: z.string().min(1).optional(),
        listing_key: z.string().min(1).optional(),
        starts_from: isoDateTime.optional(),
        starts_to: isoDateTime.optional(),
        limit: z.number().int().positive().max(1000).optional()
      },
      handler: async (args) =>
        service.getOpenHouses({
          listing_id: args.listing_id as string | undefined,
          listing_key: args.listing_key as string | undefined,
          starts_from: args.starts_from as string | undefined,
          starts_to: args.starts_to as string | undefined,
          limit: args.limit as number | undefined
        })
    }
  ];
}
