import { MlsError, redactSecrets } from '../../errors.js';
import type { Logger } from '../../logging.js';
import { nullLogger } from '../../logging.js';

/**
 * Hardened HTTP client for the MLS Grid OData API.
 *
 *  - Bearer token attached server-side only; never logged, never echoed in errors.
 *  - Conservative request throttle (documented MLS Grid rate limits are
 *    provisional; default ~2 requests/second equivalent spacing).
 *  - Retries: 429 (honors Retry-After, bounded), 5xx and network failures with
 *    exponential backoff. 401/403 never retried.
 *  - Request timeout via AbortController.
 *  - Only same-origin URLs are fetched: absolute nextLink URLs must match the
 *    configured API base origin (no arbitrary URL fetching).
 */

export interface MlsGridHttpOptions {
  baseUrl: string;
  token: string;
  timeoutMs?: number;
  minRequestIntervalMs?: number;
  maxRetries?: number;
  fetchFn?: typeof fetch;
  logger?: Logger;
  /** Injectable sleep for tests. */
  sleepFn?: (ms: number) => Promise<void>;
}

export interface ODataResponse {
  value: unknown[];
  nextLink: string | null;
  count: number | null;
}

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class MlsGridHttpClient {
  private readonly baseUrl: string;
  private readonly baseOrigin: string;
  private readonly token: string;
  private readonly timeoutMs: number;
  private readonly minIntervalMs: number;
  private readonly maxRetries: number;
  private readonly fetchFn: typeof fetch;
  private readonly sleepFn: (ms: number) => Promise<void>;
  private readonly logger: Logger;
  private lastRequestAt = 0;
  /** Serializes throttle admission so concurrent callers queue instead of bursting. */
  private admission: Promise<void> = Promise.resolve();

  constructor(opts: MlsGridHttpOptions) {
    if (!opts.token) throw new MlsError('CONFIG', 'MLS Grid client requires a token');
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.baseOrigin = new URL(this.baseUrl).origin;
    this.token = opts.token;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.minIntervalMs = opts.minRequestIntervalMs ?? 600;
    this.maxRetries = opts.maxRetries ?? 3;
    this.fetchFn = opts.fetchFn ?? fetch;
    this.sleepFn = opts.sleepFn ?? realSleep;
    this.logger = opts.logger ?? nullLogger;
  }

  buildUrl(resource: string, params: Record<string, string | number | boolean | undefined>): string {
    const url = new URL(`${this.baseUrl}/${resource}`);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
    return url.toString();
  }

  /** GET an OData collection page. `urlOrResource` is a resource-relative URL or a same-origin absolute nextLink. */
  async getPage(fullUrl: string): Promise<ODataResponse> {
    const url = new URL(fullUrl);
    if (url.origin !== this.baseOrigin) {
      throw new MlsError('VALIDATION', 'Refusing to fetch a URL outside the configured MLS Grid API origin', {
        details: { origin: url.origin }
      });
    }

    let attempt = 0;
    // Retry loop: attempt 0 plus up to maxRetries retries for retryable failures.
    for (;;) {
      await this.throttle();
      let response: Response;
      try {
        response = await this.doFetch(url.toString());
      } catch (err) {
        const timedOut = err instanceof Error && err.name === 'AbortError';
        const mlsErr = timedOut
          ? new MlsError('TIMEOUT', `MLS Grid request timed out after ${this.timeoutMs}ms`, { retryable: true })
          : new MlsError('UPSTREAM_UNAVAILABLE', `MLS Grid request failed: ${redactSecrets(String(err))}`, {
              retryable: true,
              cause: err
            });
        if (attempt >= this.maxRetries) throw mlsErr;
        attempt += 1;
        await this.backoff(attempt, null);
        continue;
      }

      if (response.status === 401 || response.status === 403) {
        throw new MlsError(
          'AUTH',
          `MLS Grid rejected the request (HTTP ${response.status}). The configured token is missing required ` +
            'authorization, expired, or not licensed for this resource.',
          { details: { status: response.status } }
        );
      }
      if (response.status === 429) {
        if (attempt >= this.maxRetries) {
          throw new MlsError('RATE_LIMITED', 'MLS Grid rate limit exceeded and retries exhausted', {
            details: { status: 429 },
            retryable: true
          });
        }
        attempt += 1;
        await this.backoff(attempt, response.headers.get('retry-after'));
        continue;
      }
      if (response.status >= 500) {
        if (attempt >= this.maxRetries) {
          throw new MlsError('UPSTREAM_UNAVAILABLE', `MLS Grid returned HTTP ${response.status} after retries`, {
            details: { status: response.status },
            retryable: true
          });
        }
        attempt += 1;
        await this.backoff(attempt, null);
        continue;
      }
      if (!response.ok) {
        // 4xx other than auth/rate-limit: request construction problem; not retryable.
        throw new MlsError('VALIDATION', `MLS Grid rejected the request (HTTP ${response.status})`, {
          details: { status: response.status }
        });
      }

      return this.parseBody(response);
    }
  }

  private async doFetch(url: string): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.fetchFn(url, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: 'application/json'
        },
        signal: controller.signal
      });
    } finally {
      clearTimeout(timer);
    }
  }

  private async parseBody(response: Response): Promise<ODataResponse> {
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new MlsError('MALFORMED_RESPONSE', 'MLS Grid returned a non-JSON body');
    }
    if (body === null || typeof body !== 'object') {
      throw new MlsError('MALFORMED_RESPONSE', 'MLS Grid returned an unexpected body shape');
    }
    const obj = body as Record<string, unknown>;
    const value = obj.value;
    if (!Array.isArray(value)) {
      throw new MlsError('MALFORMED_RESPONSE', 'MLS Grid response is missing the OData "value" array');
    }
    const nextLinkRaw = obj['@odata.nextLink'];
    const countRaw = obj['@odata.count'];
    return {
      value,
      nextLink: typeof nextLinkRaw === 'string' && nextLinkRaw.length > 0 ? nextLinkRaw : null,
      count: typeof countRaw === 'number' && Number.isFinite(countRaw) ? countRaw : null
    };
  }

  /**
   * Space out requests by at least minIntervalMs.
   *
   * Admission is serialized through a promise chain: concurrent callers (the
   * market snapshot runs three query chains at once) each wait for the previous
   * caller to claim its slot before computing their own delay. Without this,
   * simultaneous callers all read the same lastRequestAt, compute the same
   * delay, and then fire together — collapsing the throttle exactly when the
   * request volume is highest.
   */
  private async throttle(): Promise<void> {
    const previous = this.admission;
    let admit!: () => void;
    this.admission = new Promise<void>((resolve) => {
      admit = resolve;
    });
    try {
      await previous;
      const wait = this.lastRequestAt + this.minIntervalMs - Date.now();
      if (wait > 0) await this.sleepFn(wait);
      this.lastRequestAt = Date.now();
    } finally {
      // Always release the next caller, even if this one failed to claim a slot.
      admit();
    }
  }

  private async backoff(attempt: number, retryAfterHeader: string | null): Promise<void> {
    let delay = Math.min(500 * 2 ** (attempt - 1), 15_000);
    if (retryAfterHeader) {
      const secs = Number(retryAfterHeader);
      if (Number.isFinite(secs) && secs > 0) delay = Math.min(secs * 1000, 30_000);
    }
    this.logger.warn('mlsgrid retrying request', { attempt, delay_ms: delay });
    await this.sleepFn(delay);
  }
}
