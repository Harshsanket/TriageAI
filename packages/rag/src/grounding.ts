/**
 * Grounding vs citation formatting (ADR-0014).
 *
 * These are independent facts:
 *   grounded  — the answer is supported by the retrieved sources (deterministic
 *               content-word coverage; no extra model call).
 *   cited     — the model printed [ref] itself (a formatting requirement).
 * A missing citation must NOT be treated as an ungrounded answer.
 */

export const DEFAULT_GROUNDING_THRESHOLD = 0.6;

const STOPWORDS = new Set([
  'the',
  'and',
  'for',
  'are',
  'was',
  'were',
  'with',
  'that',
  'this',
  'from',
  'have',
  'has',
  'not',
  'but',
  'you',
  'your',
  'they',
  'their',
  'after',
  'within',
  'than',
  'into',
  'about',
  'over',
  'under',
  'our',
  'can',
  'will',
  'would',
  'should',
  'could',
  'there',
  'here',
  'when',
  'what',
  'how',
  'why',
  'who',
  'does',
  'did',
  'its',
  'it',
  'is',
  'be',
  'been',
  'being',
  'on',
  'in',
  'of',
  'to',
  'a',
  'an',
  'as',
  'at',
  'by',
  'or',
  'if',
  'we',
  'us',
  'my',
  'me',
]);

function contentWords(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter(
    (token) => token.length > 2 && !STOPWORDS.has(token),
  );
}

export interface GroundingSource {
  ref: string;
  text: string;
}

export interface GroundingAssessment {
  grounded: boolean;
  cited: boolean;
  coverage: number;
  threshold: number;
}

export function assessAnswer(
  answer: string,
  sources: GroundingSource[],
  threshold = DEFAULT_GROUNDING_THRESHOLD,
): GroundingAssessment {
  const trimmed = answer.trim();
  if (!trimmed || sources.length === 0) {
    return { grounded: false, cited: false, coverage: 0, threshold };
  }
  const sourceTokens = new Set(sources.flatMap((source) => contentWords(source.text)));
  const answerTokens = contentWords(trimmed);
  if (answerTokens.length === 0) {
    return { grounded: false, cited: false, coverage: 0, threshold };
  }
  const covered = answerTokens.filter((token) => sourceTokens.has(token)).length;
  const coverage = covered / answerTokens.length;
  const cited = sources.some((source) => trimmed.includes(`[${source.ref}]`));
  return { grounded: coverage >= threshold, cited, coverage, threshold };
}

export interface FinalizeInput {
  answer: string;
  sources: GroundingSource[];
  threshold?: number;
}

export interface FinalizedAnswer {
  answer: string;
  citations: string[];
  refused: boolean;
  reason?: 'empty_answer' | 'ungrounded';
  citationSource: 'model' | 'deterministic' | 'none';
  grounding: GroundingAssessment;
}

/**
 * Choose deterministic citations without inventing or over-citing: keep the
 * sources sharing the most content words with the answer (within half of the
 * best score), capped at three. Falls back to all refs when nothing overlaps.
 */
function selectSupportingRefs(answer: string, sources: GroundingSource[]): string[] {
  const answerTokens = new Set(contentWords(answer));
  const scored = sources.map((source) => {
    const sourceTokens = new Set(contentWords(source.text));
    let overlap = 0;
    for (const token of answerTokens) if (sourceTokens.has(token)) overlap += 1;
    return { ref: source.ref, overlap };
  });
  const best = Math.max(0, ...scored.map((entry) => entry.overlap));
  if (best === 0) return [...new Set(sources.map((source) => source.ref))];
  const floor = Math.max(1, Math.ceil(best / 2));
  return [
    ...new Set(
      scored
        .filter((entry) => entry.overlap >= floor)
        .sort((a, b) => b.overlap - a.overlap)
        .map((entry) => entry.ref),
    ),
  ].slice(0, 3);
}

/** Fail-closed policy: refuse ungrounded/empty; keep grounded answers and add
 * the missing citation deterministically (never invent a source). */
export function finalizeAnswer(input: FinalizeInput): FinalizedAnswer {
  const trimmed = input.answer.trim();
  const grounding = assessAnswer(trimmed, input.sources, input.threshold);
  const refusal = 'I could not verify this from the knowledge base.';

  if (!trimmed) {
    return {
      answer: refusal,
      citations: [],
      refused: true,
      reason: 'empty_answer',
      citationSource: 'none',
      grounding,
    };
  }
  if (!grounding.grounded) {
    return {
      answer: refusal,
      citations: [],
      refused: true,
      reason: 'ungrounded',
      citationSource: 'none',
      grounding,
    };
  }

  if (grounding.cited) {
    return {
      answer: trimmed,
      citations: [
        ...new Set(
          input.sources.map((source) => source.ref).filter((ref) => trimmed.includes(`[${ref}]`)),
        ),
      ],
      refused: false,
      citationSource: 'model',
      grounding,
    };
  }

  const refs = selectSupportingRefs(trimmed, input.sources);
  const suffix = refs.map((ref) => `[${ref}]`).join(' ');
  return {
    answer: `${trimmed} ${suffix}`,
    citations: refs,
    refused: false,
    citationSource: 'deterministic',
    grounding,
  };
}
