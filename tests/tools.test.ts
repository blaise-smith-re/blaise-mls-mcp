import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createLogger } from '../src/logging.js';
import { MAX_RESPONSE_BYTES, runTool } from '../src/mcp/server.js';
import type { ToolDefinition } from '../src/mcp/tools.js';
import { buildTools } from '../src/mcp/tools.js';
import { FixtureAdapter } from '../src/provider/fixture/adapter.js';
import { MlsService } from '../src/service/mls-service.js';

function makeService() {
  return new MlsService({
    provider: new FixtureAdapter(),
    defaultTimezone: 'America/Chicago',
    maxRecordsPerQuery: 2500,
    maxPages: 10,
    providerRequestCap: null,
    now: () => new Date('2026-08-30T12:00:00Z')
  });
}

const tools = buildTools(makeService());
const byName = (name: string): ToolDefinition => {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
};

describe('tool inventory', () => {
  it('exposes exactly the intended read-only inventory', () => {
    expect(tools.map((t) => t.name).sort()).toEqual([
      'get_capabilities',
      'get_comparables',
      'get_listing',
      'get_listing_history',
      'get_market_snapshot',
      'get_open_houses',
      'lookup_member_or_office',
      'market_stats',
      'search_listings'
    ]);
  });

  it('has zero write surfaces', () => {
    const writeVerb = /^(create|add|update|edit|modify|delete|remove|set|post|put|patch|submit|send|write|upload|change|cancel|close|assign)_/;
    for (const tool of tools) {
      expect(tool.name, `${tool.name} looks like a write tool`).not.toMatch(writeVerb);
    }
  });

  it('exposes no raw query, URL, or passthrough parameter on any tool', () => {
    const forbidden = /(^|_)(url|uri|endpoint|filter_raw|raw_filter|odata|query_string|sql|body|headers|token)$/i;
    for (const tool of tools) {
      for (const key of Object.keys(tool.inputSchema)) {
        expect(key, `${tool.name}.${key} would be a passthrough surface`).not.toMatch(forbidden);
      }
    }
  });

  it('gives every tool a title and a substantive description', () => {
    for (const tool of tools) {
      expect(tool.title.length).toBeGreaterThan(0);
      expect(tool.description.length).toBeGreaterThan(80);
    }
  });

  it('validates that filter schemas reject malformed dates', () => {
    const schema = z.object(byName('search_listings').inputSchema);
    expect(schema.safeParse({ closed_from: '2026-06-01' }).success).toBe(true);
    expect(schema.safeParse({ closed_from: '06/01/2026' }).success).toBe(false);
    expect(schema.safeParse({ closed_from: "2026-06-01' or 1 eq 1" }).success).toBe(false);
  });

  it('rejects an unbounded status list and negative prices', () => {
    const schema = z.object(byName('search_listings').inputSchema);
    expect(schema.safeParse({ statuses: [] }).success).toBe(false);
    expect(schema.safeParse({ min_price: -1 }).success).toBe(false);
    expect(schema.safeParse({ statuses: ['NotAStatus'] }).success).toBe(false);
  });
});

describe('tool execution', () => {
  it('returns capabilities including the history limitation', async () => {
    const outcome = await runTool(byName('get_capabilities'), {});
    expect(outcome.isError).toBeUndefined();
    const body = JSON.parse(outcome.content[0]!.text);
    expect(body.provider).toBe('fixture');
    expect(body.listing_history_events).toBe('unsupported');
  });

  it('retrieves a listing by MLS number', async () => {
    const outcome = await runTool(byName('get_listing'), { listing_id: 'NST6400001' });
    const body = JSON.parse(outcome.content[0]!.text);
    expect(body.found).toBe(true);
    expect(body.listing.listing_key).toBe('FX6400001');
  });

  it('searches with completeness metadata attached', async () => {
    const outcome = await runTool(byName('search_listings'), { cities: ['Woodbury'], statuses: ['Active'], limit: 100 });
    const body = JSON.parse(outcome.content[0]!.text);
    expect(body._completeness.completeness_status).toBe('complete');
    expect(body.listings.length).toBe(27);
  });

  it('produces market stats with methodology', async () => {
    const outcome = await runTool(byName('market_stats'), {
      cities: ['Woodbury'],
      statuses: ['Closed'],
      closed_from: '2026-06-01',
      closed_to: '2026-08-30',
      limit: 500
    });
    const body = JSON.parse(outcome.content[0]!.text);
    expect(body.methodology.null_handling).toMatch(/never imputed/);
    expect(body.cohorts[0].metrics.median_sale_price.definition).toBeTruthy();
  });

  it('produces comparables without a valuation conclusion', async () => {
    const outcome = await runTool(byName('get_comparables'), { subject_listing_id: 'NST6400009' });
    const body = JSON.parse(outcome.content[0]!.text);
    expect(body.comparables.judgment_boundary).toMatch(/not an adjusted value/);
    expect(body.comparables).not.toHaveProperty('suggested_price');
  });

  it('looks up a member and an office through one tool', async () => {
    const member = JSON.parse((await runTool(byName('lookup_member_or_office'), { type: 'member', id: '502777' })).content[0]!.text);
    expect(member.found).toBe(true);
    const office = JSON.parse((await runTool(byName('lookup_member_or_office'), { type: 'office', id: 'RMXR01' })).content[0]!.text);
    expect(office.found).toBe(true);
  });
});

describe('tool error mapping', () => {
  it('returns a structured error rather than throwing', async () => {
    const outcome = await runTool(byName('get_listing'), {});
    expect(outcome.isError).toBe(true);
    const body = JSON.parse(outcome.content[0]!.text);
    expect(body.error).toBe('VALIDATION');
    expect(body.message).toMatch(/Provide either listing_id/);
  });

  it('maps a missing subject to NOT_FOUND', async () => {
    const outcome = await runTool(byName('get_comparables'), { subject_listing_id: 'NST0000000' });
    const body = JSON.parse(outcome.content[0]!.text);
    expect(body.error).toBe('NOT_FOUND');
  });

  it('logs only the tool name and error code, never arguments or MLS content', async () => {
    const lines: string[] = [];
    const logger = createLogger({ level: 'debug', write: (l) => lines.push(l) });
    await runTool(byName('get_listing'), { address: '123 Confidential Way' }, logger);
    // The lookup succeeds-with-no-match, so nothing is logged; force an error path.
    await runTool(byName('get_listing'), { listing_id: 'x', address: '123 Confidential Way' }, logger);
    const joined = lines.join('\n');
    expect(joined).toContain('get_listing');
    expect(joined).not.toContain('123 Confidential Way');
  });

  it('refuses to emit a response beyond the size bound', async () => {
    const huge: ToolDefinition = {
      name: 'test_huge',
      title: 'test',
      description: 'test',
      inputSchema: {},
      handler: async () => ({ blob: 'x'.repeat(MAX_RESPONSE_BYTES + 100) })
    };
    const outcome = await runTool(huge, {});
    expect(outcome.isError).toBe(true);
    const body = JSON.parse(outcome.content[0]!.text);
    expect(body.error).toBe('VALIDATION');
    expect(body.message).toMatch(/Narrow the query/);
  });
});

describe('deterministic output', () => {
  it('returns byte-identical results for identical calls', async () => {
    const args = { cities: ['Woodbury'], statuses: ['Closed'], limit: 50 };
    const a = await runTool(byName('search_listings'), args);
    const b = await runTool(byName('search_listings'), args);
    expect(a.content[0]!.text).toBe(b.content[0]!.text);
  });
});
