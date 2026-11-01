import { describe, expect, it } from 'vitest';

import { captureSkillPreference } from '../src/services/skills.js';

describe('skill preference capture', () => {
  it('treats explicit statements as skills', () => {
    expect(captureSkillPreference('From now on, always cite the policy name.')).toMatchObject({
      kind: 'explicit',
      instruction: 'always cite the policy name.',
    });
    expect(captureSkillPreference('Remember that answers must be in bullet points.')).toMatchObject(
      {
        kind: 'explicit',
      },
    );
  });

  it('suggests inferred preferences without writing', () => {
    expect(captureSkillPreference('Please be more concise in your answers.')).toMatchObject({
      kind: 'suggestion',
    });
    expect(captureSkillPreference('I prefer bullet lists for long answers.')).toMatchObject({
      kind: 'suggestion',
    });
  });

  it('ignores ordinary messages, secrets and emails', () => {
    expect(captureSkillPreference('What is the status of ticket 42?')).toBeNull();
    expect(captureSkillPreference('Always use API_KEY=sk-secret-value-123')).toBeNull();
    expect(captureSkillPreference('Always email alice@example.com first')).toBeNull();
    expect(captureSkillPreference('hi')).toBeNull();
  });
});
