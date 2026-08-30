/**
 * Structured error taxonomy. Every error crossing a layer boundary is an MlsError
 * with a stable machine-readable code. Messages must never contain credentials
 * or full confidential MLS payloads.
 */

export type MlsErrorCode =
  | 'CONFIG'
  | 'VALIDATION'
  | 'AUTH'
  | 'RATE_LIMITED'
  | 'UPSTREAM_UNAVAILABLE'
  | 'TIMEOUT'
  | 'MALFORMED_RESPONSE'
  | 'UNSUPPORTED_CAPABILITY'
  | 'NOT_FOUND'
  | 'INTERNAL';

export class MlsError extends Error {
  readonly code: MlsErrorCode;
  /** Safe, redacted details for the caller. */
  readonly details?: Record<string, unknown>;
  readonly retryable: boolean;

  constructor(
    code: MlsErrorCode,
    message: string,
    opts: { details?: Record<string, unknown>; retryable?: boolean; cause?: unknown } = {}
  ) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = 'MlsError';
    this.code = code;
    this.details = opts.details;
    this.retryable = opts.retryable ?? false;
  }

  toJSON(): Record<string, unknown> {
    return {
      error: this.code,
      message: this.message,
      ...(this.details ? { details: this.details } : {}),
      retryable: this.retryable
    };
  }
}

const TOKEN_PATTERN = /(bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi;

/** Strip anything token-shaped from a string destined for logs or errors. */
export function redactSecrets(text: string): string {
  return text.replace(TOKEN_PATTERN, '$1[REDACTED]');
}

/** Convert an unknown thrown value into a safe MlsError without leaking secrets. */
export function toMlsError(err: unknown, fallbackCode: MlsErrorCode = 'INTERNAL'): MlsError {
  if (err instanceof MlsError) return err;
  const message = err instanceof Error ? redactSecrets(err.message) : 'Unknown error';
  return new MlsError(fallbackCode, message, { cause: err });
}
