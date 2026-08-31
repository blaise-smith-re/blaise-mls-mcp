import { describe, expect, it, vi } from 'vitest';
import { MlsError } from '../src/errors.js';
import { createLogger } from '../src/logging.js';
import { MlsGridHttpClient } from '../src/provider/mlsgrid/http.js';

const TOKEN = 'test-token-abcdef0123456789';
const BASE = 'https://api.mlsgrid.com/v2';

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers }
  });
}

function client(fetchFn: typeof fetch, overrides: Record<string, unknown> = {}) {
  return new MlsGridHttpClient({
    baseUrl: BASE,
    token: TOKEN,
    fetchFn,
    minRequestIntervalMs: 0,
    sleepFn: async () => undefined,
    ...overrides
  });
}

describe('MlsGridHttpClient authentication', () => {
  it('sends the token as a bearer header', async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ value: [] })) as unknown as typeof fetch;
    await client(fetchFn).getPage(`${BASE}/Property`);
    const init = (fetchFn as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0]![1];
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('maps 401 to a non-retryable AUTH error and never echoes the token', async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ error: 'nope' }, 401)) as unknown as typeof fetch;
    const c = client(fetchFn);
    await expect(c.getPage(`${BASE}/Property`)).rejects.toMatchObject({ code: 'AUTH' });
    await expect(c.getPage(`${BASE}/Property`)).rejects.toThrow(/HTTP 401/);
    expect(fetchFn).toHaveBeenCalledTimes(2); // one per call, never retried
    const err = await c.getPage(`${BASE}/Property`).catch((e: MlsError) => e);
    expect(JSON.stringify(err)).not.toContain(TOKEN);
  });

  it('maps 403 to AUTH without retrying', async () => {
    const fetchFn = vi.fn(async () => jsonResponse({}, 403)) as unknown as typeof fetch;
    await expect(client(fetchFn).getPage(`${BASE}/Property`)).rejects.toMatchObject({ code: 'AUTH' });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});

describe('MlsGridHttpClient retry behavior', () => {
  it('retries a 429 and succeeds', async () => {
    let calls = 0;
    const fetchFn = vi.fn(async () => {
      calls += 1;
      return calls === 1 ? jsonResponse({}, 429, { 'retry-after': '1' }) : jsonResponse({ value: [{ a: 1 }] });
    }) as unknown as typeof fetch;
    const page = await client(fetchFn).getPage(`${BASE}/Property`);
    expect(page.value).toHaveLength(1);
    expect(calls).toBe(2);
  });

  it('surfaces RATE_LIMITED once retries are exhausted', async () => {
    const fetchFn = vi.fn(async () => jsonResponse({}, 429)) as unknown as typeof fetch;
    await expect(client(fetchFn, { maxRetries: 2 }).getPage(`${BASE}/Property`)).rejects.toMatchObject({
      code: 'RATE_LIMITED'
    });
    expect(fetchFn).toHaveBeenCalledTimes(3); // initial + 2 retries
  });

  it('retries 5xx and then succeeds', async () => {
    let calls = 0;
    const fetchFn = vi.fn(async () => {
      calls += 1;
      return calls < 3 ? jsonResponse({}, 503) : jsonResponse({ value: [] });
    }) as unknown as typeof fetch;
    await client(fetchFn).getPage(`${BASE}/Property`);
    expect(calls).toBe(3);
  });

  it('gives up on persistent 5xx with UPSTREAM_UNAVAILABLE', async () => {
    const fetchFn = vi.fn(async () => jsonResponse({}, 500)) as unknown as typeof fetch;
    await expect(client(fetchFn, { maxRetries: 1 }).getPage(`${BASE}/Property`)).rejects.toMatchObject({
      code: 'UPSTREAM_UNAVAILABLE'
    });
  });

  it('retries a transient network failure', async () => {
    let calls = 0;
    const fetchFn = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new Error('ECONNRESET');
      return jsonResponse({ value: [] });
    }) as unknown as typeof fetch;
    await client(fetchFn).getPage(`${BASE}/Property`);
    expect(calls).toBe(2);
  });

  it('maps an aborted request to TIMEOUT', async () => {
    const fetchFn = vi.fn(async () => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    }) as unknown as typeof fetch;
    await expect(client(fetchFn, { maxRetries: 0 }).getPage(`${BASE}/Property`)).rejects.toMatchObject({
      code: 'TIMEOUT'
    });
  });

  it('does not retry a 400-class request error', async () => {
    const fetchFn = vi.fn(async () => jsonResponse({}, 400)) as unknown as typeof fetch;
    await expect(client(fetchFn).getPage(`${BASE}/Property`)).rejects.toMatchObject({ code: 'VALIDATION' });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});

describe('MlsGridHttpClient response handling', () => {
  it('rejects a non-JSON body', async () => {
    const fetchFn = vi.fn(async () => new Response('<html>oops</html>', { status: 200 })) as unknown as typeof fetch;
    await expect(client(fetchFn).getPage(`${BASE}/Property`)).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' });
  });

  it('rejects a body missing the OData value array', async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ data: [] })) as unknown as typeof fetch;
    await expect(client(fetchFn).getPage(`${BASE}/Property`)).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' });
  });

  it('rejects a null body', async () => {
    const fetchFn = vi.fn(async () => jsonResponse(null)) as unknown as typeof fetch;
    await expect(client(fetchFn).getPage(`${BASE}/Property`)).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' });
  });

  it('extracts nextLink and count when present', async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse({ value: [{ a: 1 }], '@odata.nextLink': `${BASE}/Property?$skip=1`, '@odata.count': 42 })
    ) as unknown as typeof fetch;
    const page = await client(fetchFn).getPage(`${BASE}/Property`);
    expect(page.nextLink).toBe(`${BASE}/Property?$skip=1`);
    expect(page.count).toBe(42);
  });
});

describe('MlsGridHttpClient URL controls', () => {
  it('refuses a URL outside the configured API origin', async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ value: [] })) as unknown as typeof fetch;
    await expect(client(fetchFn).getPage('https://evil.example.com/v2/Property')).rejects.toMatchObject({
      code: 'VALIDATION'
    });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('encodes query parameters through buildUrl', () => {
    const url = client((async () => jsonResponse({ value: [] })) as unknown as typeof fetch).buildUrl('Property', {
      $filter: "City eq 'Woodbury'",
      $top: 10
    });
    expect(url).toContain('%24filter=City+eq+%27Woodbury%27');
    expect(url).toContain('%24top=10');
  });
});

describe('MlsGridHttpClient throttling', () => {
  it('serializes concurrent callers instead of letting them burst', async () => {
    const offsets: number[] = [];
    const start = Date.now();
    const fetchFn = vi.fn(async () => {
      offsets.push(Date.now() - start);
      return jsonResponse({ value: [] });
    }) as unknown as typeof fetch;
    // Real sleeps, but short: the point is that callers queue rather than
    // all computing their delay from the same lastRequestAt and firing together.
    const c = new MlsGridHttpClient({ baseUrl: BASE, token: TOKEN, fetchFn, minRequestIntervalMs: 40 });
    await Promise.all([
      c.getPage(`${BASE}/Property`),
      c.getPage(`${BASE}/Property`),
      c.getPage(`${BASE}/Property`)
    ]);
    expect(offsets).toHaveLength(3);
    expect(offsets[1]! - offsets[0]!).toBeGreaterThanOrEqual(35);
    expect(offsets[2]! - offsets[1]!).toBeGreaterThanOrEqual(35);
  });

  it('releases the next caller even when a request fails', async () => {
    let calls = 0;
    const fetchFn = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new Error('ECONNRESET');
      return jsonResponse({ value: [] });
    }) as unknown as typeof fetch;
    const c = new MlsGridHttpClient({
      baseUrl: BASE,
      token: TOKEN,
      fetchFn,
      minRequestIntervalMs: 0,
      maxRetries: 0,
      sleepFn: async () => undefined
    });
    await expect(c.getPage(`${BASE}/Property`)).rejects.toMatchObject({ code: 'UPSTREAM_UNAVAILABLE' });
    // A stuck admission queue would hang this call rather than resolving it.
    await expect(c.getPage(`${BASE}/Property`)).resolves.toMatchObject({ value: [] });
  });
});

describe('MlsGridHttpClient logging', () => {
  it('never writes the bearer token to the log', async () => {
    const lines: string[] = [];
    const logger = createLogger({ level: 'debug', write: (l) => lines.push(l) });
    let calls = 0;
    const fetchFn = vi.fn(async () => {
      calls += 1;
      return calls === 1 ? jsonResponse({}, 429) : jsonResponse({ value: [] });
    }) as unknown as typeof fetch;
    await client(fetchFn, { logger }).getPage(`${BASE}/Property`);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join('\n')).not.toContain(TOKEN);
  });
});
