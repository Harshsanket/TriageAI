import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import {
  PackManifestSchema,
  generatePluginKeyPair,
  packPack,
  readPackPackage,
  signPack,
  verifyPackPackage,
} from '../src/index.js';

const manifest = {
  id: 'ticket-solver',
  version: '1.0.0',
  name: 'Ticket solver',
  license: 'MIT',
  modules: [
    { id: 'support', version: '^0.3.0' },
    { id: 'classifier-provider', version: '^1.0.0' },
    { id: 'llm-local', version: '^1.0.0', optional: true },
  ],
  wiring: {
    'capabilities.classifier.provider': 'classifier-provider',
    'capabilities.chatModel.provider': 'llm-local',
  },
};

describe('pack format (Phase 22.T12)', () => {
  it('packs, reads and verifies a signed list of modules', () => {
    const archive = packPack({ manifest });
    const read = readPackPackage(archive);
    expect(read.manifest.modules.map((module) => module.id)).toEqual([
      'support',
      'classifier-provider',
      'llm-local',
    ]);
    expect(read.manifest.wiring).toMatchObject({
      'capabilities.classifier.provider': 'classifier-provider',
    });

    const keys = generatePluginKeyPair();
    const signature = signPack(archive, keys.privateKey);
    expect(
      verifyPackPackage({ archive, signature, publicKeys: [keys.publicKey] }).manifest.id,
    ).toBe('ticket-solver');
    const tampered = Buffer.from(archive);
    tampered[tampered.length - 1] ^= 0xff;
    expect(() =>
      verifyPackPackage({ archive: tampered, signature, publicKeys: [keys.publicKey] }),
    ).toThrow();
  });

  it('rejects a pack without modules', () => {
    expect(() => packPack({ manifest: { ...manifest, modules: [] } })).toThrow();
  });

  it('ships the ticket-solver descriptor as a valid signed pack fixture (22.T12)', async () => {
    const raw = JSON.parse(
      await readFile(new URL('./fixtures/ticket-solver.pack.json', import.meta.url), 'utf8'),
    ) as unknown;
    const descriptor = PackManifestSchema.parse(raw);
    expect(descriptor.id).toBe('ticket-solver');
    expect(descriptor.modules.map((entry) => entry.id)).toEqual([
      'support',
      'classifier-provider',
      'llm-local',
    ]);

    const archive = packPack({
      manifest: descriptor,
      extraFiles: [
        {
          path: 'skills/handoff/SKILL.md',
          content: '---\nname: handoff\ndescription: Write a concise handoff.\n---\n\nBody.',
        },
      ],
    });
    const keys = generatePluginKeyPair();
    const signature = signPack(archive, keys.privateKey);
    const verified = verifyPackPackage({
      archive,
      signature,
      publicKeys: [keys.publicKey],
    });
    expect(verified.files.has('skills/handoff/SKILL.md')).toBe(true);
    expect(verified.manifest.wiring).toMatchObject({
      'capabilities.classifier.provider': 'classifier-provider',
    });
  });
});
