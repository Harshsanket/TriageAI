import { describe, expect, it } from 'vitest';

import { greeting } from './greeting';

describe('greeting (phase 13)', () => {
  const at = (hour: number) => new Date(`2026-10-30T${String(hour).padStart(2, '0')}:00:00Z`);

  it('greets by time of day with the user name', () => {
    expect(greeting('Harsh', at(7), 'UTC')).toBe('Good morning, Harsh');
    expect(greeting('Harsh', at(13), 'UTC')).toBe('Good afternoon, Harsh');
    expect(greeting('Harsh', at(19), 'UTC')).toBe('Good evening, Harsh');
    expect(greeting('Harsh', at(23), 'UTC')).toBe('Welcome back, Harsh');
  });

  it('omits the name when unknown and welcomes a first visit', () => {
    expect(greeting(null, at(7), 'UTC')).toBe('Good morning');
    expect(greeting('Harsh', at(7), 'UTC', true)).toBe('Welcome, Harsh');
  });
});
