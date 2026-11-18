/** BlobStore (ADR-0022 / Phase 18.7): content-addressed, write-once files. */
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { Client } from 'minio';

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

/** Refs are content-addressed (`ab/<sha256>`); reject arbitrary object keys. */
const REF_PATTERN = /^[0-9a-f]{2}\/[0-9a-f]{64}$/;

export interface S3BlobStoreOptions {
  bucket: string;
  /** Endpoint URL, e.g. `http://localhost:9000` (a scheme defaults to http). */
  endpoint: string;
  accessKey: string;
  secretKey: string;
  region?: string;
}

interface MinioError {
  code?: string;
}

function isMissing(error: unknown): boolean {
  const code = (error as MinioError | undefined)?.code;
  return code === 'NoSuchKey' || code === 'NoSuchBucket' || code === 'NotFound';
}

function endpointOptions(endpoint: string): {
  endPoint: string;
  port?: number;
  useSSL: boolean;
} {
  const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(endpoint) ? endpoint : `http://${endpoint}`);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`unsupported S3 endpoint protocol "${url.protocol}"`);
  }
  const useSSL = url.protocol === 'https:';
  return {
    endPoint: url.hostname,
    ...(url.port ? { port: Number(url.port) } : {}),
    useSSL,
  };
}

/**
 * S3-compatible BlobStore (18.T12): MinIO, S3 or R2. Objects are keyed by the
 * same content-addressed ref as the filesystem adapter (`ab/<sha256>`), so a
 * blob root can be migrated by re-uploading refs without changing module rows.
 */
export class S3BlobStore implements BlobStore {
  private readonly client: Client;
  private readonly bucket: string;
  private readonly region: string;
  private ensured: Promise<void> | null = null;

  constructor(options: S3BlobStoreOptions) {
    this.bucket = options.bucket;
    this.region = options.region ?? 'us-east-1';
    this.client = new Client({
      ...endpointOptions(options.endpoint),
      accessKey: options.accessKey,
      secretKey: options.secretKey,
      region: this.region,
      // Custom S3 endpoints (MinIO/R2) are reached path-style; virtual-host
      // addressing would require wildcard DNS for the bucket name.
      pathStyle: true,
    });
  }

  /** Create the bucket on first use; safe to call repeatedly/concurrently. */
  async ensureBucket(): Promise<void> {
    this.ensured ??= (async () => {
      if (await this.client.bucketExists(this.bucket)) return;
      await this.client.makeBucket(this.bucket, this.region).catch((error: unknown) => {
        // Two API instances racing on first boot: one create wins.
        const code = (error as MinioError | undefined)?.code;
        if (code !== 'BucketAlreadyOwnedByYou' && code !== 'BucketAlreadyExists') throw error;
      });
    })().catch((error: unknown) => {
      this.ensured = null;
      throw error;
    });
    await this.ensured;
  }

  async put(bytes: Uint8Array, opts: { contentType: string }): Promise<BlobRef> {
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const ref = `${sha256.slice(0, 2)}/${sha256}`;
    await this.ensureBucket();
    // Content-addressed writes are idempotent: an existing object already holds
    // these exact bytes, so a retry never rewrites it.
    const exists = await this.client
      .statObject(this.bucket, ref)
      .then(() => true)
      .catch((error: unknown) => {
        if (isMissing(error)) return false;
        throw error;
      });
    if (!exists) {
      await this.client.putObject(this.bucket, ref, Buffer.from(bytes), bytes.length, {
        'Content-Type': opts.contentType,
      });
    }
    return { ref, sha256, size: bytes.length };
  }

  async get(ref: string): Promise<Uint8Array> {
    if (!REF_PATTERN.test(ref)) throw new Error('unsafe blob ref');
    try {
      const stream = await this.client.getObject(this.bucket, ref);
      const chunks: Buffer[] = [];
      for await (const chunk of stream) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
      }
      return new Uint8Array(Buffer.concat(chunks));
    } catch (error) {
      if (isMissing(error)) throw new Error(`blob ${ref} not found`);
      throw error;
    }
  }

  async delete(ref: string): Promise<void> {
    if (!REF_PATTERN.test(ref)) throw new Error('unsafe blob ref');
    // Deleting a missing object/bucket is a no-op, matching rm(..., {force}).
    await this.client.removeObject(this.bucket, ref).catch((error: unknown) => {
      if (!isMissing(error)) throw error;
    });
  }
}

export { join };
