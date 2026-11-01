/**
 * Per-provider circuit breaker (10C.T5). Counts consecutive dependency
 * failures; after `threshold` it opens for `cooldownMs`, routes straight to the
 * fallback, then allows a single half-open probe.
 */
export interface CircuitBreakerOptions {
  threshold?: number;
  cooldownMs?: number;
  now?: () => number;
}

interface BreakerState {
  failures: number;
  openedAt: number | null;
  probing: boolean;
}

export class CircuitBreaker {
  private readonly threshold: number;
  private readonly cooldownMs: number;
  private readonly now: () => number;
  private readonly states = new Map<string, BreakerState>();

  constructor(options: CircuitBreakerOptions = {}) {
    this.threshold = options.threshold ?? 5;
    this.cooldownMs = options.cooldownMs ?? 30_000;
    this.now = options.now ?? (() => Date.now());
  }

  /** True while open or while a half-open probe is already in flight. */
  isOpen(key: string): boolean {
    const state = this.states.get(key);
    if (!state || state.openedAt === null) return false;
    const elapsed = this.now() - state.openedAt;
    if (elapsed < this.cooldownMs) return true;
    if (state.probing) return true;
    state.probing = true;
    return false;
  }

  retryAfterMs(key: string): number | undefined {
    const state = this.states.get(key);
    if (!state || state.openedAt === null) return undefined;
    return Math.max(0, this.cooldownMs - (this.now() - state.openedAt));
  }

  recordSuccess(key: string): void {
    this.states.delete(key);
  }

  /** The probe did not test the dependency (skip/cancel/non-dependency error). */
  releaseProbe(key: string): void {
    const state = this.states.get(key);
    if (state) state.probing = false;
  }

  recordFailure(key: string): void {
    const state = this.states.get(key) ?? { failures: 0, openedAt: null, probing: false };
    state.failures += 1;
    if (state.openedAt !== null || state.failures >= this.threshold) {
      state.openedAt = this.now();
      state.probing = false;
    }
    this.states.set(key, state);
  }
}
