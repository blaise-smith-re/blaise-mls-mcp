# External activation gates

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

Still open, and Blaise's decision alone:

- Which license class is actually executed (this decides whether Search/Response Use exists at all).
- Whether internal buyer advisory / CMA work falls within Permitted Marketing Use, given §1.g's
  "Participant's own listings or business" limit. See the Open Questions in the review document.
- Whether this deployment is Vendor, Participant, or both (§3 makes them jointly and severally liable).
- §4.a end-user agreement obligations, if output ever reaches clients.
- **§6:** material updates take effect 15 days after notice, and continued use is acceptance. Any
  notice triggers a re-read and a re-run of the review.

*Requires: Blaise. Acceptance of binding vendor terms, and the scope decisions above.*

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

**Status: constrained pending Gates 1–2.**

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
without an explicitly configured token.
