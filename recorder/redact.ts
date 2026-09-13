/**
 * Scrubbing a trace before it is written.
 *
 * A trace holds real requests and real responses, so it can pick up an auth
 * header, a token in a URL, or a whole scraped page. Everything written to
 * disk goes through here first, and `assertClean` then checks the output
 * again, so a leak has to get past the same patterns twice.
 */

export interface RedactionReport {
  /** How many strings were changed, by rule. */
  hits: Record<string, number>;
  /** How many long strings were shortened. */
  truncated: number;
}

const SECRET_PATTERNS: { name: string; pattern: RegExp }[] = [
  { name: "anthropic-key", pattern: /sk-ant-[A-Za-z0-9_-]{8,}/g },
  { name: "openai-key", pattern: /sk-(?:proj-)?[A-Za-z0-9]{32,}/g },
  { name: "github-token", pattern: /gh[pousr]_[A-Za-z0-9]{16,}/g },
  { name: "github-pat", pattern: /github_pat_[A-Za-z0-9_]{20,}/g },
  { name: "aws-key", pattern: /AKIA[0-9A-Z]{16}/g },
  { name: "bearer", pattern: /Bearer\s+[A-Za-z0-9._\-]{16,}/gi },
  { name: "vercel-token", pattern: /\b[A-Za-z0-9]{24}\b(?=[^A-Za-z0-9]*vercel)/gi },
  {
    name: "named-secret",
    pattern:
      /((?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password)["']?\s*[:=]\s*["']?)([A-Za-z0-9._\-]{12,})/gi,
  },
];

/** Object keys whose value is never worth keeping, whatever it looks like. */
const SENSITIVE_KEYS = new Set([
  "authorization",
  "x-api-key",
  "api_key",
  "apikey",
  "cookie",
  "set-cookie",
  "password",
  "secret",
  "encrypted_content",
]);

const MAX_STRING = 4000;
const REDACTED = "[redacted]";

export function redactTrace<T>(value: T): { value: T; report: RedactionReport } {
  const report: RedactionReport = { hits: {}, truncated: 0 };
  const cleaned = walk(value, report, false);
  return { value: cleaned as T, report };
}

function walk(value: unknown, report: RedactionReport, drop: boolean): unknown {
  if (drop) return REDACTED;

  if (typeof value === "string") return cleanString(value, report);

  if (Array.isArray(value)) {
    return value.map((item) => walk(item, report, false));
  }

  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      out[key] = walk(child, report, SENSITIVE_KEYS.has(key.toLowerCase()));
    }
    return out;
  }

  return value;
}

function cleanString(input: string, report: RedactionReport): string {
  let output = input;

  for (const { name, pattern } of SECRET_PATTERNS) {
    output = output.replace(pattern, (match, ...groups) => {
      report.hits[name] = (report.hits[name] ?? 0) + 1;
      // The named-secret rule keeps the label and replaces only the value.
      if (name === "named-secret" && typeof groups[0] === "string") {
        return `${groups[0]}${REDACTED}`;
      }
      return REDACTED;
    });
  }

  if (output.length > MAX_STRING) {
    report.truncated += 1;
    output = `${output.slice(0, MAX_STRING)}\n[trimmed ${output.length - MAX_STRING} characters]`;
  }

  return output;
}

/**
 * A second pass over the finished JSON. Anything caught here means a rule
 * above needs widening, and the run should fail rather than write the file.
 */
export function assertClean(value: unknown): void {
  const json = JSON.stringify(value);
  const found: string[] = [];

  for (const { name, pattern } of SECRET_PATTERNS) {
    if (name === "named-secret") continue; // its value is already replaced
    const match = json.match(new RegExp(pattern.source, "g"));
    if (match) found.push(`${name} (${match.length})`);
  }

  if (found.length) {
    throw new Error(
      `refusing to write a trace with secrets still in it: ${found.join(", ")}`,
    );
  }
}
