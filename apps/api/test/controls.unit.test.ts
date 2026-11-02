import { describe, expect, it } from 'vitest';

import { resolveLlmSwitch } from '../src/services/controls.js';

describe('LLM runtime switches (phase 32.2)', () => {
  it('engages the global switch when every runtime is disabled', () => {
    expect(
      resolveLlmSwitch({ disabledRuntimes: ['ollama:a', 'lmstudio:b'] }, [
        'ollama:a',
        'lmstudio:b',
      ]),
    ).toMatchObject({ llmDisabled: true });
    expect(
      resolveLlmSwitch({ disabledRuntimes: ['ollama:a'] }, ['ollama:a', 'lmstudio:b']),
    ).toEqual({ disabledRuntimes: ['ollama:a'] });
    expect(resolveLlmSwitch({ llmDisabled: false }, [])).toEqual({ llmDisabled: false });
  });
});
