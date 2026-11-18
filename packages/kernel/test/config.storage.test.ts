import { describe, expect, it } from 'vitest';

import {
  buildKernelConfig,
  parseBlobStoreAdapterConfig,
  parseCacheAdapterConfig,
  parseConfigFile,
} from '../src/index.js';

describe('storage adapter config (18.T11/T12)', () => {
  it('defaults to the in-memory cache with an LRU bound', () => {
    expect(parseCacheAdapterConfig(undefined)).toEqual({ adapter: 'memory', maxEntries: 1_000 });
    expect(parseCacheAdapterConfig({})).toEqual({ adapter: 'memory', maxEntries: 1_000 });
    expect(parseCacheAdapterConfig({ adapter: 'memory', maxEntries: 25 })).toEqual({
      adapter: 'memory',
      maxEntries: 25,
    });
  });

  it('fills Redis defaults from the named env and a safe namespace', () => {
    expect(parseCacheAdapterConfig({ adapter: 'redis' })).toEqual({
      adapter: 'redis',
      urlEnv: 'REDIS_URL',
      namespace: 'triageai:cache',
    });
    expect(
      parseCacheAdapterConfig({
        adapter: 'redis',
        urlEnv: 'CUSTOM_REDIS_URL',
        namespace: 'tenant:one',
      }),
    ).toEqual({
      adapter: 'redis',
      urlEnv: 'CUSTOM_REDIS_URL',
      namespace: 'tenant:one',
    });
  });

  it('rejects unknown cache adapters, keys and unsafe namespaces', () => {
    expect(() => parseCacheAdapterConfig({ adapter: 'memcached' })).toThrow(
      /capabilities\.cache\.adapter/,
    );
    expect(() => parseCacheAdapterConfig({ adapter: 'redis', typo: true })).toThrow(
      /capabilities\.cache\.typo/,
    );
    expect(() =>
      parseCacheAdapterConfig({ adapter: 'redis', namespace: 'bad namespace*' }),
    ).toThrow(/capabilities\.cache\.namespace/);
    expect(() => parseCacheAdapterConfig({ adapter: 'memory', maxEntries: 0 })).toThrow(
      /capabilities\.cache\.maxEntries/,
    );
  });

  it('defaults to a filesystem blob root and fills the S3/MinIO env names', () => {
    expect(parseBlobStoreAdapterConfig(undefined)).toEqual({
      adapter: 'filesystem',
      root: 'data/blobs',
    });
    expect(parseBlobStoreAdapterConfig({ adapter: 'filesystem', root: '/srv/blobs' })).toEqual({
      adapter: 'filesystem',
      root: '/srv/blobs',
    });
    expect(parseBlobStoreAdapterConfig({ adapter: 's3' })).toEqual({
      adapter: 's3',
      bucket: 'triageai-blobs',
      endpointEnv: 'TRIAGEAI_S3_ENDPOINT',
      accessKeyEnv: 'TRIAGEAI_S3_ACCESS_KEY',
      secretKeyEnv: 'TRIAGEAI_S3_SECRET_KEY',
      region: 'us-east-1',
    });
    expect(
      parseBlobStoreAdapterConfig({
        adapter: 's3',
        bucket: 'kb-blobs',
        endpointEnv: 'MINIO_ENDPOINT',
        accessKeyEnv: 'MINIO_ACCESS_KEY',
        secretKeyEnv: 'MINIO_SECRET_KEY',
        region: 'eu-west-1',
      }),
    ).toMatchObject({ bucket: 'kb-blobs', endpointEnv: 'MINIO_ENDPOINT', region: 'eu-west-1' });
  });

  it('rejects malformed blob config', () => {
    expect(() => parseBlobStoreAdapterConfig({ adapter: 'gcs' })).toThrow(
      /capabilities\.blobStore\.adapter/,
    );
    expect(() => parseBlobStoreAdapterConfig({ adapter: 's3', bucket: 'UPPER' })).toThrow(
      /capabilities\.blobStore\.bucket/,
    );
    expect(() => parseBlobStoreAdapterConfig({ adapter: 's3', region: '' })).toThrow(
      /capabilities\.blobStore\.region/,
    );
  });

  it('normalizes both adapter sections into the effective kernel config', () => {
    const cfg = buildKernelConfig(
      parseConfigFile({
        capabilities: {
          cache: { adapter: 'redis', namespace: 'runtime:cache' },
          blobStore: { adapter: 's3', bucket: 'kb-blobs' },
          generator: { adapter: 'ollama', model: 'small' },
        },
      }),
      {},
    );
    expect(cfg.capabilities.cache).toMatchObject({
      adapter: 'redis',
      urlEnv: 'REDIS_URL',
      namespace: 'runtime:cache',
    });
    expect(cfg.capabilities.blobStore).toMatchObject({ adapter: 's3', bucket: 'kb-blobs' });
    // Unrelated capability adapters pass through untouched.
    expect(cfg.capabilities.generator).toEqual({ adapter: 'ollama', model: 'small' });
  });

  it('gives every config defaults even when the file is silent', () => {
    const cfg = buildKernelConfig(parseConfigFile({}), {});
    expect(cfg.capabilities.cache).toEqual({ adapter: 'memory', maxEntries: 1_000 });
    expect(cfg.capabilities.blobStore).toEqual({ adapter: 'filesystem', root: 'data/blobs' });
  });

  it('fails boot on an invalid storage section', () => {
    expect(() =>
      buildKernelConfig(
        parseConfigFile({ capabilities: { cache: { adapter: 'redis', namespace: 'a b' } } }),
        {},
      ),
    ).toThrow(/Invalid triage\.config\.json/);
  });
});
