# Environment variable reference

All configuration is environment-based (`src/config.ts`). Validation is strict and fail-fast: an
invalid value aborts startup before the port is bound, rather than being silently clamped. Copy
`.env.example` to `.env` for local development; `.env` is git-ignored and the secret scan fails the
build if one is ever committed.

## Provider selection

| Variable | Default | Notes |
|---|---|---|
| `MLS_PROVIDER` | `fixture` | `fixture` (synthetic, offline) or `mlsgrid` (live). `mlsgrid` **requires** `MLSGRID_TOKEN`; startup aborts without it |

## MLS Grid (required only when `MLS_PROVIDER=mlsgrid`)

| Variable | Default | Notes |
|---|---|---|
| `MLSGRID_API_BASE` | `https://api.mlsgrid.com/v2` | Must be a valid URL. Trailing slashes stripped. Also pins the allowed request origin |
| `MLSGRID_TOKEN` | — | **Secret.** Bearer token. Never logged, never returned by any endpoint |
| `MLSGRID_ORIGINATING_SYSTEM` | `northstar` | Enforced on every request; exactly one system per query. The correct live value is unconfirmed |
| `MLSGRID_TIMEOUT_MS` | `30000` | 1,000–120,000 |
| `MLSGRID_MIN_REQUEST_INTERVAL_MS` | `600` | 0–10,000. Conservative throttle; real rate limits unverified |
| `MLSGRID_MAX_RETRIES` | `3` | 0–8. Applies to 429/5xx/network/timeout only — never to 401/403 |
| `MLSGRID_PAGE_SIZE` | `1000` | 1–5,000. Automatically reduced to 1,000 when media is expanded |
| `MLSGRID_MAX_PAGES_PER_QUERY` | `5` | 1–50. Hitting this cap marks the result `truncated` |
| `MLSGRID_SERVER_FILTER_FIELDS` | — | Comma-separated override of the server-side filterable allowlist. Widen **only** after live `$metadata` confirms the fields |
| `MLSGRID_EXPOSE_PRIVATE_REMARKS` | `false` | Maps `PrivateRemarks` only when the licensed feed legitimately exposes them. Leave `false` unless the license clearly permits it |

## General

| Variable | Default | Notes |
|---|---|---|
| `MLS_DEFAULT_TIMEZONE` | `America/Chicago` | Minnesota business zone; reported in statistics responses |
| `MLS_MAX_RECORDS_PER_QUERY` | `2500` | 1–25,000. Hard ceiling on records returned per query |

## AI Use Addendum controls

Two independent axes, both defaulting closed. See
[`AI_USE_ADDENDUM_REVIEW.md`](AI_USE_ADDENDUM_REVIEW.md) and the per-tool register in
[`CAPABILITIES.md`](CAPABILITIES.md).

| Variable | Default | Notes |
|---|---|---|
| `MLS_AI_ACCESS_ENABLED` | `false` | **Kill switch (§3.c).** While false every MLS tool is withheld and no MLS Grid request is made, even with a valid token and a complete declaration |
| `MLS_DATA_LICENSE_USES` | — | **Open, extensible.** Comma-separated MLS Grid data-use selections actually licensed and selected via the Data Interface (§2). Known: `idx`, `vow`, `comparative_market_analysis`, `customer_relationship_management`, `real_estate_market_analytics`, `participant_listings_use`, `back_office`. **Any future approved use is accepted** if it is a lowercase slug — no code change needed |
| `MLS_AI_AUTHORIZATION_BASES` | — | **Closed set (§1.e).** Comma-separated: `permitted_search_response`, `permitted_marketing`, `written_mls_approval`. A data use given here is rejected — the axes are distinct |
| `MLS_AI_WRITTEN_APPROVAL_REFERENCE` | — | Required whenever `written_mls_approval` is declared. That basis is **never inferred**: it also requires naming the covered tools in `MLS_AI_AUTHORIZED_TOOLS` |
| `MLS_AI_AUTHORIZED_TOOLS` | — | Optional further narrowing. Can only restrict what the two axes permit, never widen it |
| `MLS_PARTICIPANT_NAME` | — | Participant named in attribution (§3.d) |

A tool activates only when the kill switch is on **and** one declared data use **and** one declared
basis both cover it. Holding a data license is not AI permission; an AI basis without the underlying
data use is not either.

**§1.i:** `permitted_search_response` requires `idx` or `vow` among the declared data uses, and
startup fails otherwise. An invalid declaration **fails startup** rather than degrading to a
permissive default.

### Activation examples

```bash
# CMA / market-analytics work under Permitted Marketing Use
MLS_AI_ACCESS_ENABLED=true
MLS_DATA_LICENSE_USES=comparative_market_analysis,real_estate_market_analytics
MLS_AI_AUTHORIZATION_BASES=permitted_marketing
# → activates get_comparables, market_stats, get_market_snapshot, get_listing,
#   get_listing_history, lookup_member_or_office

# Buyer search under an IDX license and Permitted Search/Response Use
MLS_AI_ACCESS_ENABLED=true
MLS_DATA_LICENSE_USES=idx
MLS_AI_AUTHORIZATION_BASES=permitted_search_response
# → activates search_listings, get_listing, get_open_houses, and more

# A use expressly approved in writing (§1.e / §2)
MLS_AI_ACCESS_ENABLED=true
MLS_DATA_LICENSE_USES=participant_listings_use
MLS_AI_AUTHORIZATION_BASES=written_mls_approval
MLS_AI_WRITTEN_APPROVAL_REFERENCE=<approval identifier>
MLS_AI_AUTHORIZED_TOOLS=get_listing,market_stats   # required: never inferred
```

## Claude → MCP authentication boundary

| Variable | Default | Notes |
|---|---|---|
| `MCP_AUTH_TOKEN` | — | **Secret.** When set, `/mcp` requires `Authorization: Bearer <token>` (constant-time comparison). Distinct from and independently rotatable from `MLSGRID_TOKEN`. **Strongly recommended in production** |

## HTTP server

| Variable | Default | Notes |
|---|---|---|
| `PORT` | `3000` | Render sets this automatically |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |
| `NODE_ENV` | — | `production` enables a startup warning when `MCP_AUTH_TOKEN` is unset |

## Minimum production configuration

```bash
# Fixture (no live MLS access) — safe today
MLS_PROVIDER=fixture
MCP_AUTH_TOKEN=<generated secret>
NODE_ENV=production

# Live (only after licensing, Addendum acceptance AND certification)
MLS_PROVIDER=mlsgrid
MLSGRID_TOKEN=<licensed token>
MLSGRID_ORIGINATING_SYSTEM=<confirmed value>
MCP_AUTH_TOKEN=<generated secret>
NODE_ENV=production
# Without all three of these, the live provider serves no MLS tools at all:
MLS_AI_ACCESS_ENABLED=true
MLS_DATA_LICENSE_USES=<selections actually licensed via the Data Interface>
MLS_AI_AUTHORIZATION_BASES=<basis the applicable authorization provides>
MLS_PARTICIPANT_NAME=Buy Sell Home Team | RE/MAX Results
```
