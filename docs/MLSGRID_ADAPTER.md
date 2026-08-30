# MLS Grid adapter

`src/provider/mlsgrid/` — the live lane targeting the MLS Grid RESO Web API v2 (OData).

> **Provisional throughout.** Every behavior described here is implemented from *public MLS Grid
> documentation*. None of it has been executed against the live API. No live MLS Grid token is held
> by this project. Nothing in this document establishes a license permission — see
> [`EXTERNAL_GATES.md`](EXTERNAL_GATES.md).

## Files

| File | Responsibility |
|---|---|
| `odata.ts` | Safe `$filter` construction: field allowlist, escaping, bounded OR chains |
| `http.ts` | Authenticated transport: throttling, retries, timeouts, origin pinning, response parsing |
| `mapping.ts` | RESO payload → normalized model |
| `adapter.ts` | `MlsProvider` implementation: query pushdown, pagination, dedupe, cap detection |

## Documented assumptions awaiting live confirmation

| Assumption | Source | Encoded as | Confirm by |
|---|---|---|---|
| Base URL `https://api.mlsgrid.com/v2` | Documentation | `MLSGRID_API_BASE` default | Live request |
| Bearer token authentication | Documentation | `Authorization: Bearer …` | Live 200 vs 401 |
| Resources: Property, Member, Office, OpenHouse, Lookup | Documentation | Adapter methods | `$metadata` |
| 5,000 records/request; 1,000 with `$expand` | Documentation | `PROVIDER_REQUEST_CAP` constants | Live paging |
| One `OriginatingSystemName` per request | Documentation | Enforced on every filter | Live behavior |
| Constrained searchable field set | Documentation | `DEFAULT_SERVER_FILTERABLE_FIELDS` | `$metadata` |
| OR-clause limits | Documentation | `MAX_OR_TERMS = 10` (conservative) | Live rejection threshold |
| Server totals (`$count`) unreliable | Not established | `server_totals: 'unverified'` | Live response |
| Event-level listing history | Not offered | `listing_history_events: 'unsupported'` | `$metadata` |

`capabilities()` reports all of these as `unverified` (or `unsupported`) until certification. That is
deliberate: a capability must not read as `supported` on the strength of a documentation page.

## OData safety

No caller-supplied OData ever reaches the API. `ODataFilterBuilder` accepts only structured clauses:

```ts
new ODataFilterBuilder(allowlist)
  .where({ field: 'OriginatingSystemName', op: 'eq', value: 'northstar' }, 'originating_system')
  .whereIn({ field: 'StandardStatus', values: ['Active', 'Pending'] }, 'statuses')
  .build();
// OriginatingSystemName eq 'northstar' and (StandardStatus eq 'Active' or StandardStatus eq 'Pending')
```

Four independent controls:

1. **Field allowlist.** A field outside `DEFAULT_SERVER_FILTERABLE_FIELDS` (or the
   `MLSGRID_SERVER_FILTER_FIELDS` override) raises `UNSUPPORTED_CAPABILITY` — it is never silently
   inlined. Field names must additionally match `^[A-Za-z][A-Za-z0-9]*$`.
2. **Literal escaping.** Single quotes are doubled per OData rules, so an injected quote cannot close
   its own string literal. Control characters are rejected outright.
3. **Raw literals are validated.** Date/datetime values, which OData takes unquoted, must match an
   ISO 8601 pattern. This closes the unquoted-injection path that escaping alone would not cover.
4. **Bounded OR chains.** At most `MAX_OR_TERMS` (10) terms per clause, conservatively below the
   documented limit. Exceeding it raises an error advising a split query rather than sending a
   request the API may reject.

An empty filter is refused: every request carries at least the `OriginatingSystemName` predicate, so
an unbounded scan cannot be issued by accident.

## Query pushdown

`searchListings` pushes only allowlisted predicates into `$filter`; everything else is evaluated
in-process by the shared predicate evaluator. Both sets are reported in the result, and surface in
`_completeness.filters_applied`.

Under the conservative default allowlist, `statuses`, `property_types` and `modified_since` are
served server-side, while geography, price, beds/baths, area, year and date bounds are applied
in-process. Widening `MLSGRID_SERVER_FILTER_FIELDS` after live `$metadata` confirms real searchable
fields moves predicates server-side with no other code change — and materially reduces the volume
retrieved per query.

## Pagination, dedupe and cap detection

The adapter follows `@odata.nextLink` and deduplicates by `ListingKey` as it goes, because a record
can legitimately appear on two pages when the underlying set shifts mid-walk. Records without a
stable key are dropped rather than assigned a synthetic one.

Retrieval stops, and reports `capped` with a reason, on any of:

- the configured page cap (`MLSGRID_MAX_PAGES_PER_QUERY`),
- the requested record limit,
- a full page returned with no continuation link at the documented provider request cap — the
  silent-truncation case.

## HTTP behavior

- **Throttle.** Minimum spacing between requests (`MLSGRID_MIN_REQUEST_INTERVAL_MS`, default 600 ms).
- **Retries.** Exponential backoff (500 ms doubling, 15 s ceiling) for 429, 5xx, network failures and
  timeouts. `Retry-After` is honored, capped at 30 s. **401/403 are never retried** — a credential or
  licensing problem is not transient. Other 4xx are not retried either; they indicate a malformed
  request.
- **Timeout.** `AbortController` at `MLSGRID_TIMEOUT_MS` (default 30 s), mapped to `TIMEOUT`.
- **Origin pinning.** Every URL — including a returned `nextLink` — must match the configured API
  base origin. A redirect to another host is refused, not followed.
- **Response validation.** Non-JSON bodies, null bodies, and bodies lacking the OData `value` array
  raise `MALFORMED_RESPONSE` rather than producing empty results that would read as "no matches".

## Error taxonomy

`CONFIG`, `VALIDATION`, `AUTH`, `RATE_LIMITED`, `UPSTREAM_UNAVAILABLE`, `TIMEOUT`,
`MALFORMED_RESPONSE`, `UNSUPPORTED_CAPABILITY`, `NOT_FOUND`, `INTERNAL`. Messages are redacted of
token-shaped text before they reach a client or a log.
