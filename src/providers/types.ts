/*
 * File: types.ts
 * Project: kimiproxy
 * Provider abstraction: a single interface that decouples the chat route
 * from the underlying site protocol (Kimi API replay, DOM driving, ...).
 */

export interface ModelInfo {
  /** Prefixed model id exposed to clients, e.g. 'deepseek/deepseek-chat' */
  id: string;
  object: 'model';
  created: number;
  owned_by: string;
}

export interface CreateStreamOptions {
  /** Prompt already flattened from the OpenAI messages array. */
  prompt: string;
  /** Whether the caller asked for a thinking/reasoning model. */
  enableThinking: boolean;
  /** Internal model name (provider prefix already stripped). */
  model: string;
  /** True on the first message of a conversation -> start a fresh chat. */
  newConversation: boolean;
}

/** A single normalized event coming out of any provider stream. */
export type UnifiedDelta =
  | { type: 'reasoning'; text: string }
  | { type: 'text'; text: string }
  | { type: 'done'; paused: boolean };

/** Async-iterable stream of unified deltas. */
export type ProviderStream = AsyncIterable<UnifiedDelta>;

export interface Provider {
  /** Stable provider id, also used as the model-name prefix (e.g. 'kimi'). */
  readonly id: string;
  /** Models this provider exposes, already prefixed with `${id}/`. */
  models(): ModelInfo[];
  /** Open a generation stream of unified deltas for one request. */
  createStream(opts: CreateStreamOptions): Promise<ProviderStream>;
}
