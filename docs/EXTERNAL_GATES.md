# External activation gates

**The unresolved question is AUTHORIZATION, not technical capability.**

Every capability this business requires — buyer property search and matching, individual property
research, comparable analysis, CMA evidence, market statistics, market snapshots, buyer/seller client
preparation, listing presentations, and MLS-grounded guides and marketing — is **built, tested and
ready**. None of it is missing, disabled by design, or awaiting further engineering. What each one
awaits is the applicable Northstar/MLS Grid authorization.

When that authorization exists, activation is a **configuration change**: declare the licensed
data-license use(s), declare the AI authorization basis, switch on `MLS_AI_ACCESS_ENABLED`. No
architectural rewrite, no redesign, no re-implementation. The gates below are commercial and legal,
and they are the only thing standing between the current build and live operation.

Blockers that live **outside this repository**. No amount of engineering clears them, and none is
resolved today. Until they are, this server runs on fixture data only.

> Nothing in this repository — code, comments, or documentation — constitutes a license permission,
> a legal opinion, or evidence that any of these gates has been satisfied. Public documentation
> describing an API's technical behavior is not the same as authorization to use it.

## Gate 1 — MLS Grid data license / Back Office subscription

**Status: unresolved.**

Prior feasibility review indicates NorthstarMLS distributes programmatic data through MLS Grid, and
that the likely applicable use class is **Back Office**. Unverified: whether a solo agent /
single-agent business is eligible for a Back Office subscription at all, what the actual cost is, and
what the executed agreement permits.

*Requires: Blaise. Decision, contract execution, and payment.*

## Gate 2 — MLS Grid AI Use Addendum

**Status: REVIEWED 2026-08-30. Technically enforced. Acceptance and scope decisions still open.**

The Addendum has now been supplied and reviewed clause by clause against this implementation — see
[`AI_USE_ADDENDUM_REVIEW.md`](AI_USE_ADDENDUM_REVIEW.md). Its restrictions are now technically
enforceable in code, ahead of any live credential.

What the Addendum actually permits:

- MLS Grid Data may be used with AI Tools **solely** for (i) **Permitted Search/Response Use** and
  (ii) **Permitted Marketing Use**. "All other use of MLS GRID Data with an AI Tool is prohibited
  unless an MLS provides written approval to use that MLS's data with an AI Tool."
- **§1.i ties Permitted Search/Response Use to IDX or VOW licenses** — "for IDX Uses or VOW Uses
  (i.e., with IDX or VOW licenses)". A **Back Office license does not carry it**.
- **§1.h/§1.g limit Permitted Marketing Use** to Marketing Content created "solely for the purpose of
  marketing Participant's own listings or business", excluding copyrighted content Participant does
  not own.

**Back Office data access is therefore not blanket AI permission.** The code enforces this: Back
Office is a license class, never an AI-use basis, and declaring Permitted Search/Response Use without
an IDX or VOW class fails startup.

**The architecture now separates the two questions.** Data-license use (which MLS Grid selections
are licensed — IDX, VOW, Comparative Market Analysis, Customer Relationship Management, Real Estate
Market Analytics, Participant Listings Use, or any future approved use) is modeled independently
from AI authorization basis (the Addendum's closed set). A Back Office classification therefore
constrains *which combinations can currently be declared* — it does not remove, cripple or redesign
any capability.

Still open, and Blaise's decision alone:

- **Which MLS Grid data uses are actually selected** via the Data Interface. This determines which
  tools activate, and it is a subscription/selection question, not an engineering one.
- Which AI authorization basis applies to each intended use. §1.i ties Permitted Search/Response Use
  to IDX or VOW; §1.g ties Permitted Marketing Use to marketing the Participant's own listings or
  business. Where neither covers an intended use, §1.e/§2 allow express written approval from
  MLS GRID or the applicable MLS — the `written_mls_approval` basis exists precisely for that route.
- Whether this deployment is Vendor, Participant, or both (§3 makes them jointly and severally liable).
- §4.a end-user agreement obligations, if output ever reaches clients.
- **§6:** material updates take effect 15 days after notice, and continued use is acceptance. Any
  notice triggers a re-read and a re-run of the review.

*Requires: Blaise. Acceptance of binding vendor terms, the data-use selections, and the basis
decisions above. Nothing further is required of the software.*

## Gate 3 — Production API token

**Status: not held.**

No live MLS Grid API token exists for this project. No live API call has ever been made from this
codebase. Every "live" behavior is implemented from documentation and labeled `unverified`.

*Requires: Gates 1 and 2 first. A token is a credential — it goes in the deployment environment only,
never in this repository.*

## Gate 4 — Northstar / brokerage authorization

**Status: assumed from existing business context; confirm scope.**

Blaise has confirmed Northstar permission and team approval for the **certified Matrix browser
research lane**. Whether that authorization extends to a *programmatic API integration* is a
different question with a different answer path — the browser lane is a human using a licensed UI;
this is an automated data feed.

*Requires: Blaise. Confirmation that the API lane is covered, and that any team/brokerage
notification obligation is met.*

## Gate 5 — Permitted-use boundaries

**Status: constrained pending Gates 1–2. A constraint on activation, not on capability.**

Until the executed agreement and AI addendum are read, the conservative posture holds:

- MLS data is for Blaise's own business research and client service.
- **No owner solicitation or prospecting from MLS data** unless the governing terms explicitly permit
  it.
- No redistribution, no public display, no derived-product publication.
- Read-only. No write surface exists in this codebase regardless.

## Gate 6 — Live certification

**Status: blocked by Gates 1–3.**

Even with a working token, the MCP is not production-certified until it reconciles against the
already-certified Matrix lane. **A successful API response is not certification.** See
[`CERTIFICATION_RUNBOOK.md`](CERTIFICATION_RUNBOOK.md).

*Requires: Blaise plus a live token. Ten checkpoints, compared to Matrix.*

## Sequence

```
Gate 1 (license/subscription)  ─┐
Gate 2 (AI addendum)           ─┼─→ Gate 3 (token) ─→ Gate 6 (certification) ─→ production
Gate 4 (authorization scope)   ─┘
Gate 5 (permitted use) — constrains what the server may do at every stage
```

Gates 1, 2 and 4 are business and legal decisions that are Blaise's alone. This build stops cleanly
in front of them: the code is complete and tested on fixtures, and it will not attempt live access
without an explicitly configured token and an authorized data-use/basis combination.

To restate the point this document exists to make: **the software is not the blocker.** Each gate is
an authorization to obtain, and each one, once obtained, is expressed to this server as
configuration.
