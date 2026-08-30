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
| OR-clause limit (conservatively capped at 10) | Live rejection threshold |
| Rate limits (conservatively throttled to ~1.7 req/s) | Live 429 behavior |
| Whether `$count` is reliable | Live response |
| RESO field names and semantics in the mapping table | `$metadata` + Matrix reconciliation |
| Whether concessions and private remarks are exposed at all | `$metadata` + license terms |

Resolution path: [`CERTIFICATION_RUNBOOK.md`](CERTIFICATION_RUNBOOK.md).

## External gates

Licensing, subscription eligibility, pricing, and the MLS Grid AI Use Addendum are **outside this
repository** and unresolved. See [`EXTERNAL_GATES.md`](EXTERNAL_GATES.md). Nothing in this codebase
or its documentation constitutes a license permission.
