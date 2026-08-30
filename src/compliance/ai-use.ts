/**
 * AI-use policy enforcement, derived from the AI USE ADDENDUM TO MLS GRID DATA
 * LICENSE AGREEMENT (reviewed 2026-08-30; see docs/AI_USE_ADDENDUM_REVIEW.md).
 *
 * This module is not legal advice and grants nothing. It only provides
 * technical means to WITHHOLD access. Every gate defaults closed, and no code
 * path infers permission from the absence of a prohibition.
 *
 * Where deciding whether a capability falls inside a permitted use would
 * require a licensing judgment, this module refuses to make it and requires the
 * operator to declare it explicitly instead.
 *
 * Clauses enforced here:
 *   §1.e  Authorized AI Use = Permitted Search/Response Use, Permitted
 *         Marketing Use, and other uses expressly authorized in writing by
 *         MLS GRID or an MLS. All other AI use is prohibited.
 *   §1.i  Permitted Search/Response Use applies to "IDX Uses or VOW Uses
 *         (i.e., with IDX or VOW licenses)". A Back Office license does not
 *         carry it.
 *   §2    Authorized use is limited to "those usage options selected via the
 *         Data Interface".
 *   §3.c  "Vendor must retain the ability to restrict, suspend, and terminate
 *         an AI Tool's access to and use of MLS GRID Data at any time."
 *         — the contractual basis for the kill switch below.
 */

/**
 * §1.e. Deliberately closed: a basis not listed here cannot be configured, so
 * no unlisted use can be enabled by configuration alone.
 */
export const AUTHORIZED_USE_BASES = [
  'permitted_marketing_use',
  'permitted_search_response_use',
  'written_authorization'
] as const;

export type AuthorizedUseBasis = (typeof AUTHORIZED_USE_BASES)[number];

/**
 * Data-license classes the operator may declare. Back Office is listed because
 * it may well be the class actually held — but per §1.i it does NOT carry
 * Permitted Search/Response Use, and `validateAiUseDeclaration` enforces that.
 */
export const LICENSE_CLASSES = ['idx', 'vow', 'back_office'] as const;
export type LicenseClass = (typeof LICENSE_CLASSES)[number];

/**
 * Uses this server must never perform on MLS Grid Data, regardless of
 * configuration. Drawn from §1.d (AI Training) and §3. There is no environment
 * variable that enables any of these, and `tests/no-persistence.test.ts`
 * asserts the codebase contains no implementation of them.
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
  '§3.d — merging MLS Grid Data into a model\'s general knowledge base',
  '§3.e — generating outputs, derivative works or synthetic data to reconstruct, replicate or compete with MLS GRID, an MLS, or the MLS Grid Data',
  'Storage in Claude project knowledge, memory, or any assistant-side store'
];

export interface AiUsePolicyInput {
  provider: 'fixture' | 'mlsgrid';
  /** §3.c kill switch. Default OFF for the live provider. */
  aiAccessEnabled: boolean;
  /** §1.e declared bases. Must be non-empty for live access. */
  authorizedUseBases: AuthorizedUseBasis[];
  /** §1.i / §2 declared data-license classes actually held and selected. */
  licenseClasses: LicenseClass[];
  /** Required when 'written_authorization' is declared (§1.e). */
  writtenApprovalReference: string | undefined;
  /** Explicit per-tool allowlist. Empty means no live tool is available. */
  authorizedTools: string[];
}

export interface ToolAccessDecision {
  allowed: boolean;
  code: 'AI_ACCESS_DISABLED' | 'NO_AUTHORIZED_USE_BASIS' | 'TOOL_NOT_AUTHORIZED' | null;
  reason: string | null;
}

const ALLOWED: ToolAccessDecision = { allowed: true, code: null, reason: null };

export class AiUsePolicy {
  readonly provider: 'fixture' | 'mlsgrid';
  readonly aiAccessEnabled: boolean;
  readonly authorizedUseBases: readonly AuthorizedUseBasis[];
  readonly licenseClasses: readonly LicenseClass[];
  readonly writtenApprovalReference: string | undefined;
  private readonly authorizedTools: ReadonlySet<string>;

  constructor(input: AiUsePolicyInput) {
    this.provider = input.provider;
    this.aiAccessEnabled = input.aiAccessEnabled;
    this.authorizedUseBases = [...input.authorizedUseBases];
    this.licenseClasses = [...input.licenseClasses];
    this.writtenApprovalReference = input.writtenApprovalReference;
    this.authorizedTools = new Set(input.authorizedTools);
  }

  /**
   * True when this policy governs MLS Grid Data. The fixture provider serves
   * records generated from a seeded PRNG that were never derived from MLS Grid
   * Data, so §3.e's synthetic-data prohibition has nothing to attach to and the
   * Addendum's restrictions do not apply to them.
   */
  get governsLicensedData(): boolean {
    return this.provider === 'mlsgrid';
  }

  /** True when live access is fully declared and switched on. */
  get liveAccessPermitted(): boolean {
    if (!this.governsLicensedData) return false;
    return this.aiAccessEnabled && this.authorizedUseBases.length > 0;
  }

  /**
   * Whether one named tool may run.
   *
   * Tool-to-basis mapping is deliberately NOT inferred: deciding whether a
   * given tool constitutes Permitted Marketing Use (§1.h, limited to marketing
   * the Participant's own listings or business) or Permitted Search/Response
   * Use (§1.i, requiring an IDX or VOW license) is a licensing judgment. The
   * operator must allowlist each tool explicitly.
   */
  evaluateTool(toolName: string): ToolAccessDecision {
    if (!this.governsLicensedData) return ALLOWED;

    if (!this.aiAccessEnabled) {
      return {
        allowed: false,
        code: 'AI_ACCESS_DISABLED',
        reason:
          'Live MLS AI access is switched OFF (Addendum §3.c). This server will not retrieve MLS Grid Data ' +
          'until MLS_AI_ACCESS_ENABLED is explicitly set to true by the operator.'
      };
    }
    if (this.authorizedUseBases.length === 0) {
      return {
        allowed: false,
        code: 'NO_AUTHORIZED_USE_BASIS',
        reason:
          'No Authorized AI Use basis is declared (Addendum §1.e). Set MLS_AI_AUTHORIZED_USE_BASES to the use(s) ' +
          'the executed Addendum actually authorizes. A Back Office data license is not itself an AI-use basis.'
      };
    }
    if (!this.authorizedTools.has(toolName)) {
      return {
        allowed: false,
        code: 'TOOL_NOT_AUTHORIZED',
        reason:
          `Tool "${toolName}" is not in MLS_AI_AUTHORIZED_TOOLS. Each tool must be individually authorized ` +
          'against the executed Addendum; this server will not infer that a tool falls within a permitted use.'
      };
    }
    return ALLOWED;
  }

  filterTools(toolNames: readonly string[]): string[] {
    return toolNames.filter((name) => this.evaluateTool(name).allowed);
  }

  /** Serializable posture, safe to expose on /health and get_capabilities. */
  describe(): Record<string, unknown> {
    return {
      governs_mls_grid_data: this.governsLicensedData,
      ai_access_enabled: this.aiAccessEnabled,
      live_access_permitted: this.liveAccessPermitted,
      authorized_use_bases: [...this.authorizedUseBases],
      license_classes: [...this.licenseClasses],
      written_approval_reference: this.writtenApprovalReference ?? null,
      authorized_tools: [...this.authorizedTools].sort(),
      prohibited_uses: PROHIBITED_USES,
      retention: 'None. MLS Grid Data exists only for the lifetime of the request that retrieved it (§3.a).',
      basis_notes: [
        'Permitted Search/Response Use (§1.i) applies to IDX or VOW licensed uses. A Back Office license does not carry it.',
        'Permitted Marketing Use (§1.h/§1.g) covers Marketing Content for the Participant\'s own listings or business.',
        'Authorized use is further limited to the usage options actually selected via the MLS Grid Data Interface (§2).',
        'Material Addendum updates take effect 15 days after notice (§6); re-review on notice.'
      ]
    };
  }
}

export interface DeclarationValidation {
  bases: AuthorizedUseBasis[];
  classes: LicenseClass[];
  error: string | null;
}

/**
 * Validate the operator's declaration. Returns an error message, or null when
 * valid. Kept separate from config parsing so each rule is testable alone.
 */
export function validateAiUseDeclaration(
  rawBases: string[],
  rawClasses: string[],
  writtenApprovalReference: string | undefined
): DeclarationValidation {
  const knownBases = new Set<string>(AUTHORIZED_USE_BASES);
  const unknownBases = rawBases.filter((b) => !knownBases.has(b));
  if (unknownBases.length > 0) {
    return {
      bases: [],
      classes: [],
      error:
        `Unrecognized AI-use basis: ${unknownBases.join(', ')}. Permitted values are ` +
        `${AUTHORIZED_USE_BASES.join(', ')} (Addendum §1.e). A Back Office data license is not an AI-use basis.`
    };
  }

  const knownClasses = new Set<string>(LICENSE_CLASSES);
  const unknownClasses = rawClasses.filter((c) => !knownClasses.has(c));
  if (unknownClasses.length > 0) {
    return {
      bases: [],
      classes: [],
      error: `Unrecognized license class: ${unknownClasses.join(', ')}. Permitted values are ${LICENSE_CLASSES.join(', ')}.`
    };
  }

  const bases = rawBases as AuthorizedUseBasis[];
  const classes = rawClasses as LicenseClass[];

  if (bases.includes('written_authorization') && !writtenApprovalReference?.trim()) {
    return {
      bases: [],
      classes: [],
      error:
        'Declaring written_authorization requires MLS_AI_WRITTEN_APPROVAL_REFERENCE identifying the written ' +
        'authorization from MLS GRID or an MLS being relied upon (Addendum §1.e).'
    };
  }

  // §1.i ties Permitted Search/Response Use to IDX or VOW licensed uses.
  if (bases.includes('permitted_search_response_use')) {
    const hasIdxOrVow = classes.includes('idx') || classes.includes('vow');
    if (!hasIdxOrVow) {
      return {
        bases: [],
        classes: [],
        error:
          'permitted_search_response_use requires an IDX or VOW license class. Addendum §1.i defines Permitted ' +
          'Search/Response Use as use "for IDX Uses or VOW Uses (i.e., with IDX or VOW licenses)". Declare idx ' +
          'or vow in MLS_AI_LICENSE_CLASSES, or rely on a different basis. A Back Office license alone does not ' +
          'carry this use.'
      };
    }
  }

  return { bases, classes, error: null };
}
