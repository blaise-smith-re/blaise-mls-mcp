# AI Use Addendum — review against this implementation

Review of the **AI Use Addendum to MLS Grid Data License Agreement** (supplied by Blaise, reviewed
2026-08-30) against `blaise-mls-mcp`.

> **Not legal advice.** This is an engineering mapping from clause to control, written to make the
> Addendum's restrictions technically enforceable. It does not interpret the Addendum beyond its
> text, and it grants nothing. Where the text is ambiguous as applied to this server, the code fails
> closed and the ambiguity is listed under [Open questions](#open-questions-for-blaise).

## The headline finding

The Addendum's summary paragraph states it permits MLS Grid Data with AI Tools **solely** for
(i) Permitted Search/Response Use and (ii) Permitted Marketing Use, and that "**All other use of MLS
GRID Data with an AI Tool is prohibited unless an MLS provides written approval**."

Two definitions then constrain those two permitted uses sharply:

**§1.i — Permitted Search/Response Use** is "the use of MLS GRID Data **for IDX Uses or VOW Uses
(i.e., with IDX or VOW licenses)**…". It is tied to an IDX or VOW license. The feasibility review
indicated Blaise's likely use class is **Back Office**. On the text, a Back Office license does not
carry Permitted Search/Response Use.

**§1.h/§1.g — Permitted Marketing Use** is generating **Marketing Content**, defined as materials
"created by or on behalf of Participant **solely for the purpose of marketing Participant's own
listings or business**", and excluding "any images, videos, or other copyrighted content not owned
by Participant."

**Consequence for this server:** under a Back Office license alone, the only available basis is
Permitted Marketing Use, and that basis reaches only work marketing Blaise's own listings or
business. Several tools here — comparables and market statistics over *other* participants' listings
— do not obviously sit inside that boundary when used for internal buyer advisory or CMA work rather
than to produce marketing content. **This is the gap that most needs Blaise's decision**, and it is
why the code refuses to map tools to bases on its own.

Notably, §1.g's definition of Marketing Content *does* expressly include "predictive market
analytics", "prospective listing intelligence for properties not yet on the market", and "listing
presentation materials" — so CMA-shaped outputs can qualify **when created solely to market Blaise's
own listings or business**. The determining factor in the text is purpose, not output shape, and
purpose is not something this server can verify. Hence the per-tool allowlist.

## Clause-to-control mapping

| Clause | Requirement | Control | Test |
|---|---|---|---|
| §1.d | No AI Training: no train/fine-tune/align/embed/distill, RLHF, validation, testing, retraining, **vector embeddings, retrieval indices, knowledge graphs**, or similar representations **persisting beyond a single user session**; no use enabling output derived from the data **without contemporaneous access** | No such code exists. `PROHIBITED_USES` documents it; the server holds no store of any kind and re-fetches on every query | `no-persistence.test.ts` — no persistence/vector imports, no such dependency, no disk writes |
| §1.e | Authorized AI Use = Permitted Search/Response Use, Permitted Marketing Use, or written authorization from MLS GRID or an MLS | `AUTHORIZED_USE_BASES` is a closed enum; an undeclared basis cannot be configured | `ai-use.test.ts` — Back Office rejected as a basis |
| §1.i | Permitted Search/Response Use requires **IDX or VOW licenses** | `validateAiUseDeclaration` refuses that basis unless `idx` or `vow` is declared; startup fails | `ai-use.test.ts` — refuses without IDX/VOW, accepts with |
| §2 | Use limited to "usage options selected via the Data Interface" | Operator declares `MLS_AI_LICENSE_CLASSES` and `MLS_AI_AUTHORIZED_TOOLS` to mirror what is actually selected | `ai-use.test.ts` — empty allowlist authorizes nothing |
| §3.a | No caching, storing, archiving or retention beyond an individual query | No cache anywhere; `Cache-Control: no-store` on every request; identical repeated queries re-fetch; certification report redacts MLS values by default | `no-persistence.test.ts` — re-fetch proven by changing upstream data mid-test |
| §3.b | No AI Training without prior express authorization | Structurally absent, as §1.d above | `no-persistence.test.ts` |
| §3.c | Vendor **must retain the ability to restrict, suspend, and terminate** an AI Tool's access at any time | `MLS_AI_ACCESS_ENABLED` kill switch, **default OFF**. When off, MLS tools are absent from `tools/list` and the service refuses before any HTTP call | `ai-use.test.ts` — no fetch occurs while off |
| §3.d | Data may not be rendered unattributable to the Participant, MLS, or MLS GRID, nor merged into a model's general knowledge base | Every MLS-derived result carries an `attribution` block naming all three, attached at the service layer so no tool can omit it | `ai-use.test.ts` — attribution asserted on all nine result shapes |
| §3.e | No outputs, derivative works, or **synthetic data** to reconstruct, replicate or compete with MLS GRID, an MLS, or the data | No such capability. The fixture dataset is generated from a seeded PRNG and was never derived from MLS Grid Data, so it is not synthetic data "based on MLS GRID Data" | `fixture-adapter.test.ts` — dataset is deterministic from a seed |
| §3.f | AI Tool resilient against unauthorized third parties altering its use by exploiting vulnerabilities; appropriate cybersecurity | Bearer auth on `/mcp`, constant-time comparison, no raw query passthrough, OData allowlist + escaping, origin-pinned outbound requests, bounded request/response sizes, stateless transport | `http.test.ts`, `odata.test.ts`, `http-client.test.ts` |
| §4.b | On revocation, MLS Grid Data must be destroyed | Nothing is retained to destroy. The one exception — a certification report generated with `--include-mls-values` — carries a destroy-after-reconciliation banner | Documented in `CERTIFICATION_RUNBOOK.md` |
| §6 | Material updates effective 15 days after notice | Recorded as a standing re-review obligation | `EXTERNAL_GATES.md` |

## What this build changed in response

1. **Kill switch** (`MLS_AI_ACCESS_ENABLED`), default OFF for the live provider — §3.c.
2. **Fail-closed default**: an `MlsService` constructed without an explicit policy is treated as a
   fully-closed live policy, never as permission.
3. **Per-tool authorization** (`MLS_AI_AUTHORIZED_TOOLS`): tools are filtered out of `tools/list`
   entirely, and re-checked at the service layer so bypassing MCP does not bypass the gate.
4. **IDX/VOW enforcement** for Permitted Search/Response Use — §1.i.
5. **Back Office is not a basis**: it is a license class, never an AI-use basis.
6. **Attribution on every MLS-derived result**, naming Participant, MLS and MLS GRID — §3.d.
7. **`Cache-Control: no-store`** on every outbound request, plus tests proving no in-process cache.
8. **Certification report redacts MLS content by default**; `--include-mls-values` is opt-in and
   carries a destroy-after-use banner — §3.a.

## Open questions for Blaise

These are licensing judgments this server deliberately refuses to make. Each one determines which
tools may go into `MLS_AI_AUTHORIZED_TOOLS`.

1. **Which license class will actually be executed** — Back Office, IDX, VOW, or a combination?
   This single answer decides whether Permitted Search/Response Use is available at all (§1.i).
2. **Does internal buyer advisory / CMA work fall within Permitted Marketing Use?** §1.g ties
   Marketing Content to marketing *Blaise's own listings or business*. Comparables and market
   statistics over other participants' listings, used to advise a buyer rather than to market a
   listing, are not clearly inside that definition. If they are not, `get_comparables`,
   `market_stats` and `get_market_snapshot` should stay out of the allowlist under a Back Office
   license absent written approval.
3. **Is this deployment "Vendor", "Participant", or both?** The Addendum imposes obligations on
   Vendor (§3.c, §3.f, §4.a) that assume a software supplier distinct from the Participant. A
   self-built tool collapses those roles, and §3 makes Vendor and Participant jointly and severally
   liable.
4. **§4.a end-user agreements** — requires explicit prohibitions against scraping and non-compliant
   AI use in end-user agreements. If output ever reaches clients, that obligation attaches to
   whatever agreement governs them; it is outside this repository.
5. **Which usage options will be selected via the Data Interface** (§2), since authorized use is
   limited to those.

Until 1 and 2 are answered, the defensible configuration is: kill switch **off**, or — if switched
on — an allowlist containing only tools Blaise has affirmatively determined fall within a permitted
use.

## Standing obligations

- **§6 re-review.** Material updates take effect 15 days after notice. On any notice, re-read the
  Addendum and re-run this review; continued use is acceptance.
- **§4.c** — comply with all AI Requirements (applicable federal, state and local law).
- Re-run certification after any change to the allowlist or declared bases.
