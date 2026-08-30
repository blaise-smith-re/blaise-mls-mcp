import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { MlsError, redactSecrets } from '../src/errors.js';
import { createLogger, redactFields } from '../src/logging.js';

describe('loadConfig', () => {
  it('defaults to the fixture provider so the server never starts up expecting live access', () => {
    const c = loadConfig({});
    expect(c.provider).toBe('fixture');
    expect(c.defaultTimezone).toBe('America/Chicago');
  });

  it('refuses to start with the live provider and no token', () => {
    expect(() => loadConfig({ MLS_PROVIDER: 'mlsgrid' })).toThrow(MlsError);
    expect(() => loadConfig({ MLS_PROVIDER: 'mlsgrid', MLSGRID_TOKEN: '  ' })).toThrow(/requires MLSGRID_TOKEN/);
  });

  it('accepts the live provider when a token is present', () => {
    const c = loadConfig({ MLS_PROVIDER: 'mlsgrid', MLSGRID_TOKEN: 'abc123', MLSGRID_ORIGINATING_SYSTEM: 'northstar' });
    expect(c.provider).toBe('mlsgrid');
    expect(c.mlsgrid.originatingSystem).toBe('northstar');
  });

  it('rejects an out-of-range numeric setting instead of silently clamping', () => {
    expect(() => loadConfig({ MLSGRID_TIMEOUT_MS: '5' })).toThrow(/MLSGRID_TIMEOUT_MS/);
    expect(() => loadConfig({ PORT: 'not-a-port' })).toThrow(/PORT/);
  });

  it('rejects an invalid API base URL', () => {
    expect(() => loadConfig({ MLSGRID_API_BASE: 'not a url' })).toThrow(/MLSGRID_API_BASE/);
  });

  it('strips a trailing slash from the API base', () => {
    const c = loadConfig({ MLSGRID_API_BASE: 'https://api.mlsgrid.com/v2/' });
    expect(c.mlsgrid.apiBase).toBe('https://api.mlsgrid.com/v2');
  });

  it('keeps private remarks off unless explicitly enabled', () => {
    expect(loadConfig({}).mlsgrid.exposePrivateRemarks).toBe(false);
    expect(loadConfig({ MLSGRID_EXPOSE_PRIVATE_REMARKS: 'true' }).mlsgrid.exposePrivateRemarks).toBe(true);
  });

  it('parses a server filter field override into a list', () => {
    const c = loadConfig({ MLSGRID_SERVER_FILTER_FIELDS: 'City, PostalCode ,ListPrice' });
    expect(c.mlsgrid.serverFilterFields).toEqual(['City', 'PostalCode', 'ListPrice']);
    expect(loadConfig({}).mlsgrid.serverFilterFields).toBeUndefined();
  });
});

describe('secret redaction', () => {
  it('redacts a bearer token from free text', () => {
    // secret-scan:allow — a fake token-shaped literal is required to prove redaction works.
    expect(redactSecrets('Authorization: Bearer sk-abc123456789xyz')).toBe('Authorization: Bearer [REDACTED]');
  });

  it('redacts sensitive keys from structured fields at any depth', () => {
    const redacted = redactFields({
      url: 'https://api.mlsgrid.com',
      // secret-scan:allow — fake credential fixture.
      headers: { Authorization: 'Bearer abcdef0123456789', accept: 'application/json' },
      // secret-scan:allow — fake credential fixture.
      nested: { config: { MLSGRID_TOKEN: 'super-secret-value', api_key: 'k' } }
    }) as Record<string, any>;
    expect(redacted.headers.Authorization).toBe('[REDACTED]');
    expect(redacted.headers.accept).toBe('application/json');
    expect(redacted.nested.config.MLSGRID_TOKEN).toBe('[REDACTED]');
    expect(redacted.nested.config.api_key).toBe('[REDACTED]');
    expect(JSON.stringify(redacted)).not.toContain('super-secret-value');
  });

  it('does not log below the configured level', () => {
    const lines: string[] = [];
    const logger = createLogger({ level: 'warn', write: (l) => lines.push(l) });
    logger.debug('quiet');
    logger.info('also quiet');
    logger.warn('loud');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!).msg).toBe('loud');
  });

  it('redacts token-shaped text passed as a log message', () => {
    const lines: string[] = [];
    const logger = createLogger({ level: 'info', write: (l) => lines.push(l) });
    // secret-scan:allow — fake token-shaped literal, asserted to be redacted below.
    logger.info('calling with Bearer abcdef0123456789ghijkl');
    expect(lines[0]).not.toContain('abcdef0123456789ghijkl');
    expect(lines[0]).toContain('[REDACTED]');
  });
});
