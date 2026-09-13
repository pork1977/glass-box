/**
 * The model behind the engine, behind a small interface.
 *
 * There are two implementations: the real Anthropic API, and a scripted fake
 * used by `--dry-run`. The fake exists so the whole pipeline, the loop, the
 * gate, the fork, the redaction and the file it writes, can be exercised
 * end to end without spending anything. A trace produced by the fake is
 * marked as a placeholder so it can never be mistaken for a real capture.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { AgentDefinition } from "../src/lib/trace/schema";

export interface ModelRequest {
  model: string;
  system: string;
  messages: Anthropic.MessageParam[];
  tools: Anthropic.ToolUnion[];
  effort?: AgentDefinition["effort"];
  /** Which agent this call belongs to, for the fake script and for logging. */
  agentId: string;
}

/**
 * The response, plus when each part of it actually arrived.
 *
 * Without the timing, every event in a turn gets stamped at the moment the
 * whole response landed. A four minute call full of web searches then shows
 * up on the timeline as a single mark, which is true about when we learned
 * what happened and useless about when it happened.
 */
export interface ModelResult {
  message: Anthropic.Message;
  /** Date.now() as each content block finished, indexed like message.content. */
  blockDoneAt: number[];
}

export interface ModelClient {
  /** True for the real API. False for the scripted fake. */
  readonly live: boolean;
  send(request: ModelRequest): Promise<ModelResult>;
}

const MAX_TOKENS = 16000;

/**
 * A second breakpoint on the last thing the agent was told, so the growing
 * conversation is read from cache on the next turn rather than resent at full
 * price. The array is copied rather than edited, because the caller keeps the
 * original and a stray cache_control left on an older block would move the
 * breakpoint and quietly invalidate the cache.
 */
function withConversationBreakpoint(
  messages: Anthropic.MessageParam[],
): Anthropic.MessageParam[] {
  if (messages.length < 2) return messages;

  const last = messages[messages.length - 1];
  if (typeof last.content === "string" || !Array.isArray(last.content)) {
    return messages;
  }

  const blocks = last.content.map((block, i) =>
    i === last.content.length - 1
      ? { ...block, cache_control: { type: "ephemeral" as const } }
      : block,
  );

  return [
    ...messages.slice(0, -1),
    { ...last, content: blocks } as Anthropic.MessageParam,
  ];
}

export class LiveModel implements ModelClient {
  readonly live = true;
  private client: Anthropic;

  constructor(apiKey?: string) {
    this.client = apiKey ? new Anthropic({ apiKey }) : new Anthropic();
  }

  async send(request: ModelRequest): Promise<ModelResult> {
    try {
      // Streamed for the timing, not for the display. It also keeps a long
      // turn from sitting against the request timeout.
      const stream = this.client.messages.stream({
        model: request.model,
        max_tokens: MAX_TOKENS,
        // A cache breakpoint on the system block covers everything rendered
        // before it, which is the tool schemas as well. Without this every
        // turn of a long agent loop pays full price for the same prefix, and
        // a recording of a hundred turns pays it a hundred times.
        system: [
          {
            type: "text",
            text: request.system,
            cache_control: { type: "ephemeral" },
          },
        ],
        messages: withConversationBreakpoint(request.messages),
        tools: request.tools,
        // Adaptive thinking on every current model. The summary is worth
        // having here because a recording of an agent's reasoning is the
        // point of the whole project.
        thinking: { type: "adaptive", display: "summarized" },
        output_config: request.effort ? { effort: request.effort } : undefined,
      });

      const blockDoneAt: number[] = [];
      for await (const event of stream) {
        if (event.type === "content_block_stop") {
          blockDoneAt[event.index] = Date.now();
        }
      }

      return { message: await stream.finalMessage(), blockDoneAt };
    } catch (error) {
      // Typed exceptions, most specific first. A recording run is worth
      // failing loudly rather than half-capturing.
      if (error instanceof Anthropic.AuthenticationError) {
        throw new Error(
          "The API key was rejected. Check ANTHROPIC_API_KEY, then run it again.",
        );
      }
      if (error instanceof Anthropic.RateLimitError) {
        throw new Error(
          "Rate limited before the run finished. Wait a moment and start again; a partial trace is not worth keeping.",
        );
      }
      if (error instanceof Anthropic.BadRequestError) {
        throw new Error(`The API rejected the request: ${error.message}`);
      }
      if (error instanceof Anthropic.APIError) {
        throw new Error(`API error ${error.status}: ${error.message}`);
      }
      throw error;
    }
  }
}

/** Usage totals across a run, for the trace and for the cost line at the end. */
export function addUsage(
  total: { inputTokens: number; outputTokens: number; cacheReadTokens: number },
  usage: Anthropic.Usage | undefined,
) {
  if (!usage) return total;
  total.inputTokens += usage.input_tokens ?? 0;
  total.outputTokens += usage.output_tokens ?? 0;
  total.cacheReadTokens += usage.cache_read_input_tokens ?? 0;
  return total;
}

/**
 * Published rates, September 2026, per million tokens. Only used to print an
 * estimate at the end of a run so the cost of a recording is never a surprise.
 */
const RATES: Record<string, { input: number; output: number; cacheRead: number }> = {
  "claude-opus-5": { input: 5, output: 25, cacheRead: 0.5 },
  "claude-sonnet-5": { input: 2, output: 10, cacheRead: 0.2 },
  "claude-haiku-4-5": { input: 1, output: 5, cacheRead: 0.1 },
};

export function estimateCost(
  perModel: Map<string, { inputTokens: number; outputTokens: number; cacheReadTokens: number }>,
): number {
  let total = 0;
  for (const [model, usage] of perModel) {
    const rate = RATES[model];
    if (!rate) continue;
    total +=
      (usage.inputTokens / 1e6) * rate.input +
      (usage.outputTokens / 1e6) * rate.output +
      (usage.cacheReadTokens / 1e6) * rate.cacheRead;
  }
  return total;
}
