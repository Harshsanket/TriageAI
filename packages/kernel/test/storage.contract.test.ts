import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe } from 'vitest';

import { FilesystemBlobStore, MemoryCache, RedisCache, S3BlobStore } from '../src/index.js';
import { blobStoreContractSuite, cacheContractSuite } from '../src/storage/contract.js';

describe('Cache contract (18.T11, memory)', () => {
  cacheContractSuite('MemoryCache', () => {
    const cache = new MemoryCache(10);
    // A second instance stands in for "another namespace": clearing one must
    // not touch the other.
    return { cache, sibling: new MemoryCache(10) };
  });
});

const REDIS_URL = process.env.REDIS_URL;
const describeRedis = REDIS_URL ? describe : describe.skip;

describeRedis('Cache contract (18.T11, redis)', () => {
  const run = `${process.pid}-${Date.now()}`;
  let sequence = 0;
  cacheContractSuite('RedisCache', async () => {
    sequence += 1;
    const cache = new RedisCache({
      url: REDIS_URL as string,
      namespace: `triageai:test:${run}:${sequence}:a`,
    });
    const sibling = new RedisCache({
      url: REDIS_URL as string,
      namespace: `triageai:test:${run}:${sequence}:b`,
    });
    return {
      cache,
      sibling,
      dispose: async () => {
        await Promise.all([cache.close(), sibling.close()]);
      },
    };
  });
});

describe('BlobStore contract (18.T12, filesystem)', () => {
  blobStoreContractSuite('FilesystemBlobStore', async () => {
    const root = await mkdtemp(join(tmpdir(), 'triageai-blob-contract-'));
    return {
      store: new FilesystemBlobStore(root),
      dispose: () => rm(root, { recursive: true, force: true }),
    };
  });
});

const S3_ENDPOINT = process.env.TRIAGEAI_S3_ENDPOINT;
const S3_ACCESS_KEY = process.env.TRIAGEAI_S3_ACCESS_KEY;
const S3_SECRET_KEY = process.env.TRIAGEAI_S3_SECRET_KEY;
const S3_BUCKET = process.env.TRIAGEAI_S3_BUCKET ?? 'triageai-test-blobs';
const describeS3 = S3_ENDPOINT && S3_ACCESS_KEY && S3_SECRET_KEY ? describe : describe.skip;

describeS3('BlobStore contract (18.T12, s3/minio)', () => {
  blobStoreContractSuite('S3BlobStore', async () => {
    const store = new S3BlobStore({
      endpoint: S3_ENDPOINT as string,
      accessKey: S3_ACCESS_KEY as string,
      secretKey: S3_SECRET_KEY as string,
      bucket: S3_BUCKET,
    });
    // The ensure step is part of the adapter contract: a fresh bucket must
    // exist before the first put.
    await store.ensureBucket();
    return { store };
  });
});
