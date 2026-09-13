/**
 * The redaction pass is the last thing between a real capture and a public
 * repository, so it gets tests rather than a careful read.
 *
 *   npm test
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { assertClean, redactTrace } from "./redact";

test("removes an Anthropic key from anywhere in the trace", () => {
  const { value, report } = redactTrace({
    events: [
      {
        label: "ok",
        tool: {
          request: { headers: { authorization: "Bearer sk-ant-api03-ABCDEF123456" } },
          response: "used key sk-ant-api03-ABCDEF123456 to call the API",
        },
      },
    ],
  });

  const json = JSON.stringify(value);
  assert.ok(!json.includes("sk-ant-api03"), "the key survived redaction");
  assert.ok(report.hits["anthropic-key"] >= 1 || json.includes("[redacted]"));
});

test("drops the value of a sensitive key whatever it looks like", () => {
  const { value } = redactTrace({
    tool: { request: { "x-api-key": "not-obviously-a-secret-but-still-one" } },
  });
  assert.equal(
    (value as { tool: { request: Record<string, string> } }).tool.request["x-api-key"],
    "[redacted]",
  );
});

test("catches github, aws and bearer shapes", () => {
  const { value } = redactTrace({
    a: "ghp_abcdefghijklmnopqrstuvwxyz0123",
    b: "github_pat_11ABCDEFG0123456789_abcdefghijklmnop",
    c: "AKIAIOSFODNN7EXAMPLE",
    d: "Authorization: Bearer abcdefghijklmnopqrstuvwxyz",
  });
  const json = JSON.stringify(value);
  for (const fragment of ["ghp_", "github_pat_", "AKIA", "Bearer abcdef"]) {
    assert.ok(!json.includes(fragment), `${fragment} survived redaction`);
  }
});

test("keeps the label but not the value of a named secret", () => {
  const { value } = redactTrace({ note: 'api_key: "abcdef1234567890abcdef"' });
  const note = (value as { note: string }).note;
  assert.ok(note.includes("api_key"), "the label should stay, it is not secret");
  assert.ok(!note.includes("abcdef1234567890"), "the value should be gone");
});

test("trims a very long string instead of writing a whole scraped page", () => {
  const { value, report } = redactTrace({ page: "x".repeat(9000) });
  const page = (value as { page: string }).page;
  assert.ok(page.length < 9000);
  assert.equal(report.truncated, 1);
  assert.ok(page.includes("[trimmed"));
});

test("leaves ordinary content alone", () => {
  const input = {
    label: "web_search: Crayon pricing",
    detail: "Three headline options drafted. Went with the shortest one.",
    tMs: 4100,
  };
  const { value, report } = redactTrace(input);
  assert.deepEqual(value, input);
  assert.deepEqual(report.hits, {});
});

test("assertClean refuses a trace that still holds a key", () => {
  assert.throws(
    () => assertClean({ events: [{ detail: "sk-ant-api03-LEAKED1234567" }] }),
    /secrets still in it/,
  );
});

test("assertClean passes a redacted trace", () => {
  const { value } = redactTrace({
    events: [{ detail: "token was ghp_abcdefghijklmnopqrstuvwxyz0123" }],
  });
  assert.doesNotThrow(() => assertClean(value));
});
