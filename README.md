# blaise-mls-mcp

Private, **read-only** NorthstarMLS intelligence MCP server for Blaise Smith's real estate business
(Buy Sell Home Team | RE/MAX Results).

It gives Claude deterministic structured primitives over MLS data — exact listing lookup, bounded
search with completeness accounting, market statistics with stated methodology, and comparable
evidence retrieval — behind a provider-isolated architecture whose live lane targets the MLS Grid
RESO Web API.

---

## Current status

**MLS MCP BUILD STATUS: PARTIAL — LIVE ACTIVATION PENDING**

| | |
|---|---|
| Fixture lane | Implemented, tested, and usable now |
| MLS Grid (live) lane | Implemented from public documentation, **never executed against the live API** |
| Live MLS Grid token | **Not held.** No live call has ever been made from this codebase |
| AI Use Addendum | **Reviewed 2026-08-30 and technically enforced.** Acceptance and scope decisions remain open — [`docs/AI_USE_ADDENDUM_REVIEW.md`](docs/AI_USE_ADDENDUM_REVIEW.md) |
| Data license / subscription | **Not executed.** See [`docs/EXTERNAL_GATES.md`](docs/EXTERNAL_GATES.md) |
| Live AI access | **Kill switch OFF by default.** MLS tools are withheld — not removed — until a licensed data use and an AI basis are declared |
| Production certification | **Not granted.** Requires the reconciliation in [`docs/CERTIFICATION_RUNBOOK.md`](docs/CERTIFICATION_RUNBOOK.md) |

Everything the live adapter "knows" about MLS Grid is derived from public documentation and is
labeled `unverified` by `get_capabilities` until live metadata confirms it. A successful API
response is **not** certification — the MCP must be reconciled against the already-certified
Northstar/Matrix browser lane first.

Until then, the certified Matrix browser lane remains the production research path. This server is
intended to become the *preferred structured lane* if and only if it is licensed and certified; it
does not replace or compete with the existing workflow.

## AI Use Addendum enforcement

**Every capability is implemented and stays implemented.** Authorization controls whether a tool may
run against live MLS Grid Data — it never removes the capability. Activation is a configuration
change, not a rewrite.

Two independent axes, both defaulting closed:

**1. Data-license use** (`MLS_DATA_LICENSE_USES`) — which MLS Grid selections are actually licensed
and selected via the Data Interface (§2). **Open and extensible**: IDX, VOW, Comparative Market
Analysis, Customer Relationship Management, Real Estate Market Analytics, Participant Listings Use,
Back Office, **or any future approved use** — no code change required.

**2. AI authorization basis** (`MLS_AI_AUTHORIZATION_BASES`) — the Addendum's **closed** set (§1.e):
`permitted_search_response`, `permitted_marketing`, `written_mls_approval`.

A tool runs only when the kill switch is on **and both axes cover it**. Holding a data license is not
AI permission; an AI basis without the underlying data use is not either. `written_mls_approval`
(§1.e/§2 express written approval from MLS GRID or the applicable MLS) requires a written reference
**and** an explicit tool listing — it is never inferred.

| Control | Behavior |
|---|---|
| `MLS_AI_ACCESS_ENABLED` | Kill switch (§3.c), **default OFF** |
| `MLS_DATA_LICENSE_USES` | Axis 1 — open set of licensed selections |
| `MLS_AI_AUTHORIZATION_BASES` | Axis 2 — closed Addendum set |
| `MLS_AI_AUTHORIZED_TOOLS` | Optional narrowing; can only restrict, never widen |

Constraints the Addendum's text imposes: **§1.i** ties Permitted Search/Response Use to IDX or VOW
licenses; **§1.g** ties Permitted Marketing Use to marketing the Participant's own listings or
business. Where neither covers an intended use, §1.e/§2 provide the written-approval route.

**Nothing is retained** (§3.a, §1.d): no cache, database, file store, vector index, embedding,
retrieval index, knowledge graph, or training path exists anywhere in the codebase. Identical
repeated queries re-fetch. **Every MLS-derived result carries attribution** naming the Participant,
originating MLS and MLS GRID (§3.d).

### Business capabilities preserved for activation

Buyer property search and matching · individual property research · comparable analysis · CMA
evidence · market statistics · market snapshots · buyer/seller client preparation · listing
presentations · MLS-grounded guides and marketing.

All are built and tested today. This does **not** assert that the Addendum currently authorizes them
— see [`docs/CAPABILITIES.md`](docs/CAPABILITIES.md) for the per-tool register and
[`docs/EXTERNAL_GATES.md`](docs/EXTERNAL_GATES.md) for what remains an authorization question rather
than a technical one.

## What it will not do

No MLS Add/Edit or any write surface. No Matrix scraping. No UI automation as a data backend. No
arbitrary URL fetching, no generic HTTP proxy tool, no raw OData passthrough. No use of MLS data for
owner solicitation unless governing terms explicitly permit it. No fabricated credentials or
simulated "successful" live calls.

---

## Quick start (fixture data)

```bash
npm install
npm run verify          # typecheck + lint + tests + build + secret scan
npm run build && npm start
curl localhost:3000/health
```

The default provider is `fixture`: a deterministic synthetic dataset of 151 records. It exercises the
entire contract — search, pagination, caps, statistics, comparables — with **no live MLS access**.
Fixture output is synthetic test data and must never be presented as real market data.

## MCP tools

Nine tools, all read-only:

| Tool | Purpose |
|---|---|
| `get_capabilities` | What this server can actually serve, and what it cannot. Call before relying on address lookup, history, or media |
| `get_listing` | One listing by MLS number/listing key, or exact address, with source provenance |
| `search_listings` | Typed, deterministic filters with `_completeness` metadata |
| `get_listing_history` | Reports the history capability limitation honestly; returns only history-adjacent fields the current record carries |
| `get_comparables` | Ranked comparable *evidence* with per-candidate inclusion/rejection reasons — not a valuation |
| `market_stats` | Metrics computed from retrieved records, each with definition, sample size and exclusions |
| `get_market_snapshot` | Inventory/pending/closed composition from three reproducible bounded queries |
| `lookup_member_or_office` | Agent and brokerage directory reference |
| `get_open_houses` | Scheduled open houses |

## Documentation

| Document | Contents |
|---|---|
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Layering, provider isolation, swapping vendors |
| [`docs/MLSGRID_ADAPTER.md`](docs/MLSGRID_ADAPTER.md) | OData construction, pagination, retries, provisional assumptions |
| [`docs/FIELD_MAPPING.md`](docs/FIELD_MAPPING.md) | RESO field → normalized model mapping |
| [`docs/ENVIRONMENT.md`](docs/ENVIRONMENT.md) | Every environment variable |
| [`docs/CAPABILITIES.md`](docs/CAPABILITIES.md) | Capability and limitation register |
| [`docs/CERTIFICATION_RUNBOOK.md`](docs/CERTIFICATION_RUNBOOK.md) | The 10-point live Matrix reconciliation |
| [`docs/SECURITY.md`](docs/SECURITY.md) | Trust boundary, secret handling, logging rules |
| [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) | Render deployment and production configuration |
| [`docs/AI_USE_ADDENDUM_REVIEW.md`](docs/AI_USE_ADDENDUM_REVIEW.md) | Clause-by-clause Addendum review and the controls enforcing it |
| [`docs/EXTERNAL_GATES.md`](docs/EXTERNAL_GATES.md) | License, subscription and AI-addendum gates outside this repo |

## Design commitments

**Missing data stays missing.** A field absent from the source maps to `null` — never zero, never a
default, never a carried-forward value. Records missing a filtered field are *excluded* from results,
because a bound cannot be proven satisfied for a null.

**Truncation is always visible.** Every collection result carries `_completeness`. A result that was
capped, or whose totality cannot be confirmed, reports `truncated` or `unknown` — never `complete`.

**Statistics are reproducible, not generated.** Every metric states its formula, sample size, and how
many records were excluded for a missing input. `market_stats` and `get_market_snapshot` return the
exact queries that produced them.

**Comparables are evidence, not judgment.** The engine ranks candidates on stated tolerances and
explains every inclusion and rejection. It never emits an adjusted value or a recommended list price;
that judgment stays with Blaise and the controlling CMA workflow.

## Development

```bash
npm run typecheck   npm run lint    npm test
npm run build       npm run secret-scan
npm run verify      # all of the above
```

Tests are fixture-backed and require no credentials.
