import { z } from 'zod';
import type { AiAuthorizationBasis, DataLicenseUse } from './compliance/ai-use.js';
import { validateAiUseDeclaration } from './compliance/ai-use.js';
import { MlsError } from './errors.js';

/**
 * All configuration comes from environment variables. Secrets (MLSGRID_TOKEN,
 * MCP_AUTH_TOKEN) are never logged and never leave the server process.
 *
 * MLS Grid values marked "provisional" are documentation-derived and must be
 * confirmed against live API metadata during certification (docs/CAPABILITIES.md).
 */

const boolFromEnv = z
  .string()
  .optional()
  .transform((v) => v === 'true' || v === '1');

const intFromEnv = (def: number, min: number, max: number) =>
  z
    .string()
    .optional()
    .transform((v, ctx) => {
      if (v === undefined || v === '') return def;
      const n = Number(v);
      if (!Number.isInteger(n) || n < min || n > max) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `must be an integer in [${min}, ${max}]` });
        return z.NEVER;
      }
      return n;
    });

const envSchema = z.object({
  MLS_PROVIDER: z.enum(['fixture', 'mlsgrid']).default('fixture'),

  MLSGRID_API_BASE: z.string().url().default('https://api.mlsgrid.com/v2'),
  MLSGRID_TOKEN: z.string().optional(),
  MLSGRID_ORIGINATING_SYSTEM: z.string().default('northstar'),
  MLSGRID_TIMEOUT_MS: intFromEnv(30_000, 1_000, 120_000),
  MLSGRID_MIN_REQUEST_INTERVAL_MS: intFromEnv(600, 0, 10_000),
  MLSGRID_MAX_RETRIES: intFromEnv(3, 0, 8),
  MLSGRID_PAGE_SIZE: intFromEnv(1_000, 1, 5_000),
  MLSGRID_MAX_PAGES_PER_QUERY: intFromEnv(5, 1, 50),
  MLSGRID_SERVER_FILTER_FIELDS: z.string().optional(),
  MLSGRID_EXPOSE_PRIVATE_REMARKS: boolFromEnv,

  MLS_DEFAULT_TIMEZONE: z.string().default('America/Chicago'),
  MLS_MAX_RECORDS_PER_QUERY: intFromEnv(2_500, 1, 25_000),

  // --- AI Use Addendum controls (see src/compliance/ai-use.ts) ---
  // Kill switch (§3.c). Defaults OFF: live MLS AI access must be switched on deliberately.
  MLS_AI_ACCESS_ENABLED: boolFromEnv,
  // Open, extensible: MLS Grid data-use selections actually licensed (§2).
  MLS_DATA_LICENSE_USES: z.string().optional(),
  // Closed set (§1.e).
  MLS_AI_AUTHORIZATION_BASES: z.string().optional(),
  MLS_AI_WRITTEN_APPROVAL_REFERENCE: z.string().optional(),
  MLS_AI_AUTHORIZED_TOOLS: z.string().optional(),
  MLS_PARTICIPANT_NAME: z.string().optional(),

  MCP_AUTH_TOKEN: z.string().optional(),

  PORT: intFromEnv(3_000, 1, 65_535),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  NODE_ENV: z.string().optional()
});

export interface AppConfig {
  provider: 'fixture' | 'mlsgrid';
  mlsgrid: {
    apiBase: string;
    token: string | undefined;
    originatingSystem: string;
    timeoutMs: number;
    minRequestIntervalMs: number;
    maxRetries: number;
    pageSize: number;
    maxPagesPerQuery: number;
    /** Optional override of the conservative server-side filterable field allowlist. */
    serverFilterFields: string[] | undefined;
    exposePrivateRemarks: boolean;
  };
  defaultTimezone: string;
  maxRecordsPerQuery: number;
  aiUse: {
    accessEnabled: boolean;
    dataLicenseUses: DataLicenseUse[];
    aiAuthorizationBases: AiAuthorizationBasis[];
    unknownDataUses: DataLicenseUse[];
    writtenApprovalReference: string | undefined;
    authorizedTools: string[];
    participantName: string | undefined;
  };
  mcpAuthToken: string | undefined;
  port: number;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  isProduction: boolean;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new MlsError('CONFIG', `Invalid environment configuration: ${issues}`);
  }
  const e = parsed.data;

  if (e.MLS_PROVIDER === 'mlsgrid' && (!e.MLSGRID_TOKEN || e.MLSGRID_TOKEN.trim() === '')) {
    throw new MlsError(
      'CONFIG',
      'MLS_PROVIDER=mlsgrid requires MLSGRID_TOKEN. No live MLS Grid token is configured; ' +
        'use MLS_PROVIDER=fixture until a licensed production token exists.'
    );
  }

  const csv = (v: string | undefined): string[] =>
    v?.trim() ? v.split(',').map((s) => s.trim()).filter(Boolean) : [];

  const declaration = validateAiUseDeclaration(
    csv(e.MLS_DATA_LICENSE_USES),
    csv(e.MLS_AI_AUTHORIZATION_BASES),
    e.MLS_AI_WRITTEN_APPROVAL_REFERENCE
  );
  if (declaration.error) {
    throw new MlsError('CONFIG', `Invalid AI-use declaration: ${declaration.error}`);
  }

  const serverFilterFields = e.MLSGRID_SERVER_FILTER_FIELDS?.trim()
    ? e.MLSGRID_SERVER_FILTER_FIELDS.split(',').map((f) => f.trim()).filter(Boolean)
    : undefined;

  return {
    provider: e.MLS_PROVIDER,
    mlsgrid: {
      apiBase: e.MLSGRID_API_BASE.replace(/\/+$/, ''),
      token: e.MLSGRID_TOKEN?.trim() || undefined,
      originatingSystem: e.MLSGRID_ORIGINATING_SYSTEM,
      timeoutMs: e.MLSGRID_TIMEOUT_MS,
      minRequestIntervalMs: e.MLSGRID_MIN_REQUEST_INTERVAL_MS,
      maxRetries: e.MLSGRID_MAX_RETRIES,
      pageSize: e.MLSGRID_PAGE_SIZE,
      maxPagesPerQuery: e.MLSGRID_MAX_PAGES_PER_QUERY,
      serverFilterFields,
      exposePrivateRemarks: e.MLSGRID_EXPOSE_PRIVATE_REMARKS
    },
    defaultTimezone: e.MLS_DEFAULT_TIMEZONE,
    maxRecordsPerQuery: e.MLS_MAX_RECORDS_PER_QUERY,
    aiUse: {
      accessEnabled: e.MLS_AI_ACCESS_ENABLED,
      dataLicenseUses: declaration.dataUses,
      aiAuthorizationBases: declaration.bases,
      unknownDataUses: declaration.unknownDataUses,
      writtenApprovalReference: e.MLS_AI_WRITTEN_APPROVAL_REFERENCE?.trim() || undefined,
      authorizedTools: csv(e.MLS_AI_AUTHORIZED_TOOLS),
      participantName: e.MLS_PARTICIPANT_NAME?.trim() || undefined
    },
    mcpAuthToken: e.MCP_AUTH_TOKEN?.trim() || undefined,
    port: e.PORT,
    logLevel: e.LOG_LEVEL,
    isProduction: e.NODE_ENV === 'production'
  };
}
