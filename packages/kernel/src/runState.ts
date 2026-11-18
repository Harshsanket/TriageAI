/** Unified run status machine (Phase 18.2). */
import { AppError } from './errors.js';

export type RunStatus =
  | 'PENDING'
  | 'RUNNING'
  | 'AWAITING'
  | 'PAUSED'
  | 'CANCELLED_PENDING'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'CANCELLED';

/** Allowed transitions; terminal states cannot leave. */
export const RUN_TRANSITIONS: Record<RunStatus, readonly RunStatus[]> = {
  PENDING: ['RUNNING', 'AWAITING', 'PAUSED', 'SUCCEEDED', 'FAILED', 'CANCELLED'],
  RUNNING: ['AWAITING', 'PAUSED', 'CANCELLED_PENDING', 'SUCCEEDED', 'FAILED', 'CANCELLED'],
  AWAITING: ['RUNNING', 'PAUSED', 'CANCELLED_PENDING', 'SUCCEEDED', 'FAILED', 'CANCELLED'],
  PAUSED: ['RUNNING', 'CANCELLED_PENDING', 'CANCELLED'],
  CANCELLED_PENDING: ['CANCELLED', 'FAILED'],
  SUCCEEDED: [],
  FAILED: [],
  CANCELLED: [],
};

export function canTransitionRun(from: RunStatus, to: RunStatus): boolean {
  return RUN_TRANSITIONS[from].includes(to);
}

export function assertRunTransition(from: RunStatus, to: RunStatus): void {
  if (canTransitionRun(from, to)) return;
  throw new AppError(
    'kernel.RUN_TRANSITION_INVALID',
    `run cannot transition ${from} → ${to}`,
    undefined,
    409,
    { category: 'validation', retryable: false },
  );
}
