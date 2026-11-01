import { afterEach, describe, expect, it, vi } from 'vitest';

import { formatBootFailure, troubleshootingHint } from '../src/platform/bootFailure.js';
import { installProcessGuards } from '../src/platform/process.js';
import { AppError } from '@triageai/kernel';

const disposers: Array<() => void> = [];

afterEach(() => {
  while (disposers.length > 0) disposers.pop()?.();
  vi.restoreAllMocks();
});

describe('process guards (phase 10c)', () => {
  it('logs a fatal fault once and exits non-zero', async () => {
    const fatal = vi.fn();
    const exit = vi.fn();
    disposers.push(
      installProcessGuards({
        logger: { fatal, info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
        exit,
      }),
    );

    process.emit('unhandledRejection', new Error('boom'), Promise.resolve());
    process.emit('uncaughtException', new Error('second fault'));

    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(fatal).toHaveBeenCalledTimes(1);
    expect(fatal.mock.calls[0]?.[0]).toMatchObject({
      correlationId: expect.stringMatching(/^process-/),
      kind: 'unhandledRejection',
    });
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('links boot failures to the matching SETUP.md troubleshooting row', () => {
    expect(troubleshootingHint('Invalid environment configuration: DATABASE_URL')).toBe(
      '`Invalid environment configuration: DATABASE_URL`',
    );
    expect(
      troubleshootingHint(
        'module "kb" requires capability "retriever", but no adapter is configured',
      ),
    ).toContain('requires capability');
    expect(troubleshootingHint('something else entirely')).toBeNull();

    const rendered = formatBootFailure(
      new AppError('kernel.CONFIG_INVALID', 'DATABASE_URL is missing'),
    );
    expect(rendered).toContain('DATABASE_URL is missing');
    expect(rendered).toContain('SETUP.md §9 Troubleshooting');
  });
});
