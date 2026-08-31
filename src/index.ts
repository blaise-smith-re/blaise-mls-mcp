import { loadConfig } from './config.js';
import { MlsError } from './errors.js';
import { createService } from './factory.js';
import { createHttpApp } from './http.js';
import { createLogger } from './logging.js';
import { BUILD_STATUS, SERVER_NAME, SERVER_VERSION } from './version.js';

/**
 * HTTP entry point (remote Claude connector deployment, e.g. Render).
 *
 * Startup validation is strict and fail-fast: an invalid configuration, or a
 * live provider selected without a token, aborts before the port is bound.
 */
async function main(): Promise<void> {
  const bootLogger = createLogger({ level: 'info' });

  let config;
  try {
    config = loadConfig();
  } catch (err) {
    const message = err instanceof MlsError ? err.message : 'Unknown configuration error';
    bootLogger.error('startup aborted: invalid configuration', { message });
    process.exitCode = 1;
    return;
  }

  const logger = createLogger({ level: config.logLevel });
  const service = createService(config, logger);
  const app = createHttpApp({ config, service, logger });

  if (config.provider === 'fixture') {
    logger.warn('serving FIXTURE data', {
      detail: 'Synthetic records only. This server has no live MLS access and its output is not market data.'
    });
  }
  if (config.isProduction && !config.mcpAuthToken) {
    logger.warn('MCP endpoint is unauthenticated', {
      detail: 'Set MCP_AUTH_TOKEN to require a bearer token on /mcp.'
    });
  }

  app.listen(config.port, () => {
    logger.info('server listening', {
      server: SERVER_NAME,
      version: SERVER_VERSION,
      build_status: BUILD_STATUS,
      port: config.port,
      provider: config.provider
    });
  });
}

void main();
