import { describe, expect, it, vi } from 'vitest';
import { AiUsePolicy, PROHIBITED_USES, validateAiUseDeclaration } from '../src/compliance/ai-use.js';
import { loadConfig } from '../src/config.js';
import { createAiUsePolicy, createService } from '../src/factory.js';
import { buildTools } from '../src/mcp/tools.js';
import { MlsGridAdapter } from '../src/provider/mlsgrid/adapter.js';
import { MlsService } from '../src/service/mls-service.js';

const BASE = 'https://api.mlsgrid.com/v2';
const LIVE_ENV = { MLS_PROVIDER: 'mlsgrid', MLSGRID_TOKEN: 'live-token-abcdef123456' };

function liveRecord(n: number): Record<string, unknown> {
  return {
    ListingKey: `K${n}`,
    ListingId: `NST${n}`,
    OriginatingSystemName: 'northstar',
    StandardStatus: 'Active',
    PropertyType: 'Residential',
    PropertySubType: 'SingleFamilyResidence',
    City: 'Woodbury',
    PostalCode: '55125',
    ListPrice: 500_000 + n,
    BedroomsTotal: 3,
    BathroomsTotalInteger: 2,
    LivingArea: 2000,
    YearBuilt: 2005,
    ModificationTimestamp: '2026-08-01T10:00:00Z'
  };
}

/** A live service wired to a counting fake fetch, so we can prove no call happens. */
function liveService(policy: AiUsePolicy, records = [liveRecord(1)]) {
  const fetchFn = vi.fn(async () =>
    new Response(JSON.stringify({ value: records }), {
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
    now: () => new Date('2026-08-30T12:00:00Z')
  });

  const service = new MlsService({
    provider,
    defaultTimezone: 'America/Chicago',
    maxRecordsPerQuery: 2500,
    maxPages: 5,
    providerRequestCap: 5000,
    aiUsePolicy: policy,
    participantName: 'Buy Sell Home Team | RE/MAX Results',
    now: () => new Date('2026-08-30T12:00:00Z')
  });
  return { service, fetchFn };
}

function policyOf(overrides: Partial<ConstructorParameters<typeof AiUsePolicy>[0]> = {}): AiUsePolicy {
  return new AiUsePolicy({
    provider: 'mlsgrid',
    aiAccessEnabled: false,
    authorizedUseBases: [],
    licenseClasses: [],
    writtenApprovalReference: undefined,
    authorizedTools: [],
    ...overrides
  });
}

const FULLY_OPEN = policyOf({
  aiAccessEnabled: true,
  authorizedUseBases: ['permitted_marketing_use'],
  licenseClasses: ['back_office'],
  authorizedTools: [
    'get_listing',
    'search_listings',
    'get_listing_history',
    'get_comparables',
    'market_stats',
    'get_market_snapshot',
    'lookup_member_or_office',
    'get_open_houses'
  ]
});

describe('kill switch (Addendum §3.c)', () => {
  it('defaults OFF for the live provider', () => {
    const config = loadConfig(LIVE_ENV);
    expect(config.aiUse.accessEnabled).toBe(false);
    expect(createAiUsePolicy(config).liveAccessPermitted).toBe(false);
  });

  it('withholds every MLS tool while switched off', () => {
    const { service } = liveService(policyOf());
    const names = buildTools(service).map((t) => t.name);
    // Only the discovery tool remains, so a client can learn why.
    expect(names).toEqual(['get_capabilities']);
  });

  it('makes no MLS Grid request while switched off', async () => {
    const { service, fetchFn } = liveService(policyOf());
    await expect(service.searchListings({ cities: ['Woodbury'], limit: 10 })).rejects.toMatchObject({
      code: 'UNSUPPORTED_CAPABILITY'
    });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('explains the denial without leaking configuration', async () => {
    const { service } = liveService(policyOf());
    const err = await service.getListing({ listing_id: 'NST1' }).catch((e) => e);
    expect(err.details.ai_use_denial).toBe('AI_ACCESS_DISABLED');
    expect(err.message).toMatch(/switched OFF/);
    expect(err.message).toMatch(/§3\.c/);
  });

  it('still blocks when switched on but no basis is declared', async () => {
    const { service, fetchFn } = liveService(policyOf({ aiAccessEnabled: true }));
    const err = await service.searchListings({ limit: 10 }).catch((e) => e);
    expect(err.details.ai_use_denial).toBe('NO_AUTHORIZED_USE_BASIS');
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('permits access only once switch, basis and tool are all configured', async () => {
    const { service, fetchFn } = liveService(FULLY_OPEN);
    const result = await service.searchListings({ cities: ['Woodbury'], limit: 10 });
    expect(result.listings).toHaveLength(1);
    expect(fetchFn).toHaveBeenCalled();
  });

  it('leaves the fixture provider ungated, since synthetic data is not MLS Grid Data', () => {
    const service = createService(loadConfig({ MLS_PROVIDER: 'fixture' }));
    expect(buildTools(service)).toHaveLength(9);
    expect(service.aiUsePolicy.governsLicensedData).toBe(false);
  });
});

describe('per-tool capability gating', () => {
  it('registers only the explicitly authorized tools', () => {
    const { service } = liveService(
      policyOf({
        aiAccessEnabled: true,
        authorizedUseBases: ['permitted_marketing_use'],
        licenseClasses: ['back_office'],
        authorizedTools: ['get_listing', 'search_listings']
      })
    );
    expect(buildTools(service).map((t) => t.name).sort()).toEqual([
      'get_capabilities',
      'get_listing',
      'search_listings'
    ]);
  });

  it('blocks an unauthorized tool at the service layer too, not just in the inventory', async () => {
    const { service, fetchFn } = liveService(
      policyOf({
        aiAccessEnabled: true,
        authorizedUseBases: ['permitted_marketing_use'],
        licenseClasses: ['back_office'],
        authorizedTools: ['get_listing']
      })
    );
    const err = await service.marketStats({ query: { cities: ['Woodbury'] } }).catch((e) => e);
    expect(err.details.ai_use_denial).toBe('TOOL_NOT_AUTHORIZED');
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('does not require authorizing a composed tool separately', async () => {
    // get_comparables composes an internal listing lookup; authorizing the
    // comparable tool must not additionally require authorizing get_listing.
    const { service } = liveService(
      policyOf({
        aiAccessEnabled: true,
        authorizedUseBases: ['permitted_marketing_use'],
        licenseClasses: ['back_office'],
        authorizedTools: ['get_comparables']
      }),
      [liveRecord(1), liveRecord(2)]
    );
    await expect(service.getComparables({ subject_listing_id: 'NST1' })).resolves.toBeTruthy();
  });

  it('never infers permission from an empty allowlist', () => {
    const policy = policyOf({
      aiAccessEnabled: true,
      authorizedUseBases: ['permitted_marketing_use'],
      licenseClasses: ['back_office']
    });
    expect(policy.filterTools(['get_listing', 'market_stats'])).toEqual([]);
  });
});

describe('Authorized AI Use declaration (§1.e, §1.i)', () => {
  it('rejects Back Office as an AI-use basis', () => {
    const r = validateAiUseDeclaration(['back_office'], ['back_office'], undefined);
    expect(r.error).toMatch(/Unrecognized AI-use basis/);
    expect(r.error).toMatch(/Back Office data license is not an AI-use basis/);
  });

  it('refuses Permitted Search/Response Use without an IDX or VOW license', () => {
    const r = validateAiUseDeclaration(['permitted_search_response_use'], ['back_office'], undefined);
    expect(r.error).toMatch(/requires an IDX or VOW license class/);
    expect(r.error).toMatch(/§1\.i/);
  });

  it('accepts Permitted Search/Response Use with an IDX or VOW license', () => {
    expect(validateAiUseDeclaration(['permitted_search_response_use'], ['idx'], undefined).error).toBeNull();
    expect(validateAiUseDeclaration(['permitted_search_response_use'], ['vow'], undefined).error).toBeNull();
  });

  it('accepts Permitted Marketing Use under a Back Office license', () => {
    // §1.h is not tied to IDX/VOW, so this combination is declarable.
    expect(validateAiUseDeclaration(['permitted_marketing_use'], ['back_office'], undefined).error).toBeNull();
  });

  it('requires a reference when relying on written authorization', () => {
    expect(validateAiUseDeclaration(['written_authorization'], [], undefined).error).toMatch(
      /requires MLS_AI_WRITTEN_APPROVAL_REFERENCE/
    );
    expect(validateAiUseDeclaration(['written_authorization'], [], 'MLSGRID-2026-001').error).toBeNull();
  });

  it('rejects an unknown license class', () => {
    expect(validateAiUseDeclaration([], ['syndication'], undefined).error).toMatch(/Unrecognized license class/);
  });

  it('fails startup on an invalid declaration rather than silently ignoring it', () => {
    expect(() =>
      loadConfig({ ...LIVE_ENV, MLS_AI_AUTHORIZED_USE_BASES: 'permitted_search_response_use', MLS_AI_LICENSE_CLASSES: 'back_office' })
    ).toThrow(/IDX or VOW/);
    expect(() => loadConfig({ ...LIVE_ENV, MLS_AI_AUTHORIZED_USE_BASES: 'back_office' })).toThrow(
      /Unrecognized AI-use basis/
    );
  });

  it('parses a complete declaration from the environment', () => {
    const config = loadConfig({
      ...LIVE_ENV,
      MLS_AI_ACCESS_ENABLED: 'true',
      MLS_AI_AUTHORIZED_USE_BASES: 'permitted_marketing_use',
      MLS_AI_LICENSE_CLASSES: 'back_office',
      MLS_AI_AUTHORIZED_TOOLS: 'get_listing, search_listings'
    });
    expect(config.aiUse.accessEnabled).toBe(true);
    expect(config.aiUse.authorizedUseBases).toEqual(['permitted_marketing_use']);
    expect(config.aiUse.authorizedTools).toEqual(['get_listing', 'search_listings']);
  });
});

describe('attribution (§3.d)', () => {
  it('attaches attribution naming Participant, MLS and distributor to every MLS-derived result', async () => {
    const { service } = liveService(FULLY_OPEN, [liveRecord(1), liveRecord(2)]);
    const results: Array<Record<string, any>> = [
      await service.getListing({ listing_id: 'NST1' }),
      await service.searchListings({ cities: ['Woodbury'], limit: 10 }),
      (await service.getListingHistory('NST1')) as Record<string, any>,
      await service.getComparables({ subject_listing_id: 'NST1' }),
      await service.marketStats({ query: { cities: ['Woodbury'], limit: 10 } }),
      (await service.marketSnapshot({ cities: ['Woodbury'] })) as Record<string, any>,
      await service.getMember('502777'),
      await service.getOffice('RMXR01'),
      await service.getOpenHouses({})
    ];
    for (const result of results) {
      expect(result.attribution, JSON.stringify(Object.keys(result))).toBeDefined();
      expect(result.attribution.content_class).toBe('mls_grid');
      expect(result.attribution.originating_mls).toBe('northstar');
      expect(result.attribution.distributor).toBe('MLS GRID');
      expect(result.attribution.participant).toBe('Buy Sell Home Team | RE/MAX Results');
      expect(result.attribution.handling.join(' ')).toMatch(/§3\.a/);
    }
  });

  it('marks fixture output as synthetic rather than MLS content', async () => {
    const service = createService(loadConfig({ MLS_PROVIDER: 'fixture' }));
    const result = await service.getListing({ listing_id: 'NST6400001' });
    expect(result.attribution.content_class).toBe('synthetic');
    expect(result.attribution.notice).toMatch(/SYNTHETIC FIXTURE DATA/);
    expect(result.attribution.distributor).toBeNull();
  });
});

describe('zero write surface under a live policy', () => {
  it('exposes no write-shaped tool even when every tool is authorized', () => {
    const { service } = liveService(FULLY_OPEN);
    const writeVerb =
      /^(create|add|update|edit|modify|delete|remove|set|post|put|patch|submit|send|write|upload|change|cancel|close|assign)_/;
    const tools = buildTools(service);
    expect(tools).toHaveLength(9);
    for (const tool of tools) {
      expect(tool.name).not.toMatch(writeVerb);
    }
  });

  it('issues only GET requests to MLS Grid', async () => {
    const { service, fetchFn } = liveService(FULLY_OPEN);
    await service.searchListings({ cities: ['Woodbury'], limit: 10 });
    const calls = (fetchFn as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    for (const [, init] of calls) {
      expect(init.method).toBe('GET');
    }
  });
});

describe('policy disclosure', () => {
  it('reports the full posture including prohibitions', () => {
    const description = FULLY_OPEN.describe();
    expect(description.ai_access_enabled).toBe(true);
    expect(description.governs_mls_grid_data).toBe(true);
    expect(description.prohibited_uses).toEqual(PROHIBITED_USES);
    expect(String(description.retention)).toMatch(/§3\.a/);
    expect(JSON.stringify(description.basis_notes)).toMatch(/Back Office license does not carry it/);
  });

  it('surfaces the denial reason through get_capabilities while gated', async () => {
    const { service } = liveService(policyOf());
    const tools = buildTools(service);
    const caps = (await tools[0]!.handler({})) as Record<string, any>;
    expect(caps.ai_use.ai_access_enabled).toBe(false);
    expect(caps.ai_use.live_access_permitted).toBe(false);
  });
});
