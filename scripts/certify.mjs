#!/usr/bin/env node
/**
 * Live certification harness.
 *
 * Runs the ten certification checkpoints against the configured provider and
 * writes a Markdown report with the MCP-side values filled in and the Matrix
 * columns left BLANK for a human to complete.
 *
 * This script cannot certify anything by itself. It gathers evidence; a person
 * reconciles that evidence against the certified Northstar/Matrix browser lane.
 * A successful API response is not certification.
 *
 * Usage:
 *   npm run build
 *   node scripts/certify.mjs --mls-number NST6400001 --address "..." --city Woodbury \
 *                            --subject NST6400009 [--out report.md]
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

const params = {
  mlsNumber: arg('mls-number'),
  address: arg('address'),
  city: arg('city', 'Woodbury'),
  subject: arg('subject'),
  out: arg('out', 'certification-report.md')
};

if (!params.mlsNumber || !params.subject) {
  console.error('Required: --mls-number <id> --subject <id>. Optional: --address, --city, --out');
  process.exit(2);
}

const config = loadConfig();
const service = createService(config);
const results = [];

async function step(id, name, fn) {
  process.stderr.write(`[${id}] ${name}\n`);
  try {
    const evidence = await fn();
    results.push({ id, name, outcome: 'collected', evidence });
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
    listing_key: r.listing?.listing_key ?? null,
    listing_id: r.listing?.listing_id ?? null,
    standard_status: r.listing?.standard_status ?? null,
    list_price: r.listing?.list_price ?? null,
    close_price: r.listing?.close_price ?? null,
    living_area_sqft: r.listing?.living_area_sqft ?? null,
    bedrooms_total: r.listing?.bedrooms_total ?? null,
    bathrooms_total: r.listing?.bathrooms_total ?? null,
    year_built: r.listing?.year_built ?? null,
    days_on_market: r.listing?.days_on_market ?? null,
    close_date: r.listing?.close_date ?? null,
    address: r.listing?.address.unparsed ?? null
  };
});

await step(2, 'Exact address lookup', async () => {
  if (!params.address) return { skipped: 'no --address supplied' };
  const r = await service.getListing({ address: params.address });
  return { found: r.found, matches: r.lookup.matches, listing_id: r.listing?.listing_id ?? null, notes: r.notes };
});

const boundedSearch = (statuses, extra = {}) => async () => {
  const r = await service.searchListings({ cities: [params.city], statuses, limit: 1000, ...extra });
  return {
    returned_count: r._completeness.returned_count,
    completeness_status: r._completeness.completeness_status,
    capped: r._completeness.capped,
    pages_fetched: r._completeness.pages_fetched,
    server_side_filters: r._completeness.filters_applied.server_side,
    client_side_filters: r._completeness.filters_applied.client_side,
    sample_listing_ids: r.listings.slice(0, 10).map((l) => l.listing_id)
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
    subject: r.comparables.subject,
    tolerances: r.comparables.tolerances,
    candidates_evaluated: r.comparables.candidates_evaluated,
    included: r.comparables.included.map((c) => ({
      listing_id: c.listing_id,
      close_price: c.close_price,
      close_date: c.close_date,
      living_area_sqft: c.living_area_sqft,
      similarity_distance: c.similarity_distance
    })),
    rejected_count: r.comparables.rejected.length,
    rejection_reasons_sample: r.comparables.rejected.slice(0, 5).map((c) => ({
      listing_id: c.listing_id,
      reasons: c.rejection_reasons
    })),
    retrieval_query: r.retrieval.query,
    retrieval_completeness: r.retrieval._completeness.completeness_status
  };
});

await step(7, `Market statistics (${params.city})`, async () => {
  const r = await service.marketStats({
    query: { cities: [params.city], statuses: ['Closed'], closed_from: windowStart, closed_to: windowEnd, limit: 1000 },
    include_prior_period: true
  });
  const closed = r.cohorts.find((c) => c.cohort === 'closed');
  return {
    query_definition: r.query_definition,
    record_counts: r.record_counts,
    closed_metrics: closed
      ? Object.fromEntries(
          Object.entries(closed.metrics).map(([k, v]) => [k, { value: v.value, sample_size: v.sample_size, excluded: v.excluded_missing_input }])
        )
      : null,
    price_bands: closed?.price_bands ?? null,
    prior_period_window: r.prior_period?.window ?? null,
    completeness_status: r._completeness.completeness_status,
    limitations: r.limitations
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

await step(9, 'Field semantics', async () => {
  const r = await service.getListing({ listing_id: params.mlsNumber });
  const l = r.listing;
  const history = await service.getListingHistory(params.mlsNumber);
  return {
    capabilities: service.capabilities(),
    null_fields: l ? Object.entries(l).filter(([, v]) => v === null).map(([k]) => k) : [],
    history_capability: history.capability,
    provenance: l?.source ?? null
  };
});

await step(10, 'Zero write surfaces', async () => {
  const tools = buildTools(service);
  const writeVerb = /^(create|add|update|edit|modify|delete|remove|set|post|put|patch|submit|send|write|upload|change|cancel|close|assign)_/;
  return {
    tool_count: tools.length,
    tool_names: tools.map((t) => t.name),
    write_shaped_tools: tools.map((t) => t.name).filter((n) => writeVerb.test(n)),
    zero_write_surfaces: tools.every((t) => !writeVerb.test(t.name))
  };
});

const caps = service.capabilities();
const isLive = config.provider === 'mlsgrid';

const report = `# MLS MCP live certification report

**Generated:** ${asOf}
**Server version:** ${SERVER_VERSION}
**Build status:** ${BUILD_STATUS}
**Provider:** \`${config.provider}\`${isLive ? '' : ' — **FIXTURE DATA. This run cannot certify anything.**'}
**Originating system:** \`${caps.originating_system}\`

> This report contains the MCP side only. Every Matrix column below is intentionally BLANK and must
> be filled in by a human from the certified Northstar/Matrix browser lane. A checkpoint is PASS only
> when the MCP value and the Matrix value are reconciled and match, or the difference is explained
> and accepted. **A successful API response is not certification.**

${
  isLive
    ? ''
    : '## ⚠ Fixture run\n\nThis run used synthetic fixture data. It exercises the certification path end to end but has NO evidentiary value for production certification. Re-run with `MLS_PROVIDER=mlsgrid` and a licensed token.\n'
}
## Checkpoint results

| # | Checkpoint | Collected | Matrix value | Reconciled | Notes |
|---|---|---|---|---|---|
${results
  .map((r) => `| ${r.id} | ${r.name} | ${r.outcome === 'error' ? '**ERROR**' : 'yes'} | | ☐ | |`)
  .join('\n')}

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

A checkpoint passes only when its Matrix counterpart is recorded and reconciled above.

- [ ] 1. Exact MLS number returns the same record, status and material fields as Matrix
- [ ] 2. Exact address resolves to the same record (or the limitation is documented)
- [ ] 3. Active count matches Matrix for identical criteria
- [ ] 4. Pending count matches Matrix for identical criteria
- [ ] 5. Closed count matches Matrix for identical criteria and window
- [ ] 6. Comparable candidate set is explainable and consistent with Matrix data
- [ ] 7. Market statistics inputs reconcile with Matrix (counts and underlying values)
- [ ] 8. Pagination is complete, deduplicated, and truncation is correctly disclosed
- [ ] 9. Field semantics confirmed against \`$metadata\` and Matrix (area, DOM/CDOM, concessions)
- [ ] 10. Zero writes — confirmed by tool inventory and by no MLS-side change during this run

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
console.log(
  isLive
    ? 'Live provider. Complete the Matrix columns before claiming certification.'
    : 'FIXTURE provider — this run has no evidentiary value for production certification.'
);
