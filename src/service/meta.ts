import type { CollectionMeta, CompletenessStatus } from '../models/meta.js';
import type { ProviderCollectionResult } from '../provider/types.js';

export interface MetaContext {
  provider: string;
  originatingSystem: string;
  asOf: string;
  providerRequestCap: number | null;
  maxPages: number;
}

/**
 * Derive completeness metadata from a provider result.
 *
 * Completeness rules:
 *  - `complete` requires that nothing was capped, no continuation remains, AND
 *    every requested predicate was actually applied somewhere in the pipeline.
 *  - A capped or continuing result is `truncated` — never silently "complete".
 *  - When the provider exposes no reliable server total and we cannot prove we
 *    saw the whole matching set, the status is `unknown`.
 */
export function buildCollectionMeta<T>(
  result: ProviderCollectionResult<T>,
  ctx: MetaContext,
  extraNotes: string[] = []
): CollectionMeta {
  const notes = [...extraNotes];

  let status: CompletenessStatus;
  if (result.capped || result.has_more) {
    status = 'truncated';
    notes.push(
      result.cap_reason
        ? `Result set is incomplete: ${result.cap_reason}. Narrow the query (tighter geography, status, price or date bounds) to retrieve a complete set.`
        : 'Result set is incomplete: more matching records remain beyond what was retrieved.'
    );
  } else if (result.total_known === null) {
    status = 'unknown';
    notes.push(
      'The source does not expose a verified server-side total for this query. Retrieval ran to exhaustion ' +
        'with no continuation link, which is consistent with a complete set but is not independently confirmed.'
    );
  } else if (result.total_known === result.records.length) {
    status = 'complete';
  } else {
    status = 'unknown';
    notes.push(
      `Server-reported total (${result.total_known}) does not match the returned count (${result.records.length}); ` +
        'the difference may be client-side filtering or deduplication. Treat the set as unconfirmed.'
    );
  }

  if (result.client_side_filters.length > 0) {
    notes.push(
      `Filtered in-process after retrieval: ${result.client_side_filters.join(', ')}. Records missing a filtered ` +
        'field are excluded, because a bound cannot be proven satisfied for a null value.'
    );
  }

  return {
    returned_count: result.records.length,
    total_known: result.total_known,
    pages_fetched: result.pages_fetched,
    has_more: result.has_more,
    capped: result.capped,
    cap_reason: result.cap_reason,
    source_limit: {
      page_size: result.page_size,
      max_pages: ctx.maxPages,
      provider_request_cap: ctx.providerRequestCap
    },
    filters_applied: {
      server_side: result.server_side_filters,
      client_side: result.client_side_filters
    },
    originating_system: ctx.originatingSystem,
    provider: ctx.provider,
    as_of: ctx.asOf,
    completeness_status: status,
    notes
  };
}
