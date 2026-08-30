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

**Status: unresolved and material.**

MLS Grid maintains an AI Use Addendum whose current production terms have **not** been reviewed or
accepted. This gate is specifically about *this* server: an MCP that feeds MLS data to an AI
assistant is squarely within whatever that addendum governs.

Its terms may constrain what this server is permitted to do — retention, derived statistics, what may
be surfaced to a model, redistribution. Those constraints could require code changes before live use.
Read it before, not after, wiring the token.

*Requires: Blaise. Review and acceptance of binding vendor terms.*

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
