import { describe, expect, it } from 'vitest';
import { MlsError } from '../src/errors.js';
import {
  DEFAULT_SERVER_FILTERABLE_FIELDS,
  MAX_OR_TERMS,
  ODataFilterBuilder,
  escapeODataString
} from '../src/provider/mlsgrid/odata.js';

describe('OData escaping', () => {
  it('doubles single quotes so a literal cannot terminate its own string', () => {
    expect(escapeODataString("O'Brien")).toBe("O''Brien");
  });

  it('neutralizes an attempted filter-injection payload', () => {
    const payload = "Woodbury' or ListPrice gt 0 or City eq 'x";
    expect(escapeODataString(payload)).toBe("Woodbury'' or ListPrice gt 0 or City eq ''x");
  });

  it('rejects control characters', () => {
    expect(() => escapeODataString('Wood\u0000bury')).toThrow(MlsError);
    expect(() => escapeODataString('Wood\nbury')).toThrow(MlsError);
  });
});

describe('ODataFilterBuilder', () => {
  const allowlist = [...DEFAULT_SERVER_FILTERABLE_FIELDS, 'City'];

  it('builds an and-joined filter and reports served predicates', () => {
    const b = new ODataFilterBuilder(allowlist)
      .where({ field: 'OriginatingSystemName', op: 'eq', value: 'northstar' }, 'originating_system')
      .whereIn({ field: 'StandardStatus', values: ['Active', 'Pending'] }, 'statuses');
    expect(b.build()).toBe(
      "OriginatingSystemName eq 'northstar' and (StandardStatus eq 'Active' or StandardStatus eq 'Pending')"
    );
    expect(b.servedPredicates).toEqual(['originating_system', 'statuses']);
  });

  it('escapes injected quotes inside a built filter', () => {
    const filter = new ODataFilterBuilder(allowlist)
      .where({ field: 'City', op: 'eq', value: "x' or ListPrice gt 0 or City eq 'y" })
      .build();
    expect(filter).toBe("City eq 'x'' or ListPrice gt 0 or City eq ''y'");
    // The payload's quotes are all doubled, so no unescaped quote can close the literal.
    expect(filter.match(/'/g)!.length % 2).toBe(0);
  });

  it('refuses a field outside the allowlist', () => {
    const b = new ODataFilterBuilder(['OriginatingSystemName']);
    expect(() => b.where({ field: 'ListPrice', op: 'gt', value: 100 })).toThrow(/not in the server-side filterable allowlist/);
  });

  it('refuses a syntactically invalid field name', () => {
    const b = new ODataFilterBuilder(['OriginatingSystemName']);
    expect(() => b.where({ field: "City eq 'x' or 1", op: 'eq', value: 'y' })).toThrow(/Invalid OData field name/);
  });

  it('bounds OR chains to the conservative limit', () => {
    const values = Array.from({ length: MAX_OR_TERMS + 1 }, (_, i) => `V${i}`);
    const b = new ODataFilterBuilder(allowlist);
    expect(() => b.whereIn({ field: 'City', values })).toThrow(/exceeds the conservative/);
  });

  it('rejects an empty OR group', () => {
    const b = new ODataFilterBuilder(allowlist);
    expect(() => b.whereIn({ field: 'City', values: [] })).toThrow(/at least one value/);
  });

  it('emits a single-value OR group without parentheses', () => {
    const filter = new ODataFilterBuilder(allowlist).whereIn({ field: 'City', values: ['Woodbury'] }).build();
    expect(filter).toBe("City eq 'Woodbury'");
  });

  it('refuses to build an empty (unbounded) filter', () => {
    expect(() => new ODataFilterBuilder(allowlist).build()).toThrow(/empty \$filter/);
  });

  it('accepts an ISO datetime as a raw literal', () => {
    const filter = new ODataFilterBuilder(allowlist)
      .where({ field: 'ModificationTimestamp', op: 'ge', value: '2026-08-01T00:00:00Z', raw: true })
      .build();
    expect(filter).toBe('ModificationTimestamp ge 2026-08-01T00:00:00Z');
  });

  it('refuses a non-ISO raw literal, closing the unquoted-injection path', () => {
    const b = new ODataFilterBuilder(allowlist);
    expect(() =>
      b.where({ field: 'ModificationTimestamp', op: 'ge', value: "2026-01-01 or ListPrice gt 0", raw: true })
    ).toThrow(/ISO 8601/);
  });

  it('rejects non-finite numeric values', () => {
    const b = new ODataFilterBuilder(allowlist);
    expect(() => b.where({ field: 'City', op: 'eq', value: Number.NaN })).toThrow(/finite/);
  });
});
