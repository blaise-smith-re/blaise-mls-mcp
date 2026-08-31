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

## Authorization model: two independent axes

**Every capability below is fully implemented and stays that way.** What varies is whether the
current authorization permits running it against live MLS Grid Data. A withheld tool is
*unauthorized*, not *absent* — activating it later is a configuration change, not a rewrite.

Authorization has two independent axes, and a tool runs only when **both** are satisfied and the
kill switch is on:

**1. Data-license use** (`MLS_DATA_LICENSE_USES`) — which MLS Grid data-use selections are actually
licensed and selected via the Data Interface (§2). **Open and extensible**: IDX, VOW, Comparative
Market Analysis, Customer Relationship Management, Real Estate Market Analytics, Participant
Listings Use, Back Office, **or any future approved use** — a newly approved selection needs no code
change, only a declaration.

**2. AI authorization basis** (`MLS_AI_AUTHORIZATION_BASES`) — the Addendum's **closed** set (§1.e):
`permitted_search_response`, `permitted_marketing`, `written_mls_approval`.

Holding a data license is not AI permission, and an AI basis without the underlying data use is not
either. Neither axis alone authorizes anything.

| Condition | Effect |
|---|---|
| `MLS_AI_ACCESS_ENABLED` unset/false | Every MLS tool withheld; no MLS Grid request made (§3.c) |
| No `MLS_AI_AUTHORIZATION_BASES` | Withheld — `NO_AI_AUTHORIZATION_BASIS` |
| No `MLS_DATA_LICENSE_USES` | Withheld — `NO_DATA_LICENSE_USE` |
| Tool's data use not among those declared | Withheld — `DATA_USE_NOT_LICENSED` |
| Tool's basis not among those declared | Withheld — `BASIS_NOT_DECLARED` |
| `permitted_search_response` without `idx`/`vow` | **Startup fails** — §1.i ties that use to IDX or VOW |
| A data use given as an AI basis | **Startup fails** — the axes are distinct |
| `written_mls_approval` without a reference and explicit tool listing | Withheld — never inferred |

`MLS_AI_AUTHORIZED_TOOLS` is an optional further narrowing. It can only restrict what the two axes
already permit, never widen it.

## Per-tool capability register

For each tool: technical capability, the data uses that could underpin it, the AI bases it could run
under, and — at runtime — its current authorization state and the reason when withheld.
`get_capabilities` returns this live, including every withheld tool.

| Tool | Technical capability | Data-use requirement (any of) | Possible AI basis | Business capabilities served |
|---|---|---|---|---|
| `get_capabilities` | Reports capabilities, limitations and authorization state | *(none — no MLS data)* | *(n/a)* | Operational transparency |
| `get_listing` | Exact lookup by MLS number/key or address, with provenance | idx, vow, comparative_market_analysis, customer_relationship_management, real_estate_market_analytics, participant_listings_use | search/response, marketing, written | Individual property research · Buyer/seller prep · Listing presentations |
| `search_listings` | Deterministic filtered search with completeness accounting | idx, vow, comparative_market_analysis, customer_relationship_management, real_estate_market_analytics, participant_listings_use | search/response, marketing, written | **Buyer property search and matching** · Property research · Buyer prep |
| `get_listing_history` | History-adjacent fields plus the capability limitation | *same as `get_listing`* | search/response, marketing, written | Property research · Seller prep · Listing presentations |
| `get_comparables` | Retrieves and ranks comparable candidates with reasoning | comparative_market_analysis, real_estate_market_analytics, idx, vow | search/response, marketing, written | **Comparable analysis · CMA evidence** · Seller prep · Listing presentations |
| `market_stats` | Computes market metrics with stated methodology | comparative_market_analysis, real_estate_market_analytics, idx, vow | search/response, marketing, written | **Market statistics** · CMA evidence · MLS-grounded guides · Listing presentations |
| `get_market_snapshot` | Inventory/pending/closed composition from bounded queries | comparative_market_analysis, real_estate_market_analytics, idx, vow | search/response, marketing, written | **Market snapshots** · Market statistics · MLS-grounded guides |
| `lookup_member_or_office` | Member/office directory lookup | *same as `get_listing`* | search/response, marketing, written | Property research · Buyer/seller prep |
| `get_open_houses` | Scheduled open houses, optionally scoped | idx, vow, participant_listings_use, customer_relationship_management | search/response, marketing, written | Buyer search and matching · Buyer prep · Listing presentations |

> The data-use and basis columns are a **configuration scaffold, not a legal determination**. They
> record which declarations *would* activate each tool. They do **not** assert that the executed
> Addendum authorizes any of them today. Confirming which MLS Grid selections actually cover which
> tool is Blaise's decision with counsel; the operator declares the result through configuration.

### Preserved business capabilities

These remain architecturally supported and activate by configuration once the applicable
Northstar/MLS Grid authorization exists:

buyer property search and matching · individual property research · comparable analysis · CMA
evidence · market statistics · market snapshots · buyer/seller client preparation · listing
presentations · MLS-grounded guides and marketing.

Structurally prohibited regardless of configuration (§1.d, §3): embeddings, vector indexes,
retrieval indices, knowledge graphs, fine-tuning, training datasets, persistent retrieval stores,
any representation persisting beyond a single session, caching beyond an individual query, storage in
Claude project knowledge or memory, and rendering data unattributable to the Participant, MLS or
MLS GRID.

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
