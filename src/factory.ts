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

export function createService(config: AppConfig, logger: Logger = nullLogger): MlsService {
  const provider = createProvider(config, logger);
  return new MlsService({
    provider,
    defaultTimezone: config.defaultTimezone,
    maxRecordsPerQuery: config.maxRecordsPerQuery,
    maxPages: config.provider === 'mlsgrid' ? config.mlsgrid.maxPagesPerQuery : 10,
    providerRequestCap: config.provider === 'mlsgrid' ? PROVIDER_REQUEST_CAP : null
  });
}
