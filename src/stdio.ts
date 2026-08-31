import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config.js';
import { MlsError } from './errors.js';
import { createService } from './factory.js';
import { createLogger } from './logging.js';
import { createMcpServer } from './mcp/server.js';

/**
 * stdio entry point, for running this MCP server as a local subprocess.
 * All logging goes to stderr; stdout carries the MCP protocol stream only.
 */
async function main(): Promise<void> {
  const logger = createLogger({ level: 'warn' });
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    logger.error('startup aborted: invalid configuration', {
      message: err instanceof MlsError ? err.message : 'Unknown configuration error'
    });
    process.exitCode = 1;
    return;
  }

  const service = createService(config, logger);
  const server = createMcpServer(service, logger);
  await server.connect(new StdioServerTransport());
}

void main();
