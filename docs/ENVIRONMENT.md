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

# Live (only after licensing AND certification)
MLS_PROVIDER=mlsgrid
MLSGRID_TOKEN=<licensed token>
MLSGRID_ORIGINATING_SYSTEM=<confirmed value>
MCP_AUTH_TOKEN=<generated secret>
NODE_ENV=production
```
