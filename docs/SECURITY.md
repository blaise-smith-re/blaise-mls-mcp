# Security notes

## Trust boundary

Two separate credentials, deliberately not the same secret:

```
Claude  ──Bearer MCP_AUTH_TOKEN──▶  blaise-mls-mcp  ──Bearer MLSGRID_TOKEN──▶  MLS Grid API
        (Claude → MCP boundary)                      (MCP → vendor boundary)
```

**The MLS Grid credential never crosses the Claude boundary.** It is read from the server
environment, attached to outbound requests, and never returned by any endpoint, included in any tool
response, or written to any log. Claude authenticates to *this server*; this server authenticates to
*MLS Grid*. The two tokens rotate independently, and compromise of the Claude-side token does not
expose the licensed MLS credential.

This is why the design does not add OAuth. The question worth answering was whether the vendor
credential should stay server-side while a separate boundary guards Claude→MCP — it should, and a
bearer token on `/mcp` achieves it. OAuth would add flows and stored state without changing that
property. Revisit only if multiple distinct principals ever need differentiated access; today there
is one principal, Blaise's own Claude.

## Secret handling

- Secrets come only from environment variables. No secret is ever a CLI argument, a request
  parameter, or a committed file.
- `.env` and `.env.*` (except `.env.example`) are git-ignored.
- `npm run secret-scan` runs over **git-tracked files** and fails the build on assigned secret-shaped
  env vars, literal bearer tokens, private key blocks, AWS key ids, or a committed `.env`. It is part
  of `npm run verify`.
- `MCP_AUTH_TOKEN` is compared in constant time (`timingSafeEqual`), with a length check first.

## Logging

Logs are structured JSON on **stderr** (stdout is reserved for the stdio MCP transport).

- Token-shaped text is stripped from every message by `redactSecrets` before it is written.
- Structured fields are walked recursively and any key matching
  `authorization|token|api_key|secret|password|bearer|mlsgrid_token|mcp_auth_token` is replaced with
  `[REDACTED]`.
- **Confidential MLS content is never logged by default.** A failed tool call logs the tool name and
  the error code only — not arguments, not upstream payloads. Tests assert that an address passed to
  a failing call does not appear in the log.
- A rejected `/mcp` request logs the reason (`invalid_or_missing_bearer`), never the presented
  credential.

## Request and response bounds

- Request bodies are capped at 1 MB.
- Tool responses are capped at 1.5 MB; exceeding it returns a `VALIDATION` error telling the caller
  to narrow the query, rather than emitting an unbounded payload.
- Records per query are capped by `MLS_MAX_RECORDS_PER_QUERY` (default 2,500); pages by
  `MLSGRID_MAX_PAGES_PER_QUERY`.
- Outbound requests are throttled and time-bounded (`AbortController`).

## Attack surface controls

**No arbitrary URL fetching.** Every outbound URL — including an `@odata.nextLink` returned by the
API — must match the configured `MLSGRID_API_BASE` origin. A redirect to another host is refused.

**No raw query passthrough.** Callers supply typed predicates only. OData is constructed server-side
against a field allowlist with escaped literals, validated raw date literals, and bounded OR chains.
See [`MLSGRID_ADAPTER.md`](MLSGRID_ADAPTER.md#odata-safety). A test asserts no tool exposes a
parameter named like `url`, `endpoint`, `odata`, `body`, `headers` or `token`.

**No generic HTTP proxy tool.** Nothing in the tool inventory can be pointed at an arbitrary service.

**No write surface.** Nine read-only tools, all annotated `readOnlyHint: true`. There is no MLS
Add/Edit, status-change, or submission code path anywhere in this repository. Tests assert both the
naming and the annotations.

**Stateless transport.** A fresh MCP server and transport per request means no cross-request session
state and no session-fixation surface.

## AI Use Addendum enforcement

The MLS Grid AI Use Addendum is enforced technically, not just documented. See
[`AI_USE_ADDENDUM_REVIEW.md`](AI_USE_ADDENDUM_REVIEW.md) for the clause-by-clause mapping.

**Kill switch (§3.c).** `MLS_AI_ACCESS_ENABLED` defaults **OFF** for the live provider. While off,
MLS tools do not appear in `tools/list` at all and the service refuses before any HTTP request is
constructed — the Addendum's requirement that access can be restricted, suspended and terminated at
any time is a single environment variable.

**Fail closed.** An `MlsService` built without an explicit policy is treated as a fully-closed live
policy. Permission is never inferred from the absence of a prohibition.

**Per-tool authorization (§2).** `MLS_AI_AUTHORIZED_TOOLS` gates each tool individually. The server
deliberately does **not** decide which tool falls within a permitted use — that is a licensing
judgment, so an empty allowlist authorizes nothing.

**No retention (§3.a, §1.d).** Nothing is cached, stored, archived or retained beyond the request
that fetched it. `Cache-Control: no-store` goes out on every request; identical repeated queries
re-fetch. There is no database, no file store, no vector index, no embedding, no retrieval index, no
knowledge graph, and no training or fine-tuning path anywhere in the codebase. `tests/no-persistence.test.ts`
proves this structurally: it asserts no runtime module writes to disk, imports a persistence or
embedding client, declares one as a dependency, or uses browser-side storage — and that no MLS
records remain reachable on the adapter or service after a request completes.

**Never in assistant-side storage.** MLS content must not be placed in Claude project knowledge,
memory, or any other assistant-side store. Every MLS-derived result carries that instruction in its
`attribution.handling` block.

**Attribution (§3.d).** Every MLS-derived result names the Participant, the originating MLS, and
MLS GRID. Attribution is attached at the service layer, so a new tool cannot ship without it.

**Certification reports.** `scripts/certify.mjs` redacts MLS content by default so its report can be
retained safely. `--include-mls-values` opts in for Matrix reconciliation and stamps the file with a
destroy-after-use banner — that file is MLS Grid Data at rest.

## Data handling posture

Private/agent remarks are mapped only when the licensed feed exposes them *and*
`MLSGRID_EXPOSE_PRIVATE_REMARKS=true` — default off. MLS data retrieved through this server is for
Blaise's own business research and client service; owner solicitation from MLS data is out of scope
unless the governing terms explicitly permit it ([`EXTERNAL_GATES.md`](EXTERNAL_GATES.md), Gate 5).

## Deployment checklist

- [ ] `MCP_AUTH_TOKEN` set to a strong generated secret (the server warns at startup in production if
      it is missing)
- [ ] `MLSGRID_TOKEN` set in the platform's secret store, never in the repository
- [ ] `NODE_ENV=production`
- [ ] TLS terminated by the platform; no plaintext transport
- [ ] `LOG_LEVEL=info` (not `debug`) in production
- [ ] `npm run verify` green on the deployed commit
- [ ] Rotation plan for both tokens
