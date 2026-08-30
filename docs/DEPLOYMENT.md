# Deployment

Target: **Render** web service, matching the existing `blaise-fub-mcp` deployment pattern so both
connectors are operated the same way.

## Why Render

The existing FUB MCP is already certified and running there, so operations, secret management and
deploy flow are known. This server is stateless with no datastore, so nothing about it argues for a
different platform. A stdio entry point (`npm run start:stdio`) exists for local subprocess use.

## Render service configuration

| Setting | Value |
|---|---|
| Environment | Node |
| Build command | `npm ci && npm run build` |
| Start command | `npm start` |
| Health check path | `/health` |
| Auto deploy | Your preference; the branch must pass `npm run verify` |

`render.yaml` in the repository root captures this as infrastructure-as-code. It declares every
secret with `sync: false`, so no credential value is ever stored in the repository.

## Environment variables

Set in the Render dashboard (or as sync-false secrets). Full reference:
[`ENVIRONMENT.md`](ENVIRONMENT.md).

**Fixture deployment — safe today, no license required:**

```
MLS_PROVIDER=fixture
MCP_AUTH_TOKEN=<generated secret>
NODE_ENV=production
LOG_LEVEL=info
```

**Live deployment — only after licensing AND certification:**

```
MLS_PROVIDER=mlsgrid
MLSGRID_TOKEN=<licensed token>
MLSGRID_ORIGINATING_SYSTEM=<value confirmed during certification>
MLSGRID_SERVER_FILTER_FIELDS=<fields confirmed by live $metadata>
MCP_AUTH_TOKEN=<generated secret>
NODE_ENV=production
LOG_LEVEL=info
```

`PORT` is provided by Render automatically.

Startup is fail-fast: `MLS_PROVIDER=mlsgrid` without `MLSGRID_TOKEN` aborts before binding the port,
so a misconfigured live deploy fails loudly at boot instead of silently serving errors.

## Endpoints

| Path | Method | Auth | Purpose |
|---|---|---|---|
| `/health` | GET | none | Liveness. Reports provider, build status, whether live MLS access is active, and whether MCP auth is required |
| `/version` | GET | none | Version, Node version, and the full capability register |
| `/mcp` | POST | Bearer `MCP_AUTH_TOKEN` | MCP Streamable HTTP endpoint (stateless) |

`GET`/`DELETE` on `/mcp` return 405: stateless mode supports neither server-initiated streams nor
session teardown.

Neither `/health` nor `/version` exposes any token value.

## Connecting Claude

Add as a remote MCP connector:

- **URL:** `https://<service>.onrender.com/mcp`
- **Header:** `Authorization: Bearer <MCP_AUTH_TOKEN>`

Verify with `GET /health` first — `provider` and `live_mls_access` tell you immediately whether you
are talking to fixture data or the live feed.

## Post-deploy smoke test

```bash
curl -s https://<service>.onrender.com/health | jq
# expect: status ok, provider as configured, mcp_auth_required true

curl -s -X POST https://<service>.onrender.com/mcp \
  -H "authorization: Bearer $MCP_AUTH_TOKEN" \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"1"}}}'
# expect: 200 with serverInfo

curl -s -o /dev/null -w '%{http_code}\n' -X POST https://<service>.onrender.com/mcp \
  -H 'content-type: application/json' -d '{}'
# expect: 401
```

Then call `get_capabilities` through Claude and confirm the reported provider matches what you
intended to deploy.

## Versioning

`src/version.ts` carries `SERVER_VERSION` and `BUILD_STATUS`, both surfaced on `/health` and
`/version`. `BUILD_STATUS` stays `PARTIAL — LIVE ACTIVATION PENDING` until the certification runbook
returns PASS. Dependencies are locked via `package-lock.json`; deploys use `npm ci`.
