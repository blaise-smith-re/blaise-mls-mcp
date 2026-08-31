#!/usr/bin/env node
/**
 * Live certification harness.
 *
 * Runs the ten certification checkpoints against the configured provider and
 * writes a Markdown report with the MCP-side values filled in and the Matrix
 * columns left BLANK for a human to complete.
 *
 * RETENTION CONTROL (AI Use Addendum §3.a)
 * ----------------------------------------
 * MLS Grid Data may not be cached, stored, archived or retained beyond the
 * duration reasonably necessary to fulfill an individual user query. Writing a
 * report file that contains listing field values is retention.
 *
 * So by default this report contains NO MLS content: only counts, completeness
 * accounting, capability flags and pass/fail structure — enough to prove the
 * mechanics ran. Reconciling field values against Matrix genuinely requires
 * those values, so `--include-mls-values` opts in; the resulting file is
 * MLS Grid Data at rest and must be destroyed once reconciliation is complete
 * (§3.a, and §4.b on revocation).
 *
 * This script cannot certify anything by itself. It gathers evidence; a person
 * reconciles that evidence against the certified Northstar/Matrix browser lane.
 * A successful API response is not certification.
 *
 * Usage:
 *   npm run build
 *   node scripts/certify.mjs --mls-number NST6400001 --subject NST6400009 \
 *                            [--address "..."] [--city Woodbury] \
 *                            [--include-mls-values] [--out report.md]
 */
import { writeFileSync } from 'node:fs';
import { loadConfig } from '../dist/config.js';
import { createService } from '../dist/factory.js';
import { buildTools } from '../dist/mcp/tools.js';
import { BUILD_STATUS, SERVER_VERSION } from '../dist/version.js';

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const flag = (name) => process.argv.includes(`--${name}`);

const params = {
  mlsNumber: arg('mls-number'),
  address: arg('address'),
  city: arg('city', 'Woodbury'),
  subject: arg('subject'),
  includeMlsValues: flag('include-mls-values'),
  out: arg('out', 'certification-report.md')
};

if (!params.mlsNumber || !params.subject) {
  console.error('Required: --mls-number <id> --subject <id>');
  console.error('Optional: --address, --city, --include-mls-values, --out');
  process.exit(2);
}

const REDACTED = '[REDACTED — MLS content not retained (Addendum §3.a). Re-run with --include-mls-values to reconcile.]';

/** Wrap MLS-derived content so it is omitted unless explicitly opted in. */
const mls = (value) => (params.includeMlsValues ? value : REDACTED);

const config = loadConfig();
const service = createService(config);
const isLive = config.provider === 'mlsgrid';
const policy = service.aiUsePolicy;
const results = [];

async function step(id, name, fn) {
  process.stderr.write(`[${id}] ${name}\n`);
  try {
    results.push({ id, name, outcome: 'collected', evidence: await fn() });
  } catch (err) {
    results.push({
      id,
      name,
      outcome: 'error',
      evidence: { error: err?.code ?? 'ERROR', message: err?.message ?? String(err) }
    });
  }
}

const asOf = new Date().toISOString();
const windowEnd = asOf.slice(0, 10);
const windowStart = new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 10);

await step(1, 'Exact MLS number lookup', async () => {
  const r = await service.getListing({ listing_id: params.mlsNumber });
  return {
    found: r.found,
    matches: r.lookup.matches,
    attribution_present: Boolean(r.attribution),
    fields_present: r.listing
      ? Object.entries(r.listing)
          .filter(([, v]) => v !== null)
          .map(([k]) => k)
      : [],
    record: mls(r.listing)
  };
});

await step(2, 'Exact address lookup', async () => {
  if (!params.address) return { skipped: 'no --address supplied' };
  const r = await service.getListing({ address: params.address });
  return { found: r.found, matches: r.lookup.matches, notes: r.notes, record: mls(r.listing) };
});

const boundedSearch = (statuses, extra = {}) => async () => {
  const r = await service.searchListings({ cities: [params.city], statuses, limit: 1000, ...extra });
  return {
    returned_count: r._completeness.returned_count,
    completeness_status: r._completeness.completeness_status,
    capped: r._completeness.capped,
    cap_reason: r._completeness.cap_reason,
    pages_fetched: r._completeness.pages_fetched,
    total_known: r._completeness.total_known,
    server_side_filters: r._completeness.filters_applied.server_side,
    client_side_filters: r._completeness.filters_applied.client_side,
    listing_ids: mls(r.listings.map((l) => l.listing_id))
  };
};

await step(3, `Bounded Active search (${params.city})`, boundedSearch(['Active']));
await step(4, `Bounded Pending search (${params.city})`, boundedSearch(['Pending', 'ActiveUnderContract']));
await step(
  5,
  `Bounded Closed search (${params.city}, ${windowStart}..${windowEnd})`,
  boundedSearch(['Closed'], { closed_from: windowStart, closed_to: windowEnd })
);

await step(6, 'Subject comparable candidate dataset', async () => {
  const r = await service.getComparables({ subject_listing_id: params.subject });
  return {
    tolerances: r.comparables.tolerances,
    candidates_evaluated: r.comparables.candidates_evaluated,
    included_count: r.comparables.included.length,
    rejected_count: r.comparables.rejected.length,
    retrieval_query: r.retrieval.query,
    retrieval_completeness: r.retrieval._completeness.completeness_status,
    rejection_reason_categories: [
      ...new Set(r.comparables.rejected.flatMap((c) => c.rejection_reasons.map((s) => s.split(':')[0])))
    ],
    subject: mls(r.comparables.subject),
    included: mls(
      r.comparables.included.map((c) => ({
        listing_id: c.listing_id,
        close_price: c.close_price,
        close_date: c.close_date,
        living_area_sqft: c.living_area_sqft,
        similarity_distance: c.similarity_distance
      }))
    )
  };
});

await step(7, `Market statistics (${params.city})`, async () => {
  const r = await service.marketStats({
    query: {
      cities: [params.city],
      statuses: ['Closed'],
      closed_from: windowStart,
      closed_to: windowEnd,
      limit: 1000
    },
    include_prior_period: true
  });
  const closed = r.cohorts.find((c) => c.cohort === 'closed');
  return {
    query_definition: r.query_definition,
    record_counts: r.record_counts,
    completeness_status: r._completeness.completeness_status,
    prior_period_window: r.prior_period?.window ?? null,
    limitations: r.limitations,
    metric_sample_sizes: closed
      ? Object.fromEntries(
          Object.entries(closed.metrics).map(([k, v]) => [
            k,
            { sample_size: v.sample_size, excluded: v.excluded_missing_input }
          ])
        )
      : null,
    // Aggregate metrics are Derivative Works of MLS Grid Data (§1.f), so they
    // are withheld by default alongside record-level content.
    metric_values: mls(
      closed ? Object.fromEntries(Object.entries(closed.metrics).map(([k, v]) => [k, v.value])) : null
    ),
    price_bands: mls(closed?.price_bands ?? null)
  };
});

await step(8, 'Pagination and completeness accounting', async () => {
  const wide = await service.searchListings({ cities: [params.city], limit: 1000 });
  const capped = await service.searchListings({ cities: [params.city], limit: 5 });
  const keys = wide.listings.map((l) => l.listing_key);
  return {
    wide: {
      returned_count: wide._completeness.returned_count,
      pages_fetched: wide._completeness.pages_fetched,
      completeness_status: wide._completeness.completeness_status,
      total_known: wide._completeness.total_known,
      duplicate_keys: keys.length - new Set(keys).size
    },
    capped: {
      returned_count: capped._completeness.returned_count,
      capped: capped._completeness.capped,
      cap_reason: capped._completeness.cap_reason,
      completeness_status: capped._completeness.completeness_status
    }
  };
});

await step(9, 'Field semantics and capability register', async () => {
  const r = await service.getListing({ listing_id: params.mlsNumber });
  const history = await service.getListingHistory(params.mlsNumber);
  return {
    capabilities: service.capabilities(),
    null_fields: r.listing
      ? Object.entries(r.listing)
          .filter(([, v]) => v === null)
          .map(([k]) => k)
      : [],
    history_capability: history.capability,
    attribution: r.attribution
  };
});

await step(10, 'Zero write surfaces and AI-use gating', async () => {
  const tools = buildTools(service);
  const writeVerb =
    /^(create|add|update|edit|modify|delete|remove|set|post|put|patch|submit|send|write|upload|change|cancel|close|assign)_/;
  return {
    registered_tools: tools.map((t) => t.name),
    write_shaped_tools: tools.map((t) => t.name).filter((n) => writeVerb.test(n)),
    zero_write_surfaces: tools.every((t) => !writeVerb.test(t.name)),
    ai_use_policy: policy.describe()
  };
});

const retentionBanner = params.includeMlsValues
  ? `## ⚠ THIS FILE CONTAINS MLS GRID DATA AT REST

It was generated with \`--include-mls-values\`. Under AI Use Addendum §3.a, MLS Grid Data may not be
retained beyond the duration reasonably necessary to fulfil an individual query. **Destroy this file
as soon as the Matrix reconciliation below is complete.** Do not commit it, sync it to cloud storage,
attach it to a ticket, or place it in Claude project knowledge.
`
  : `## MLS content withheld

This report contains no MLS field values: only counts, completeness accounting and capability flags,
so it can be retained safely under Addendum §3.a. Checkpoints that require comparing actual field
values to Matrix need \`--include-mls-values\`; that output is MLS Grid Data at rest and must be
destroyed after reconciliation.
`;

const report = `# MLS MCP live certification report

**Generated:** ${asOf}
**Server version:** ${SERVER_VERSION}
**Build status:** ${BUILD_STATUS}
**Provider:** \`${config.provider}\`${isLive ? '' : ' — **FIXTURE DATA. This run cannot certify anything.**'}
**AI access enabled:** ${policy.aiAccessEnabled}
**Authorized use bases:** ${policy.authorizedUseBases.join(', ') || '(none declared)'}
**License classes:** ${policy.licenseClasses.join(', ') || '(none declared)'}
**MLS values included:** ${params.includeMlsValues}

${retentionBanner}
${
  isLive
    ? ''
    : '## ⚠ Fixture run\n\nThis run used synthetic fixture data. It exercises the certification path end to end but has NO evidentiary value for production certification. Re-run with `MLS_PROVIDER=mlsgrid` and a licensed token.\n'
}
> Every Matrix column below is intentionally BLANK and must be filled in by a human from the
> certified Northstar/Matrix browser lane. A checkpoint is PASS only when the MCP value and the
> Matrix value are reconciled and match, or the difference is explained and accepted.

## Checkpoint results

| # | Checkpoint | Collected | Matrix value | Reconciled | Notes |
|---|---|---|---|---|---|
${results.map((r) => `| ${r.id} | ${r.name} | ${r.outcome === 'error' ? '**ERROR**' : 'yes'} | | ☐ | |`).join('\n')}

## Evidence

${results
  .map(
    (r) => `### ${r.id}. ${r.name}

\`\`\`json
${JSON.stringify(r.evidence, null, 2)}
\`\`\`
`
  )
  .join('\n')}

## Sign-off

- [ ] 1. Exact MLS number returns the same record, status and material fields as Matrix
- [ ] 2. Exact address resolves to the same record (or the limitation is documented)
- [ ] 3. Active count matches Matrix for identical criteria
- [ ] 4. Pending count matches Matrix for identical criteria
- [ ] 5. Closed count matches Matrix for identical criteria and window
- [ ] 6. Comparable candidate set is explainable and consistent with Matrix data
- [ ] 7. Market statistics inputs reconcile with Matrix (counts and underlying values)
- [ ] 8. Pagination is complete, deduplicated, and truncation is correctly disclosed
- [ ] 9. Field semantics confirmed against \`$metadata\` and Matrix (area, DOM/CDOM, concessions)
- [ ] 10. Zero writes, and AI-use gating matches the executed Addendum
- [ ] This report file destroyed (if generated with \`--include-mls-values\`)

**Certification decision:** ☐ PASS ☐ PARTIAL ☐ HOLD

**Certified by:** ______________________  **Date:** ____________
`;

writeFileSync(params.out, report);
const errors = results.filter((r) => r.outcome === 'error');
console.log(`\nWrote ${params.out}`);
console.log(`Checkpoints collected: ${results.length - errors.length}/${results.length}`);
if (errors.length > 0) {
  console.log(`Errors: ${errors.map((e) => `${e.id} (${e.evidence.error})`).join(', ')}`);
}
if (params.includeMlsValues) {
  console.log('\n*** This report contains MLS Grid Data at rest (Addendum §3.a).');
  console.log('*** Destroy it as soon as Matrix reconciliation is complete. Do not commit it.');
}
console.log(
  isLive
    ? 'Live provider. Complete the Matrix columns before claiming certification.'
    : 'FIXTURE provider — this run has no evidentiary value for production certification.'
);
