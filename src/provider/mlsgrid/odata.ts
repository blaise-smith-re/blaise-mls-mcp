import { MlsError } from '../../errors.js';

/**
 * Safe OData v4 filter construction for the MLS Grid API.
 *
 * Design rules:
 *  - No caller-supplied OData strings are ever passed through.
 *  - Only allowlisted fields may appear in a server-side $filter.
 *  - String literals are escaped (single quotes doubled) and control
 *    characters rejected.
 *  - OR-chains are bounded (MLS Grid documents OR-clause limits; the exact
 *    live limit is unverified, so we enforce a conservative cap).
 */

/**
 * PROVISIONAL server-side filterable fields, derived from public MLS Grid
 * documentation which describes a constrained searchable field set. This
 * conservative allowlist must be reconciled against live $metadata during
 * certification; it can be overridden via MLSGRID_SERVER_FILTER_FIELDS.
 */
export const DEFAULT_SERVER_FILTERABLE_FIELDS: readonly string[] = [
  'OriginatingSystemName',
  'ModificationTimestamp',
  'ListingId',
  'ListingKey',
  'StandardStatus',
  'MlsStatus',
  'PropertyType',
  'MemberMlsId',
  'MemberKey',
  'OfficeMlsId',
  'OfficeKey',
  'OpenHouseKey'
];

/** Conservative cap on OR terms inside a single clause (documented limit unverified). */
export const MAX_OR_TERMS = 10;

const FIELD_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9]*$/;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

export function escapeODataString(value: string): string {
  if (CONTROL_CHARS.test(value)) {
    throw new MlsError('VALIDATION', 'String filter values must not contain control characters');
  }
  return value.replace(/'/g, "''");
}

export type ODataPrimitive = string | number | boolean;

export interface ODataClause {
  field: string;
  op: 'eq' | 'ne' | 'gt' | 'ge' | 'lt' | 'le';
  value: ODataPrimitive;
  /** Raw (unquoted) literal, for date/datetime values that OData takes bare. */
  raw?: boolean;
}

export interface ODataOrGroup {
  field: string;
  values: ODataPrimitive[];
}

function literal(value: ODataPrimitive, raw: boolean): string {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new MlsError('VALIDATION', 'Numeric filter values must be finite');
    return String(value);
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return raw ? value : `'${escapeODataString(value)}'`;
}

function assertField(field: string, allowlist: ReadonlySet<string>): void {
  if (!FIELD_NAME_PATTERN.test(field)) {
    throw new MlsError('VALIDATION', `Invalid OData field name: ${JSON.stringify(field)}`);
  }
  if (!allowlist.has(field)) {
    throw new MlsError(
      'UNSUPPORTED_CAPABILITY',
      `Field "${field}" is not in the server-side filterable allowlist; it must be filtered client-side`,
      { details: { field } }
    );
  }
}

const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?)?$/;

/** Validate a raw date/datetime literal before it is embedded unquoted. */
function assertRawLiteral(value: ODataPrimitive): void {
  if (typeof value !== 'string' || !ISO_DATETIME.test(value)) {
    throw new MlsError('VALIDATION', 'Raw OData literals must be ISO 8601 date/datetime strings');
  }
}

export class ODataFilterBuilder {
  private readonly parts: string[] = [];
  private readonly allowlist: ReadonlySet<string>;
  private readonly served: string[] = [];

  constructor(allowlistFields: readonly string[] = DEFAULT_SERVER_FILTERABLE_FIELDS) {
    this.allowlist = new Set(allowlistFields);
  }

  /** Which logical predicates were pushed into this filter (for metadata). */
  get servedPredicates(): string[] {
    return [...this.served];
  }

  canServe(field: string): boolean {
    return FIELD_NAME_PATTERN.test(field) && this.allowlist.has(field);
  }

  where(clause: ODataClause, predicateName?: string): this {
    assertField(clause.field, this.allowlist);
    if (clause.raw) assertRawLiteral(clause.value);
    this.parts.push(`${clause.field} ${clause.op} ${literal(clause.value, clause.raw === true)}`);
    if (predicateName) this.served.push(predicateName);
    return this;
  }

  /** field eq v1 or field eq v2 ... — bounded OR-chain. */
  whereIn(group: ODataOrGroup, predicateName?: string): this {
    assertField(group.field, this.allowlist);
    if (group.values.length === 0) {
      throw new MlsError('VALIDATION', `OR group for "${group.field}" must have at least one value`);
    }
    if (group.values.length > MAX_OR_TERMS) {
      throw new MlsError(
        'VALIDATION',
        `OR group for "${group.field}" exceeds the conservative ${MAX_OR_TERMS}-term limit ` +
          '(MLS Grid documents constrained OR clauses; split the query instead)'
      );
    }
    const terms = group.values.map((v) => `${group.field} eq ${literal(v, false)}`);
    this.parts.push(group.values.length === 1 ? terms[0]! : `(${terms.join(' or ')})`);
    if (predicateName) this.served.push(predicateName);
    return this;
  }

  build(): string {
    if (this.parts.length === 0) {
      throw new MlsError('VALIDATION', 'Refusing to build an empty $filter (unbounded query)');
    }
    return this.parts.join(' and ');
  }
}
