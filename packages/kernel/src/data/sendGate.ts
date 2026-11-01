/**
 * The send gate (Phase 18.8/18.T16): one decision for every item that would
 * reach a model. `secret` is never sent; `restricted` never reaches a hosted
 * model; `internal` is sent only after redaction; the class can be stricter
 * (`modelUse`) and the agent's egress class is the ceiling.
 */
import type { ModelUse, Sensitivity } from './classes.js';

export type SendDecision = 'sent' | 'redacted' | 'withheld';

export interface SendGateItem {
  sensitivity: Sensitivity;
  modelUse?: ModelUse;
  /** The destination model is hosted (off-box). */
  hosted: boolean;
  /** Highest sensitivity this agent/tool may receive. */
  egressClass?: Sensitivity;
  /** Deterministic PII tags (e.g. `pii:email`) from the detectors. */
  tags?: string[];
}

export interface SendGateResult {
  decision: SendDecision;
  reason: string;
}

const ORDER: Sensitivity[] = ['public', 'internal', 'restricted', 'secret'];

export function classifySend(item: SendGateItem): SendGateResult {
  const modelUse = item.modelUse ?? 'redacted';
  if (modelUse === 'never') return { decision: 'withheld', reason: 'model_use_never' };
  if (item.sensitivity === 'secret') return { decision: 'withheld', reason: 'secret' };
  if (item.egressClass) {
    const ceiling = ORDER.indexOf(item.egressClass);
    if (ORDER.indexOf(item.sensitivity) > ceiling) {
      return { decision: 'withheld', reason: 'egress_class_exceeded' };
    }
  }
  if (item.hosted) {
    if (item.sensitivity === 'restricted') {
      return { decision: 'withheld', reason: 'restricted_hosted' };
    }
    if (modelUse === 'local_only') return { decision: 'withheld', reason: 'local_only' };
  }
  const needsRedaction =
    item.sensitivity === 'internal' ||
    Boolean(item.tags?.some((tag) => tag.startsWith('pii:') || tag.startsWith('secret:')));
  if (needsRedaction) {
    if (item.hosted || item.tags?.some((tag) => tag.startsWith('pii:'))) {
      return { decision: 'redacted', reason: 'pii_or_internal_redaction' };
    }
  }
  if (modelUse === 'local_only' && !item.hosted)
    return { decision: 'sent', reason: 'local_allowed' };
  return { decision: 'sent', reason: 'allowed' };
}
