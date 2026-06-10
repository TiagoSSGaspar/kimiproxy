/*
 * File: chat.ts
 * Project: kimiproxy
 * Author: Pedro Farias
 * Created: 2026-05-09
 *
 * OpenAI-compatible chat handler. Protocol-agnostic: it routes to a provider
 * by model name (see providers/registry.ts) and consumes a unified delta
 * stream, so the same tool-parsing / auto-continue logic serves every backend.
 */

import { Context } from 'hono';
import { stream as honoStream } from 'hono/streaming';
import { v4 as uuidv4 } from 'uuid';
import { OpenAIRequest } from '../utils/types.ts';
import { StreamingToolParser } from '../tools/parser.ts';
import { resolveModel } from '../providers/index.ts';
import type { ProviderStream } from '../providers/types.ts';

const PAUSE_PATTERNS = [
  /maximum number of tool calls/i,
  /reached the maximum number of tool/i,
  /Type [‘'"]continue[’'"] to resume/i,
  /número máximo de chamadas de ferramenta/i,
  /Digite [‘'"]continue[’'"] para retomar/i,
  /limite máximo de chamadas/i
];

function isPausedMessage(text: string): boolean {
  return PAUSE_PATTERNS.some(pattern => pattern.test(text));
}

function cleanPauseMessage(text: string): string {
  let cleaned = text;
  const phrasesToRemove = [
    /This task paused because Kimi reached the maximum number of tool calls for a single message\.\s*Type [‘'"]continue[’'"] to resume the task\./gi,
    /Esta tarefa foi pausada porque o Kimi atingiu o número máximo de chamadas de ferramenta para uma única mensagem\.\s*Digite [‘'"]continue[’'"] para retomar a tarefa\./gi,
    /This task paused because Kimi reached the maximum number of tool calls for a single message\.\s*Type [‘'"]continue[’'"] to resume\./gi,
    /This task paused because Kimi reached.*/gi,
    /Esta tarefa foi pausada porque.*/gi
  ];

  for (const regex of phrasesToRemove) {
    cleaned = cleaned.replace(regex, '');
  }

  return cleaned.trim();
}

interface StreamConsumptionResult {
  textBuffer: string;
  reasoningBuffer: string;
  toolCallsOut: any[];
}

async function consumeUnifiedStream(
  stream: ProviderStream,
  toolParser: StreamingToolParser
): Promise<StreamConsumptionResult> {
  const toolCallsOut: any[] = [];
  let reasoningBuffer = '';
  let textBuffer = '';

  for await (const delta of stream) {
    if (delta.type === 'reasoning') {
      reasoningBuffer += delta.text;
    } else if (delta.type === 'text') {
      const { text, toolCalls } = toolParser.feed(delta.text);
      if (text) textBuffer += text;
      for (const tc of toolCalls) {
        toolCallsOut.push({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: JSON.stringify(tc.arguments) }
        });
      }
    }
  }

  const { text: remainingText, toolCalls: remainingToolCalls } = toolParser.flush();
  if (remainingText) textBuffer += remainingText;
  for (const tc of remainingToolCalls) {
    toolCallsOut.push({
      id: tc.id,
      type: 'function',
      function: { name: tc.name, arguments: JSON.stringify(tc.arguments) }
    });
  }

  return { textBuffer, reasoningBuffer, toolCallsOut };
}

export async function chatCompletions(c: Context) {
  try {
    const body: OpenAIRequest = await c.req.json();
    const isStream = body.stream ?? false;

    // Extract the prompt
    let prompt = '';
    const messages = body.messages || [];
    let systemPrompt = '';

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      let contentStr = '';
      if (Array.isArray(msg.content)) {
        contentStr = msg.content.map((c: any) => c.text || JSON.stringify(c)).join('\n');
      } else if (typeof msg.content === 'object' && msg.content !== null) {
        contentStr = JSON.stringify(msg.content);
      } else {
        contentStr = msg.content || '';
      }

      if (msg.role === 'system') {
        systemPrompt += contentStr + '\n\n';
      } else if (msg.role === 'user') {
        prompt += `User: ${contentStr}\n\n`;
      } else if (msg.role === 'assistant') {
        let assistantContent = contentStr;
        if ((msg as any).reasoning_content) {
          assistantContent = `<think>\n${(msg as any).reasoning_content}\n</think>\n${assistantContent}`;
        }
        if (msg.tool_calls && Array.isArray(msg.tool_calls)) {
           for (const tc of msg.tool_calls) {
              let args = tc.function?.arguments || '{}';
              if (typeof args !== 'string') args = JSON.stringify(args);
              assistantContent += `\n<tool_call>{"name": "${tc.function?.name}", "arguments": ${args}}</tool_call>`;
           }
        }
        prompt += `Assistant: ${assistantContent.trim()}\n\n`;
      } else if (msg.role === 'tool' || msg.role === 'function') {
        prompt += `Tool Response (${msg.name || 'tool'}): ${contentStr}\n\n`;
      }
    }

    // Inject tools instructions
    const bodyAny = body as any;
    if (bodyAny.tools && Array.isArray(bodyAny.tools) && bodyAny.tools.length > 0) {
      // Better formatting for tools
      const formattedTools = bodyAny.tools.map((t: any) => {
        if (t.type === 'function') {
          return {
            name: t.function.name,
            description: t.function.description || '',
            parameters: t.function.parameters
          };
        }
        return t;
      });
      const toolsJson = JSON.stringify(formattedTools, null, 2);

      systemPrompt += `\n\n# TOOLS AVAILABLE\nYou have access to the following tools:\n${toolsJson}\n\n# TOOL CALLING FORMAT (MANDATORY)\nTo use a tool, you MUST output a JSON object wrapped EXACTLY in these tags:\n<tool_call>\n{"name": "tool_name", "arguments": {"param_name": "value"}}\n</tool_call>\n\nEXAMPLE OF MULTIPLE TOOL CALLS:\n<tool_call>\n{"name": "read_file", "arguments": {"path": "file1.txt"}}\n</tool_call>\n<tool_call>\n{"name": "read_file", "arguments": {"path": "file2.txt"}}\n</tool_call>\n\nCRITICAL RULES:\n1. ONLY use the tags above for tool calling. NEVER output raw JSON without tags.\n2. You can call multiple tools by outputting multiple <tool_call> blocks consecutively.\n3. Do NOT output any other text (explanations, chat, etc.) after your <tool_call> blocks. Wait for the user to provide the tool response.\n4. The JSON inside the tags MUST be valid and include ALL required braces and the "arguments" field.\n5. If you need to use a tool, do it IMMEDIATELY without preamble.\n\n`;

      if (bodyAny.tool_choice && typeof bodyAny.tool_choice === 'object' && bodyAny.tool_choice.function) {
        const forcedTool = bodyAny.tool_choice.function.name;
        systemPrompt += `CRITICAL: You MUST call the tool "${forcedTool}" in this response.\n\n`;
      }
    }

    const finalPrompt = systemPrompt ? `${systemPrompt}\n${prompt}` : prompt;

    const isThinkingModel = body.model.includes('thinking');
    const isNewSession = !messages.some(m => m.role === 'assistant');

    // Resolve the backend provider from the model name prefix.
    const { provider, internalModel } = resolveModel(body.model);

    const openStream = async (text: string, newConversation: boolean): Promise<ProviderStream> => {
      let retries = 3;
      while (true) {
        try {
          return await provider.createStream({
            prompt: text,
            enableThinking: isThinkingModel,
            model: internalModel,
            newConversation
          });
        } catch (err) {
          retries--;
          if (retries === 0) throw err;
          await new Promise(r => setTimeout(r, 1000));
        }
      }
    };

    const stream = await openStream(finalPrompt, isNewSession);

    const completionId = 'chatcmpl-' + uuidv4();

    // 1. Non-streaming completions
    if (!isStream) {
      const toolParser = new StreamingToolParser();
      let reasoningBuffer = '';
      let textBuffer = '';
      const toolCallsOut: any[] = [];
      let currentStream = stream;

      let autoContinueTurns = 0;
      const MAX_AUTO_CONTINUE_TURNS = 5;

      while (autoContinueTurns < MAX_AUTO_CONTINUE_TURNS) {
        const res = await consumeUnifiedStream(currentStream, toolParser);
        textBuffer += res.textBuffer;
        reasoningBuffer += res.reasoningBuffer;
        toolCallsOut.push(...res.toolCallsOut);

        if (isPausedMessage(res.textBuffer)) {
          // Clean the pause message from the buffer
          textBuffer = cleanPauseMessage(textBuffer);

          console.log(`[AutoContinue] Pause detected in non-streaming response. Auto-continuing turn ${autoContinueTurns + 1}...`);

          currentStream = await openStream('continue', false);
          autoContinueTurns++;
          continue;
        }
        break;
      }

      const usage = {
        prompt_tokens: Math.ceil(finalPrompt.length / 3.5),
        completion_tokens: Math.ceil((reasoningBuffer.length + textBuffer.length) / 3.5),
        total_tokens: Math.ceil((finalPrompt.length + reasoningBuffer.length + textBuffer.length) / 3.5),
      };

      const message: any = { role: 'assistant', content: toolCallsOut.length ? null : textBuffer };
      if (reasoningBuffer) message.reasoning_content = reasoningBuffer;
      if (toolCallsOut.length) toolCallsOut.forEach((tc, idx) => tc.index = idx);
      if (toolCallsOut.length) message.tool_calls = toolCallsOut;

      return c.json({
        id: completionId,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: body.model,
        choices: [{
          index: 0,
          message,
          logprobs: null,
          finish_reason: toolCallsOut.length ? 'tool_calls' : 'stop'
        }],
        usage
      });
    }

    // 2. Streaming completions
    c.header('Content-Type', 'text/event-stream');
    c.header('Cache-Control', 'no-cache');
    c.header('Connection', 'keep-alive');

    return honoStream(c, async (streamWriter: any) => {
      const writeEvent = async (data: any) => {
        await streamWriter.write(`data: ${JSON.stringify(data)}\n\n`);
      };

      const makeChoice = (delta: any, finishReason: string | null = null) => ({
        index: 0,
        delta,
        logprobs: null,
        finish_reason: finishReason
      });

      // Send initial chunk
      await writeEvent({
        id: completionId,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: body.model,
        choices: [makeChoice({ role: 'assistant', content: '' })]
      });

      let currentStream = stream;
      let autoContinueTurns = 0;
      const MAX_AUTO_CONTINUE_TURNS = 5;

      let reasoningBuffer = '';
      let textBuffer = '';
      let textStreamBuffer = '';
      const BUFFER_WINDOW = 200; // Hold back 200 chars to cover the pause message length
      let totalToolCallsEmitted = 0;
      let lastToolParserEmittedCount = 0;

      while (autoContinueTurns < MAX_AUTO_CONTINUE_TURNS) {
        const toolParser = new StreamingToolParser();
        let currentTurnHasPause = false;

        for await (const delta of currentStream) {
          // Stream thinking block content
          if (delta.type === 'reasoning') {
            reasoningBuffer += delta.text;
            await writeEvent({
              id: completionId,
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model: body.model,
              choices: [makeChoice({ reasoning_content: delta.text })]
            });
          } else if (delta.type === 'text') {
            const { text, toolCalls } = toolParser.feed(delta.text);

            if (text) {
              textStreamBuffer += text;
              // Emit everything beyond the buffer window
              if (textStreamBuffer.length > BUFFER_WINDOW) {
                const toEmit = textStreamBuffer.substring(0, textStreamBuffer.length - BUFFER_WINDOW);
                textStreamBuffer = textStreamBuffer.substring(textStreamBuffer.length - BUFFER_WINDOW);
                textBuffer += toEmit;
                await writeEvent({
                  id: completionId,
                  object: 'chat.completion.chunk',
                  created: Math.floor(Date.now() / 1000),
                  model: body.model,
                  choices: [makeChoice({ content: toEmit })]
                });
              }
            }

            for (const tc of toolCalls) {
              await writeEvent({
                id: completionId,
                object: 'chat.completion.chunk',
                created: Math.floor(Date.now() / 1000),
                model: body.model,
                choices: [makeChoice({
                  tool_calls: [{
                    index: totalToolCallsEmitted + toolParser.getEmittedToolCallCount() - toolCalls.length + toolCalls.indexOf(tc),
                    id: tc.id,
                    type: 'function',
                    function: {
                      name: tc.name,
                      arguments: JSON.stringify(tc.arguments)
                    }
                  }]
                })]
              });
            }
          }
          // 'done' deltas just end this turn's iteration.
        }

        // Flush remaining tool call content
        const { text: remainingText, toolCalls: remainingToolCalls } = toolParser.flush();
        if (remainingText) {
          textStreamBuffer += remainingText;
        }
        for (const tc of remainingToolCalls) {
          await writeEvent({
            id: completionId,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: body.model,
            choices: [makeChoice({
              tool_calls: [{
                index: totalToolCallsEmitted + toolParser.getEmittedToolCallCount() - remainingToolCalls.length + remainingToolCalls.indexOf(tc),
                id: tc.id,
                type: 'function',
                function: {
                  name: tc.name,
                  arguments: JSON.stringify(tc.arguments)
                }
              }]
            })]
          });
        }

        lastToolParserEmittedCount = toolParser.getEmittedToolCallCount();

        // Check if currentTurn has the pause message
        if (isPausedMessage(textStreamBuffer)) {
          currentTurnHasPause = true;
          // Clean the pause message from the buffer
          textStreamBuffer = cleanPauseMessage(textStreamBuffer);
        }

        if (currentTurnHasPause) {
          console.log(`[AutoContinue] Pause detected in streaming response. Auto-continuing turn ${autoContinueTurns + 1}...`);

          totalToolCallsEmitted += lastToolParserEmittedCount;

          currentStream = await openStream('continue', false);
          autoContinueTurns++;
          continue;
        }

        // If we reach here, it means we don't have a pause (or continue failed).
        // Emit any remaining buffered text and exit the loop.
        if (textStreamBuffer) {
          textBuffer += textStreamBuffer;
          await writeEvent({
            id: completionId,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: body.model,
            choices: [makeChoice({ content: textStreamBuffer })]
          });
          textStreamBuffer = '';
        }
        totalToolCallsEmitted += lastToolParserEmittedCount;
        break;
      }

      const usage = {
        prompt_tokens: Math.ceil(finalPrompt.length / 3.5),
        completion_tokens: Math.ceil((reasoningBuffer.length + textBuffer.length) / 3.5),
        total_tokens: Math.ceil((finalPrompt.length + reasoningBuffer.length + textBuffer.length) / 3.5),
      };

      const finalFinishReason = totalToolCallsEmitted > 0 ? 'tool_calls' : 'stop';

      // Send final finish reason and usage
      await writeEvent({
        id: completionId,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: body.model,
        choices: [makeChoice({}, finalFinishReason)],
        usage: usage
      });
      await streamWriter.write('data: [DONE]\n\n');
    });

  } catch (err: any) {
    console.error('Error in chatCompletions:', err);
    return c.json({ error: { message: err.message } }, 500);
  }
}
