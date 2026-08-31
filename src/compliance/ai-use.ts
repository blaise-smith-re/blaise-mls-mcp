/**
 * AI-use policy enforcement, derived from the AI USE ADDENDUM TO MLS GRID DATA
 * LICENSE AGREEMENT (reviewed 2026-08-30; see docs/AI_USE_ADDENDUM_REVIEW.md).
 *
 * This module is not legal advice and grants nothing. It only provides
 * technical means to WITHHOLD access. Every gate defaults closed, and no code
 * path infers permission from the absence of a prohibition.
 *
 * TWO INDEPENDENT AXES
 * --------------------
 * Data-license use and AI authorization basis are separate concepts and are
 * modeled separately:
 *
 *   DATA-LICENSE USE (open, extensible) — which MLS Grid data-use selections
 *   are licensed and selected via the Data Interface (§2): IDX, VOW,
 *   Comparative Market Analysis, Customer Relationship Management, Real Estate
 *   Market Analytics, Participant Listings Use, or any future approved use.
 *
 *   AI AUTHORIZATION BASIS (closed, §1.e) — permitted_search_response,
 *   permitted_marketing, or written_mls_approval.
 *
 * A tool runs only when the kill switch is on AND both axes are satisfied for
 * that tool. Neither axis alone authorizes anything: holding a data license is
 * not AI permission, and an AI basis without the underlying data use is not
 * either.
 *
 * Clauses enforced here:
 *   §1.e  Authorized AI Use is the closed set above; all other AI use is
 *         prohibited unless expressly authorized in writing.
 *   §1.i  Permitted Search/Response Use applies to "IDX Uses or VOW Uses
 *         (i.e., with IDX or VOW licenses)".
 *   §2    Authorized use is limited to the usage options selected via the
 *         Data Interface.
 *   §3.c  "Vendor must retain the ability to restrict, suspend, and terminate
 *         an AI Tool's access to and use of MLS GRID Data at any time."
 */

import type { AiAuthorizationBasis, DataLicenseUse, ToolRequirement } from './tool-requirements.js';
import {
  AI_AUTHORIZATION_BASES,
  DATA_USE_PATTERN,
  KNOWN_DATA_LICENSE_USES,
  TOOL_REQUIREMENTS,
  toolRequirement
} from './tool-requirements.js';

export type { AiAuthorizationBasis, DataLicenseUse } from './tool-requirements.js';
export { AI_AUTHORIZATION_BASES, KNOWN_DATA_LICENSE_USES } from './tool-requirements.js';

/**
 * Uses this server must never perform on MLS Grid Data, regardless of
 * configuration. Drawn from §1.d (AI Training) and §3. No environment variable
 * enables any of these, and `tests/no-persistence.test.ts` asserts the codebase
 * contains no implementation of them.
 */
export const PROHIBITED_USES: readonly string[] = [
  '§1.d — vector embeddings of MLS Grid Data',
  '§1.d — retrieval indices or similarity-search stores',
  '§1.d — knowledge graphs built from MLS Grid Data',
  '§1.d — training, fine-tuning, aligning, embedding, distilling, RLHF, validation, testing or retraining',
  '§1.d — any representation of MLS Grid Data persisting beyond a single user session',
  '§1.d — any use enabling output derived from MLS Grid Data without contemporaneous access to that data',
  '§3.a — caching, storing, archiving or retaining beyond the duration needed for an individual user query',
  '§3.d — rendering data unattributable to the Participant, MLS, or MLS GRID',
  "§3.d — merging MLS Grid Data into a model's general knowledge base",
  '§3.e — generating outputs, derivative works or synthetic data to reconstruct, replicate or compete with MLS GRID, an MLS, or the MLS Grid Data',
  'Storage in Claude project knowledge, memory, or any assistant-side store'
];

export interface AiUsePolicyInput {
  provider: 'fixture' | 'mlsgrid';
  /** §3.c kill switch. Default OFF for the live provider. */
  aiAccessEnabled: boolean;
  /** §2 declared data-license uses actually licensed and selected. */
  dataLicenseUses: DataLicenseUse[];
  /** §1.e declared AI authorization bases. */
  aiAuthorizationBases: AiAuthorizationBasis[];
  /** Required whenever 'written_mls_approval' is declared. Never inferred. */
  writtenApprovalReference: string | undefined;
  /** Optional further narrowing. When non-empty, only these tools may run. */
  authorizedTools: string[];
}

export type DenialCode =
  | 'AI_ACCESS_DISABLED'
  | 'NO_AI_AUTHORIZATION_BASIS'
  | 'NO_DATA_LICENSE_USE'
  | 'DATA_USE_NOT_LICENSED'
  | 'BASIS_NOT_DECLARED'
  | 'TOOL_NOT_IN_ALLOWLIST'
  | 'UNKNOWN_TOOL';

export interface ToolAccessDecision {
  allowed: boolean;
  code: DenialCode | null;
  reason: string | null;
  /** Which declared data uses would satisfy this tool, when authorized. */
  satisfied_by_data_uses: DataLicenseUse[];
  /** Which declared bases would satisfy this tool, when authorized. */
  satisfied_by_bases: AiAuthorizationBasis[];
}

function allow(dataUses: DataLicenseUse[], bases: AiAuthorizationBasis[]): ToolAccessDecision {
  return {
    allowed: true,
    code: null,
    reason: null,
    satisfied_by_data_uses: dataUses,
    satisfied_by_bases: bases
  };
}

function deny(code: DenialCode, reason: string): ToolAccessDecision {
  return { allowed: false, code, reason, satisfied_by_data_uses: [], satisfied_by_bases: [] };
}

export interface ToolRegisterEntry {
  tool: string;
  technical_capability: string;
  business_uses: string[];
  data_use_requirement: {
    any_of: DataLicenseUse[];
    declared_and_matching: DataLicenseUse[];
    satisfied: boolean;
  };
  possible_ai_basis: {
    any_of: AiAuthorizationBasis[];
    declared_and_matching: AiAuthorizationBasis[];
    satisfied: boolean;
  };
  authorization_state: 'authorized' | 'withheld' | 'not_applicable';
  withheld_reason: string | null;
}

export class AiUsePolicy {
  readonly provider: 'fixture' | 'mlsgrid';
  readonly aiAccessEnabled: boolean;
  readonly dataLicenseUses: readonly DataLicenseUse[];
  readonly aiAuthorizationBases: readonly AiAuthorizationBasis[];
  readonly writtenApprovalReference: string | undefined;
  private readonly authorizedTools: ReadonlySet<string>;

  constructor(input: AiUsePolicyInput) {
    this.provider = input.provider;
    this.aiAccessEnabled = input.aiAccessEnabled;
    this.dataLicenseUses = [...input.dataLicenseUses];
    this.aiAuthorizationBases = [...input.aiAuthorizationBases];
    this.writtenApprovalReference = input.writtenApprovalReference;
    this.authorizedTools = new Set(input.authorizedTools);
  }

  /**
   * True when this policy governs MLS Grid Data. The fixture provider serves
   * records generated from a seeded PRNG that were never derived from MLS Grid
   * Data, so the Addendum's restrictions do not attach to them.
   */
  get governsLicensedData(): boolean {
    return this.provider === 'mlsgrid';
  }

  /** True when the kill switch is on and both axes carry at least one declaration. */
  get liveAccessPermitted(): boolean {
    if (!this.governsLicensedData) return false;
    return (
      this.aiAccessEnabled && this.aiAuthorizationBases.length > 0 && this.dataLicenseUses.length > 0
    );
  }

  private intersectDataUses(requirement: ToolRequirement): DataLicenseUse[] {
    return requirement.data_uses.filter((u) => this.dataLicenseUses.includes(u));
  }

  private intersectBases(requirement: ToolRequirement): AiAuthorizationBasis[] {
    return requirement.bases.filter((b) => this.aiAuthorizationBases.includes(b));
  }

  /** Whether one named tool may run, and precisely why not when it may not. */
  evaluateTool(toolName: string): ToolAccessDecision {
    const requirement = toolRequirement(toolName);
    if (!requirement) {
      return deny('UNKNOWN_TOOL', `Tool "${toolName}" has no declared authorization requirement.`);
    }
    // Tools that touch no MLS data are always available, in either provider.
    if (!requirement.requires_mls_data) return allow([], []);
    if (!this.governsLicensedData) return allow([], []);

    if (!this.aiAccessEnabled) {
      return deny(
        'AI_ACCESS_DISABLED',
        'Live MLS AI access is switched OFF (Addendum §3.c). Set MLS_AI_ACCESS_ENABLED=true once the ' +
          'applicable authorization exists. The capability itself remains fully implemented.'
      );
    }
    if (this.aiAuthorizationBases.length === 0) {
      return deny(
        'NO_AI_AUTHORIZATION_BASIS',
        'No AI authorization basis is declared (Addendum §1.e). Set MLS_AI_AUTHORIZATION_BASES to the basis ' +
          'the applicable authorization provides.'
      );
    }
    if (this.dataLicenseUses.length === 0) {
      return deny(
        'NO_DATA_LICENSE_USE',
        'No MLS Grid data-license use is declared (Addendum §2). Set MLS_DATA_LICENSE_USES to the usage ' +
          'options actually selected via the Data Interface.'
      );
    }

    const matchingDataUses = this.intersectDataUses(requirement);
    if (matchingDataUses.length === 0) {
      return deny(
        'DATA_USE_NOT_LICENSED',
        `No declared data-license use underpins "${toolName}". This capability is implemented and ready; it ` +
          `activates once one of [${requirement.data_uses.join(', ')}] is licensed, selected via the Data ` +
          `Interface, and declared. Currently declared: [${this.dataLicenseUses.join(', ') || 'none'}].`
      );
    }

    const matchingBases = this.intersectBases(requirement);
    if (matchingBases.length === 0) {
      return deny(
        'BASIS_NOT_DECLARED',
        `No declared AI authorization basis covers "${toolName}". It activates under one of ` +
          `[${requirement.bases.join(', ')}]. Currently declared: [${this.aiAuthorizationBases.join(', ') || 'none'}].`
      );
    }

    // Optional narrowing: when an allowlist is configured it further restricts,
    // but it can never widen what the two axes above permit.
    if (this.authorizedTools.size > 0 && !this.authorizedTools.has(toolName)) {
      return deny(
        'TOOL_NOT_IN_ALLOWLIST',
        `Tool "${toolName}" is excluded by MLS_AI_AUTHORIZED_TOOLS, which narrows the authorized set further.`
      );
    }

    // written_mls_approval is never inferred: it authorizes only tools the
    // operator names explicitly, alongside the written reference.
    if (matchingBases.length === 1 && matchingBases[0] === 'written_mls_approval') {
      if (!this.writtenApprovalReference?.trim()) {
        return deny(
          'BASIS_NOT_DECLARED',
          'written_mls_approval requires MLS_AI_WRITTEN_APPROVAL_REFERENCE identifying the written approval.'
        );
      }
      if (!this.authorizedTools.has(toolName)) {
        return deny(
          'TOOL_NOT_IN_ALLOWLIST',
          `"${toolName}" relies solely on written_mls_approval, which is never inferred. Name it explicitly in ` +
            'MLS_AI_AUTHORIZED_TOOLS to confirm the written approval covers it.'
        );
      }
    }

    return allow(matchingDataUses, matchingBases);
  }

  filterTools(toolNames: readonly string[]): string[] {
    return toolNames.filter((name) => this.evaluateTool(name).allowed);
  }

  /**
   * Per-tool capability register: technical capability, data-use requirement,
   * possible AI basis, current authorization state, and the reason when
   * withheld. Every tool appears, including withheld ones — a capability that
   * is merely unauthorized is not a missing capability.
   */
  register(): ToolRegisterEntry[] {
    return TOOL_REQUIREMENTS.map((requirement) => {
      const decision = this.evaluateTool(requirement.name);
      const matchingDataUses = this.intersectDataUses(requirement);
      const matchingBases = this.intersectBases(requirement);
      return {
        tool: requirement.name,
        technical_capability: requirement.capability,
        business_uses: requirement.business_uses,
        data_use_requirement: {
          any_of: requirement.data_uses,
          declared_and_matching: matchingDataUses,
          satisfied: !requirement.requires_mls_data || matchingDataUses.length > 0
        },
        possible_ai_basis: {
          any_of: requirement.bases,
          declared_and_matching: matchingBases,
          satisfied: !requirement.requires_mls_data || matchingBases.length > 0
        },
        authorization_state: !requirement.requires_mls_data
          ? 'not_applicable'
          : decision.allowed
            ? 'authorized'
            : 'withheld',
        withheld_reason: decision.allowed ? null : decision.reason
      };
    });
  }

  /** Serializable posture, safe to expose on /health and get_capabilities. */
  describe(): Record<string, unknown> {
    return {
      governs_mls_grid_data: this.governsLicensedData,
      ai_access_enabled: this.aiAccessEnabled,
      live_access_permitted: this.liveAccessPermitted,
      data_license_uses: [...this.dataLicenseUses],
      ai_authorization_bases: [...this.aiAuthorizationBases],
      written_approval_reference: this.writtenApprovalReference ?? null,
      tool_allowlist_narrowing: [...this.authorizedTools].sort(),
      prohibited_uses: PROHIBITED_USES,
      retention: 'None. MLS Grid Data exists only for the lifetime of the request that retrieved it (§3.a).',
      model:
        'Data-license use and AI authorization basis are independent. A tool runs only when the kill switch is ' +
        'on and both axes are satisfied for that tool. Holding a data license is not AI permission, and an AI ' +
        'basis without the underlying data use is not either.',
      notes: [
        'Every capability remains implemented regardless of authorization state. Withheld means unauthorized, not absent.',
        'Permitted Search/Response Use (§1.i) requires an IDX or VOW data-license use.',
        'Permitted Marketing Use (§1.h/§1.g) covers Marketing Content for the Participant\'s own listings or business.',
        'written_mls_approval is never inferred: it requires a written reference and an explicit tool listing.',
        'Material Addendum updates take effect 15 days after notice (§6); re-review on notice.'
      ]
    };
  }
}

export interface DeclarationValidation {
  dataUses: DataLicenseUse[];
  bases: AiAuthorizationBasis[];
  /** Declared uses not in the known list — accepted, but surfaced. */
  unknownDataUses: DataLicenseUse[];
  error: string | null;
}

/**
 * Validate the operator's declaration.
 *
 * Data uses are open: an unrecognized but well-formed value is accepted so a
 * future MLS Grid-approved selection needs no code change. AI bases are closed
 * (§1.e) and an unrecognized value is rejected.
 */
export function validateAiUseDeclaration(
  rawDataUses: string[],
  rawBases: string[],
  writtenApprovalReference: string | undefined
): DeclarationValidation {
  const empty = { dataUses: [], bases: [], unknownDataUses: [] };

  const malformed = rawDataUses.filter((u) => !DATA_USE_PATTERN.test(u));
  if (malformed.length > 0) {
    return {
      ...empty,
      error:
        `Malformed data-license use: ${malformed.join(', ')}. Use lowercase slugs, e.g. ` +
        `${KNOWN_DATA_LICENSE_USES.slice(0, 3).join(', ')}.`
    };
  }

  const knownBases = new Set<string>(AI_AUTHORIZATION_BASES);
  const unknownBases = rawBases.filter((b) => !knownBases.has(b));
  if (unknownBases.length > 0) {
    return {
      ...empty,
      error:
        `Unrecognized AI authorization basis: ${unknownBases.join(', ')}. The Addendum's set is closed (§1.e): ` +
        `${AI_AUTHORIZATION_BASES.join(', ')}. A data-license use such as back_office or comparative_market_analysis ` +
        'is not an AI authorization basis — declare it in MLS_DATA_LICENSE_USES instead.'
    };
  }

  const dataUses = rawDataUses as DataLicenseUse[];
  const bases = rawBases as AiAuthorizationBasis[];

  if (bases.includes('written_mls_approval') && !writtenApprovalReference?.trim()) {
    return {
      ...empty,
      error:
        'Declaring written_mls_approval requires MLS_AI_WRITTEN_APPROVAL_REFERENCE identifying the written ' +
        'authorization from MLS GRID or the applicable MLS (Addendum §1.e / §2). It is never inferred.'
    };
  }

  // §1.i ties Permitted Search/Response Use to IDX or VOW licensed uses.
  if (bases.includes('permitted_search_response')) {
    const hasIdxOrVow = dataUses.includes('idx') || dataUses.includes('vow');
    if (!hasIdxOrVow) {
      return {
        ...empty,
        error:
          'permitted_search_response requires an idx or vow data-license use. Addendum §1.i defines Permitted ' +
          'Search/Response Use as use "for IDX Uses or VOW Uses (i.e., with IDX or VOW licenses)". Declare idx or ' +
          'vow in MLS_DATA_LICENSE_USES, or rely on a different basis.'
      };
    }
  }

  const known = new Set<string>(KNOWN_DATA_LICENSE_USES);
  return {
    dataUses,
    bases,
    unknownDataUses: dataUses.filter((u) => !known.has(u)),
    error: null
  };
}
