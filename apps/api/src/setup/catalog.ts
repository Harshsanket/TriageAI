/**
 * Model catalog for the setup wizard (ADR-0025): curated presets per hardware
 * tier from `config/model-presets.json`, plus a server-side Hugging Face search
 * proxy. Only `huggingface.co` is ever contacted, only the search text is
 * sent, and results are cached.
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import type { CatalogModel, HardwareProfile } from '@triageai/contracts';

const HF_API = 'https://huggingface.co/api/models';
const HF_TIMEOUT_MS = 8000;
const CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_RESULTS = 10;
/** Search text is user input forwarded to a third party: keep it boring. */
export const SEARCH_QUERY = /^[\w .\-/]{1,100}$/;

type Kind = CatalogModel['kind'];
const REPO_ID = /^[\w.-]+\/[\w.-]+$/;

interface PresetEntry {
  runtimeModel: string;
  sizeBytes: number;
  contextLength: number;
  license: string;
  note: string;
}

interface PresetFile {
  generation: Record<HardwareProfile['tier'], PresetEntry[]>;
  embedding: PresetEntry[];
}

/**
 * Will a model of this size run within the budget? Weights plus ~20% for the
 * runtime and a working KV cache; "tight" means it loads but leaves little
 * headroom for anything else.
 */
export function fitFor(sizeBytes: number | null, budgetBytes: number): CatalogModel['fit'] {
  if (!sizeBytes) return 'unknown';
  const needed = sizeBytes * 1.2 + 512 * 1024 ** 2;
  if (needed <= budgetBytes * 0.8) return 'fits';
  if (needed <= budgetBytes) return 'tight';
  return 'too-large';
}

/** `qwen2.5-1.5b-instruct-q4_k_m.gguf` → `Q4_K_M` (Ollama's `hf.co/<repo>:<quant>` tag). */
export function quantOf(filename: string): string | null {
  const match = /[-._](i?q\d(?:_[a-z0-9]+)*|f16|bf16|f32)\.gguf$/i.exec(filename);
  return match?.[1]?.toUpperCase() ?? null;
}

async function loadPresets(): Promise<PresetFile> {
  for (const candidate of [
    resolve(process.cwd(), 'config/model-presets.json'),
    resolve(process.cwd(), '../../config/model-presets.json'),
  ]) {
    try {
      return JSON.parse(await readFile(candidate, 'utf8')) as PresetFile;
    } catch {
      // try the next root (workspace scripts run from apps/api)
    }
  }
  return { generation: { small: [], medium: [], large: [] }, embedding: [] };
}

export async function presetModels(hardware: HardwareProfile, kind: Kind): Promise<CatalogModel[]> {
  const presets = await loadPresets();
  const entries = kind === 'generation' ? presets.generation[hardware.tier] : presets.embedding;
  return (entries ?? []).map((entry) => ({
    id: entry.runtimeModel,
    kind,
    runtimeModel: entry.runtimeModel,
    sizeBytes: entry.sizeBytes,
    fit: fitFor(entry.sizeBytes, hardware.modelBudgetBytes),
    license: entry.license,
    gated: false,
    downloads: null,
    contextLength: entry.contextLength,
    source: 'preset',
    note: entry.note,
  }));
}

interface HfSearchHit {
  id: string;
  downloads?: number;
  tags?: string[];
}

interface HfModelInfo {
  id: string;
  gated?: boolean | string;
  downloads?: number;
  tags?: string[];
  siblings?: Array<{ rfilename: string; size?: number }>;
  gguf?: { context_length?: number };
  safetensors?: { total?: number };
}

const cache = new Map<string, { at: number; value: unknown }>();

async function hfJson<T>(url: string): Promise<T> {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value as T;
  if (!url.startsWith(`${HF_API}`)) throw new Error('refusing non-Hugging Face URL');
  const res = await fetch(url, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(HF_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Hugging Face responded ${res.status}`);
  const value = (await res.json()) as T;
  cache.set(url, { at: Date.now(), value });
  return value;
}

const licenseOf = (tags: string[] | undefined): string | null =>
  tags?.find((tag) => tag.startsWith('license:'))?.slice('license:'.length) ?? null;

/** Prefer the common Q4_K_M quantisation, else the smallest single-file GGUF. */
function pickGguf(siblings: HfModelInfo['siblings']): { file: string; size: number } | null {
  const files = (siblings ?? [])
    .filter((s) => s.rfilename.endsWith('.gguf') && !/-\d{5}-of-\d{5}\.gguf$/.test(s.rfilename))
    .filter((s) => typeof s.size === 'number' && quantOf(s.rfilename))
    .map((s) => ({ file: s.rfilename, size: s.size as number }));
  if (files.length === 0) return null;
  return (
    files.find((f) => quantOf(f.file) === 'Q4_K_M') ??
    files.reduce((best, f) => (f.size < best.size ? f : best))
  );
}

export async function searchHuggingFace(
  query: string,
  kind: Kind,
  hardware: HardwareProfile,
): Promise<CatalogModel[]> {
  if (!SEARCH_QUERY.test(query))
    throw new Error('search text may only contain letters, digits, space . - _ /');
  const params = new URLSearchParams({
    search: query,
    sort: 'downloads',
    limit: String(MAX_RESULTS),
  });
  if (kind === 'generation') {
    params.set('filter', 'gguf');
    params.set('pipeline_tag', 'text-generation');
  } else {
    params.set('pipeline_tag', 'sentence-similarity');
    params.set('library', 'sentence-transformers');
  }
  const hits = await hfJson<HfSearchHit[]>(`${HF_API}?${params.toString()}`);
  const infos = await Promise.all(
    hits
      .filter((hit) => REPO_ID.test(hit.id))
      .map((hit) => hfJson<HfModelInfo>(`${HF_API}/${hit.id}?blobs=true`).catch(() => null)),
  );

  const results: CatalogModel[] = [];
  for (const info of infos) {
    if (!info) continue;
    const gated = Boolean(info.gated);
    if (kind === 'generation') {
      const file = pickGguf(info.siblings);
      if (!file) continue;
      results.push({
        id: info.id,
        kind,
        runtimeModel: `hf.co/${info.id}:${quantOf(file.file)}`,
        sizeBytes: file.size,
        fit: fitFor(file.size, hardware.modelBudgetBytes),
        license: licenseOf(info.tags),
        gated,
        downloads: info.downloads ?? null,
        contextLength: info.gguf?.context_length ?? null,
        source: 'huggingface',
        note: file.file,
      });
    } else {
      const params = info.safetensors?.total ?? null;
      const size = params ? params * 4 : null;
      results.push({
        id: info.id,
        kind,
        runtimeModel: info.id,
        sizeBytes: size,
        fit: fitFor(size, hardware.modelBudgetBytes),
        license: licenseOf(info.tags),
        gated,
        downloads: info.downloads ?? null,
        contextLength: null,
        source: 'huggingface',
        note: params ? `${Math.round(params / 1e6)}M parameters` : null,
      });
    }
  }
  return results;
}
