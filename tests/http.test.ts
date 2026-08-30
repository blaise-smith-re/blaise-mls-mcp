import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { createService } from '../src/factory.js';
import { createHttpApp } from '../src/http.js';
import { createLogger } from '../src/logging.js';

const MCP_TOKEN = 'mcp-shared-secret-0123456789';

function app(env: Record<string, string> = {}) {
  const config = loadConfig({ MLS_PROVIDER: 'fixture', ...env });
  const service = createService(config);
  return createHttpApp({ config, service });
}

const initBody = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'test', version: '1.0.0' }
  }
};

describe('/health', () => {
  it('reports status, provider and build status without requiring auth', async () => {
    const res = await request(app({ MCP_AUTH_TOKEN: MCP_TOKEN })).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.provider).toBe('fixture');
    expect(res.body.live_mls_access).toBe(false);
    expect(res.body.build_status).toMatch(/LIVE ACTIVATION PENDING/);
    expect(res.body.mcp_auth_required).toBe(true);
    expect(res.body.timezone).toBe('America/Chicago');
  });

  it('never exposes a token value', async () => {
    const res = await request(app({ MCP_AUTH_TOKEN: MCP_TOKEN })).get('/health');
    expect(JSON.stringify(res.body)).not.toContain(MCP_TOKEN);
  });
});

describe('/version', () => {
  it('reports build and capability information', async () => {
    const res = await request(app()).get('/version');
    expect(res.status).toBe(200);
    expect(res.body.server).toBe('blaise-mls-mcp');
    expect(res.body.capabilities.listing_history_events).toBe('unsupported');
  });
});

describe('/mcp authentication boundary', () => {
  it('rejects a request with no bearer token when one is configured', async () => {
    const res = await request(app({ MCP_AUTH_TOKEN: MCP_TOKEN })).post('/mcp').send(initBody);
    expect(res.status).toBe(401);
    expect(res.body.error.message).toBe('Unauthorized');
  });

  it('rejects a wrong bearer token', async () => {
    const res = await request(app({ MCP_AUTH_TOKEN: MCP_TOKEN }))
      .post('/mcp')
      .set('authorization', 'Bearer wrong-token-0123456789')
      .send(initBody);
    expect(res.status).toBe(401);
  });

  it('accepts the configured bearer token', async () => {
    const res = await request(app({ MCP_AUTH_TOKEN: MCP_TOKEN }))
      .post('/mcp')
      .set('authorization', `Bearer ${MCP_TOKEN}`)
      .set('accept', 'application/json, text/event-stream')
      .send(initBody);
    expect(res.status).toBe(200);
  });

  it('allows unauthenticated access only when no token is configured', async () => {
    const res = await request(app())
      .post('/mcp')
      .set('accept', 'application/json, text/event-stream')
      .send(initBody);
    expect(res.status).toBe(200);
  });

  it('does not log the presented credential on rejection', async () => {
    const lines: string[] = [];
    const config = loadConfig({ MLS_PROVIDER: 'fixture', MCP_AUTH_TOKEN: MCP_TOKEN });
    const service = createService(config);
    const instrumented = createHttpApp({
      config,
      service,
      logger: createLogger({ level: 'debug', write: (l) => lines.push(l) })
    });
    // secret-scan:allow — fake credential, asserted below to be absent from logs.
    await request(instrumented).post('/mcp').set('authorization', 'Bearer leaked-value-9876543210').send(initBody);
    expect(lines.join('\n')).not.toContain('leaked-value-9876543210');
    expect(lines.join('\n')).toContain('invalid_or_missing_bearer');
  });
});

describe('/mcp transport surface', () => {
  it('rejects GET and DELETE in stateless mode', async () => {
    const a = app();
    expect((await request(a).get('/mcp')).status).toBe(405);
    expect((await request(a).delete('/mcp')).status).toBe(405);
  });

  it('lists only read-only tools over the protocol', async () => {
    const agent = request.agent(app());
    const init = await agent
      .post('/mcp')
      .set('accept', 'application/json, text/event-stream')
      .send(initBody);
    expect(init.status).toBe(200);

    const res = await agent
      .post('/mcp')
      .set('accept', 'application/json, text/event-stream')
      .send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    expect(res.status).toBe(200);
    const payload = res.text.includes('event:') ? JSON.parse(res.text.split('data: ')[1]!.trim()) : res.body;
    const toolList = payload.result.tools as Array<{ name: string; annotations?: { readOnlyHint?: boolean } }>;
    expect(toolList.length).toBe(9);
    for (const tool of toolList) {
      expect(tool.annotations?.readOnlyHint, `${tool.name} must be read-only`).toBe(true);
    }
  });
});

describe('unknown routes', () => {
  it('returns a 404 without leaking internals', async () => {
    const res = await request(app()).get('/admin');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'not_found' });
  });
});
