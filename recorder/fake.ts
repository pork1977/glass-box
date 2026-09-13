/**
 * A scripted stand-in for the model, used by `--dry-run`.
 *
 * It answers in the same shapes the real API does, including a server tool
 * call and its result, so the engine, the gate, the fork and the writer are
 * all exercised for real. Only the thinking is fake, and any trace it
 * produces is stamped as a placeholder.
 */

import type Anthropic from "@anthropic-ai/sdk";
import type { ModelClient, ModelRequest, ModelResult } from "./model";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let counter = 0;
function nextId(prefix: string): string {
  counter += 1;
  return `${prefix}_dry${counter.toString().padStart(3, "0")}`;
}

function message(
  model: string,
  content: Anthropic.ContentBlock[],
  stopReason: Anthropic.Message["stop_reason"],
  usage: { input: number; output: number; cacheRead: number },
): ModelResult {
  const now = Date.now();
  return {
    blockDoneAt: content.map(() => now),
    message: {
    id: nextId("msg"),
    type: "message",
    role: "assistant",
    model,
    content,
    stop_reason: stopReason,
    stop_sequence: null,
      usage: {
        input_tokens: usage.input,
        output_tokens: usage.output,
        cache_read_input_tokens: usage.cacheRead,
        cache_creation_input_tokens: 0,
      },
    } as unknown as Anthropic.Message,
  };
}

function text(value: string): Anthropic.ContentBlock {
  return { type: "text", text: value, citations: null } as unknown as Anthropic.ContentBlock;
}

function toolUse(
  name: string,
  input: Record<string, unknown>,
): Anthropic.ContentBlock {
  return {
    type: "tool_use",
    id: nextId("toolu"),
    name,
    input,
  } as unknown as Anthropic.ContentBlock;
}

function serverSearch(query: string, results: string[]): Anthropic.ContentBlock[] {
  const id = nextId("srvtoolu");
  return [
    {
      type: "server_tool_use",
      id,
      name: "web_search",
      input: { query },
    } as unknown as Anthropic.ContentBlock,
    {
      type: "web_search_tool_result",
      tool_use_id: id,
      content: results.map((url, i) => ({
        type: "web_search_result",
        url,
        title: `Result ${i + 1} for ${query}`,
        page_age: null,
        encrypted_content: "(stripped in dry run)",
      })),
    } as unknown as Anthropic.ContentBlock,
  ];
}

const DELEGATIONS = [
  { agent: "research-a", task: "Research Crayon: what they sell, to whom, pricing, and where they are strong or weak." },
  { agent: "research-b", task: "Research Klue: what they sell, to whom, pricing, and where they are strong or weak." },
  { agent: "research-c", task: "Research Kompyte: what they sell, to whom, pricing, and where they are strong or weak." },
  { agent: "writer", task: "Turn the three sets of notes into a positioning brief and file it." },
];

const RESEARCH: Record<string, { query: string; urls: string[]; report: string }> = {
  "research-a": {
    query: "Crayon competitive intelligence pricing",
    urls: ["https://example.invalid/crayon/pricing", "https://example.invalid/reviews/crayon"],
    report:
      "Crayon sells competitive intelligence to enterprise product marketing teams. Pricing is quote only, and reviewers put it in the high five figures a year. Strong at breadth of capture, weaker on how much manual curation the battlecards still need. Sources: example.invalid/crayon/pricing, example.invalid/reviews/crayon.",
  },
  "research-b": {
    query: "Klue competitive enablement pricing reviews",
    urls: ["https://example.invalid/klue/product", "https://example.invalid/reviews/klue"],
    report:
      "Klue is aimed squarely at sales enablement rather than product marketing, with battlecards pushed into the CRM. Also quote only. Strong at getting reps to actually use it, weaker for teams who want the raw research rather than the cards. Sources: example.invalid/klue/product, example.invalid/reviews/klue.",
  },
  "research-c": {
    query: "Kompyte pricing small teams",
    urls: ["https://example.invalid/kompyte/pricing"],
    report:
      "Kompyte is the cheapest of the three and publishes a starting price, which the other two do not. Aimed at smaller marketing teams. Strong on automated tracking of rival websites, weaker on synthesis: it tells you what changed, not what it means. Source: example.invalid/kompyte/pricing.",
  },
};

const BRIEF = [
  "# Where the gap is",
  "",
  "All three of the tools we looked at are sold to teams big enough to have someone",
  "whose job is competitive research. Crayon and Klue will not even show a price.",
  "Kompyte publishes one, and it is still aimed at a marketing team rather than a",
  "founder.",
  "",
  "Nobody is serving the company that has no competitive analyst at all.",
  "",
  "## The one thing worth saying",
  "",
  "You do not need a research team to know what your rivals are doing this week.",
  "",
  "## What that means for the product",
  "",
  "- Lead with a price on the page, because two of the three will not show one.",
  "- Sell the summary, not the feed. Kompyte proves that telling someone what",
  "  changed is not the same as telling them what it means.",
  "- Aim at the founder, not the analyst, because nobody else is.",
].join("\n");

export class ScriptedModel implements ModelClient {
  readonly live = false;
  private calls = new Map<string, number>();

  async send(request: ModelRequest): Promise<ModelResult> {
    const turn = (this.calls.get(request.agentId) ?? 0) + 1;
    this.calls.set(request.agentId, turn);

    if (request.agentId === "planner") {
      await sleep(420);
      const delegation = DELEGATIONS[turn - 1];
      if (delegation) {
        return message(
          request.model,
          [
            text(`Next: ${delegation.agent}.`),
            toolUse("delegate", delegation),
          ],
          "tool_use",
          { input: 1800 + turn * 900, output: 120, cacheRead: turn === 1 ? 0 : 1600 },
        );
      }
      return message(
        request.model,
        [
          text(
            "Three companies researched and a positioning brief written. The gap is the company with no competitive analyst at all.",
          ),
        ],
        "end_turn",
        { input: 6200, output: 90, cacheRead: 4800 },
      );
    }

    const research = RESEARCH[request.agentId];
    if (research) {
      await sleep(1300);
      return message(
        request.model,
        [...serverSearch(research.query, research.urls), text(research.report)],
        "end_turn",
        { input: 2400, output: 210, cacheRead: 1200 },
      );
    }

    if (request.agentId === "writer") {
      await sleep(900);
      const carried = lastToolResultText(request.messages);
      if (carried.includes("changed this before it ran")) {
        return message(
          request.model,
          [
            text(
              "Filed as a draft, as you changed it to. The content is the same, only the title moved, so nothing in the brief needed rewriting.",
            ),
          ],
          "end_turn",
          { input: 4200, output: 70, cacheRead: 3300 },
        );
      }
      if (carried.includes("declined")) {
        return message(
          request.model,
          [
            text(
              `Not filed, so here is the brief in full instead.\n\n${BRIEF}`,
            ),
          ],
          "end_turn",
          { input: 3600, output: 420, cacheRead: 2400 },
        );
      }
      if (turn === 1) {
        return message(
          request.model,
          [
            text("The brief is ready. Asking before it goes into the repo."),
            toolUse("publish_brief", {
              title: "Positioning: the company with no analyst",
              markdown: BRIEF,
              summary:
                "Three rivals all sell to teams with a competitive analyst. Nobody serves the ones without.",
            }),
          ],
          "tool_use",
          { input: 3400, output: 380, cacheRead: 2200 },
        );
      }
      return message(
        request.model,
        [text("Filed. The brief is in the repository under public/briefs.")],
        "end_turn",
        { input: 4100, output: 60, cacheRead: 3200 },
      );
    }

    throw new Error(`the dry run has no script for agent ${request.agentId}`);
  }
}

/** Whatever came back from the last tool result, lowercased. */
function lastToolResultText(messages: Anthropic.MessageParam[]): string {
  const last = messages[messages.length - 1];
  if (!last || last.role !== "user" || typeof last.content === "string") {
    return "";
  }
  return last.content
    .filter((block) => block.type === "tool_result")
    .map((block) =>
      typeof (block as { content?: unknown }).content === "string"
        ? String((block as { content: string }).content)
        : "",
    )
    .join(" ")
    .toLowerCase();
}
