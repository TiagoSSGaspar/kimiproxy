/*
 * File: registry.ts
 * Project: kimiproxy
 * Provider registry + model-name routing.
 *
 * Clients select a provider through the model name prefix:
 *   'kimi/k2d6', 'deepseek/deepseek-chat', 'mimo/...'
 * A name without a known prefix falls back to the default provider (kimi),
 * preserving backwards compatibility with bare names like 'k2d6'.
 */

import type { ModelInfo, Provider } from './types.ts';

const DEFAULT_PROVIDER_ID = 'kimi';

const providers = new Map<string, Provider>();

export function registerProvider(provider: Provider): void {
  providers.set(provider.id, provider);
}

export function getProvider(id: string): Provider | undefined {
  return providers.get(id);
}

export function listProviders(): Provider[] {
  return Array.from(providers.values());
}

export interface ResolvedModel {
  provider: Provider;
  /** Provider-internal model name (prefix removed). */
  internalModel: string;
}

/**
 * Resolve a client-supplied model id to a provider and its internal model name.
 * Throws if the prefix names an unknown provider, or if the default provider
 * is missing for an unprefixed name.
 */
export function resolveModel(modelId: string): ResolvedModel {
  const slash = modelId.indexOf('/');
  if (slash !== -1) {
    const prefix = modelId.slice(0, slash);
    const rest = modelId.slice(slash + 1);
    const provider = providers.get(prefix);
    if (provider) {
      return { provider, internalModel: rest };
    }
    // Unknown prefix: fall through to default provider with the full name,
    // so a model that legitimately contains a slash still works.
  }

  const fallback = providers.get(DEFAULT_PROVIDER_ID);
  if (!fallback) {
    throw new Error(`No provider registered for model '${modelId}'`);
  }
  return { provider: fallback, internalModel: modelId };
}

/** Aggregate the model lists of every registered provider. */
export function allModels(): ModelInfo[] {
  const out: ModelInfo[] = [];
  for (const provider of providers.values()) {
    out.push(...provider.models());
  }
  return out;
}
