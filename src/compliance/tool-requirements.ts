/**
 * Tool authorization matrix.
 *
 * Two independent axes decide whether a tool may run against live MLS data:
 *
 *   1. DATA-LICENSE USE — which MLS Grid data-use selections are actually
 *      licensed and selected via the Data Interface (§2). An open, extensible
 *      set: MLS Grid can approve new uses without a code change here.
 *   2. AI AUTHORIZATION BASIS — the Addendum's closed set (§1.e):
 *      Permitted Search/Response Use, Permitted Marketing Use, or another use
 *      expressly authorized in writing by MLS GRID or the applicable MLS.
 *
 * A tool is authorized only when BOTH axes are satisfied, and only while the
 * kill switch is on.
 *
 * WHAT THIS MATRIX IS, AND IS NOT
 * -------------------------------
 * This is a CONFIGURATION SCAFFOLD, not a legal determination. Each entry says:
 * "if the operator declares one of these data uses AND one of these AI bases,
 * treat the tool as authorized." It does NOT assert that the Addendum, as
 * executed, authorizes any of them today. Confirming which MLS Grid selections
 * actually cover which tool is Blaise's decision with counsel; the operator
 * declares the result through configuration.
 *
 * The purpose is architectural: every capability below stays fully implemented
 * and can be activated by configuration once the corresponding authorization
 * exists, with no rewrite.
 */

/** The Addendum's closed set of AI authorization bases (§1.e). */
export const AI_AUTHORIZATION_BASES = [
  'permitted_search_response',
  'permitted_marketing',
  'written_mls_approval'
] as const;

export type AiAuthorizationBasis = (typeof AI_AUTHORIZATION_BASES)[number];

/**
 * Data-license uses known today. This list is NOT closed: any future
 * MLS Grid-approved use may be declared, provided it is a lowercase slug.
 * Unknown values are accepted and reported as such rather than rejected, so a
 * newly approved selection never requires a code change.
 */
export const KNOWN_DATA_LICENSE_USES = [
  'idx',
  'vow',
  'comparative_market_analysis',
  'customer_relationship_management',
  'real_estate_market_analytics',
  'participant_listings_use',
  'back_office'
] as const;

export type DataLicenseUse = string;

export const DATA_USE_PATTERN = /^[a-z][a-z0-9_]*$/;

export interface ToolRequirement {
  name: string;
  /** What the tool technically does. */
  capability: string;
  /** Business capabilities this tool underpins; preserved for future activation. */
  business_uses: string[];
  /** Any ONE of these declared data uses satisfies the data-license axis. */
  data_uses: DataLicenseUse[];
  /** Any ONE of these declared bases satisfies the AI-authorization axis. */
  bases: AiAuthorizationBasis[];
  /** False only for tools that touch no MLS data. */
  requires_mls_data: boolean;
}

/**
 * Every tool that reads listing content can be underpinned by CMA, market
 * analytics, IDX/VOW, CRM or participant-listings selections depending on how
 * it is used. The operator declares which of those are licensed; this matrix
 * only records which selections are capable of underpinning each tool.
 */
const LISTING_DATA_USES: DataLicenseUse[] = [
  'idx',
  'vow',
  'comparative_market_analysis',
  'customer_relationship_management',
  'real_estate_market_analytics',
  'participant_listings_use'
];

const ANALYTICS_DATA_USES: DataLicenseUse[] = [
  'real_estate_market_analytics',
  'comparative_market_analysis',
  'idx',
  'vow'
];

const ALL_BASES: AiAuthorizationBasis[] = [
  'permitted_search_response',
  'permitted_marketing',
  'written_mls_approval'
];

export const TOOL_REQUIREMENTS: readonly ToolRequirement[] = [
  {
    name: 'get_capabilities',
    capability: 'Reports server capabilities, limitations and authorization state.',
    business_uses: ['Operational transparency'],
    data_uses: [],
    bases: [],
    requires_mls_data: false
  },
  {
    name: 'get_listing',
    capability: 'Exact listing lookup by MLS number/listing key or exact address, with provenance.',
    business_uses: ['Individual property research', 'Buyer/seller client preparation', 'Listing presentations'],
    data_uses: LISTING_DATA_USES,
    bases: ALL_BASES,
    requires_mls_data: true
  },
  {
    name: 'search_listings',
    capability: 'Deterministic filtered listing search with completeness accounting.',
    business_uses: ['Buyer property search and matching', 'Individual property research', 'Buyer client preparation'],
    data_uses: LISTING_DATA_USES,
    bases: ALL_BASES,
    requires_mls_data: true
  },
  {
    name: 'get_listing_history',
    capability: 'Reports history-adjacent fields on a current-state record, plus the capability limitation.',
    business_uses: ['Individual property research', 'Seller client preparation', 'Listing presentations'],
    data_uses: LISTING_DATA_USES,
    bases: ALL_BASES,
    requires_mls_data: true
  },
  {
    name: 'get_comparables',
    capability: 'Retrieves and objectively ranks comparable candidates with per-candidate reasoning.',
    business_uses: ['Comparable analysis', 'CMA evidence', 'Seller client preparation', 'Listing presentations'],
    data_uses: ANALYTICS_DATA_USES,
    bases: ALL_BASES,
    requires_mls_data: true
  },
  {
    name: 'market_stats',
    capability: 'Computes market metrics from retrieved records with stated methodology.',
    business_uses: ['Market statistics', 'CMA evidence', 'MLS-grounded guides and marketing', 'Listing presentations'],
    data_uses: ANALYTICS_DATA_USES,
    bases: ALL_BASES,
    requires_mls_data: true
  },
  {
    name: 'get_market_snapshot',
    capability: 'Composes inventory/pending/closed snapshots from bounded reproducible queries.',
    business_uses: ['Market snapshots', 'Market statistics', 'MLS-grounded guides and marketing'],
    data_uses: ANALYTICS_DATA_USES,
    bases: ALL_BASES,
    requires_mls_data: true
  },
  {
    name: 'lookup_member_or_office',
    capability: 'Looks up one MLS member or office by id/key.',
    business_uses: ['Individual property research', 'Buyer/seller client preparation'],
    data_uses: LISTING_DATA_USES,
    bases: ALL_BASES,
    requires_mls_data: true
  },
  {
    name: 'get_open_houses',
    capability: 'Retrieves scheduled open houses, optionally scoped to a listing or time window.',
    business_uses: ['Buyer property search and matching', 'Buyer client preparation', 'Listing presentations'],
    data_uses: ['idx', 'vow', 'participant_listings_use', 'customer_relationship_management'],
    bases: ALL_BASES,
    requires_mls_data: true
  }
];

export function toolRequirement(name: string): ToolRequirement | undefined {
  return TOOL_REQUIREMENTS.find((t) => t.name === name);
}

/** Every business capability the server preserves, for the capability register. */
export const PRESERVED_BUSINESS_CAPABILITIES: readonly string[] = [
  'Buyer property search and matching',
  'Individual property research',
  'Comparable analysis',
  'CMA evidence',
  'Market statistics',
  'Market snapshots',
  'Buyer/seller client preparation',
  'Listing presentations',
  'MLS-grounded guides and marketing'
];
