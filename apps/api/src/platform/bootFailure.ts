/**
 * Boot-failure presentation (10C.T6): the operator gets the precise error plus
 * the matching SETUP.md troubleshooting row, never a stack with no next step.
 */
const HINTS: Array<{ match: RegExp; hint: string }> = [
  { match: /DATABASE_URL/i, hint: '`Invalid environment configuration: DATABASE_URL`' },
  { match: /AUTH_JWT_SECRET/i, hint: '`AUTH_JWT_SECRET must be set` on boot' },
  { match: /requires capability/i, hint: '`kernel.BOOT_VALIDATION_FAILED … requires capability`' },
  { match: /bullmq/i, hint: '`queue adapter "bullmq" is not implemented yet`' },
  { match: /checksum|migration/i, hint: '`core migration …: checksum` on boot' },
  { match: /setup\.REQUIRED|setup token/i, hint: 'Every route returns `409 setup.REQUIRED`' },
];

export function troubleshootingHint(message: string): string | null {
  return HINTS.find((entry) => entry.match.test(message))?.hint ?? null;
}

/** Render the fatal boot line used by `apps/api/src/index.ts`. */
export function formatBootFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const hint = troubleshootingHint(message);
  const pointer = hint
    ? `See SETUP.md §9 Troubleshooting → ${hint}.`
    : 'See SETUP.md §9 Troubleshooting.';
  return `TriageAI could not start.\n\n${message}\n\n${pointer}`;
}
