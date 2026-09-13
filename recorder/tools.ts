/**
 * The tools agents can call.
 *
 * Two kinds live here. Local tools run in this process and are what the
 * allowlist actually gates. Server tools (web search) run on Anthropic's side
 * and come back inside the same response, so they have no implementation here
 * and are billed to whichever key made the call, which is what makes live
 * mode on a visitor's own key possible later.
 */

import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import type Anthropic from "@anthropic-ai/sdk";
import type { Sandbox } from "./sandbox";

export interface LocalTool {
  name: string;
  description: string;
  input_schema: Anthropic.Tool["input_schema"];
  /**
   * True when a person has to say yes before it runs. This is the flag that
   * creates a human-in-the-loop gate, and the only place one comes from.
   */
  requiresApproval?: boolean;
  /** What the card shows when it asks. */
  gate?: {
    title: (input: Record<string, unknown>) => string;
    reason: (input: Record<string, unknown>) => string;
    ifDenied: string;
    risk: "low" | "medium" | "high";
    /**
     * Approving with a change is a third answer, not a variation on yes. The
     * payload that runs is not the one the agent proposed, so the tool has to
     * say what a sensible change looks like and how to apply it.
     */
    edit?: {
      label: string;
      /** What changed, in words, for the card and the trace. */
      describe: (
        before: Record<string, unknown>,
        after: Record<string, unknown>,
      ) => string;
      apply: (
        input: Record<string, unknown>,
        override?: Record<string, unknown>,
      ) => Record<string, unknown>;
    };
  };
  run: (input: Record<string, unknown>) => Promise<unknown>;
}

/**
 * Where publish_brief is allowed to write. Nothing else on disk is reachable.
 * A dry run points this somewhere ignored by git, so exercising the tool for
 * real never leaves a fake brief in the repository.
 */
let briefDir = path.resolve(process.cwd(), "public", "briefs");

export function setBriefDir(dir: string) {
  briefDir = path.resolve(dir);
}

function safeSlug(value: unknown, fallback: string): string {
  const raw = typeof value === "string" ? value : "";
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug || fallback;
}

export const publishBrief: LocalTool = {
  name: "publish_brief",
  description:
    "Write the finished brief into the repository as a markdown file. This is a real file write and needs a person to approve it first.",
  input_schema: {
    type: "object",
    properties: {
      title: { type: "string", description: "Title of the brief" },
      markdown: { type: "string", description: "The full brief, in markdown" },
      summary: {
        type: "string",
        description: "One line on what the brief concludes",
      },
    },
    required: ["title", "markdown"],
    additionalProperties: false,
  },
  requiresApproval: true,
  gate: {
    title: (input) => `Write "${String(input.title ?? "brief")}" into the repo`,
    reason: (input) => {
      const words = String(input.markdown ?? "").trim().split(/\s+/).length;
      return `The brief is finished, about ${words} words. This writes a new file into public/briefs in the repository.`;
    },
    ifDenied:
      "Nothing is written. The writer replies with the brief in the conversation instead, so the work is not lost.",
    risk: "medium",
    edit: {
      label: "Approve, but file it as a draft",
      describe: (before, after) =>
        `Title changed from "${String(before.title)}" to "${String(after.title)}" before it ran.`,
      apply: (input, override) => ({
        ...input,
        title: String(
          override?.title ?? `Draft: ${String(input.title ?? "brief")}`,
        ),
      }),
    },
  },
  run: async (input) => {
    const slug = safeSlug(input.title, "brief");
    const file = path.join(briefDir, `${slug}.md`);
    await mkdir(briefDir, { recursive: true });
    await writeFile(file, String(input.markdown ?? ""), "utf8");
    return {
      written: true,
      path: path.relative(process.cwd(), file).replace(/\\/g, "/"),
      bytes: Buffer.byteLength(String(input.markdown ?? ""), "utf8"),
    };
  },
};

/**
 * Delegation is a tool like any other, which is what makes the planner's
 * handoffs visible in the trace instead of hidden inside one long
 * conversation. Its `run` is supplied by the engine, because only the engine
 * can start another agent.
 */
export const DELEGATE_TOOL_NAME = "delegate";

export function delegateTool(
  allowedAgents: string[],
  run: (input: Record<string, unknown>) => Promise<unknown>,
): LocalTool {
  return {
    name: DELEGATE_TOOL_NAME,
    description:
      "Hand one specific job to a specialist agent and wait for what it reports back.",
    input_schema: {
      type: "object",
      properties: {
        agent: {
          type: "string",
          enum: allowedAgents,
          description: "Which specialist to hand the job to",
        },
        task: {
          type: "string",
          description: "The job, in one or two plain sentences",
        },
      },
      required: ["agent", "task"],
      additionalProperties: false,
    },
    run,
  };
}

/** The issues an agent proposed, in a shape the gate and the tool can both use. */
function asIssues(
  input: Record<string, unknown>,
): { title: string; body: string; severity?: string }[] {
  const raw = Array.isArray(input.issues) ? input.issues : [];
  return raw.map((entry) => {
    const issue = (entry ?? {}) as Record<string, unknown>;
    return {
      title: String(issue.title ?? "Untitled finding"),
      body: String(issue.body ?? ""),
      severity: issue.severity ? String(issue.severity) : undefined,
    };
  });
}

/**
 * The tools that reach the checkout. They are built per run rather than
 * declared once, because each one needs the sandbox it is confined to, and a
 * tool with no sandbox should not exist at all.
 */
export function sandboxTools(sandbox: Sandbox): LocalTool[] {
  const readFile: LocalTool = {
    name: "read_file",
    description: "Read one file from the checkout.",
    input_schema: {
      type: "object",
      properties: { path: { type: "string", description: "Path inside the repo" } },
      required: ["path"],
      additionalProperties: false,
    },
    run: async (input) => {
      const content = await sandbox.readFile(String(input.path ?? ""));
      return { path: input.path, lines: content.split("\n").length, content };
    },
  };

  const listFiles: LocalTool = {
    name: "list_files",
    description: "List the files tracked in the checkout.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
    run: async () => ({ files: await sandbox.listFiles() }),
  };

  const writeFile: LocalTool = {
    name: "write_file",
    description:
      "Write one file in the checkout. Nothing leaves this machine until a pull request is opened, which needs a person.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path inside the repo" },
        content: { type: "string", description: "The complete new contents" },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
    run: async (input) => {
      const bytes = await sandbox.writeFile(
        String(input.path ?? ""),
        String(input.content ?? ""),
      );
      return { path: input.path, bytes, changed: await sandbox.diffStat() };
    },
  };

  const runBuild: LocalTool = {
    name: "run_build",
    description: "Run the repository's own build and report what it said.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
    run: async () => await sandbox.build(),
  };

  const openPr: LocalTool = {
    name: "github_create_pr",
    description:
      "Push the changes to a branch and open a pull request. This leaves the machine, so it needs a person to approve it first.",
    input_schema: {
      type: "object",
      properties: {
        branch: { type: "string", description: "New branch name" },
        title: { type: "string", description: "Pull request title" },
        body: { type: "string", description: "What changed and why" },
      },
      required: ["branch", "title", "body"],
      additionalProperties: false,
    },
    requiresApproval: true,
    gate: {
      title: (input) => `Open a pull request: ${String(input.title ?? "")}`,
      reason: (input) => {
        const files = sandbox.changedFiles();
        const list = files.length ? files.join(", ") : "(nothing)";
        return [
          `Pushes branch ${String(input.branch ?? "")} to the sandbox repository and opens a pull request.`,
          `${files.length} file${files.length === 1 ? "" : "s"} would be committed: ${list}.`,
        ].join(" ");
      },
      ifDenied:
        "Nothing is pushed. The work stays in the local checkout and the agent reports what it would have opened.",
      risk: "medium",
      edit: {
        label: "Approve, but mark it a draft in the title",
        describe: (before, after) =>
          `Title changed from "${String(before.title)}" to "${String(after.title)}" before it ran.`,
        apply: (input, override) => ({
          ...input,
          title: String(override?.title ?? `WIP: ${String(input.title ?? "")}`),
        }),
      },
    },
    run: async (input) =>
      await sandbox.openPullRequest({
        branch: String(input.branch ?? "agent/change"),
        title: String(input.title ?? "Agent change"),
        body: String(input.body ?? ""),
      }),
  };

  const fileIssues: LocalTool = {
    name: "github_create_issues",
    description:
      "File the audit findings as issues on the repository. This is public and visible to everyone, so it needs a person to approve it first.",
    input_schema: {
      type: "object",
      properties: {
        issues: {
          type: "array",
          description: "One entry per finding, most serious first",
          items: {
            type: "object",
            properties: {
              title: { type: "string", description: "Short, specific title" },
              body: {
                type: "string",
                description:
                  "What is wrong, where, who it affects, and how to fix it",
              },
              severity: {
                type: "string",
                enum: ["high", "medium", "low"],
                description: "How much it hurts a person using the site",
              },
            },
            required: ["title", "body", "severity"],
            additionalProperties: false,
          },
        },
      },
      required: ["issues"],
      additionalProperties: false,
    },
    requiresApproval: true,
    gate: {
      title: (input) => {
        const issues = asIssues(input);
        return `File ${issues.length} issue${issues.length === 1 ? "" : "s"} on the repository`;
      },
      reason: (input) => {
        const issues = asIssues(input);
        const bySeverity = ["high", "medium", "low"]
          .map((s) => `${issues.filter((i) => i.severity === s).length} ${s}`)
          .join(", ");
        return [
          `Creates ${issues.length} public issue${issues.length === 1 ? "" : "s"} (${bySeverity}).`,
          `Titles: ${issues.map((i) => i.title).join("; ")}.`,
        ].join(" ");
      },
      ifDenied:
        "Nothing is filed. The audit comes back as a summary in the conversation instead, so the findings are not lost.",
      risk: "medium",
      edit: {
        label: "Approve, but file only the high severity ones",
        describe: (before, after) =>
          `Filed ${asIssues(after).length} of ${asIssues(before).length} findings: the high severity ones only.`,
        apply: (input, override) => {
          if (override?.issues) return { ...input, issues: override.issues };
          const high = asIssues(input).filter((i) => i.severity === "high");
          return { ...input, issues: high.length ? high : asIssues(input).slice(0, 1) };
        },
      },
    },
    run: async (input) => await sandbox.createIssues(asIssues(input)),
  };

  return [readFile, listFiles, writeFile, runBuild, openPr, fileIssues];
}

const LOCAL_TOOLS: LocalTool[] = [publishBrief];

/** Tools that only exist for the length of one run, registered as they are built. */
let runScoped: LocalTool[] = [];

export function setRunScopedTools(tools: LocalTool[]) {
  runScoped = tools;
}

export function localTool(name: string): LocalTool | undefined {
  return runScoped.find((t) => t.name === name) ?? LOCAL_TOOLS.find((t) => t.name === name);
}

/** Server-side tools, declared by name in an agent's allowlist. */
export const SERVER_TOOLS: Record<string, Anthropic.ToolUnion> = {
  web_search: {
    type: "web_search_20260209",
    name: "web_search",
    max_uses: 5,
  } as Anthropic.ToolUnion,
};

export function isServerTool(name: string): boolean {
  return name in SERVER_TOOLS;
}

/**
 * Turn an agent's allowlist into the tools array for a request. An unknown
 * name is a configuration error and is worth failing on: silently dropping it
 * would leave an agent unable to do its job for no visible reason.
 */
export function toolsFor(
  allowlist: string[],
  extras: LocalTool[] = [],
): Anthropic.ToolUnion[] {
  const tools: Anthropic.ToolUnion[] = [];

  for (const name of allowlist) {
    if (isServerTool(name)) {
      tools.push(SERVER_TOOLS[name]);
      continue;
    }
    const extra = extras.find((t) => t.name === name);
    const local = extra ?? localTool(name);
    if (!local) throw new Error(`agent allowlist names unknown tool: ${name}`);
    tools.push({
      name: local.name,
      description: local.description,
      input_schema: local.input_schema,
    });
  }

  return tools;
}
