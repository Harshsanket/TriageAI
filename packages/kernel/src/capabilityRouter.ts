/**
 * Capability router (ADR-0054 §4). Consumers ask for a capability id; the core
 * chooses the provider from config. Built-in host adapters and module-provided
 * implementations sit behind the same seam.
 */
import type { Capabilities, KernelConfig } from './types.js';

export interface CapabilityProvider {
  capability: string;
  provider: string;
  moduleId: string | null;
  value: unknown;
}

export class CapabilityRouter {
  private providers = new Map<string, CapabilityProvider[]>();

  constructor(
    private readonly config: KernelConfig,
    builtIn: Capabilities = {},
  ) {
    for (const [capability, value] of Object.entries(builtIn)) {
      if (value === undefined) continue;
      this.register({ capability, provider: 'built-in', moduleId: null, value });
    }
  }

  register(provider: CapabilityProvider): void {
    const list = this.providers.get(provider.capability) ?? [];
    this.providers.set(provider.capability, [
      ...list.filter((entry) => entry.provider !== provider.provider),
      provider,
    ]);
  }

  provide(moduleId: string, capability: string, value: unknown): void {
    this.register({ capability, provider: moduleId, moduleId, value });
  }

  providersFor(capability: string): CapabilityProvider[] {
    return [...(this.providers.get(capability) ?? [])];
  }

  /** The configured provider, a single module provider, or the built-in one. */
  resolve(capability: string): unknown {
    const candidates = this.providersFor(capability);
    if (candidates.length === 0) return undefined;
    const configured = this.config.capabilities[capability]?.provider;
    if (configured) {
      const exact = candidates.find(
        (entry) => entry.provider === configured || entry.moduleId === configured,
      );
      if (exact) return exact.value;
      return undefined;
    }
    const modules = candidates.filter((entry) => entry.moduleId !== null);
    if (modules.length === 1) return modules[0]?.value;
    const builtIn = candidates.find((entry) => entry.provider === 'built-in');
    if (builtIn) return builtIn.value;
    return candidates[0]?.value;
  }

  providerOf(capability: string): CapabilityProvider | null {
    const value = this.resolve(capability);
    if (value === undefined) return null;
    const configured = this.config.capabilities[capability]?.provider;
    const candidates = this.providersFor(capability);
    return (
      candidates.find(
        (entry) =>
          (configured && (entry.provider === configured || entry.moduleId === configured)) ||
          ((!configured || !candidates.some((c) => c.provider === configured)) &&
            entry.value === value),
      ) ?? null
    );
  }

  has(capability: string): boolean {
    return this.resolve(capability) !== undefined;
  }

  snapshot(): Record<string, { provider: string; moduleId: string | null }> {
    const result: Record<string, { provider: string; moduleId: string | null }> = {};
    for (const capability of this.providers.keys()) {
      const provider = this.providerOf(capability);
      if (provider)
        result[capability] = { provider: provider.provider, moduleId: provider.moduleId };
    }
    return result;
  }
}
