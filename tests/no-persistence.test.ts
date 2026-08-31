import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { AiUsePolicy } from '../src/compliance/ai-use.js';
import { createLogger } from '../src/logging.js';
import { MlsGridAdapter } from '../src/provider/mlsgrid/adapter.js';
import { MlsService } from '../src/service/mls-service.js';

/**
 * Structural proof of Addendum §3.a (no caching, storing, archiving or
 * retention beyond an individual query) and §1.d (no embeddings, retrieval
 * indices, knowledge graphs, training data, or any representation persisting
 * beyond a single session).
 */

const BASE = 'https://api.mlsgrid.com/v2';

const OPEN_POLICY = new AiUsePolicy({
  provider: 'mlsgrid',
  aiAccessEnabled: true,
  dataLicenseUses: ['comparative_market_analysis'],
  aiAuthorizationBases: ['permitted_marketing'],
  writtenApprovalReference: undefined,
  authorizedTools: []
});

function record(n: number, price: number): Record<string, unknown> {
  return {
    ListingKey: `K${n}`,
    ListingId: `NST${n}`,
    OriginatingSystemName: 'northstar',
    StandardStatus: 'Active',
    PropertyType: 'Residential',
    City: 'Woodbury',
    ListPrice: price,
    ModificationTimestamp: '2026-08-01T10:00:00Z'
  };
}

function serviceWith(responses: Array<Record<string, unknown>[]>) {
  let call = 0;
  const fetchFn = vi.fn(async () => {
    const body = responses[Math.min(call, responses.length - 1)];
    call += 1;
    return new Response(JSON.stringify({ value: body }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  }) as unknown as typeof fetch;

  const provider = new MlsGridAdapter({
    apiBase: BASE,
    token: 'live-token-abcdef123456',
    originatingSystem: 'northstar',
    fetchFn,
    minRequestIntervalMs: 0,
    sleepFn: async () => undefined
  });
  const service = new MlsService({
    provider,
    defaultTimezone: 'America/Chicago',
    maxRecordsPerQuery: 2500,
    maxPages: 5,
    providerRequestCap: 5000,
    aiUsePolicy: OPEN_POLICY
  });
  return { service, fetchFn, provider };
}

describe('no response caching (§3.a)', () => {
  it('re-fetches on an identical repeated query rather than serving a cached copy', async () => {
    const { service, fetchFn } = serviceWith([[record(1, 500_000)], [record(1, 625_000)]]);
    const first = await service.searchListings({ cities: ['Woodbury'], limit: 10 });
    const second = await service.searchListings({ cities: ['Woodbury'], limit: 10 });

    expect(fetchFn).toHaveBeenCalledTimes(2);
    // A cache would have replayed the first price; the live value must win.
    expect(first.listings[0]!.list_price).toBe(500_000);
    expect(second.listings[0]!.list_price).toBe(625_000);
  });

  it('re-fetches an identical exact lookup', async () => {
    const { service, fetchFn } = serviceWith([[record(1, 500_000)], [record(1, 700_000)]]);
    const a = await service.getListing({ listing_id: 'NST1' });
    const b = await service.getListing({ listing_id: 'NST1' });
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(a.listing!.list_price).toBe(500_000);
    expect(b.listing!.list_price).toBe(700_000);
  });

  it('sends no-store on every outbound MLS Grid request', async () => {
    const { service, fetchFn } = serviceWith([[record(1, 500_000)]]);
    await service.searchListings({ cities: ['Woodbury'], limit: 10 });
    const calls = (fetchFn as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls;
    for (const [, init] of calls) {
      expect((init.headers as Record<string, string>)['Cache-Control']).toBe('no-store');
    }
  });

  it('retains no MLS records on the adapter or service after a request completes', async () => {
    const { service, provider } = serviceWith([[record(1, 500_000), record(2, 600_000)]]);
    await service.searchListings({ cities: ['Woodbury'], limit: 10 });

    // Walk every own property of both objects looking for retained listing data.
    const serialized = JSON.stringify(
      [provider, service],
      (_k, v) => (typeof v === 'function' ? undefined : v)
    );
    expect(serialized).not.toContain('NST1');
    expect(serialized).not.toContain('Woodbury');
    expect(serialized).not.toContain('500000');
  });
});

describe('no persistent stores in the server runtime (§1.d)', () => {
  const runtimeSources = [
    'src/config.ts',
    'src/errors.ts',
    'src/factory.ts',
    'src/http.ts',
    'src/index.ts',
    'src/logging.ts',
    'src/stdio.ts',
    'src/version.ts',
    'src/compliance/ai-use.ts',
    'src/compliance/attribution.ts',
    'src/mcp/server.ts',
    'src/mcp/tools.ts',
    'src/models/meta.ts',
    'src/models/normalized.ts',
    'src/provider/mlsgrid/adapter.ts',
    'src/provider/mlsgrid/http.ts',
    'src/provider/mlsgrid/mapping.ts',
    'src/provider/mlsgrid/odata.ts',
    'src/provider/predicates.ts',
    'src/provider/types.ts',
    'src/service/comps.ts',
    'src/service/meta.ts',
    'src/service/mls-service.ts',
    'src/service/stats.ts'
  ];

  it('writes nothing to disk from any runtime module', () => {
    // Matches actual write calls, not the words used in prohibition text.
    const fsWrite = /\b(writeFile|writeFileSync|appendFile|appendFileSync|createWriteStream|mkdirSync|openSync)\s*\(/;
    for (const file of runtimeSources) {
      expect(fsWrite.test(readFileSync(file, 'utf8')), `${file} must not write to disk`).toBe(false);
    }
  });

  it('imports no database, vector store, or embedding client', () => {
    const forbiddenImport =
      /from\s+['"](pg|mysql|mysql2|sqlite3|better-sqlite3|mongodb|mongoose|redis|ioredis|level|lowdb|typeorm|prisma|knex|sequelize|@pinecone-database\/\S*|chromadb|weaviate\S*|faiss\S*|@qdrant\/\S*|langchain\S*|llamaindex|@xenova\/transformers|openai|@anthropic-ai\/\S*)['"]/;
    for (const file of runtimeSources) {
      const content = readFileSync(file, 'utf8');
      expect(forbiddenImport.test(content), `${file} must not import a persistence or embedding client`).toBe(false);
    }
  });

  it('declares no such package as a runtime dependency', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as {
      dependencies: Record<string, string>;
    };
    const forbidden = [
      'pg', 'mysql', 'mysql2', 'sqlite3', 'better-sqlite3', 'mongodb', 'mongoose', 'redis', 'ioredis',
      'level', 'lowdb', 'typeorm', 'prisma', 'knex', 'sequelize', 'chromadb', 'llamaindex', 'openai'
    ];
    const declared = Object.keys(pkg.dependencies ?? {});
    for (const name of forbidden) {
      expect(declared, `${name} must not be a runtime dependency`).not.toContain(name);
    }
    for (const name of declared) {
      expect(name, `${name} looks like a vector/embedding dependency`).not.toMatch(
        /pinecone|weaviate|qdrant|faiss|langchain|embedding|vector/i
      );
    }
  });

  it('uses no browser or assistant-side persistence API', () => {
    const forbidden = /\b(localStorage|sessionStorage|indexedDB)\b/;
    for (const file of runtimeSources) {
      expect(forbidden.test(readFileSync(file, 'utf8')), `${file} must not use client-side storage`).toBe(false);
    }
  });
});

describe('logs and errors never persist MLS payloads or credentials (§3.a)', () => {
  it('logs no MLS field values when a tool call fails', async () => {
    const lines: string[] = [];
    const logger = createLogger({ level: 'debug', write: (l) => lines.push(l) });
    const fetchFn = vi.fn(async () =>
      new Response(JSON.stringify({ value: [record(1, 500_000)] }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    ) as unknown as typeof fetch;
    const provider = new MlsGridAdapter({
      apiBase: BASE,
      token: 'live-token-abcdef123456',
      originatingSystem: 'northstar',
      fetchFn,
      minRequestIntervalMs: 0,
      sleepFn: async () => undefined,
      logger
    });
    const service = new MlsService({
      provider,
      defaultTimezone: 'America/Chicago',
      maxRecordsPerQuery: 2500,
      maxPages: 5,
      providerRequestCap: 5000,
      aiUsePolicy: OPEN_POLICY
    });

    await service.searchListings({ cities: ['Woodbury'], limit: 10 });
    const joined = lines.join('\n');
    expect(joined).not.toContain('NST1');
    expect(joined).not.toContain('500000');
    expect(joined).not.toContain('live-token-abcdef123456');
  });

  it('keeps MLS payloads out of upstream error messages', async () => {
    const fetchFn = vi.fn(async () =>
      new Response(JSON.stringify({ error: 'denied', ListingId: 'NST-SECRET', ListPrice: 999999 }), {
        status: 403,
        headers: { 'content-type': 'application/json' }
      })
    ) as unknown as typeof fetch;
    const provider = new MlsGridAdapter({
      apiBase: BASE,
      token: 'live-token-abcdef123456',
      originatingSystem: 'northstar',
      fetchFn,
      minRequestIntervalMs: 0,
      sleepFn: async () => undefined
    });
    const service = new MlsService({
      provider,
      defaultTimezone: 'America/Chicago',
      maxRecordsPerQuery: 2500,
      maxPages: 5,
      providerRequestCap: 5000,
      aiUsePolicy: OPEN_POLICY
    });

    const err = await service.searchListings({ limit: 10 }).catch((e) => e);
    const serialized = JSON.stringify(err.toJSON());
    expect(serialized).not.toContain('NST-SECRET');
    expect(serialized).not.toContain('999999');
    expect(serialized).not.toContain('live-token-abcdef123456');
  });

  it('creates no file-backed log transport', () => {
    const logging = readFileSync('src/logging.ts', 'utf8');
    expect(logging).not.toMatch(/createWriteStream|writeFileSync|appendFile/);
    // stderr only, or an injected sink for tests.
    expect(logging).toMatch(/process\.stderr\.write/);
  });
});
