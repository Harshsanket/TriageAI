/**
 * Machine check for the setup wizard: what this host can run. RAM/CPU/disk
 * come from Node; the GPU view comes from the ai-service (torch), when it is
 * running. The model budget drives every "fits / too large" verdict.
 */
import { statfs } from 'node:fs/promises';
import os from 'node:os';

import type { HardwareProfile } from '@triageai/contracts';

const PROBE_TIMEOUT_MS = 1500;
const GIB = 1024 ** 3;

async function reachable(url: string, fetchImpl: typeof fetch): Promise<boolean> {
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    return res.ok;
  } catch {
    return false;
  }
}

async function gpuFromAiService(
  aiServiceUrl: string,
  fetchImpl: typeof fetch,
): Promise<HardwareProfile['gpu']> {
  try {
    const res = await fetchImpl(`${aiServiceUrl}/ai/v1/hardware`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as {
      kind: 'cuda' | 'mps' | 'none';
      name?: string | null;
      memoryBytes?: number | null;
    };
    return { kind: body.kind, name: body.name ?? null, memoryBytes: body.memoryBytes ?? null };
  } catch {
    return null;
  }
}

/**
 * Memory a local model may use. A dedicated GPU gets most of its VRAM; on
 * unified-memory Macs the GPU shares RAM, so leave room for the OS, Postgres,
 * the API and the embedding model.
 */
export function modelBudget(
  memoryTotalBytes: number,
  gpu: HardwareProfile['gpu'],
  appleSilicon: boolean,
): { bytes: number; tier: HardwareProfile['tier'] } {
  const bytes =
    gpu?.kind === 'cuda' && gpu.memoryBytes
      ? Math.round(gpu.memoryBytes * 0.9)
      : Math.round(memoryTotalBytes * (appleSilicon ? 0.6 : 0.5));
  const tier = bytes < 6 * GIB ? 'small' : bytes < 14 * GIB ? 'medium' : 'large';
  return { bytes, tier };
}

export async function probeHardware(options: {
  aiServiceUrl: string;
  ollamaUrl: string;
  dataDir?: string;
  /** Every probe goes through the egress client (F6); defaults to raw fetch. */
  fetchImpl?: typeof fetch;
}): Promise<HardwareProfile> {
  const cpus = os.cpus();
  const cpuModel = cpus[0]?.model ?? 'unknown';
  const appleSilicon = os.platform() === 'darwin' && os.arch() === 'arm64';
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const [gpu, aiService, ollama, disk] = await Promise.all([
    gpuFromAiService(options.aiServiceUrl, fetchImpl),
    reachable(`${options.aiServiceUrl}/healthz`, fetchImpl),
    reachable(`${options.ollamaUrl.replace(/\/$/, '')}/api/version`, fetchImpl),
    statfs(options.dataDir ?? process.cwd()).catch(() => null),
  ]);
  const budget = modelBudget(os.totalmem(), gpu, appleSilicon);
  return {
    platform: os.platform(),
    arch: os.arch(),
    cpuModel,
    cpuCores: cpus.length,
    memoryTotalBytes: os.totalmem(),
    memoryFreeBytes: os.freemem(),
    appleSilicon,
    gpu,
    diskFreeBytes: disk ? disk.bavail * disk.bsize : null,
    modelBudgetBytes: budget.bytes,
    tier: budget.tier,
    services: { aiService, ollama },
  };
}
