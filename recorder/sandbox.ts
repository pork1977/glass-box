/**
 * The working copy an agent is allowed to touch.
 *
 * Everything here is confined to one throwaway repository checked out under
 * .sandbox, and every path an agent gives is resolved and then checked to be
 * inside it. An agent that is talked into `../../../.env` gets an error, not a
 * file. This is the boundary the whole safety story rests on, so it is worth
 * more care than the rest of the recorder put together.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const run = promisify(execFile);

export interface SandboxConfig {
  /** owner/name of the throwaway repository. */
  repo: string;
  /** A token scoped to that repository and nothing else. */
  token: string;
  /** Where to check it out. Ignored by git in this project. */
  dir: string;
  /** The branch pull requests are opened against. */
  base: string;
}

/**
 * Files an agent may not touch. A build an agent can edit is not a build, and
 * a recorded run where the agent quietly replaced the checks with a line that
 * exits zero is exactly what this list exists to prevent.
 */
const PROTECTED = [
  "build.js",
  "package.json",
  "package-lock.json",
  ".github/",
  ".git/",
];

export class Sandbox {
  /**
   * What the agent wrote, kept in memory as well as on disk. Each recorded
   * branch opens its own pull request from a clean base, so the contents have
   * to be re-applied rather than assumed to still be sitting in the checkout.
   */
  private written = new Map<string, string>();

  /** How many pull requests this checkout has opened, for unique branch names. */
  private attempts = 0;

  constructor(private config: SandboxConfig) {}

  /** The one place an agent's file paths are allowed to land. */
  private resolve(relative: string): string {
    const full = path.resolve(this.config.dir, relative);
    const root = path.resolve(this.config.dir);
    if (full !== root && !full.startsWith(root + path.sep)) {
      throw new Error(
        `${relative} is outside the sandbox. Only files inside the checkout are reachable.`,
      );
    }
    return full;
  }

  private remote(): string {
    // The token lives in the remote URL for the life of the process only. It
    // is never written into the checkout's git config, so it cannot end up in
    // a commit or a trace.
    return `https://x-access-token:${this.config.token}@github.com/${this.config.repo}.git`;
  }

  /**
   * npm has to go through a shell on Windows. Node will not spawn `npm`
   * (it is a shim, not an executable) and refuses to spawn `npm.cmd` directly
   * at all, so every build here silently reported "failed, with no output"
   * until this was noticed. A build that cannot run is worse than no build,
   * because the agent believes the failure and works around it.
   */
  private async npm(args: string[]) {
    return await run(`npm ${args.join(" ")}`, [], {
      cwd: this.config.dir,
      shell: true,
      maxBuffer: 32 * 1024 * 1024,
    });
  }

  private async git(args: string[], cwd = this.config.dir) {
    const { stdout, stderr } = await run("git", args, {
      cwd,
      maxBuffer: 8 * 1024 * 1024,
    });
    return `${stdout}${stderr}`.trim();
  }

  /** A clean checkout for each recording, so runs never inherit each other. */
  async prepare(): Promise<void> {
    await rm(this.config.dir, { recursive: true, force: true });
    await mkdir(path.dirname(this.config.dir), { recursive: true });
    await run("git", [
      "clone",
      "--depth",
      "1",
      "--branch",
      this.config.base,
      this.remote(),
      this.config.dir,
    ]);
    await this.git(["config", "user.name", "glass-box-agent"]);
    await this.git(["config", "user.email", "agent@glass-box.invalid"]);
  }

  async readFile(relative: string): Promise<string> {
    return await readFile(this.resolve(relative), "utf8");
  }

  async writeFile(relative: string, content: string): Promise<number> {
    const normalised = relative.replace(/\\/g, "/").replace(/^\.\//, "");
    const blocked = PROTECTED.find(
      (entry) =>
        entry.endsWith("/")
          ? normalised.startsWith(entry)
          : normalised === entry,
    );
    if (blocked) {
      throw new Error(
        `${normalised} is protected and cannot be changed. It defines whether the work is correct, so it is not yours to edit. Change the site instead.`,
      );
    }

    const full = this.resolve(relative);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, content, "utf8");
    this.written.set(normalised, content);
    return Buffer.byteLength(content, "utf8");
  }

  async listFiles(): Promise<string[]> {
    const out = await this.git(["ls-files"]);
    return out.split(/\r?\n/).filter(Boolean).slice(0, 200);
  }

  async diffStat(): Promise<string> {
    if (this.written.size === 0) return "no changes";
    const paths = [...this.written.keys()];
    return (await this.git(["diff", "--stat", "--", ...paths])) || "no changes";
  }

  /** What this run has changed, for the gate to show before anything is pushed. */
  changedFiles(): string[] {
    return [...this.written.keys()];
  }

  /** Run the repository's own build, when it has one. */
  async build(): Promise<{ ok: boolean; output: string }> {
    const pkg = path.join(this.config.dir, "package.json");
    if (!existsSync(pkg)) {
      return { ok: true, output: "No package.json, nothing to build." };
    }
    const manifest = JSON.parse(await readFile(pkg, "utf8")) as {
      scripts?: Record<string, string>;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    if (!manifest.scripts?.build) {
      return { ok: true, output: "No build script, nothing to build." };
    }
    try {
      if (
        manifest.dependencies ||
        manifest.devDependencies
          ? !existsSync(path.join(this.config.dir, "node_modules"))
          : false
      ) {
        await this.npm(["install", "--no-audit", "--no-fund"]);
      }
      const { stdout, stderr } = await this.npm(["run", "build"]);
      return { ok: true, output: `${stdout}${stderr}`.trim().slice(-1500) };
    } catch (error) {
      const problem = error as { stdout?: string; stderr?: string };
      return {
        ok: false,
        output: `${problem.stdout ?? ""}${problem.stderr ?? ""}`.trim().slice(-1500),
      };
    }
  }

  /**
   * Push what the agent changed onto a new branch and open a pull request.
   * This is the step that leaves the machine, which is why it sits behind a
   * gate rather than being something an agent can reach on its own.
   */
  async openPullRequest(input: {
    branch: string;
    title: string;
    body: string;
  }): Promise<{ number: number; url: string; state: string }> {
    if (this.written.size === 0) {
      throw new Error(
        "Nothing has been written, so there is nothing to open a pull request for.",
      );
    }

    // Each branch of a recording opens its own pull request from the same
    // checkout, so start from a clean base every time and give the branch a
    // name that has not been used yet. Without this the second one dies on
    // "a branch named ... already exists".
    this.attempts += 1;
    const branch =
      this.attempts === 1 ? input.branch : `${input.branch}-${this.attempts}`;

    await this.git(["checkout", "-f", this.config.base]);
    await this.git(["checkout", "-b", branch]);

    // Re-apply what the agent wrote. Checking out the base threw it away, and
    // the contents are held in memory for exactly this reason.
    for (const [relative, content] of this.written) {
      const full = this.resolve(relative);
      await mkdir(path.dirname(full), { recursive: true });
      await writeFile(full, content, "utf8");
    }

    // Only the files this run actually wrote. `git add -A` would sweep up
    // anything else sitting in the checkout, which is how a pull request ends
    // up containing a change its own description denies making.
    await this.git(["add", "--", ...this.written.keys()]);
    await this.git(["commit", "-m", input.title]);
    await this.git(["push", this.remote(), `HEAD:${branch}`]);

    const response = await fetch(
      `https://api.github.com/repos/${this.config.repo}/pulls`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.config.token}`,
          accept: "application/vnd.github+json",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          title: input.title,
          body: input.body,
          head: branch,
          base: this.config.base,
        }),
      },
    );

    if (!response.ok) {
      const detail = await response.text();
      throw new Error(
        `GitHub refused the pull request (${response.status}): ${detail.slice(0, 300)}`,
      );
    }

    const pr = (await response.json()) as {
      number: number;
      html_url: string;
      state: string;
    };
    return { number: pr.number, url: pr.html_url, state: pr.state };
  }

  /**
   * File issues on the sandbox repository. Like a pull request this leaves the
   * machine, so it sits behind a gate. Each issue is created separately
   * because GitHub has no batch endpoint, and a partial failure is reported
   * rather than hidden.
   */
  async createIssues(
    issues: { title: string; body: string; severity?: string }[],
  ): Promise<{ created: { number: number; url: string; title: string }[] }> {
    const created: { number: number; url: string; title: string }[] = [];

    for (const issue of issues) {
      const response = await fetch(
        `https://api.github.com/repos/${this.config.repo}/issues`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${this.config.token}`,
            accept: "application/vnd.github+json",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            title: issue.title,
            body: issue.severity
              ? `${issue.body}

---
Severity: ${issue.severity}`
              : issue.body,
          }),
        },
      );

      if (!response.ok) {
        const detail = await response.text();
        throw new Error(
          `GitHub refused issue "${issue.title}" (${response.status}) after creating ${created.length}: ${detail.slice(0, 200)}`,
        );
      }

      const made = (await response.json()) as {
        number: number;
        html_url: string;
        title: string;
      };
      created.push({ number: made.number, url: made.html_url, title: made.title });
    }

    return { created };
  }
}

/** Built from the environment, so a missing token fails before anything runs. */
export function sandboxFromEnv(dir: string): Sandbox {
  const repo = process.env.GLASSBOX_SANDBOX_REPO;
  const token = process.env.GLASSBOX_GITHUB_TOKEN;

  if (!repo || !token) {
    throw new Error(
      "This flight writes to GitHub, so it needs GLASSBOX_SANDBOX_REPO (owner/name) and GLASSBOX_GITHUB_TOKEN in .env.local.",
    );
  }
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    throw new Error(`GLASSBOX_SANDBOX_REPO should be owner/name, got ${repo}`);
  }

  return new Sandbox({
    repo,
    token,
    dir,
    base: process.env.GLASSBOX_SANDBOX_BASE ?? "main",
  });
}
