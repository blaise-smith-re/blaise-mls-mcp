import type { AiUsePolicy } from './ai-use.js';

/**
 * Source / MLS / provenance attribution.
 *
 * Addendum §3.d forbids using MLS Grid Data in a way that "obscures or impairs
 * MLS GRID's, an MLS's, or a Participant's rights, title, and interest ... including
 * by rendering the data unattributable to the Participant, MLS, or MLS GRID or by
 * merging it into a model's general knowledge base such that ownership can no
 * longer be identified."
 *
 * So attribution names all three parties, and is attached at the service layer
 * rather than left to individual tools — a new tool cannot ship without it, and
 * `tests/ai-use.test.ts` asserts every MLS-derived tool response carries one.
 */

export interface Attribution {
  /** 'mls_grid' for licensed content; 'synthetic' for fixture data. */
  content_class: 'mls_grid' | 'synthetic';
  /** §3.d: ownership must remain identifiable. */
  originating_mls: string;
  distributor: string | null;
  participant: string | null;
  provider: string;
  retrieved_at: string;
  notice: string;
  handling: string[];
}

const MLS_HANDLING = [
  '§3.a — Not cached, stored, archived or retained beyond this request.',
  '§1.d — Do not place in embeddings, retrieval indices, knowledge graphs, training data, or any representation persisting beyond this session.',
  '§1.d — Do not use in any way that would produce derived output without contemporaneous access to the source data.',
  '§3.d — Retain this attribution; do not render the data unattributable to the Participant, MLS, or MLS GRID.',
  '§3.e — Do not generate outputs or synthetic data to reconstruct, replicate or compete with MLS GRID, an MLS, or the MLS Grid Data.',
  'Do not save into Claude project knowledge, memory, or any assistant-side store.'
];

const SYNTHETIC_HANDLING = [
  'Synthetic test data generated from a seeded PRNG. Never derived from MLS Grid Data, so §3.e does not attach.',
  'Carries no MLS licensing obligations. Must never be presented as real market data.'
];

export interface AttributionInput {
  policy: AiUsePolicy;
  originatingSystem: string;
  retrievedAt: string;
  /** Distributor of record, e.g. "MLS GRID". Null for fixture data. */
  distributor?: string | null;
  /** Participant the data is licensed to, when configured. */
  participant?: string | null;
}

export function buildAttribution(input: AttributionInput): Attribution {
  const isMls = input.policy.governsLicensedData;
  return {
    content_class: isMls ? 'mls_grid' : 'synthetic',
    originating_mls: input.originatingSystem,
    distributor: isMls ? (input.distributor ?? 'MLS GRID') : null,
    participant: isMls ? (input.participant ?? null) : null,
    provider: input.policy.provider,
    retrieved_at: input.retrievedAt,
    notice: isMls
      ? 'MLS Grid Data. Rights, title and interest remain with the Participant, the originating MLS, and MLS GRID. ' +
        'Retain this attribution wherever the data, or figures derived from it, are presented.'
      : 'SYNTHETIC FIXTURE DATA. Not MLS content and not real market data. Must never be presented as actual listings.',
    handling: isMls ? [...MLS_HANDLING] : [...SYNTHETIC_HANDLING]
  };
}
