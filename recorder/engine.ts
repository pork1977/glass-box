/**
 * The engine: it runs a scenario for real and writes down everything that
 * happened as it happens.
 *
 * Why a hand-written loop rather than the SDK's tool runner: this needs to
 * snapshot the exact conversation state at the moment a gate fires, then
 * re-enter from that snapshot with the opposite answer. It also has to record
 * every turn in the trace format as it goes. Owning the loop makes both
 * ordinary instead of awkward, and the same loop runs unchanged in a browser
 * later for live mode, where the SDK's Claude Code harness could not go.
 */

import type Anthropic from "@anthropic-ai/sdk";
import type {
  Artifact,
  Branch,
  Decision,
  Trace,
  TraceEvent,
  Usage,
} from "../src/lib/trace/schema";
import { TRACE_SCHEMA_ID } from "../src/lib/trace/schema";
import { agentSpec, type AgentSpec, type Scenario } from "./config";
import {
  DELEGATE_TOOL_NAME,
  delegateTool,
  localTool,
  toolsFor,
  type LocalTool,
} from "./tools";
import { addUsage, type ModelClient } from "./model";

export type Answer = "approve" | "deny" | "edit";

/**
 * What a person answered. "edit" carries the payload that should run instead
 * of the one the agent proposed, which is what makes it a third answer rather
 * than a softer yes.
 */
export interface GateAnswer {
  answer: Answer;
  input?: Record<string, unknown>;
}

export interface Approver {
  /** Asked once per gate. Declining is a real answer, not a failure. */
  (gate: {
    agentName: string;
    toolName: string;
    title: string;
    reason: string;
    ifDenied: string;
    canEdit: boolean;
    editLabel?: string;
    input: Record<string, unknown>;
  }): Promise<GateAnswer>;
}

interface Frame {
  agentId: string;
  messages: Anthropic.MessageParam[];
}

export interface GateRecord {
  decisionId: string;
  tMs: number;
  agentId: string;
  toolName: string;
  input: Record<string, unknown>;
  /** Every open conversation at the moment of the gate, outermost first. */
  frames: Frame[];
  pendingToolUseId: string;
  answer: Answer;
  /** The payload a person substituted, when the answer was "edit". */
  editedInput?: Record<string, unknown>;
}

const DEFAULT_MAX_TURNS = 12;

function shorten(value: string, max = 90): string {
  const clean = value.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function cloneFrames(frames: Frame[]): Frame[] {
  return frames.map((f) => ({
    agentId: f.agentId,
    messages: structuredClone(f.messages),
  }));
}

export class Engine {
  private events: TraceEvent[] = [];
  private decisions: Decision[] = [];
  private artifacts: Artifact[] = [];
  private gates: GateRecord[] = [];
  private usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
  private perModel = new Map<
    string,
    { inputTokens: number; outputTokens: number; cacheReadTokens: number }
  >();

  private seq = 0;
  private branchId = "main";
  private wallStart = Date.now();
  private timeBase = 0;

  constructor(
    private model: ModelClient,
    private approve: Approver,
    private log: (line: string) => void = () => {},
  ) {}

  // ---------- recording ----------

  private now(): number {
    return this.timeBase + (Date.now() - this.wallStart);
  }

  private id(prefix: string): string {
    this.seq += 1;
    return `${prefix}${this.seq.toString().padStart(3, "0")}`;
  }

  /** Wall clock (Date.now) translated into this run's timeline. */
  private at(wall: number | undefined): number {
    if (!wall) return this.now();
    return Math.max(0, this.timeBase + (wall - this.wallStart));
  }

  private record(
    event: Omit<TraceEvent, "id" | "branchId" | "tMs">,
    atMs?: number,
  ): TraceEvent {
    const full: TraceEvent = {
      id: this.id("e"),
      branchId: this.branchId,
      tMs: atMs ?? this.now(),
      ...event,
    };
    this.events.push(full);
    this.log(`  ${(full.tMs / 1000).toFixed(1)}s  ${full.kind}: ${full.label}`);
    return full;
  }

  // ---------- running ----------

  /** The whole scenario on the primary branch. */
  async runPrimary(sc: Scenario): Promise<void> {
    this.branchId = "main";
    this.timeBase = 0;
    this.wallStart = Date.now();

    this.record({
      kind: "plan",
      agentId: "planner",
      label: `Task received: ${shorten(sc.title, 70)}`,
      detail: sc.prompt,
    });

    await this.runAgent("planner", sc.prompt, []);
  }

  /**
   * Re-enter from a gate with the other answer. This is a real second
   * execution that shares everything before the fork and diverges after it.
   */
  async runAlternate(
    gate: GateRecord,
    branchId: string,
    answer: Answer,
  ): Promise<void> {
    this.branchId = branchId;
    this.timeBase = gate.tMs;
    this.wallStart = Date.now();

    const frames = cloneFrames(gate.frames);
    const innermost = frames[frames.length - 1];

    this.record({
      kind: "message",
      agentId: gate.agentId,
      label: `The other answer: ${answerWord(answer)}`,
      detail: `Re-run from the saved state just before the ${gate.toolName} gate.`,
    });

    // Answer the pending tool call the other way, then finish that agent.
    let carried = await this.continueFrame(
      innermost,
      await this.resultForAnswer(gate, answer),
      frames.slice(0, -1),
    );

    // Then hand what it produced back up the stack, one delegate call at a time.
    for (let i = frames.length - 2; i >= 0; i -= 1) {
      const frame = frames[i];
      const pending = lastPendingToolUseId(frame, DELEGATE_TOOL_NAME);
      if (!pending) break;
      carried = await this.continueFrame(
        frame,
        { type: "tool_result", tool_use_id: pending, content: carried },
        frames.slice(0, i),
      );
    }
  }

  /** Start an agent on a task and run it until it is finished. */
  private async runAgent(
    agentId: string,
    task: string,
    stack: Frame[],
  ): Promise<string> {
    const frame: Frame = {
      agentId,
      messages: [{ role: "user", content: task }],
    };

    this.record({
      kind: "agent_start",
      agentId,
      label: `${agentSpec(agentId).name} started`,
      detail: shorten(task, 200),
    });

    const output = await this.loop(frame, stack);

    this.record({
      kind: "agent_end",
      agentId,
      label: `${agentSpec(agentId).name} finished`,
    });

    return output;
  }

  /** Continue an existing conversation after answering its pending tool call. */
  private async continueFrame(
    frame: Frame,
    result: Anthropic.ToolResultBlockParam,
    stack: Frame[],
  ): Promise<string> {
    frame.messages.push({ role: "user", content: [result] });
    const output = await this.loop(frame, stack);
    this.record({
      kind: "agent_end",
      agentId: frame.agentId,
      label: `${agentSpec(frame.agentId).name} finished`,
    });
    return output;
  }

  /** One agent's request and tool-result cycle, until it stops asking. */
  private async loop(frame: Frame, stack: Frame[]): Promise<string> {
    const spec = agentSpec(frame.agentId);
    const tools = this.toolSet(spec, frame, stack);
    let lastText = "";

    const maxTurns = spec.definition.maxTurns ?? DEFAULT_MAX_TURNS;

    for (let turn = 0; turn < maxTurns; turn += 1) {
      const { message: response, blockDoneAt } = await this.model.send({
        agentId: frame.agentId,
        model: spec.definition.model,
        system: spec.definition.systemPrompt,
        messages: frame.messages,
        tools: toolsFor(spec.definition.tools, tools),
        effort: spec.definition.effort,
      });

      this.countUsage(spec.definition.model, response.usage);
      lastText =
        this.recordAssistantTurn(frame.agentId, response, blockDoneAt) ||
        lastText;

      // A server tool ran long and the turn paused. Push it back and continue.
      if (response.stop_reason === "pause_turn") {
        frame.messages.push({ role: "assistant", content: response.content });
        continue;
      }

      const calls = response.content.filter(
        (block): block is Anthropic.ToolUseBlock => block.type === "tool_use",
      );

      if (response.stop_reason !== "tool_use" || calls.length === 0) {
        return lastText;
      }

      frame.messages.push({ role: "assistant", content: response.content });

      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const call of calls) {
        results.push(
          await this.runToolCall(call, frame, stack, tools),
        );
      }
      frame.messages.push({ role: "user", content: results });
    }

    throw new Error(
      `${spec.name} did not finish within ${maxTurns} turns. Raise maxTurns on its definition if the job genuinely needs more.`,
    );
  }

  /** Tools this agent can call, including delegation when it has children. */
  private toolSet(spec: AgentSpec, frame: Frame, stack: Frame[]): LocalTool[] {
    if (!spec.definition.tools.includes(DELEGATE_TOOL_NAME)) return [];

    const children = this.childrenOf(spec.id);
    return [
      delegateTool(children, async (input) => {
        const agent = String(input.agent ?? "");
        const task = String(input.task ?? "");
        if (!children.includes(agent)) {
          return `There is no agent called ${agent}. Choose one of: ${children.join(", ")}.`;
        }
        return await this.runAgent(agent, task, [...stack, frame]);
      }),
    ];
  }

  private childrenOf(parentId: string): string[] {
    return this.scenarioAgents
      .filter((id) => agentSpec(id).parentId === parentId)
      .filter((id) => id !== parentId);
  }

  private scenarioAgents: string[] = [];

  setScenarioAgents(ids: string[]) {
    this.scenarioAgents = ids;
  }

  /** Run one tool call, stopping for a person first when the tool says so. */
  private async runToolCall(
    call: Anthropic.ToolUseBlock,
    frame: Frame,
    stack: Frame[],
    extras: LocalTool[],
  ): Promise<Anthropic.ToolResultBlockParam> {
    const tool =
      extras.find((t) => t.name === call.name) ?? localTool(call.name);
    const input = (call.input ?? {}) as Record<string, unknown>;

    if (!tool) {
      return {
        type: "tool_result",
        tool_use_id: call.id,
        content: `No tool called ${call.name} is available to you.`,
        is_error: true,
      };
    }

    if (tool.requiresApproval && tool.gate) {
      const gate = await this.gateFor(tool, call, input, frame, stack);
      return await this.resultForAnswer(gate, gate.answer);
    }

    this.record({
      kind: "tool_call",
      agentId: frame.agentId,
      label: `${call.name}: ${shorten(describeInput(call.name, input), 60)}`,
      tool: { name: call.name, request: input },
    });

    try {
      const output = await tool.run(input);
      this.record({
        kind: "tool_result",
        agentId: frame.agentId,
        label: `${call.name} finished`,
        tool: { name: call.name, request: input, response: output, ok: true },
      });
      return {
        type: "tool_result",
        tool_use_id: call.id,
        content: typeof output === "string" ? output : JSON.stringify(output),
      };
    } catch (error) {
      const problem = error instanceof Error ? error.message : String(error);
      this.record({
        kind: "tool_result",
        agentId: frame.agentId,
        label: `${call.name} failed: ${shorten(problem, 50)}`,
        tool: { name: call.name, request: input, response: problem, ok: false },
      });
      return {
        type: "tool_result",
        tool_use_id: call.id,
        content: problem,
        is_error: true,
      };
    }
  }

  /** Record the gate, ask the person, and remember enough to fork later. */
  private async gateFor(
    tool: LocalTool,
    call: Anthropic.ToolUseBlock,
    input: Record<string, unknown>,
    frame: Frame,
    stack: Frame[],
  ): Promise<GateRecord> {
    const spec = agentSpec(frame.agentId);
    const decisionId = this.id("d");
    const tMs = this.now();

    const decision: Decision = {
      id: decisionId,
      tMs,
      agentId: frame.agentId,
      title: tool.gate!.title(input),
      reason: tool.gate!.reason(input),
      ifDenied: tool.gate!.ifDenied,
      risk: tool.gate!.risk,
      proposedAction: { tool: call.name, input },
      takenBranchId: this.branchId,
      branchIds: [this.branchId],
    };
    this.decisions.push(decision);

    this.record({
      kind: "decision",
      agentId: frame.agentId,
      label: `Waiting on a person: ${shorten(decision.title, 60)}`,
      decisionId,
    });

    const asked = await this.approve({
      agentName: spec.name,
      toolName: call.name,
      title: decision.title,
      reason: decision.reason,
      ifDenied: decision.ifDenied,
      canEdit: Boolean(tool.gate!.edit),
      editLabel: tool.gate!.edit?.label,
      input,
    });

    const gate: GateRecord = {
      decisionId,
      tMs,
      agentId: frame.agentId,
      toolName: call.name,
      input,
      // The snapshot has to be taken before the answer changes anything.
      frames: cloneFrames([...stack, frame]),
      pendingToolUseId: call.id,
      answer: asked.answer,
      editedInput: asked.input,
    };
    this.gates.push(gate);
    return gate;
  }

  /** Carry out a gated call, or report the refusal back to the agent. */
  private async resultForAnswer(
    gate: GateRecord,
    answer: Answer,
  ): Promise<Anthropic.ToolResultBlockParam> {
    const tool = localTool(gate.toolName);
    if (!tool) throw new Error(`gate names unknown tool ${gate.toolName}`);

    if (answer === "deny") {
      this.record({
        kind: "tool_result",
        agentId: gate.agentId,
        label: `${gate.toolName} declined by a person`,
        detail: tool.gate?.ifDenied,
        tool: {
          name: gate.toolName,
          request: gate.input,
          response: "declined by the person watching",
          ok: false,
        },
      });
      return {
        type: "tool_result",
        tool_use_id: gate.pendingToolUseId,
        content:
          "The person watching declined this. Do not try it again. Finish your work without it and say what you would have done.",
      };
    }

    // Approving with a change runs a different payload from the one the agent
    // proposed, so the trace has to show both and say what moved.
    const edited = answer === "edit";
    const input = edited
      ? (tool.gate?.edit?.apply(gate.input, gate.editedInput) ?? gate.input)
      : gate.input;

    if (edited) {
      this.record({
        kind: "message",
        agentId: gate.agentId,
        label: "A person changed the action before it ran",
        detail:
          tool.gate?.edit?.describe(gate.input, input) ??
          "The payload was edited before it ran.",
      });
    }

    this.record({
      kind: "tool_call",
      agentId: gate.agentId,
      label: `${gate.toolName}: ${edited ? "approved with a change" : "approved by a person"}`,
      tool: {
        name: gate.toolName,
        request: edited ? { proposed: gate.input, ran: input } : input,
      },
    });

    const output = await tool.run(input);
    this.record({
      kind: "tool_result",
      agentId: gate.agentId,
      label: `${gate.toolName} finished`,
      tool: {
        name: gate.toolName,
        request: input,
        response: output,
        ok: true,
      },
    });

    const artifactId = this.id("a");
    this.artifacts.push({
      id: artifactId,
      kind: gate.toolName === "github_create_pr" ? "pull_request" : "document",
      title: String(input.title ?? "Artifact"),
      summary: String(input.summary ?? ""),
      // The whole promise of a flight is that it ends in something real you
      // can open, so a produced pull request has to carry its link.
      url: linkFor(output),
      branchId: this.branchId,
    });
    this.record({
      kind: "artifact",
      agentId: gate.agentId,
      label: `Produced: ${shorten(String(input.title ?? "artifact"), 50)}`,
      artifactId,
    });

    return {
      type: "tool_result",
      tool_use_id: gate.pendingToolUseId,
      content:
        (edited
          ? "The person watching changed this before it ran. "
          : "") +
        (typeof output === "string" ? output : JSON.stringify(output)),
    };
  }

  /**
   * Write down what the model said this turn: its summarised thinking, its
   * text, and any server-side tool it used on its own.
   */
  private recordAssistantTurn(
    agentId: string,
    response: Anthropic.Message,
    blockDoneAt: number[] = [],
  ): string {
    // Every text block, not the last one. A cited answer arrives split across
    // several blocks, and keeping only the final one is how a full research
    // report turns into a sentence fragment.
    const texts: string[] = [];

    for (const [index, block] of response.content.entries()) {
      const at = this.at(blockDoneAt[index]);

      if (block.type === "text") {
        if (!block.text.trim()) continue;
        texts.push(block.text);
        {
          this.record(
            {
              kind: "message",
              agentId,
              label: shorten(block.text, 80),
              detail: block.text,
            },
            at,
          );
        }
        continue;
      }

      if (block.type === "thinking" && block.thinking?.trim()) {
        this.record(
          {
            kind: "message",
            agentId,
            label: `Thinking: ${shorten(block.thinking, 70)}`,
            detail: block.thinking,
          },
          at,
        );
        continue;
      }

      const loose = block as unknown as {
        type: string;
        name?: string;
        input?: Record<string, unknown>;
        content?: unknown;
      };

      if (loose.type === "server_tool_use") {
        this.record(
          {
            kind: "tool_call",
            agentId,
            label: `${loose.name}: ${shorten(
              describeInput(loose.name ?? "", loose.input ?? {}),
              60,
            )}`,
            tool: {
              name: loose.name ?? "server_tool",
              request: loose.input ?? {},
              server: true,
            },
          },
          at,
        );
        continue;
      }

      if (loose.type.endsWith("_tool_result")) {
        const results = Array.isArray(loose.content) ? loose.content : [];
        const errored =
          !Array.isArray(loose.content) &&
          typeof loose.content === "object" &&
          loose.content !== null;
        this.record(
          {
            kind: "tool_result",
            agentId,
            label: errored
              ? "Search failed"
              : `${results.length} result${results.length === 1 ? "" : "s"} back`,
            tool: {
              name: loose.type.replace("_tool_result", ""),
              request: {},
              response: loose.content,
              ok: !errored,
              server: true,
            },
          },
          at,
        );
      }
    }

    return texts.join("\n\n");
  }

  private countUsage(model: string, usage: Anthropic.Usage | undefined) {
    addUsage(this.usage, usage);
    const current =
      this.perModel.get(model) ??
      { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
    addUsage(current, usage);
    this.perModel.set(model, current);
  }

  // ---------- output ----------

  /** Everything captured so far, for the case where a run falls over. */
  get capturedEvents(): number {
    return this.events.length;
  }

  get recordedGates(): GateRecord[] {
    return this.gates;
  }

  get modelUsage() {
    return this.perModel;
  }

  /** Note on the trace that a decision now has a second recorded answer. */
  linkBranchToDecision(decisionId: string, branchId: string) {
    const decision = this.decisions.find((d) => d.id === decisionId);
    if (decision && !decision.branchIds.includes(branchId)) {
      decision.branchIds.push(branchId);
    }
  }

  build(sc: Scenario, branches: Branch[], placeholder: boolean): Trace {
    const usage: Usage = {
      inputTokens: this.usage.inputTokens,
      outputTokens: this.usage.outputTokens,
      cacheReadTokens: this.usage.cacheReadTokens,
    };

    return {
      schema: TRACE_SCHEMA_ID,
      id: sc.id,
      title: sc.title,
      prompt: sc.prompt,
      recordedAt: new Date().toISOString(),
      model: agentSpec("planner").definition.model,
      placeholder,
      agents: sc.agentIds.map((id) => {
        const spec = agentSpec(id);
        return {
          id: spec.id,
          name: spec.name,
          role: spec.role,
          parentId: spec.parentId,
          definition: spec.definition,
        };
      }),
      branches,
      events: [...this.events].sort((a, b) => a.tMs - b.tMs),
      decisions: this.decisions,
      artifacts: this.artifacts,
      usage,
    };
  }
}

/**
 * Where the thing a run produced can be opened: a pull request on GitHub, or a
 * file this site serves. A dry run writes outside public/, and a dead link
 * would be worse than none, so anything else gets no link at all.
 */
function linkFor(output: unknown): string | undefined {
  if (!output || typeof output !== "object") return undefined;

  const url = (output as { url?: unknown }).url;
  if (typeof url === "string" && /^https?:\/\//.test(url)) return url;

  const filePath = (output as { path?: unknown }).path;
  if (typeof filePath === "string" && filePath.startsWith("public/")) {
    return `/${filePath.slice("public/".length)}`;
  }

  return undefined;
}

/** How an answer reads in a label. */
export function answerWord(answer: Answer): string {
  return answer === "approve"
    ? "approved"
    : answer === "deny"
      ? "declined"
      : "approved with a change";
}

/** The last tool call of a given name still waiting for its result. */
function lastPendingToolUseId(frame: Frame, toolName: string): string | null {
  for (let i = frame.messages.length - 1; i >= 0; i -= 1) {
    const message = frame.messages[i];
    if (message.role !== "assistant" || typeof message.content === "string") {
      continue;
    }
    for (const block of [...message.content].reverse()) {
      if (block.type === "tool_use" && block.name === toolName) {
        return block.id;
      }
    }
  }
  return null;
}

/** A short, readable version of a tool's input for the timeline label. */
function describeInput(
  toolName: string,
  input: Record<string, unknown>,
): string {
  if (toolName === DELEGATE_TOOL_NAME) {
    return `${String(input.agent ?? "")} — ${String(input.task ?? "")}`;
  }
  for (const key of ["query", "title", "path", "command", "url"]) {
    if (typeof input[key] === "string") return input[key] as string;
  }
  // Web search drives itself through code execution, so the useful label is
  // the first line of that code rather than the word "code".
  if (typeof input.code === "string") {
    const firstLine = input.code
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0);
    if (firstLine) return firstLine;
  }
  return Object.keys(input).join(", ");
}
