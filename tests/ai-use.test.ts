import { describe, expect, it, vi } from 'vitest';
import { AiUsePolicy, PROHIBITED_USES, validateAiUseDeclaration } from '../src/compliance/ai-use.js';
import {
  PRESERVED_BUSINESS_CAPABILITIES,
  TOOL_REQUIREMENTS
} from '../src/compliance/tool-requirements.js';
import { loadConfig } from '../src/config.js';
import { createAiUsePolicy, createService } from '../src/factory.js';
import { buildTools } from '../src/mcp/tools.js';
import { MlsGridAdapter } from '../src/provider/mlsgrid/adapter.js';
import { MlsService } from '../src/service/mls-service.js';

const BASE = 'https://api.mlsgrid.com/v2';
// secret-scan:allow — fake token; the live provider requires one to construct.
const LIVE_ENV = { MLS_PROVIDER: 'mlsgrid', MLSGRID_TOKEN: 'live-token-abcdef123456' };

const ALL_TOOL_NAMES = [
  'get_capabilities',
  'get_listing',
  'search_listings',
  'get_listing_history',
  'get_comparables',
  'market_stats',
  'get_market_snapshot',
  'lookup_member_or_office',
  'get_open_houses'
];

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

function policyOf(overrides: Partial<ConstructorParameters<typeof AiUsePolicy>[0]> = {}): AiUsePolicy {
  return new AiUsePolicy({
    provider: 'mlsgrid',
    aiAccessEnabled: false,
    dataLicenseUses: [],
    aiAuthorizationBases: [],
    writtenApprovalReference: undefined,
    authorizedTools: [],
    ...overrides
  });
}

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
    now: () => new Date('2026-08-31T12:00:00Z')
  });

  const service = new MlsService({
    provider,
    defaultTimezone: 'America/Chicago',
    maxRecordsPerQuery: 2500,
    maxPages: 5,
    providerRequestCap: 5000,
    aiUsePolicy: policy,
    participantName: 'Buy Sell Home Team | RE/MAX Results',
    now: () => new Date('2026-08-31T12:00:00Z')
  });
  return { service, fetchFn };
}

/** A CMA + market-analytics licence under Permitted Marketing Use. */
const CMA_MARKETING = policyOf({
  aiAccessEnabled: true,
  dataLicenseUses: ['comparative_market_analysis', 'real_estate_market_analytics'],
  aiAuthorizationBases: ['permitted_marketing']
});

/** A full IDX licence under Permitted Search/Response Use. */
const IDX_SEARCH = policyOf({
  aiAccessEnabled: true,
  dataLicenseUses: ['idx'],
  aiAuthorizationBases: ['permitted_search_response']
});

describe('capability preservation', () => {
  it('keeps all nine tools implemented regardless of authorization', () => {
    expect(TOOL_REQUIREMENTS.map((t) => t.name).sort()).toEqual([...ALL_TOOL_NAMES].sort());
  });

  it('covers every preserved business capability across the tool matrix', () => {
    const covered = new Set(TOOL_REQUIREMENTS.flatMap((t) => t.business_uses));
    for (const capability of PRESERVED_BUSINESS_CAPABILITIES) {
      expect(covered, `${capability} must remain supported by some tool`).toContain(capability);
    }
  });

  it('reports every tool in the register even when withheld, with a reason', () => {
    const register = policyOf().register();
    expect(register.map((e) => e.tool).sort()).toEqual([...ALL_TOOL_NAMES].sort());
    for (const entry of register.filter((e) => e.tool !== 'get_capabilities')) {
      expect(entry.authorization_state).toBe('withheld');
      expect(entry.withheld_reason).toBeTruthy();
      // A withheld capability is unauthorized, not absent.
      expect(entry.technical_capability.length).toBeGreaterThan(10);
      expect(entry.data_use_requirement.any_of.length).toBeGreaterThan(0);
      expect(entry.possible_ai_basis.any_of.length).toBeGreaterThan(0);
    }
  });

  it('activates the full inventory once a broad combination is declared', () => {
    const broad = policyOf({
      aiAccessEnabled: true,
      dataLicenseUses: ['idx', 'vow', 'comparative_market_analysis', 'real_estate_market_analytics'],
      aiAuthorizationBases: ['permitted_search_response', 'permitted_marketing']
    });
    const { service } = liveService(broad);
    // Activation is configuration, not a rewrite.
    expect(buildTools(service).map((t) => t.name).sort()).toEqual([...ALL_TOOL_NAMES].sort());
  });
});

describe('kill switch (Addendum §3.c)', () => {
  it('defaults OFF for the live provider', () => {
    const config = loadConfig(LIVE_ENV);
    expect(config.aiUse.accessEnabled).toBe(false);
    expect(createAiUsePolicy(config).liveAccessPermitted).toBe(false);
  });

  it('withholds every MLS tool while switched off, keeping only the discovery tool', () => {
    const { service } = liveService(policyOf());
    expect(buildTools(service).map((t) => t.name)).toEqual(['get_capabilities']);
  });

  it('makes no MLS Grid request while switched off', async () => {
    const { service, fetchFn } = liveService(policyOf());
    await expect(service.searchListings({ cities: ['Woodbury'], limit: 10 })).rejects.toMatchObject({
      code: 'UNSUPPORTED_CAPABILITY'
    });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('overrides an otherwise complete declaration', async () => {
    const { service, fetchFn } = liveService(
      policyOf({
        aiAccessEnabled: false,
        dataLicenseUses: ['idx'],
        aiAuthorizationBases: ['permitted_search_response']
      })
    );
    const err = await service.searchListings({ limit: 10 }).catch((e) => e);
    expect(err.details.ai_use_denial).toBe('AI_ACCESS_DISABLED');
    expect(err.message).toMatch(/remains fully implemented/);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('leaves the fixture provider ungated, since synthetic data is not MLS Grid Data', () => {
    const service = createService(loadConfig({ MLS_PROVIDER: 'fixture' }));
    expect(buildTools(service)).toHaveLength(9);
    expect(service.aiUsePolicy.governsLicensedData).toBe(false);
  });
});

describe('two independent axes', () => {
  it('refuses when a data use is declared but no AI basis is', async () => {
    const { service, fetchFn } = liveService(
      policyOf({ aiAccessEnabled: true, dataLicenseUses: ['comparative_market_analysis'] })
    );
    const err = await service.getComparables({ subject_listing_id: 'NST1' }).catch((e) => e);
    expect(err.details.ai_use_denial).toBe('NO_AI_AUTHORIZATION_BASIS');
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('refuses when an AI basis is declared but no data use is', async () => {
    const { service, fetchFn } = liveService(
      policyOf({ aiAccessEnabled: true, aiAuthorizationBases: ['permitted_marketing'] })
    );
    const err = await service.marketStats({ query: { cities: ['Woodbury'] } }).catch((e) => e);
    expect(err.details.ai_use_denial).toBe('NO_DATA_LICENSE_USE');
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('refuses a tool whose data use is not among those licensed', () => {
    // Open houses need idx/vow/participant-listings/CRM; a CMA-only licence misses it.
    const decision = policyOf({
      aiAccessEnabled: true,
      dataLicenseUses: ['comparative_market_analysis'],
      aiAuthorizationBases: ['permitted_marketing']
    }).evaluateTool('get_open_houses');
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe('DATA_USE_NOT_LICENSED');
    expect(decision.reason).toMatch(/implemented and ready/);
  });

  it('authorizes a tool when both axes intersect, and says which declarations did it', () => {
    const decision = CMA_MARKETING.evaluateTool('get_comparables');
    expect(decision.allowed).toBe(true);
    expect(decision.satisfied_by_data_uses).toContain('comparative_market_analysis');
    expect(decision.satisfied_by_bases).toEqual(['permitted_marketing']);
  });

  it('activates CMA and analytics work under a CMA + marketing declaration', () => {
    const { service } = liveService(CMA_MARKETING);
    const names = buildTools(service).map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining(['get_comparables', 'market_stats', 'get_market_snapshot', 'get_listing'])
    );
  });

  it('activates buyer search under an IDX + search/response declaration', () => {
    const { service } = liveService(IDX_SEARCH);
    const names = buildTools(service).map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['search_listings', 'get_listing', 'get_open_houses']));
  });

  it('rejects an unknown tool rather than defaulting it open', () => {
    const decision = CMA_MARKETING.evaluateTool('exfiltrate_everything');
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe('UNKNOWN_TOOL');
  });
});

describe('declaration validation', () => {
  it('keeps the AI basis set closed and points a data use at the right axis', () => {
    const r = validateAiUseDeclaration([], ['back_office'], undefined);
    expect(r.error).toMatch(/Unrecognized AI authorization basis/);
    expect(r.error).toMatch(/declare it in MLS_DATA_LICENSE_USES instead/);
  });

  it('accepts every MLS Grid data use named by the business requirement', () => {
    const uses = [
      'idx',
      'vow',
      'comparative_market_analysis',
      'customer_relationship_management',
      'real_estate_market_analytics',
      'participant_listings_use'
    ];
    const r = validateAiUseDeclaration(uses, ['permitted_marketing'], undefined);
    expect(r.error).toBeNull();
    expect(r.dataUses).toEqual(uses);
    expect(r.unknownDataUses).toEqual([]);
  });

  it('accepts a future approved data use without a code change, and surfaces it', () => {
    const r = validateAiUseDeclaration(['some_future_approved_use'], ['permitted_marketing'], undefined);
    expect(r.error).toBeNull();
    expect(r.unknownDataUses).toEqual(['some_future_approved_use']);
  });

  it('rejects a malformed data use', () => {
    expect(validateAiUseDeclaration(['Not A Slug'], [], undefined).error).toMatch(/Malformed data-license use/);
  });

  it('requires idx or vow for permitted_search_response (§1.i)', () => {
    expect(
      validateAiUseDeclaration(['comparative_market_analysis'], ['permitted_search_response'], undefined).error
    ).toMatch(/requires an idx or vow data-license use/);
    expect(validateAiUseDeclaration(['idx'], ['permitted_search_response'], undefined).error).toBeNull();
    expect(validateAiUseDeclaration(['vow'], ['permitted_search_response'], undefined).error).toBeNull();
  });

  it('allows permitted_marketing under a non-IDX data use', () => {
    expect(validateAiUseDeclaration(['back_office'], ['permitted_marketing'], undefined).error).toBeNull();
  });

  it('requires a reference for written_mls_approval', () => {
    expect(validateAiUseDeclaration(['idx'], ['written_mls_approval'], undefined).error).toMatch(
      /requires MLS_AI_WRITTEN_APPROVAL_REFERENCE/
    );
    expect(validateAiUseDeclaration(['idx'], ['written_mls_approval'], 'MLSGRID-2026-001').error).toBeNull();
  });

  it('fails startup on an invalid declaration rather than degrading to permissive', () => {
    expect(() =>
      loadConfig({
        ...LIVE_ENV,
        MLS_AI_AUTHORIZATION_BASES: 'permitted_search_response',
        MLS_DATA_LICENSE_USES: 'comparative_market_analysis'
      })
    ).toThrow(/idx or vow/);
    expect(() => loadConfig({ ...LIVE_ENV, MLS_AI_AUTHORIZATION_BASES: 'back_office' })).toThrow(
      /Unrecognized AI authorization basis/
    );
  });

  it('parses a complete two-axis declaration from the environment', () => {
    const config = loadConfig({
      ...LIVE_ENV,
      MLS_AI_ACCESS_ENABLED: 'true',
      MLS_DATA_LICENSE_USES: 'comparative_market_analysis, real_estate_market_analytics',
      MLS_AI_AUTHORIZATION_BASES: 'permitted_marketing'
    });
    expect(config.aiUse.accessEnabled).toBe(true);
    expect(config.aiUse.dataLicenseUses).toEqual(['comparative_market_analysis', 'real_estate_market_analytics']);
    expect(config.aiUse.aiAuthorizationBases).toEqual(['permitted_marketing']);
  });
});

describe('written_mls_approval is never inferred', () => {
  const writtenOnly = policyOf({
    aiAccessEnabled: true,
    dataLicenseUses: ['participant_listings_use'],
    aiAuthorizationBases: ['written_mls_approval'],
    writtenApprovalReference: 'MLSGRID-2026-001'
  });

  it('does not authorize a tool merely because the basis is declared', () => {
    const decision = writtenOnly.evaluateTool('get_listing');
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/never inferred/);
  });

  it('authorizes only tools named explicitly alongside the written reference', () => {
    const named = policyOf({
      aiAccessEnabled: true,
      dataLicenseUses: ['participant_listings_use'],
      aiAuthorizationBases: ['written_mls_approval'],
      writtenApprovalReference: 'MLSGRID-2026-001',
      authorizedTools: ['get_listing']
    });
    expect(named.evaluateTool('get_listing').allowed).toBe(true);
    expect(named.evaluateTool('search_listings').allowed).toBe(false);
  });

  it('refuses the basis without a written reference', () => {
    const noRef = policyOf({
      aiAccessEnabled: true,
      dataLicenseUses: ['participant_listings_use'],
      aiAuthorizationBases: ['written_mls_approval'],
      authorizedTools: ['get_listing']
    });
    expect(noRef.evaluateTool('get_listing').allowed).toBe(false);
  });
});

describe('optional allowlist narrowing', () => {
  it('narrows but never widens the authorized set', () => {
    const narrowed = policyOf({
      aiAccessEnabled: true,
      dataLicenseUses: ['comparative_market_analysis', 'real_estate_market_analytics'],
      aiAuthorizationBases: ['permitted_marketing'],
      authorizedTools: ['get_comparables']
    });
    expect(narrowed.evaluateTool('get_comparables').allowed).toBe(true);
    expect(narrowed.evaluateTool('market_stats').code).toBe('TOOL_NOT_IN_ALLOWLIST');
    // Naming a tool the axes do not cover still does not authorize it.
    const overreach = policyOf({
      aiAccessEnabled: true,
      dataLicenseUses: ['comparative_market_analysis'],
      aiAuthorizationBases: ['permitted_marketing'],
      authorizedTools: ['get_open_houses']
    });
    expect(overreach.evaluateTool('get_open_houses').code).toBe('DATA_USE_NOT_LICENSED');
  });
});

describe('attribution (§3.d)', () => {
  it('attaches attribution naming Participant, MLS and distributor to every MLS-derived result', async () => {
    const broad = policyOf({
      aiAccessEnabled: true,
      dataLicenseUses: ['idx', 'vow', 'comparative_market_analysis', 'real_estate_market_analytics'],
      aiAuthorizationBases: ['permitted_search_response', 'permitted_marketing']
    });
    const { service } = liveService(broad, [liveRecord(1), liveRecord(2)]);
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
      expect(result.attribution).toBeDefined();
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
    expect(result.attribution.distributor).toBeNull();
  });
});

describe('zero write surface under a live policy', () => {
  it('exposes no write-shaped tool even when fully authorized', () => {
    const broad = policyOf({
      aiAccessEnabled: true,
      dataLicenseUses: ['idx', 'vow', 'comparative_market_analysis', 'real_estate_market_analytics'],
      aiAuthorizationBases: ['permitted_search_response', 'permitted_marketing']
    });
    const { service } = liveService(broad);
    const writeVerb =
      /^(create|add|update|edit|modify|delete|remove|set|post|put|patch|submit|send|write|upload|change|cancel|close|assign)_/;
    const tools = buildTools(service);
    expect(tools).toHaveLength(9);
    for (const tool of tools) expect(tool.name).not.toMatch(writeVerb);
  });

  it('issues only GET requests to MLS Grid', async () => {
    const { service, fetchFn } = liveService(CMA_MARKETING);
    await service.marketStats({ query: { cities: ['Woodbury'], limit: 10 } });
    const calls = (fetchFn as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    for (const [, init] of calls) expect(init.method).toBe('GET');
  });
});

describe('policy disclosure', () => {
  it('reports both axes and the prohibitions', () => {
    const description = CMA_MARKETING.describe();
    expect(description.data_license_uses).toEqual(['comparative_market_analysis', 'real_estate_market_analytics']);
    expect(description.ai_authorization_bases).toEqual(['permitted_marketing']);
    expect(description.prohibited_uses).toEqual(PROHIBITED_USES);
    expect(String(description.model)).toMatch(/independent/);
    expect(JSON.stringify(description.notes)).toMatch(/Withheld means unauthorized, not absent/);
  });

  it('surfaces the register through get_capabilities while gated', async () => {
    const { service } = liveService(policyOf());
    const caps = (await buildTools(service)[0]!.handler({})) as Record<string, any>;
    expect(caps.ai_use.ai_access_enabled).toBe(false);
    const register = caps.tool_register as Array<Record<string, any>>;
    expect(register).toHaveLength(9);
    const comparables = register.find((e) => e.tool === 'get_comparables')!;
    expect(comparables.authorization_state).toBe('withheld');
    expect(comparables.business_uses).toContain('CMA evidence');
    expect(comparables.withheld_reason).toBeTruthy();
  });
});
