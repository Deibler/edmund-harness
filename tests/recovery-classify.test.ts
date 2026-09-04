import { describe, expect, test } from "bun:test";
import { type FailureClass, classifyError, describeErrorClass } from "../src/recovery/classify.ts";

/**
 * Table-driven: every error string we've seen in production logs maps
 * to its expected class. Adding a new failure mode to the runner =
 * adding a row here.
 */
const CASES: Array<{ msg: string; cls: FailureClass }> = [
  // request_too_large
  { msg: "Request too large (max 32MB). Try with a smaller file.", cls: "request_too_large" },
  { msg: "Maximum request size exceeded (33,554,432 bytes)", cls: "request_too_large" },
  { msg: "max payload exceeded for this request", cls: "request_too_large" },
  // image_dim_exceeded
  {
    msg: "An image in the conversation exceeds the dimension limit for many-image requests (2000px). Start a new session with fewer images.",
    cls: "image_dim_exceeded",
  },
  { msg: "image rejected: width 2400px exceeds 2000px limit", cls: "image_dim_exceeded" },
  // stale_session_id
  { msg: "no conversation found for session id abc-123", cls: "stale_session_id" },
  { msg: "session not found", cls: "stale_session_id" },
  { msg: "Error: unknown session 'foo'", cls: "stale_session_id" },
  // session_in_use
  { msg: "Session already in use", cls: "session_in_use" },
  // bad_tool_ids — persisted tool ids the API rejects on resume
  {
    msg: `API Error: 400 messages.3.content.0.tool_use.id: String should match pattern '^[a-zA-Z0-9_-]+$'`,
    cls: "bad_tool_ids",
  },
  {
    msg: `400 messages.7.content.1.tool_result.tool_use_id: String should match pattern '^[a-zA-Z0-9_-]+$'`,
    cls: "bad_tool_ids",
  },
  // invalid_tool_schema — a published tool schema the API rejects against
  // draft 2020-12. Took the Alex DM down for 26 min on 2026-08-17
  // (kitchen_recipe_save's tuple published as draft-4 array-form `items`).
  {
    msg: "API Error: 400 tools.33.custom.input_schema: JSON schema is invalid. It must match JSON Schema draft 2020-12 (https://json-schema.org/draft/2020-12). Learn more about tool use at https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview.",
    cls: "invalid_tool_schema",
  },
  // empty_content_block
  {
    msg: "API Error: 400 messages: text content blocks must be non-empty",
    cls: "empty_content_block",
  },
  // transient_api
  { msg: "Rate limit exceeded — retry later", cls: "transient_api" },
  { msg: "got 429 Too Many Requests", cls: "transient_api" },
  { msg: "Service Overloaded (503)", cls: "transient_api" },
  { msg: "fetch failed: ETIMEDOUT", cls: "transient_api" },
  { msg: "ECONNRESET while reading body", cls: "transient_api" },
  // #2 production error (40×) — previously fell to `unknown`, no healer,
  // no in-band retry classification.
  {
    msg: "API Error: 500 Error: Unable to connect. Is the computer able to access the url?",
    cls: "transient_api",
  },
  { msg: "connect ECONNREFUSED 127.0.0.1:443", cls: "transient_api" },
  // unknown — anything we haven't classified
  { msg: "something completely new", cls: "unknown" },
  { msg: "", cls: "unknown" },
];

describe("classifyError", () => {
  for (const c of CASES) {
    test(`"${c.msg.slice(0, 50)}…" → ${c.cls}`, () => {
      expect(classifyError(c.msg)).toBe(c.cls);
    });
  }

  test("handles null / undefined", () => {
    expect(classifyError(null)).toBe("unknown");
    expect(classifyError(undefined)).toBe("unknown");
  });
});

describe("describeErrorClass", () => {
  test("each class produces a human-readable sentence", () => {
    const classes: FailureClass[] = [
      "request_too_large",
      "image_dim_exceeded",
      "stale_session_id",
      "session_in_use",
      "bad_tool_ids",
      "empty_content_block",
      "transient_api",
      "unknown",
    ];
    for (const c of classes) {
      const desc = describeErrorClass(c, true);
      expect(desc.length).toBeGreaterThan(20);
      expect(desc.endsWith(".")).toBe(true);
    }
  });

  test("healed=true vs healed=false: heal-able classes show different tail", () => {
    const a = describeErrorClass("request_too_large", true);
    const b = describeErrorClass("request_too_large", false);
    expect(a).not.toBe(b);
    expect(a).toContain("fixed it automatically");
    expect(b).toContain("may not have stuck");
  });

  test("unknown class with raw error embeds the raw error verbatim", () => {
    const raw = "Surprise mystery error from the API";
    const desc = describeErrorClass("unknown", false, raw);
    expect(desc).toContain(raw);
  });

  test("unknown class without raw error degrades gracefully", () => {
    const desc = describeErrorClass("unknown", false, null);
    expect(desc).toContain("without a recognized cause");
  });
});
