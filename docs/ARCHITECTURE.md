# Architecture

## Layering

```
Claude (MCP client)
      │  MCP protocol over Streamable HTTP (bearer-authenticated)
      ▼
MCP tool layer                     src/mcp/tools.ts, src/mcp/server.ts
      │  typed arguments only — no raw queries cross this line
      ▼
MLS intelligence / service layer   src/service/mls-service.ts
      │  completeness accounting, statistics, comparable ranking
      ▼
Normalized internal models         src/models/
      │  provider-neutral shapes; missing data is null, never guessed
      ▼
Provider adapter interface         src/provider/types.ts
      ├──────────────────────────────────────────┐
      ▼                                          ▼
MLS Grid RESO adapter              Fixture adapter
src/provider/mlsgrid/              src/provider/fixture/
      │
      ▼
Official MLS Grid API (RESO Web API v2 / OData)
```

Each layer depends only on the one below it. The tool layer never imports an adapter; the service
layer never imports MLS Grid specifics. `src/factory.ts` is the single place where a concrete
provider is selected from configuration.

## Provider isolation

`MlsProvider` (`src/provider/types.ts`) is the whole contract a data vendor must satisfy:

```ts
interface MlsProvider {
  readonly name: string;
  readonly originatingSystem: string;
  capabilities(): ProviderCapabilities;
  getListing(idOrKey, opts?): Promise<NormalizedListing | null>;
  getListingsByAddress(address, opts?): Promise<NormalizedListing[]>;
  searchListings(query: ListingQuery): Promise<ProviderCollectionResult<NormalizedListing>>;
  getMember(memberMlsId): Promise<NormalizedMember | null>;
  getOffice(officeMlsId): Promise<NormalizedOffice | null>;
  getOpenHouses(query): Promise<ProviderCollectionResult<NormalizedOpenHouse>>;
}
```

Three properties make this swappable without touching the MCP tools:

**Queries are typed, not textual.** `ListingQuery` is a struct of named predicates. No OData, SQL, or
vendor query string is ever constructed above the adapter, so a vendor with a different query
language needs no changes upstream.

**Adapters declare what they served.** `ProviderCollectionResult` reports `server_side_filters` and
`client_side_filters` separately. A vendor that can filter on price server-side and one that cannot
both satisfy the interface; the difference surfaces truthfully in `_completeness` instead of being
hidden. Predicates an adapter does not push down are applied in-process by the shared evaluator in
`src/provider/predicates.ts`, so filter *semantics* stay identical across vendors.

**Capabilities are explicit and three-valued.** `capabilities()` returns `supported`, `unsupported`,
or `unverified` per capability. `unverified` exists specifically for the MLS Grid adapter's
documentation-derived assumptions: the code is written, but nothing has confirmed it against live
behavior. The service layer turns an `unsupported` capability into an honest limitation response
rather than an approximation — see `get_listing_history`.

### Replacing MLS Grid

To swap in a different authorized Northstar vendor: implement `MlsProvider`, map that vendor's fields
into `src/models/normalized.ts`, declare `capabilities()` honestly, and register it in
`src/factory.ts`. The MCP tool layer, statistics engine, comparable engine, and completeness
accounting are untouched. The fixture adapter is the worked example — it reuses the same mapping and
predicate modules as the live adapter, so contract tests describe real behavior rather than a
simplified stand-in.

## Completeness accounting

This is the load-bearing invariant. `src/service/meta.ts` derives `CollectionMeta` from every
provider result:

- `complete` — nothing capped, no continuation remains, and the source-reported total matches what
  was returned.
- `truncated` — a cap was hit or a continuation remains. The notes name the cap and how to narrow.
- `unknown` — retrieval ran to exhaustion but the source exposes no verified total, so completeness
  is consistent with but not proven complete.

MLS Grid is **not** assumed to expose a reliable server-side `$count`; when no total is available the
result is `unknown`, not `complete`. Caps are detected three ways: the configured page cap, the
requested record limit, and a full page returned with no continuation link at the documented provider
request cap — the case where an API silently truncates.

## Statistics and comparables

Both engines are pure functions over normalized records (`src/service/stats.ts`,
`src/service/comps.ts`), which is why they are exhaustively testable without a network.

Statistics never impute. Each metric reports `sample_size` and `excluded_missing_input`. Ratios are
computed per record then aggregated, never as a ratio of aggregates. Months of supply is refused
unless an explicit closed window of known length exists *and* the dataset actually contains active
inventory — a close-date-bounded query structurally cannot contain active listings, and reporting
`0` for an unmeasured numerator would be a fabricated statistic.

Comparables rank on normalized distance-to-tolerance across weighted dimensions, scoring only
dimensions with data on both sides, and reject a candidate whose available dimensions fall below the
coverage floor rather than scoring it on thin evidence. Every candidate carries its rejection reasons
and per-dimension differences. The engine returns no price conclusion of any kind.

## Transport and process model

The HTTP entry point (`src/index.ts`) serves `/health`, `/version`, and a **stateless** `/mcp`
endpoint: a fresh `McpServer` and transport per request, so there is no cross-request session state
and horizontal scaling is trivial. A stdio entry point (`src/stdio.ts`) exists for local subprocess
use; there, logs go to stderr because stdout carries the protocol stream.

Startup validation is fail-fast: an invalid configuration, or the live provider selected without a
token, aborts before the port is bound.
