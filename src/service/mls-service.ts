import { AiUsePolicy } from '../compliance/ai-use.js';
import type { Attribution } from '../compliance/attribution.js';
import { buildAttribution } from '../compliance/attribution.js';
import { MlsError } from '../errors.js';
import type { CollectionMeta } from '../models/meta.js';
import type {
  NormalizedListing,
  NormalizedMember,
  NormalizedOffice,
  NormalizedOpenHouse
} from '../models/normalized.js';
import type { ListingQuery, MlsProvider, OpenHouseQuery, ProviderCapabilities } from '../provider/types.js';
import type { CompResult, CompTolerances } from './comps.js';
import { DEFAULT_TOLERANCES, selectComparables } from './comps.js';
import type { MetaContext } from './meta.js';
import { buildCollectionMeta } from './meta.js';
import type { CohortStats } from './stats.js';
import {
  METHODOLOGY,
  computeCohortStats,
  monthsSupply,
  partitionByCohort,
  periodChange,
  windowMonths
} from './stats.js';

/**
 * MLS intelligence/service layer. It composes provider results into the shapes
 * the MCP tools return, and owns every rule that must hold regardless of which
 * provider is behind the interface: completeness accounting, capability
 * limitations, statistical methodology and the comparable judgment boundary.
 */

export interface ServiceOptions {
  provider: MlsProvider;
  defaultTimezone: string;
  maxRecordsPerQuery: number;
  maxPages: number;
  providerRequestCap: number | null;
  /** AI Use Addendum policy. Defaults to a fully-closed live policy when omitted. */
  aiUsePolicy?: AiUsePolicy;
  participantName?: string | undefined;
  now?: () => Date;
}

export interface ListingResult {
  listing: NormalizedListing | null;
  found: boolean;
  lookup: { by: 'listing_id_or_key' | 'address'; value: string; matches: number };
  notes: string[];
  attribution: Attribution;
}

export interface SearchResult {
  listings: NormalizedListing[];
  query: ListingQuery;
  _completeness: CollectionMeta;
  attribution: Attribution;
}

export interface StatsResult {
  query_definition: Record<string, unknown>;
  record_counts: {
    retrieved: number;
    active: number;
    pending: number;
    closed: number;
    unclassified: number;
    new_listings_in_window: number | null;
  };
  cohorts: CohortStats[];
  months_supply: { value: number | null; definition: string; reason: string | null };
  prior_period: {
    window: { from: string; to: string } | null;
    closed_cohort: CohortStats | null;
    changes: Record<string, { absolute: number | null; percent: number | null }> | null;
    _completeness: CollectionMeta | null;
  } | null;
  methodology: typeof METHODOLOGY;
  limitations: string[];
  as_of: string;
  timezone: string;
  _completeness: CollectionMeta;
  attribution: Attribution;
}

export class MlsService {
  private readonly provider: MlsProvider;
  private readonly defaultTimezone: string;
  private readonly maxRecords: number;
  private readonly maxPages: number;
  private readonly providerRequestCap: number | null;
  private readonly policy: AiUsePolicy;
  private readonly participantName: string | undefined;
  private readonly now: () => Date;

  constructor(opts: ServiceOptions) {
    this.provider = opts.provider;
    this.defaultTimezone = opts.defaultTimezone;
    this.maxRecords = opts.maxRecordsPerQuery;
    this.maxPages = opts.maxPages;
    this.providerRequestCap = opts.providerRequestCap;
    // Fail closed: an omitted policy is treated as a fully-closed live policy,
    // never as permission. A caller must construct one deliberately.
    this.policy =
      opts.aiUsePolicy ??
      new AiUsePolicy({
        provider: opts.provider.name === 'fixture' ? 'fixture' : 'mlsgrid',
        aiAccessEnabled: false,
        authorizedUseBases: [],
        licenseClasses: [],
        writtenApprovalReference: undefined,
        authorizedTools: []
      });
    this.participantName = opts.participantName;
    this.now = opts.now ?? (() => new Date());
  }

  get aiUsePolicy(): AiUsePolicy {
    return this.policy;
  }

  /**
   * Enforcement point for the Addendum's access controls (§3.c). Every method
   * that can reach MLS Grid Data calls this first, so the gate cannot be
   * bypassed by talking to the service directly instead of through MCP.
   */
  private assertToolPermitted(toolName: string): void {
    const decision = this.policy.evaluateTool(toolName);
    if (!decision.allowed) {
      throw new MlsError('UNSUPPORTED_CAPABILITY', decision.reason ?? 'Not authorized', {
        details: { ai_use_denial: decision.code, tool: toolName }
      });
    }
  }

  /** §3.d attribution, attached to every MLS-derived result. */
  private attribution(): Attribution {
    return buildAttribution({
      policy: this.policy,
      originatingSystem: this.provider.originatingSystem,
      retrievedAt: this.now().toISOString(),
      participant: this.participantName ?? null
    });
  }

  capabilities(): ProviderCapabilities & {
    provider: string;
    originating_system: string;
    ai_use: Record<string, unknown>;
  } {
    return {
      provider: this.provider.name,
      originating_system: this.provider.originatingSystem,
      ...this.provider.capabilities(),
      ai_use: this.policy.describe()
    };
  }

  private metaContext(): MetaContext {
    return {
      provider: this.provider.name,
      originatingSystem: this.provider.originatingSystem,
      asOf: this.now().toISOString(),
      providerRequestCap: this.providerRequestCap,
      maxPages: this.maxPages
    };
  }

  async getListing(args: {
    listing_id?: string;
    address?: string;
    include_media?: boolean;
  }): Promise<ListingResult> {
    this.assertToolPermitted('get_listing');
    const result = await this.resolveListing(args);
    return { ...result, attribution: this.attribution() };
  }

  /**
   * Unguarded lookup used to compose other tools. Callers must have already
   * passed their own `assertToolPermitted` check: authorizing get_comparables
   * must not additionally require authorizing get_listing.
   */
  private async resolveListing(args: {
    listing_id?: string;
    address?: string;
    include_media?: boolean;
  }): Promise<Omit<ListingResult, 'attribution'>> {
    const notes: string[] = [];
    if (!args.listing_id && !args.address) {
      throw new MlsError('VALIDATION', 'Provide either listing_id (MLS number or listing key) or address.');
    }
    if (args.listing_id && args.address) {
      throw new MlsError(
        'VALIDATION',
        'Provide exactly one of listing_id or address so the matched record is unambiguous.'
      );
    }

    const opts = args.include_media ? { include_media: true } : {};

    if (args.listing_id) {
      const listing = await this.provider.getListing(args.listing_id, opts);
      if (listing === null) {
        notes.push(
          'No record matched this MLS number or listing key for the configured originating system. This is a ' +
            'confirmed non-match within the licensed feed, not a search failure.'
        );
      }
      return {
        listing,
        found: listing !== null,
        lookup: { by: 'listing_id_or_key', value: args.listing_id, matches: listing === null ? 0 : 1 },
        notes
      };
    }

    const matches = await this.provider.getListingsByAddress(args.address!, opts);
    if (matches.length > 1) {
      notes.push(
        `${matches.length} records share this exact address (commonly a re-list or a prior transaction on the same ` +
          'property). The most recently modified record is returned; use listing_id for an exact record.'
      );
    }
    if (matches.length === 0) {
      notes.push(
        'No record matched this exact address string. Address matching is exact, not fuzzy: a formatting difference ' +
          'in the source record will not match. Try the MLS number.'
      );
    }
    const sorted = [...matches].sort((a, b) =>
      (b.modification_timestamp ?? '').localeCompare(a.modification_timestamp ?? '')
    );
    return {
      listing: sorted[0] ?? null,
      found: sorted.length > 0,
      lookup: { by: 'address', value: args.address!, matches: matches.length },
      notes
    };
  }

  async searchListings(query: ListingQuery): Promise<SearchResult> {
    this.assertToolPermitted('search_listings');
    const bounded: ListingQuery = { ...query, limit: Math.min(query.limit ?? this.maxRecords, this.maxRecords) };
    const result = await this.provider.searchListings(bounded);
    return {
      listings: result.records,
      query: bounded,
      _completeness: buildCollectionMeta(result, this.metaContext()),
      attribution: this.attribution()
    };
  }

  /**
   * Listing history is reported as a capability limitation unless the licensed
   * feed exposes an event-level history resource. We never reconstruct a price
   * or status timeline from a single current-state record.
   */
  async getListingHistory(listingId: string): Promise<Record<string, unknown>> {
    this.assertToolPermitted('get_listing_history');
    const caps = this.provider.capabilities();
    const lookup = await this.resolveListing({ listing_id: listingId });

    if (caps.listing_history_events === 'supported') {
      throw new MlsError(
        'INTERNAL',
        'Provider reports event-level history support but no history retrieval is implemented for it.'
      );
    }

    const l = lookup.listing;
    return {
      listing_id: listingId,
      found: lookup.found,
      capability: {
        event_level_history: caps.listing_history_events,
        explanation:
          'The licensed feed exposes current-state listing records, not an event-level history resource. ' +
          'Price-change and status-change timelines are therefore NOT available through this MCP and are not ' +
          'reconstructed or inferred. Use the certified Northstar/Matrix browser lane for full listing history.'
      },
      /** The only history-adjacent facts the current-state record legitimately carries. */
      current_state_history_fields: l
        ? {
            standard_status: l.standard_status,
            mls_status: l.mls_status,
            list_price: l.list_price,
            original_list_price: l.original_list_price,
            close_price: l.close_price,
            listing_contract_date: l.listing_contract_date,
            purchase_contract_date: l.purchase_contract_date,
            close_date: l.close_date,
            days_on_market: l.days_on_market,
            cumulative_days_on_market: l.cumulative_days_on_market,
            modification_timestamp: l.modification_timestamp,
            source: l.source
          }
        : null,
      notes: [
        ...lookup.notes,
        'A difference between original_list_price and list_price indicates at least one price change occurred, but ' +
          'the number, size, and dates of those changes are not exposed by these fields.'
      ],
      attribution: this.attribution()
    };
  }

  async getComparables(args: {
    subject_listing_id?: string;
    subject_address?: string;
    cities?: string[];
    postal_codes?: string[];
    tolerances?: Partial<CompTolerances>;
    candidate_limit?: number;
  }): Promise<{
    comparables: CompResult;
    retrieval: { query: ListingQuery; _completeness: CollectionMeta };
    attribution: Attribution;
  }> {
    this.assertToolPermitted('get_comparables');
    const subjectLookup = await this.resolveListing({
      ...(args.subject_listing_id ? { listing_id: args.subject_listing_id } : {}),
      ...(args.subject_address ? { address: args.subject_address } : {})
    });
    if (subjectLookup.listing === null) {
      throw new MlsError('NOT_FOUND', 'Subject property was not found; comparables cannot be anchored.', {
        details: { lookup: subjectLookup.lookup, notes: subjectLookup.notes }
      });
    }
    const subject = subjectLookup.listing;
    const tol: CompTolerances = { ...DEFAULT_TOLERANCES, ...args.tolerances };

    // Geography defaults to the subject's own city/postal code so the candidate
    // set is bounded and reproducible rather than market-wide.
    const cities = args.cities ?? (subject.address.city ? [subject.address.city] : undefined);
    const postalCodes = args.postal_codes ?? undefined;
    if (!cities && !postalCodes) {
      throw new MlsError(
        'VALIDATION',
        'No geography could be determined: the subject record has no city and none was supplied. Provide cities or postal_codes.'
      );
    }

    const asOfDate = this.now().toISOString().slice(0, 10);
    const closedFrom = new Date(this.now().getTime() - tol.closed_within_days * 86_400_000)
      .toISOString()
      .slice(0, 10);

    const query: ListingQuery = {
      statuses: tol.statuses,
      ...(cities ? { cities } : {}),
      ...(postalCodes ? { postal_codes: postalCodes } : {}),
      ...(subject.property_type ? { property_types: [subject.property_type] } : {}),
      ...(tol.require_same_property_sub_type && subject.property_sub_type
        ? { property_sub_types: [subject.property_sub_type] }
        : {}),
      ...(tol.statuses.includes('Closed') ? { closed_from: closedFrom, closed_to: asOfDate } : {}),
      limit: Math.min(args.candidate_limit ?? 500, this.maxRecords)
    };

    const retrieval = await this.provider.searchListings(query);
    const comparables = selectComparables(subject, retrieval.records, tol, { asOfDate });

    return {
      comparables,
      retrieval: { query, _completeness: buildCollectionMeta(retrieval, this.metaContext()) },
      attribution: this.attribution()
    };
  }

  async marketStats(args: {
    query: ListingQuery;
    price_band_size?: number;
    include_prior_period?: boolean;
  }): Promise<StatsResult> {
    this.assertToolPermitted('market_stats');
    const bandSize = args.price_band_size ?? 100_000;
    const bounded: ListingQuery = {
      ...args.query,
      limit: Math.min(args.query.limit ?? this.maxRecords, this.maxRecords)
    };

    const result = await this.provider.searchListings(bounded);
    const meta = buildCollectionMeta(result, this.metaContext());
    const parts = partitionByCohort(result.records);

    const cohorts: CohortStats[] = [];
    if (parts.active.length > 0) cohorts.push(computeCohortStats('active', parts.active, bandSize));
    if (parts.pending.length > 0) cohorts.push(computeCohortStats('pending', parts.pending, bandSize));
    if (parts.closed.length > 0) cohorts.push(computeCohortStats('closed', parts.closed, bandSize));

    const newListings =
      bounded.listed_from || bounded.listed_to
        ? result.records.filter((r) => r.listing_contract_date !== null).length
        : null;

    const months = windowMonths(bounded.closed_from, bounded.closed_to);
    const supply = monthsSupply(parts.active.length, parts.closed.length, months);

    const limitations: string[] = [
      'Statistics describe only the records retrieved by the stated query, from the configured originating system.',
      'Records missing a metric input are excluded from that metric and counted; no value is imputed.'
    ];
    if (meta.completeness_status !== 'complete') {
      limitations.push(
        `Retrieval completeness is "${meta.completeness_status}". These statistics may not describe the full ` +
          'matching population — treat them as describing the retrieved subset only.'
      );
    }
    if (parts.unclassified.length > 0) {
      limitations.push(
        `${parts.unclassified.length} retrieved record(s) had no recognized StandardStatus and are excluded from ` +
          'every cohort rather than assigned to one.'
      );
    }
    if (this.provider.name === 'fixture') {
      limitations.push(
        'FIXTURE PROVIDER: these figures are computed from synthetic test data and are NOT real market statistics.'
      );
    }

    let prior: StatsResult['prior_period'] = null;
    if (args.include_prior_period && bounded.closed_from && bounded.closed_to) {
      const from = new Date(`${bounded.closed_from.slice(0, 10)}T00:00:00Z`);
      const to = new Date(`${bounded.closed_to.slice(0, 10)}T00:00:00Z`);
      const spanDays = Math.round((to.getTime() - from.getTime()) / 86_400_000) + 1;
      const priorTo = new Date(from.getTime() - 86_400_000);
      const priorFrom = new Date(priorTo.getTime() - (spanDays - 1) * 86_400_000);
      const priorQuery: ListingQuery = {
        ...bounded,
        closed_from: priorFrom.toISOString().slice(0, 10),
        closed_to: priorTo.toISOString().slice(0, 10)
      };
      const priorResult = await this.provider.searchListings(priorQuery);
      const priorParts = partitionByCohort(priorResult.records);
      const priorClosed =
        priorParts.closed.length > 0 ? computeCohortStats('closed', priorParts.closed, bandSize) : null;
      const currentClosed = cohorts.find((c) => c.cohort === 'closed') ?? null;

      let changes: Record<string, { absolute: number | null; percent: number | null }> | null = null;
      if (priorClosed && currentClosed) {
        changes = {};
        for (const key of Object.keys(currentClosed.metrics)) {
          changes[key] = periodChange(
            currentClosed.metrics[key]?.value ?? null,
            priorClosed.metrics[key]?.value ?? null
          );
        }
        changes.record_count = periodChange(currentClosed.record_count, priorClosed.record_count);
      }

      prior = {
        window: { from: priorQuery.closed_from!, to: priorQuery.closed_to! },
        closed_cohort: priorClosed,
        changes,
        _completeness: buildCollectionMeta(priorResult, this.metaContext())
      };
    }

    return {
      query_definition: { ...bounded, price_band_size: bandSize },
      record_counts: {
        retrieved: result.records.length,
        active: parts.active.length,
        pending: parts.pending.length,
        closed: parts.closed.length,
        unclassified: parts.unclassified.length,
        new_listings_in_window: newListings
      },
      cohorts,
      months_supply: supply,
      prior_period: prior,
      methodology: METHODOLOGY,
      limitations,
      as_of: this.now().toISOString(),
      timezone: this.defaultTimezone,
      _completeness: meta,
      attribution: this.attribution()
    };
  }

  /**
   * Composition snapshot built from three explicit bounded queries, each with
   * its own completeness metadata so the snapshot stays reproducible.
   */
  async marketSnapshot(args: {
    cities?: string[];
    postal_codes?: string[];
    property_types?: string[];
    property_sub_types?: string[];
    min_price?: number;
    max_price?: number;
    closed_window_days?: number;
    limit_per_query?: number;
  }): Promise<Record<string, unknown>> {
    this.assertToolPermitted('get_market_snapshot');
    if (!args.cities?.length && !args.postal_codes?.length) {
      throw new MlsError('VALIDATION', 'A snapshot requires an explicit geography: cities or postal_codes.');
    }
    const windowDays = args.closed_window_days ?? 90;
    const asOf = this.now();
    const closedFrom = new Date(asOf.getTime() - windowDays * 86_400_000).toISOString().slice(0, 10);
    const closedTo = asOf.toISOString().slice(0, 10);
    const limit = Math.min(args.limit_per_query ?? 1_000, this.maxRecords);

    const base: ListingQuery = {
      ...(args.cities?.length ? { cities: args.cities } : {}),
      ...(args.postal_codes?.length ? { postal_codes: args.postal_codes } : {}),
      ...(args.property_types?.length ? { property_types: args.property_types } : {}),
      ...(args.property_sub_types?.length ? { property_sub_types: args.property_sub_types } : {}),
      ...(args.min_price !== undefined ? { min_price: args.min_price } : {}),
      ...(args.max_price !== undefined ? { max_price: args.max_price } : {}),
      limit
    };

    const activeQuery: ListingQuery = { ...base, statuses: ['Active'] };
    const pendingQuery: ListingQuery = { ...base, statuses: ['Pending', 'ActiveUnderContract'] };
    const closedQuery: ListingQuery = {
      ...base,
      statuses: ['Closed'],
      closed_from: closedFrom,
      closed_to: closedTo
    };

    const [active, pending, closed] = await Promise.all([
      this.provider.searchListings(activeQuery),
      this.provider.searchListings(pendingQuery),
      this.provider.searchListings(closedQuery)
    ]);

    const bandSize = 100_000;
    const supply = monthsSupply(active.records.length, closed.records.length, windowMonths(closedFrom, closedTo));

    const notes: string[] = [
      'Reproduce this snapshot by running the three queries under queries verbatim through search_listings.',
      'Each query carries its own completeness metadata; a truncated query makes the corresponding count a floor, not a total.'
    ];
    if (this.provider.name === 'fixture') {
      notes.push('FIXTURE PROVIDER: synthetic test data, not real market data.');
    }

    return {
      geography: {
        cities: args.cities ?? null,
        postal_codes: args.postal_codes ?? null
      },
      closed_window: { from: closedFrom, to: closedTo, days: windowDays },
      composition: {
        active_count: active.records.length,
        pending_count: pending.records.length,
        closed_count: closed.records.length
      },
      cohorts: [
        computeCohortStats('active', active.records, bandSize),
        computeCohortStats('pending', pending.records, bandSize),
        computeCohortStats('closed', closed.records, bandSize)
      ],
      months_supply: supply,
      queries: { active: activeQuery, pending: pendingQuery, closed: closedQuery },
      _completeness: {
        active: buildCollectionMeta(active, this.metaContext()),
        pending: buildCollectionMeta(pending, this.metaContext()),
        closed: buildCollectionMeta(closed, this.metaContext())
      },
      methodology: METHODOLOGY,
      as_of: asOf.toISOString(),
      timezone: this.defaultTimezone,
      attribution: this.attribution(),
      notes
    };
  }

  async getMember(
    memberMlsId: string
  ): Promise<{ member: NormalizedMember | null; found: boolean; attribution: Attribution }> {
    this.assertToolPermitted('lookup_member_or_office');
    const member = await this.provider.getMember(memberMlsId);
    return { member, found: member !== null, attribution: this.attribution() };
  }

  async getOffice(
    officeMlsId: string
  ): Promise<{ office: NormalizedOffice | null; found: boolean; attribution: Attribution }> {
    this.assertToolPermitted('lookup_member_or_office');
    const office = await this.provider.getOffice(officeMlsId);
    return { office, found: office !== null, attribution: this.attribution() };
  }

  async getOpenHouses(
    query: OpenHouseQuery
  ): Promise<{ open_houses: NormalizedOpenHouse[]; _completeness: CollectionMeta; attribution: Attribution }> {
    this.assertToolPermitted('get_open_houses');
    const result = await this.provider.getOpenHouses(query);
    return {
      open_houses: result.records,
      _completeness: buildCollectionMeta(result, this.metaContext()),
      attribution: this.attribution()
    };
  }
}
