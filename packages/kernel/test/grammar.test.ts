import { describe, expect, it } from 'vitest';

import { evaluateWhen, resolveRef, resolveStageInput, validateWhen } from '../src/grammar.js';

const ctx = {
  data: {
    input: { text: 'ship it', count: 3, flag: true },
    upper: { upper: 'SHIP IT' },
    empty: {},
  },
  config: { threshold: 2 },
  runId: 'run-1',
};

describe('grammar: refs', () => {
  it('resolves input shorthands, stage outputs and config', () => {
    expect(resolveRef('$.text', ctx)).toBe('ship it');
    expect(resolveRef('${input.count}', ctx)).toBe(3);
    expect(resolveRef('${stages.upper.output.upper}', ctx)).toBe('SHIP IT');
    expect(resolveRef('${config.threshold}', ctx)).toBe(2);
    expect(resolveRef('${run.id}', ctx)).toBe('run-1');
    expect(resolveRef('${missing.deep.path}', ctx)).toBeUndefined();
  });

  it('resolves stage input mappings and passes literals through', () => {
    const resolved = resolveStageInput(
      { text: '$.text', upper: '${stages.upper.output.upper}', literal: 'plain', n: 7 },
      ctx,
    );
    expect(resolved).toEqual({ text: 'ship it', upper: 'SHIP IT', literal: 'plain', n: 7 });
  });

  it('defaults to the run input when no mapping is given', () => {
    expect(resolveStageInput(undefined, ctx)).toEqual({ text: 'ship it', count: 3, flag: true });
  });
});

describe('grammar: when expressions', () => {
  it('evaluates comparisons and boolean combos', () => {
    expect(evaluateWhen("${input.text} == 'ship it'", ctx)).toBe(true);
    expect(evaluateWhen("${input.text} != 'ship it'", ctx)).toBe(false);
    expect(evaluateWhen('${input.count} >= 3', ctx)).toBe(true);
    expect(evaluateWhen('${input.flag} && ${input.count} > 2', ctx)).toBe(true);
    expect(evaluateWhen('${input.flag} || ${input.count} > 99', ctx)).toBe(true);
    expect(evaluateWhen('!${input.flag}', ctx)).toBe(false);
    expect(evaluateWhen('${input.flag}', ctx)).toBe(true);
  });

  it('treats missing refs as falsy and undefined comparisons as false', () => {
    expect(evaluateWhen('${nope.here}', ctx)).toBe(false);
    expect(evaluateWhen("${nope.here} == 'x'", ctx)).toBe(false);
  });

  it('rejects unsupported grammar before boot', () => {
    expect(() => validateWhen('${input.text} =~ /x/')).toThrow(/unsupported expression atom/);
    expect(() => validateWhen('input.text == ship')).toThrow(/unsupported/);
    expect(() => validateWhen('${input.text} == ship')).toThrow(/invalid literal/);
  });
});
