import { describe, expect, test } from "bun:test";
import { browseEventsFor, loggableUrl } from "../src/util/browse-log.ts";

describe("what a tool call opened on the web", () => {
  test("the CLI's fetch and search", () => {
    expect(
      browseEventsFor("WebFetch", { url: "https://example.com/a?page=2", prompt: "x" }),
    ).toEqual([{ kind: "fetch", target: "https://example.com/a?page=2" }]);
    expect(browseEventsFor("WebSearch", { query: "tide tables" })).toEqual([
      { kind: "search", target: "tide tables" },
    ]);
    expect(browseEventsFor("mcp__edmund-harness__web_search", { query: "tide tables" })).toEqual([
      { kind: "search", target: "tide tables" },
    ]);
  });

  test("the browser, with or without an address", () => {
    expect(
      browseEventsFor("mcp__chrome-devtools__navigate_page", { url: "https://example.com/login" }),
    ).toEqual([{ kind: "browser", target: "navigate_page https://example.com/login" }]);
    expect(browseEventsFor("mcp__chrome-devtools__click", { uid: "1_2" })).toEqual([
      { kind: "browser", target: "click" },
    ]);
  });

  test("addresses inside a shell command", () => {
    expect(
      browseEventsFor("Bash", {
        command:
          'curl -s "https://api.example.com/v1/x?api_key=sk-secret" | jq . && curl https://example.org/y',
      }),
    ).toEqual([
      { kind: "shell", target: "https://api.example.com/v1/x?api_key=***" },
      { kind: "shell", target: "https://example.org/y" },
    ]);
    expect(browseEventsFor("Bash", { command: "ls -la" })).toEqual([]);
  });

  test("a tool that does not touch the web leaves nothing", () => {
    expect(browseEventsFor("Read", { file_path: "/tmp/x" })).toEqual([]);
    expect(
      browseEventsFor("mcp__edmund-harness__send_message", { text: "see https://example.com" }),
    ).toEqual([]);
    expect(browseEventsFor(undefined, {})).toEqual([]);
  });

  test("a logged address hides credentials and keeps the rest", () => {
    expect(
      loggableUrl("https://example.com/s/0f66f61026db697ea6c05ccfc2aea69a?token=abc&q=boats"),
    ).toBe("https://example.com/s/0f66f6…?token=***&q=boats");
    expect(loggableUrl("file:///etc/passwd")).toBeNull();
    expect(loggableUrl("not a url")).toBeNull();
  });
});
