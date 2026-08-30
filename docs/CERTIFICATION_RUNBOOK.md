# Live certification runbook

How this MCP earns production status once a licensed MLS Grid token exists.

> **A successful API response is not certification.** The API answering proves connectivity. It does
> not prove the MCP returns the same records, the same counts, or the same field semantics as the
> already-certified Northstar/Matrix browser lane. Certification is that reconciliation.

## Preconditions

All must hold before starting. See [`EXTERNAL_GATES.md`](EXTERNAL_GATES.md).

- [ ] MLS Grid data license / Back Office subscription executed (Gate 1)
- [ ] MLS Grid AI Use Addendum **accepted** (reviewed 2026-08-30 and enforced in code — see
      [`AI_USE_ADDENDUM_REVIEW.md`](AI_USE_ADDENDUM_REVIEW.md); acceptance and the scope decisions
      below remain Blaise's) (Gate 2)
- [ ] Declared license class matches what was executed. **§1.i: Permitted Search/Response Use
      requires an IDX or VOW license; a Back Office license does not carry it**
- [ ] Each tool in `MLS_AI_AUTHORIZED_TOOLS` affirmatively determined to fall within a permitted use.
      **Back Office access alone is not blanket AI permission**
- [ ] `MLS_AI_ACCESS_ENABLED=true` set deliberately — the kill switch defaults OFF (§3.c)
- [ ] Production API token issued and configured **in the deployment environment only** (Gate 3)
- [ ] Northstar/brokerage authorization confirmed to cover a programmatic API lane (Gate 4)
- [ ] `npm run verify` passes on the deployed commit
- [ ] Matrix access available in the same session, for side-by-side comparison

## Step 0 — Metadata reconciliation

Before any checkpoint, retrieve live `$metadata` and reconcile it against
[`FIELD_MAPPING.md`](FIELD_MAPPING.md) and [`CAPABILITIES.md`](CAPABILITIES.md):

- Confirm resource names (Property, Member, Office, OpenHouse).
- Confirm every RESO field name in the mapping table exists and means what the table says.
- Confirm which fields are **server-side searchable**, then set `MLSGRID_SERVER_FILTER_FIELDS`
  accordingly. This is the single highest-value configuration change: it moves predicates from
  in-process to server-side and sharply reduces retrieved volume.
- Confirm the correct `OriginatingSystemName` value for NorthstarMLS.
- **Confirm the `StandardStatus` wire spelling.** Filters send the normalized enum
  (`ActiveUnderContract`); some feeds store the spaced form (`Active Under Contract`). Reading
  tolerates both, but a filter is an exact string match — a mismatch returns **zero rows with no
  error**, which reads as "no listings" rather than as a bug. Verify against the Lookup resource and
  confirm a status-filtered query returns a non-zero count before trusting checkpoints 3–5.
- Confirm whether `$count` is reliable, whether concessions are exposed, and whether private remarks
  are exposed *and licensed*.

Record every finding. Any assumption in `CAPABILITIES.md` that survives this step unverified must
stay marked `unverified`.

## Retention control during certification (§3.a)

MLS Grid Data may not be retained beyond the duration needed for an individual query, so the harness
writes **no MLS content by default** — only counts, completeness accounting and capability flags.

Checkpoints 1–2 and 6–7 require comparing actual field values against Matrix, which needs
`--include-mls-values`. That output **is MLS Grid Data at rest**: it carries a destroy-after-use
banner, must never be committed, synced to cloud storage, attached to a ticket, or placed in Claude
project knowledge, and must be destroyed as soon as reconciliation is complete. Sign-off includes a
checkbox for that destruction.

## Running the harness

```bash
npm run build
MLS_PROVIDER=mlsgrid \
MLSGRID_TOKEN=<licensed token> \
MLSGRID_ORIGINATING_SYSTEM=<confirmed value> \
MLS_AI_ACCESS_ENABLED=true \
MLS_AI_AUTHORIZED_USE_BASES=<declared basis> \
MLS_AI_LICENSE_CLASSES=<executed class> \
MLS_AI_AUTHORIZED_TOOLS=<authorized tools> \
node scripts/certify.mjs \
  --include-mls-values \
  --mls-number <a known MLS number> \
  --address "<that property's exact address>" \
  --city Woodbury \
  --subject <subject MLS number> \
  --out certification-report.md
```

The harness collects the MCP side and leaves every Matrix column blank. It cannot certify anything
on its own; a person fills in the Matrix values and decides.

## The twelve checkpoints

| # | Checkpoint | Passes when |
|---|---|---|
| 1 | **Exact MLS number** | The same record comes back, and status, list/close price, beds, baths, living area, year built, DOM and dates match Matrix field for field |
| 2 | **Exact address** | Resolves to the same record as the MLS-number lookup — or the limitation is documented and accepted (address filtering may be unsupported) |
| 3 | **Bounded Active search** | Count matches Matrix for identical criteria, and the MLS numbers reconcile |
| 4 | **Bounded Pending search** | Same, including how Matrix treats Pending vs Active-Under-Contract |
| 5 | **Bounded Closed search** | Same, over an identical close-date window |
| 6 | **Comparable candidates** | The candidate set is reproducible from the stated retrieval query, inclusions and rejections are explainable, and no candidate Matrix would obviously include is silently missing |
| 7 | **Woodbury market statistics** | The *inputs* reconcile: record counts and the underlying values. A median matching by luck over a different record set is a failure, not a pass |
| 8 | **Pagination and completeness** | A wide query returns no duplicate keys and correct page accounting; a deliberately capped query reports `truncated` with a cap reason |
| 9 | **Field semantics** | Live `$metadata` confirms the mapping, especially `LivingArea` vs above/below-grade area, `DaysOnMarket` vs `CumulativeDaysOnMarket`, and concessions availability |
| 10 | **Zero writes and AI-use gating** | Tool inventory contains no write surface, nothing changed in Matrix during the run, and the registered tools match exactly what the executed Addendum authorizes |
| 11 | **Kill switch** | Setting `MLS_AI_ACCESS_ENABLED=false` removes every MLS tool and produces no MLS Grid request (§3.c) |
| 12 | **No retention** | An identical repeated query re-fetches rather than replaying a cached copy; no report file retains MLS content unless deliberately opted in (§3.a) |

### On counts that don't match

A mismatch is information, not automatic failure. Investigate before deciding:

- Are the Matrix criteria *exactly* the criteria in `query_definition`? (Matrix carries stale default
  filters between searches — the certified Matrix lane already requires verifying the displayed
  criteria summary. Do that first.)
- Was the MCP result `truncated`? Then the count is a floor and the comparison is invalid.
- Do the sets differ by records missing a filtered field? The MCP excludes those deliberately.
- Do date bounds mean the same thing on both sides (inclusive, same field)?

Record the explanation. An explained, accepted difference can still pass; an unexplained one cannot.

## Outcomes

**PASS** — all twelve reconciled. The MCP becomes the preferred structured lane. Update
`BUILD_STATUS` in `src/version.ts`, `CAPABILITIES.md` (`unverified` → `supported`), and the governing
SOP.

**PARTIAL** — connectivity and some checkpoints reconcile, others do not. Usable only for the
specific reconciled operations, with the failures documented as limitations. Matrix remains
authoritative elsewhere.

**HOLD** — material mismatch, a licensing problem, or a capability the feed cannot support. Matrix
remains the production lane; fix and re-certify.

## After certification

Re-certify when: the MLS Grid contract changes, **the AI Use Addendum is materially updated (§6:
effective 15 days after notice, and continued use is acceptance)**, the declared AI-use bases or
`MLS_AI_AUTHORIZED_TOOLS` allowlist changes, the adapter or mapping changes
materially, `MLSGRID_SERVER_FILTER_FIELDS` is widened (it changes what the API filters), or
NorthstarMLS changes its feed. Periodic spot-checks against Matrix are cheap insurance — a feed can
change semantics without changing its schema.
