# Capability and limitation register

What this server can do, what it cannot, and what is merely *believed* to be true pending live
verification. `get_capabilities` returns the machine-readable version of this table.

Three-valued status: **supported** (implemented and verified in this lane) · **unsupported** (the
lane cannot do this; the server says so rather than approximating) · **unverified** (implemented from
documentation, never confirmed against live behavior).

## By provider

| Capability | Fixture | MLS Grid (live) |
|---|---|---|
| Listing lookup by MLS number / key | supported | unverified |
| Exact address lookup | supported | unsupported by default¹ |
| Event-level listing history | unsupported | unsupported |
| Media references | unsupported² | unverified |
| Member (agent) lookup | supported | unverified |
| Office lookup | supported | unverified |
| Open houses | supported | unverified |
| Server-reported totals (`$count`) | supported | unverified |

¹ Address fields are not in the conservative default server-side filterable allowlist. The adapter
raises `UNSUPPORTED_CAPABILITY` rather than issuing a query it cannot support. Widening
`MLSGRID_SERVER_FILTER_FIELDS` after live `$metadata` confirmation enables it (then `unverified`).

² The fixture dataset carries no media; the code path exists and is exercised by mapping tests.

## AI-use gating (MLS Grid AI Use Addendum)

Live tools are **unavailable by default**. Availability requires all three of: the live provider
configured, the AI-access kill switch on, and the tool individually allowlisted.

| Condition | Effect |
|---|---|
| `MLS_AI_ACCESS_ENABLED` unset/false | No MLS tool is registered; no MLS Grid request is made (§3.c) |
| No `MLS_AI_AUTHORIZED_USE_BASES` | Same — Authorized AI Use is undeclared (§1.e) |
| Tool absent from `MLS_AI_AUTHORIZED_TOOLS` | That tool is not registered and is refused at the service layer (§2) |
| `permitted_search_response_use` without `idx`/`vow` | **Startup fails** — §1.i ties that use to IDX or VOW licenses |
| `back_office` given as an AI-use basis | **Startup fails** — Back Office is a license class, not an AI-use basis |

**Back Office access alone is not blanket AI permission.** Under a Back Office license the only
declarable basis is Permitted Marketing Use, which §1.g limits to marketing *Blaise's own listings or
business*. Whether comparables and market statistics over other participants' listings fall inside
that limit is an open licensing question — see the Open Questions in
[`AI_USE_ADDENDUM_REVIEW.md`](AI_USE_ADDENDUM_REVIEW.md).

Structurally prohibited regardless of configuration (§1.d, §3): embeddings, vector indexes,
retrieval indices, knowledge graphs, fine-tuning, training datasets, persistent retrieval stores,
any representation persisting beyond a single session, caching beyond an individual query, storage in
Claude project knowledge or memory, and rendering data unattributable to the Participant, MLS or
MLS GRID. `get_capabilities` returns the live posture, including why a tool is withheld.

## Standing limitations

**No listing history.** The licensed feed exposes current-state records, not a history resource.
Price-change and status-change timelines are unavailable here and are never reconstructed.
`get_listing_history` returns the limitation plus the history-adjacent fields the current record
carries — `original_list_price` differing from `list_price` proves at least one price change occurred,
but not how many, how large, or when. Full history requires the certified Matrix browser lane.

**No write surface.** Nine read-only tools. No MLS Add/Edit, status change, submission, or
communication capability exists in this codebase, and a test asserts every tool is annotated
read-only.

**Records missing a filtered field are excluded.** A bound cannot be proven satisfied for a null. A
listing with no `LivingArea` will not appear in a `min_living_area_sqft` search. `_completeness` names
every predicate applied in-process so this is visible per query.

**Server totals may not exist.** When the source reports no total and retrieval ran to exhaustion,
completeness is `unknown` — consistent with complete, not proven complete.

**Concessions absent ≠ zero.** The feed does not distinguish "no concessions" from "not reported", so
concession statistics use only records that report an amount.

**Months of supply is often refused.** It requires an explicit closed window of known length *and* a
dataset containing active inventory. A close-date-bounded query cannot contain active listings, so
`market_stats` returns `null` with a reason and directs to `get_market_snapshot`, which measures both
sides with separate queries.

**Statistics describe the retrieved subset.** If `_completeness.completeness_status` is not
`complete`, the figures describe what was retrieved, not the market. The limitations array says so
explicitly.

**Comparables are not valuation.** Ranked evidence with stated tolerances and per-candidate
reasoning. No adjusted value, no recommended list price.

**Every MLS-derived result carries attribution.** Participant, originating MLS, distributor,
retrieval time, and handling instructions (§3.d). Preserve it wherever figures are presented.

**Nothing is retained.** MLS content exists only for the lifetime of the request that fetched it
(§3.a). There is no cache to warm and no store to query; identical repeated calls re-fetch.

**Fixture data is synthetic.** 151 generated records. Never real market data; statistics computed
from it carry an explicit `FIXTURE PROVIDER` limitation.

**Private/agent remarks default off.** Mapped only when the licensed feed exposes them *and*
`MLSGRID_EXPOSE_PRIVATE_REMARKS=true`.

## Unverified assumptions (live lane)

Every item is documentation-derived. None has been executed against the live API, because no live
token is held.

| Assumption | Verify by |
|---|---|
| Base URL, bearer auth scheme | First authenticated live request |
| Resource names: Property, Member, Office, OpenHouse | `$metadata` |
| 5,000 records/request; 1,000 with `$expand` | Live paging behavior |
| One `OriginatingSystemName` per request; correct value for NorthstarMLS | Live behavior |
| Which fields are server-side searchable | `$metadata` + live rejections |
| **`StandardStatus` wire spelling.** Filters send the normalized enum (`ActiveUnderContract`); some feeds store the spaced form (`Active Under Contract`). A filter is an exact string match, so a mismatch returns **zero rows silently** | `$metadata` / Lookup resource, before trusting any status-filtered count |
| OR-clause limit (conservatively capped at 10) | Live rejection threshold |
| Rate limits (conservatively throttled to ~1.7 req/s) | Live 429 behavior |
| Whether `$count` is reliable | Live response |
| RESO field names and semantics in the mapping table | `$metadata` + Matrix reconciliation |
| Whether concessions and private remarks are exposed at all | `$metadata` + license terms |

Resolution path: [`CERTIFICATION_RUNBOOK.md`](CERTIFICATION_RUNBOOK.md).

## External gates

Licensing, subscription eligibility and pricing are **outside this repository** and unresolved. The
AI Use Addendum has been reviewed and is now technically enforced
([`AI_USE_ADDENDUM_REVIEW.md`](AI_USE_ADDENDUM_REVIEW.md)), but its acceptance and the scope
decisions it raises remain Blaise's. See [`EXTERNAL_GATES.md`](EXTERNAL_GATES.md). Nothing in this
codebase or its documentation constitutes a license permission.
