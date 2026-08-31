import { AiUsePolicy } from './compliance/ai-use.js';
import type { AppConfig } from './config.js';
import { MlsError } from './errors.js';
import type { Logger } from './logging.js';
import { nullLogger } from './logging.js';
import { FixtureAdapter } from './provider/fixture/adapter.js';
import { MlsGridAdapter, PROVIDER_REQUEST_CAP } from './provider/mlsgrid/adapter.js';
import type { MlsProvider } from './provider/types.js';
import { MlsService } from './service/mls-service.js';

export function createProvider(config: AppConfig, logger: Logger = nullLogger): MlsProvider {
  if (config.provider === 'fixture') {
    logger.info('using fixture provider', { note: 'synthetic data; no live MLS access' });
    return new FixtureAdapter({
      maxRecordsPerQuery: config.maxRecordsPerQuery,
      exposePrivateRemarks: false
    });
  }

  if (!config.mlsgrid.token) {
    throw new MlsError('CONFIG', 'MLS Grid provider selected but no token is configured.');
  }
  logger.info('using mlsgrid provider', {
    api_base: config.mlsgrid.apiBase,
    originating_system: config.mlsgrid.originatingSystem
  });
  return new MlsGridAdapter({
    apiBase: config.mlsgrid.apiBase,
    token: config.mlsgrid.token,
    originatingSystem: config.mlsgrid.originatingSystem,
    timeoutMs: config.mlsgrid.timeoutMs,
    minRequestIntervalMs: config.mlsgrid.minRequestIntervalMs,
    maxRetries: config.mlsgrid.maxRetries,
    pageSize: config.mlsgrid.pageSize,
    maxPagesPerQuery: config.mlsgrid.maxPagesPerQuery,
    maxRecordsPerQuery: config.maxRecordsPerQuery,
    serverFilterFields: config.mlsgrid.serverFilterFields,
    exposePrivateRemarks: config.mlsgrid.exposePrivateRemarks,
    logger
  });
}

export function createAiUsePolicy(config: AppConfig): AiUsePolicy {
  return new AiUsePolicy({
    provider: config.provider,
    aiAccessEnabled: config.aiUse.accessEnabled,
    dataLicenseUses: config.aiUse.dataLicenseUses,
    aiAuthorizationBases: config.aiUse.aiAuthorizationBases,
    writtenApprovalReference: config.aiUse.writtenApprovalReference,
    authorizedTools: config.aiUse.authorizedTools
  });
}

export function createService(config: AppConfig, logger: Logger = nullLogger): MlsService {
  const provider = createProvider(config, logger);
  const policy = createAiUsePolicy(config);
  if (config.provider === 'mlsgrid' && !policy.liveAccessPermitted) {
    logger.warn('live MLS AI access is withheld', {
      detail:
        'MLS Grid provider is configured but the kill switch, data-license use, or AI authorization basis is ' +
        'not declared. MLS tools remain fully implemented but unavailable, and no MLS Grid request will be made.'
    });
  }
  if (config.aiUse.unknownDataUses.length > 0) {
    // Accepted deliberately: MLS Grid may approve new data uses at any time and
    // this server must not need a code change to honour one.
    logger.info('data-license use not in the known list', {
      uses: config.aiUse.unknownDataUses,
      detail: 'Accepted as a future approved use. Confirm it matches an actual Data Interface selection.'
    });
  }
  return new MlsService({
    provider,
    defaultTimezone: config.defaultTimezone,
    maxRecordsPerQuery: config.maxRecordsPerQuery,
    maxPages: config.provider === 'mlsgrid' ? config.mlsgrid.maxPagesPerQuery : 10,
    providerRequestCap: config.provider === 'mlsgrid' ? PROVIDER_REQUEST_CAP : null,
    aiUsePolicy: policy,
    participantName: config.aiUse.participantName
  });
}
