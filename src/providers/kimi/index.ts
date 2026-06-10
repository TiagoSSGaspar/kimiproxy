/*
 * File: kimi/index.ts
 * Project: kimiproxy
 * Kimi provider (fast API replay). Wraps the existing Connect-protocol client
 * in services/kimi.ts and adapts its gRPC-web framed stream into UnifiedDelta.
 */

import { createKimiStream, updateSessionParent } from '../../services/kimi.ts';
import type {
  CreateStreamOptions,
  ModelInfo,
  Provider,
  ProviderStream,
  UnifiedDelta,
} from '../types.ts';

export const KIMI_MODELS = ['k2d6', 'k2d6-thinking'];

/**
 * Parser for Kimi's Connect/gRPC-web stream format (5-byte length-prefixed
 * frames). Moved here from routes/chat.ts so the route stays protocol-agnostic.
 */
export class ConnectStreamParser {
  private buffer: Uint8Array = new Uint8Array(0);

  feed(chunk: Uint8Array): any[] {
    const newBuffer = new Uint8Array(this.buffer.length + chunk.length);
    newBuffer.set(this.buffer);
    newBuffer.set(chunk, this.buffer.length);
    this.buffer = newBuffer;

    const messages: any[] = [];
    const textDecoder = new TextDecoder();

    while (this.buffer.length >= 5) {
      const flags = this.buffer[0];
      const length =
        (this.buffer[1] << 24) |
        (this.buffer[2] << 16) |
        (this.buffer[3] << 8) |
        this.buffer[4];

      if (this.buffer.length < 5 + length) break;

      const payload = this.buffer.slice(5, 5 + length);
      this.buffer = this.buffer.slice(5 + length);

      if (flags === 0x00) {
        const jsonStr = textDecoder.decode(payload);
        try {
          messages.push(JSON.parse(jsonStr));
        } catch (e) {
          console.error('Failed to parse Connect JSON:', e, jsonStr);
        }
      } else if (flags === 0x02) {
        // End-of-stream trailers; nothing to emit.
      }
    }

    return messages;
  }
}

async function* toUnifiedDeltas(
  stream: ReadableStream,
  initialUiSessionId: string
): AsyncGenerator<UnifiedDelta> {
  const reader = stream.getReader();
  const parser = new ConnectStreamParser();
  let uiSessionId = initialUiSessionId;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    for (const msg of parser.feed(value)) {
      if (msg.op === 'set' && msg.mask === 'chat.lastRequest' && msg.chat?.id) {
        uiSessionId = msg.chat.id;
      }
      if (msg.op === 'set' && msg.mask === 'message' && msg.message) {
        if (msg.message.role === 'assistant' && msg.message.id) {
          updateSessionParent(uiSessionId, msg.message.id);
        }
      }
      if (msg.block?.think?.content) {
        yield { type: 'reasoning', text: msg.block.think.content };
      }
      if (msg.block?.text?.content) {
        yield { type: 'text', text: msg.block.text.content };
      }
    }
  }

  // The route detects Kimi's "paused / continue" sentinel from the text itself,
  // so we always report paused:false here.
  yield { type: 'done', paused: false };
}

export class KimiProvider implements Provider {
  readonly id = 'kimi';

  models(): ModelInfo[] {
    const created = Math.floor(Date.now() / 1000);
    return KIMI_MODELS.map((name) => ({
      id: `${this.id}/${name}`,
      object: 'model' as const,
      created,
      owned_by: 'kimi',
    }));
  }

  async createStream(opts: CreateStreamOptions): Promise<ProviderStream> {
    const { stream, uiSessionId } = await createKimiStream(
      opts.prompt,
      opts.enableThinking,
      opts.model,
      opts.newConversation ? null : undefined
    );
    return toUnifiedDeltas(stream, uiSessionId);
  }
}
