import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express from 'express';
import type { Express, NextFunction, Request, Response } from 'express';
import { timingSafeEqual } from 'node:crypto';
import type { AppConfig } from './config.js';
import type { Logger } from './logging.js';
import { nullLogger } from './logging.js';
import { createMcpServer } from './mcp/server.js';
import type { MlsService } from './service/mls-service.js';
import { BUILD_STATUS, SERVER_NAME, SERVER_VERSION } from './version.js';

/**
 * HTTP surface for remote Claude connectors.
 *
 * Security boundary (see docs/SECURITY.md):
 *   Claude  --(MCP_AUTH_TOKEN bearer)-->  this server  --(MLSGRID_TOKEN bearer)-->  MLS Grid
 *
 * The MLS Grid credential is held server-side only and never travels to, or is
 * derived from, the Claude side of the boundary. The two tokens are distinct
 * and independently rotatable.
 */

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export function createAuthMiddleware(expectedToken: string | undefined, logger: Logger) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!expectedToken) {
      next();
      return;
    }
    const header = req.header('authorization') ?? '';
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (!match || !safeEqual(match[1]!.trim(), expectedToken)) {
      // Log the rejection but never the presented credential.
      logger.warn('mcp request rejected', { reason: 'invalid_or_missing_bearer' });
      res.status(401).json({
        jsonrpc: '2.0',
        error: { code: -32001, message: 'Unauthorized' },
        id: null
      });
      return;
    }
    next();
  };
}

export interface HttpAppOptions {
  config: AppConfig;
  service: MlsService;
  logger?: Logger;
}

export function createHttpApp(opts: HttpAppOptions): Express {
  const { config, service } = opts;
  const logger = opts.logger ?? nullLogger;
  const app = express();

  // Bounded request body: MCP JSON-RPC calls are small; anything larger is rejected.
  app.use(express.json({ limit: '1mb' }));

  app.get('/health', (_req: Request, res: Response) => {
    res.json({
      status: 'ok',
      server: SERVER_NAME,
      version: SERVER_VERSION,
      build_status: BUILD_STATUS,
      provider: config.provider,
      originating_system: service.capabilities().originating_system,
      // Distinguish "a live provider is configured" from "live MLS data may
      // actually be retrieved" — with the kill switch off these differ, and
      // conflating them would misreport the server as having live access.
      provider_is_live: config.provider === 'mlsgrid',
      live_mls_access: service.aiUsePolicy.liveAccessPermitted,
      ai_use: service.aiUsePolicy.describe(),
      mcp_auth_required: config.mcpAuthToken !== undefined,
      timezone: config.defaultTimezone,
      uptime_seconds: Math.round(process.uptime())
    });
  });

  app.get('/version', (_req: Request, res: Response) => {
    res.json({
      server: SERVER_NAME,
      version: SERVER_VERSION,
      build_status: BUILD_STATUS,
      node: process.version,
      capabilities: service.capabilities()
    });
  });

  const requireAuth = createAuthMiddleware(config.mcpAuthToken, logger);

  app.post('/mcp', requireAuth, async (req: Request, res: Response) => {
    // Stateless: a fresh server and transport per request. No cross-request
    // session state means no session fixation surface and clean horizontal scaling.
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    const server = createMcpServer(service, logger);
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      logger.error('mcp transport error', { error: err instanceof Error ? err.name : 'unknown' });
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null
        });
      }
    }
  });

  // Stateless mode does not support server-initiated streams or session teardown.
  const methodNotAllowed = (_req: Request, res: Response): void => {
    res.status(405).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Method not allowed: this MCP endpoint is stateless (POST only).' },
      id: null
    });
  };
  app.get('/mcp', requireAuth, methodNotAllowed);
  app.delete('/mcp', requireAuth, methodNotAllowed);

  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: 'not_found' });
  });

  return app;
}
