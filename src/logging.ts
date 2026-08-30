import { redactSecrets } from './errors.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Keys whose values are always redacted from structured log fields. */
const SENSITIVE_KEYS = /^(authorization|token|api[_-]?key|secret|password|bearer|mlsgrid_token|mcp_auth_token)$/i;

export function redactFields(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[TRUNCATED]';
  if (typeof value === 'string') return redactSecrets(value);
  if (Array.isArray(value)) return value.map((v) => redactFields(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEYS.test(k) ? '[REDACTED]' : redactFields(v, depth + 1);
    }
    return out;
  }
  return value;
}

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

export interface LoggerOptions {
  level?: LogLevel;
  /** Injectable sink for tests. Defaults to stderr (stdout is reserved for stdio MCP transport). */
  write?: (line: string) => void;
}

export function createLogger(opts: LoggerOptions = {}): Logger {
  const level = opts.level ?? 'info';
  const write = opts.write ?? ((line: string) => process.stderr.write(line + '\n'));

  function emit(lvl: LogLevel, msg: string, fields?: Record<string, unknown>): void {
    if (LEVEL_ORDER[lvl] < LEVEL_ORDER[level]) return;
    const entry: Record<string, unknown> = {
      ts: new Date().toISOString(),
      level: lvl,
      msg: redactSecrets(msg)
    };
    if (fields) entry.fields = redactFields(fields);
    write(JSON.stringify(entry));
  }

  return {
    debug: (m, f) => emit('debug', m, f),
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f)
  };
}

export const nullLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined
};
