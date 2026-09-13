/**
 * Record a flight.
 *
 *   npm run record -- --dry-run          scripted, costs nothing, writes a
 *                                        trace marked as a placeholder
 *   npm run record                       the real thing, needs an API key
 *   npm run record -- --yes              approve gates without asking
 *   npm run record -- --scenario=<id>    pick a scenario
 *   npm run record -- --publish          put a dry run in the published flights
 *   npm run record -- --force            replace a real capture (with --publish)
 *
 * A run does two executions: the scenario as it happens, with you answering
 * any gate for real, and then a second run from the saved state just before
 * that gate with the opposite answer. Both go in one file.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { existsSync, readFileSync } from "node:fs";
import type { Branch, FlightSummary, Trace } from "../src/lib/trace/schema";
import { traceProblems } from "../src/lib/trace/validate";
import { SCENARIOS, scenario, type Scenario } from "./config";
import { Engine, answerWord, type Answer, type Approver } from "./engine";
import { LiveModel, estimateCost, type ModelClient } from "./model";
import { ScriptedModel } from "./fake";
import { assertClean, redactTrace } from "./redact";
import { localTool, sandboxTools, setBriefDir, setRunScopedTools } from "./tools";
import { sandboxFromEnv } from "./sandbox";

/** Where the site reads flights from. Only a real recording belongs here. */
const FLIGHT_DIR = path.resolve(process.cwd(), "public", "flights");

/**
 * A dry run writes here instead, and nowhere near the published flights.
 * Keeping them apart is the only reliable fix: a guard on the published
 * directory can be waved through with a flag, and then is, because the flag
 * is the quickest way to get a test run to finish.
 */
const DRY_FLIGHT_DIR = path.resolve(process.cwd(), ".dry-run", "flights");

interface Options {
  dryRun: boolean;
  autoApprove: boolean;
  scenarioId: string;
  /** Record only one alternate branch instead of every other answer. */
  oneAlternate: boolean;
  /** Allow a placeholder trace to replace a real recording. */
  force: boolean;
  /** Put a dry run into the published flights anyway. */
  publish: boolean;
}

/** Only offer an edit branch for tools that describe what an edit means. */
function answerAvailable(toolName: string, answer: Answer): boolean {
  if (answer !== "edit") return true;
  return Boolean(localTool(toolName)?.gate?.edit);
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    dryRun: argv.includes("--dry-run"),
    autoApprove: argv.includes("--yes"),
    scenarioId: SCENARIOS[0].id,
    oneAlternate: argv.includes("--one-alternate"),
    force: argv.includes("--force"),
    publish: argv.includes("--publish"),
  };
  for (const arg of argv) {
    if (arg.startsWith("--scenario=")) options.scenarioId = arg.slice(11);
  }
  return options;
}

/**
 * Read the key from a file when it is not already in the environment.
 * `.env.local` comes first because that is Next's convention for secrets and
 * git already ignores it. A real value in the environment always wins, and an
 * empty assignment is skipped so a blank stub does not look like a key.
 */
const ENV_FILES = [".env.local", ".env"];

function loadEnvFile() {
  for (const name of ENV_FILES) {
    const file = path.resolve(process.cwd(), name);
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
      const match = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i.exec(line);
      if (!match) continue;
      const value = match[2].replace(/^["']|["']$/g, "");
      if (!value) continue;
      if (!process.env[match[1]]) process.env[match[1]] = value;
    }
  }
}

function askInTerminal(): Approver {
  return async (gate) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    console.log("");
    console.log("  ---------------------------------------------");
    console.log(`  ${gate.agentName} is asking before it acts`);
    console.log(`  ${gate.title}`);
    console.log(`  Why: ${gate.reason}`);
    console.log(`  If you say no: ${gate.ifDenied}`);
    console.log("  ---------------------------------------------");
    if (gate.canEdit) console.log(`  Or change it first: ${gate.editLabel}`);
    const prompt = gate.canEdit
      ? "  [y] approve  [n] decline  [e] edit first: "
      : "  [y] approve  [n] decline: ";
    const typed = (await rl.question(prompt)).trim().toLowerCase();

    if (gate.canEdit && typed.startsWith("e")) {
      const suggested = `Draft: ${String(gate.input.title ?? "brief")}`;
      const title = (await rl.question(`  New title [${suggested}]: `)).trim();
      rl.close();
      console.log("  -> approved with a change");
      return { answer: "edit", input: { title: title || suggested } };
    }

    rl.close();
    const approved = typed.startsWith("y");
    console.log(`  -> ${approved ? "approved" : "declined"}`);
    return { answer: approved ? "approve" : "deny" };
  };
}

function branchLabel(toolName: string, answer: Answer): string {
  if (toolName === "github_create_issues") {
    if (answer === "approve") return "Approved, every finding was filed";
    if (answer === "deny") return "Declined, kept as a summary";
    return "Approved with a change, only the high severity ones filed";
  }
  if (toolName === "github_create_pr") {
    if (answer === "approve") return "Approved, the pull request was opened";
    if (answer === "deny") return "Declined, nothing was pushed";
    return "Approved with a change, opened as a draft";
  }
  if (toolName === "publish_brief") {
    if (answer === "approve") return "Approved, the brief was filed";
    if (answer === "deny") return "Declined, kept as a draft";
    return "Approved with a change, filed as a draft";
  }
  if (answer === "approve") return "Approved as proposed";
  if (answer === "deny") return "Declined";
  return "Approved with a change";
}

/**
 * A dry run and a real run write to the same place, so a throwaway trace can
 * land on top of a capture that cost money and took ten minutes. Nothing but
 * an explicit --force gets past this.
 */
async function guardExisting(file: string, trace: Trace, force: boolean) {
  if (!trace.placeholder || force || !existsSync(file)) return;

  const existing = JSON.parse(await readFile(file, "utf8")) as Partial<Trace>;
  if (existing.placeholder === false) {
    const shown = path.relative(process.cwd(), file).replace(/\\/g, "/");
    console.error(
      `\n${shown} holds a real recording (${existing.events?.length ?? "?"} events, recorded ${existing.recordedAt}).`,
    );
    console.error(
      "Refusing to replace it with placeholder data. Record for real, or pass --force if you meant it.",
    );
    process.exit(1);
  }
}

async function writeFlight(trace: Trace, dir: string, force: boolean) {
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${trace.id}.json`);
  await guardExisting(file, trace, force);
  await writeFile(file, `${JSON.stringify(trace, null, 2)}\n`, "utf8");

  const mainEvents = trace.events.filter((e) => e.branchId === "main");
  const summary: FlightSummary = {
    id: trace.id,
    title: trace.title,
    prompt: trace.prompt,
    file: `/flights/${trace.id}.json`,
    placeholder: trace.placeholder,
    agentCount: trace.agents.length,
    decisionCount: trace.decisions.length,
    durationMs: Math.max(0, ...mainEvents.map((e) => e.tMs)),
  };

  const indexFile = path.join(dir, "index.json");
  let flights: FlightSummary[] = [];
  if (existsSync(indexFile)) {
    const parsed = JSON.parse(await readFile(indexFile, "utf8")) as {
      flights?: FlightSummary[];
    };
    flights = parsed.flights ?? [];
  }
  flights = [summary, ...flights.filter((f) => f.id !== summary.id)];
  await writeFile(
    indexFile,
    `${JSON.stringify({ flights }, null, 2)}\n`,
    "utf8",
  );

  return file;
}

/** Write an unfinished capture somewhere git ignores, and say where. */
async function keepPartial(engine: Engine, sc: Scenario) {
  if (engine.capturedEvents === 0) return;
  try {
    const partial = engine.build(
      sc,
      [
        {
          id: "main",
          label: "Unfinished run",
          kind: "primary",
          parentId: null,
          forkFromMs: null,
          decisionId: null,
          answer: null,
        },
      ],
      true,
    );
    const dir = path.resolve(process.cwd(), ".dry-run");
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, `unfinished-${sc.id}.json`);
    await writeFile(file, `${JSON.stringify(partial, null, 2)}
`, "utf8");
    const shown = path.relative(process.cwd(), file).replace(/\\/g, "/");
    console.error(
      `\n${engine.capturedEvents} events were captured before this failed. Kept at ${shown}.`,
    );
  } catch {
    console.error("The partial capture could not be saved either.");
  }
}

async function main() {
  loadEnvFile();
  const options = parseArgs(process.argv.slice(2));
  const sc = scenario(options.scenarioId);

  let model: ModelClient;
  if (options.dryRun) {
    model = new ScriptedModel();
    // Tools still run for real, so they are genuinely exercised, but their
    // output goes somewhere git ignores.
    setBriefDir(path.resolve(process.cwd(), ".dry-run", "briefs"));
    console.log("Dry run: scripted model, nothing is charged.");
  } else {
    if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
      console.error(
        "No API key found. Put ANTHROPIC_API_KEY in .env.local (or set it in your shell), or use --dry-run.",
      );
      process.exit(1);
    }
    model = new LiveModel();
    console.log("Live run: this will call the API and cost real money.");
  }

  const approver: Approver = options.autoApprove || options.dryRun
    ? async () => {
        console.log("  gate: approved automatically");
        return { answer: "approve" as Answer };
      }
    : askInTerminal();

  // A flight that touches GitHub gets a fresh checkout of the throwaway
  // repository, and the tools that can reach it only exist for this run.
  if (sc.needsSandbox) {
    const sandbox = sandboxFromEnv(path.resolve(process.cwd(), ".sandbox"));
    console.log("Preparing the sandbox checkout...");
    await sandbox.prepare();
    setRunScopedTools(sandboxTools(sandbox));
    console.log("Sandbox ready.\n");
  }

  const engine = new Engine(model, approver, (line) => console.log(line));
  engine.setScenarioAgents(sc.agentIds);

  console.log(`\nRecording "${sc.title}"\n`);
  try {
    await engine.runPrimary(sc);
  } catch (error) {
    // The run may already have opened a pull request or written a file by the
    // time something falls over, so an incomplete capture is still worth
    // keeping. Losing it means paying again to find out what went wrong.
    await keepPartial(engine, sc);
    throw error;
  }

  const branches: Branch[] = [
    {
      id: "main",
      label: "The run as it happened",
      kind: "primary",
      parentId: null,
      forkFromMs: null,
      decisionId: null,
      answer: null,
    },
  ];

  // Every answer that was not given gets its own branch: a real re-run from
  // the saved state just before the gate. Each one is another execution and
  // another slice of cost, so --one-alternate records only the first.
  const gate = engine.recordedGates[0];
  if (gate) {
    branches[0].label = branchLabel(gate.toolName, gate.answer);

    const others = (["approve", "deny", "edit"] as Answer[]).filter(
      (answer) =>
        answer !== gate.answer && answerAvailable(gate.toolName, answer),
    );
    const toRecord = options.oneAlternate ? others.slice(0, 1) : others;

    for (const answer of toRecord) {
      const branchId = `alt-${gate.decisionId}-${answer}`;
      branches.push({
        id: branchId,
        label: branchLabel(gate.toolName, answer),
        kind: "alternate",
        parentId: "main",
        forkFromMs: gate.tMs,
        decisionId: gate.decisionId,
        answer,
      });

      console.log(`\nRe-running from the gate, ${answerWord(answer)} this time\n`);
      try {
        await engine.runAlternate(gate, branchId, answer);
        engine.linkBranchToDecision(gate.decisionId, branchId);
      } catch (error) {
        // The primary branch is already recorded and may already have opened a
        // pull request. Losing all of that because one alternate fell over is
        // the wrong trade, so keep what there is and say what broke.
        await keepPartial(engine, sc);
        throw error;
      }
    }
  } else {
    console.log("\nNo gate fired, so there is no alternate branch to record.\n");
  }

  const built = engine.build(sc, branches, !model.live);
  const { value: trace, report } = redactTrace(built);
  assertClean(trace);

  const problems = traceProblems(trace);
  if (problems.length) {
    // A live run costs money, so a rejected trace is kept for diagnosis
    // rather than thrown away. It goes somewhere git ignores.
    const rejectDir = path.resolve(process.cwd(), ".dry-run");
    await mkdir(rejectDir, { recursive: true });
    const rejected = path.join(rejectDir, `rejected-${trace.id}.json`);
    await writeFile(rejected, `${JSON.stringify(trace, null, 2)}\n`, "utf8");

    console.error("\nThe trace did not pass validation, so it was not published:");
    for (const problem of problems) console.error(`  - ${problem}`);
    console.error(
      `\nThe run itself is kept at ${path
        .relative(process.cwd(), rejected)
        .replace(/\\/g, "/")}, so nothing is lost.`,
    );
    process.exit(1);
  }

  const publishing = !options.dryRun || options.publish;
  const file = await writeFlight(
    trace,
    publishing ? FLIGHT_DIR : DRY_FLIGHT_DIR,
    options.force,
  );

  const redactions = Object.entries(report.hits);
  console.log("");
  console.log(`Wrote ${path.relative(process.cwd(), file).replace(/\\/g, "/")}`);
  console.log(
    `  ${trace.events.length} events, ${trace.decisions.length} decision(s), ${branches.length} branch(es)`,
  );
  console.log(
    `  redacted: ${redactions.length ? redactions.map(([k, v]) => `${k} x${v}`).join(", ") : "nothing found"}` +
      `${report.truncated ? `, trimmed ${report.truncated} long string(s)` : ""}`,
  );
  if (model.live) {
    const cost = estimateCost(engine.modelUsage);
    console.log(
      `  tokens: ${trace.usage?.inputTokens} in, ${trace.usage?.outputTokens} out, ${trace.usage?.cacheReadTokens} cached`,
    );
    console.log(`  estimated cost: $${cost.toFixed(2)}`);
  } else {
    console.log("  cost: nothing, this was a dry run");
  }
}

main().catch((error) => {
  console.error(`\nRecording failed: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
});
