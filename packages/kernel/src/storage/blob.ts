/** BlobStore (ADR-0022 / Phase 18.7): content-addressed, write-once files. */
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

export interface BlobRef {
  ref: string;
  sha256: string;
  size: number;
}

export interface BlobStore {
  put(bytes: Uint8Array, opts: { contentType: string }): Promise<BlobRef>;
  get(ref: string): Promise<Uint8Array>;
  delete(ref: string): Promise<void>;
}

export class FilesystemBlobStore implements BlobStore {
  constructor(private readonly root: string) {}

  async put(bytes: Uint8Array, _opts: { contentType: string }): Promise<BlobRef> {
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const ref = `${sha256.slice(0, 2)}/${sha256}`;
    const path = resolve(this.root, ref);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes).catch(async (err) => {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    });
    return { ref, sha256, size: bytes.length };
  }

  async get(ref: string): Promise<Uint8Array> {
    const path = resolve(this.root, ref);
    if (!path.startsWith(`${resolve(this.root)}/`)) throw new Error('unsafe blob ref');
    return new Uint8Array(await readFile(path));
  }

  async delete(ref: string): Promise<void> {
    const path = resolve(this.root, ref);
    if (!path.startsWith(`${resolve(this.root)}/`)) throw new Error('unsafe blob ref');
    await rm(path, { force: true });
  }
}

export { join };
