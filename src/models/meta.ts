/**
 * Collection completeness metadata. Every collection-shaped tool response
 * carries this so a capped/truncated dataset can never silently present
 * itself as complete. Modeled on the hardened FUB task-retrieval standard.
 */

export type CompletenessStatus = 'complete' | 'truncated' | 'unknown';

export interface CollectionMeta {
  returned_count: number;
  /** Server-reported total when the source exposes one; otherwise null. */
  total_known: number | null;
  pages_fetched: number;
  has_more: boolean;
  /** True when a client-side page/record cap stopped retrieval early. */
  capped: boolean;
  cap_reason: string | null;
  source_limit: {
    page_size: number;
    max_pages: number;
    /** Documented provider per-request record cap (provisional for MLS Grid). */
    provider_request_cap: number | null;
  };
  filters_applied: {
    /** Predicates pushed down to the provider API. */
    server_side: string[];
    /** Predicates evaluated in-process after retrieval. */
    client_side: string[];
  };
  originating_system: string;
  provider: string;
  /** ISO 8601 UTC timestamp when this result set was assembled. */
  as_of: string;
  completeness_status: CompletenessStatus;
  notes: string[];
}
