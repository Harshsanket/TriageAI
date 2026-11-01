import { describe, expect, it } from 'vitest';

import { CircuitBreaker } from '../src/circuitBreaker.js';

describe('circuit breaker (phase 10c)', () => {
  it('opens after the threshold, probes after cooldown and resets on success', () => {
    let now = 0;
    const breaker = new CircuitBreaker({ threshold: 2, cooldownMs: 1_000, now: () => now });

    breaker.recordFailure('provider');
    expect(breaker.isOpen('provider')).toBe(false);
    breaker.recordFailure('provider');
    expect(breaker.isOpen('provider')).toBe(true);
    expect(breaker.retryAfterMs('provider')).toBe(1_000);

    now = 1_000;
    expect(breaker.isOpen('provider')).toBe(false);
    expect(breaker.isOpen('provider')).toBe(true);

    breaker.releaseProbe('provider');
    expect(breaker.isOpen('provider')).toBe(false);
    breaker.recordSuccess('provider');
    expect(breaker.isOpen('provider')).toBe(false);
  });
});
