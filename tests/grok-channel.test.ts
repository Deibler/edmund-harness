import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionPipeline } from "../src/channels/pipeline.ts";
import type { Config } from "../src/config/config.ts";
import { createGrokChannel } from "../src/grok/channel.ts";
import type { ContactBook } from "../src/sessions/contacts.ts";

const closers: Array<() => void> = [];
afterEach(() => {
  for (const close of closers.splice(0)) close();
});

function configOn(port: number, over: Record<string, unknown> = {}): Config {
  return {
    paths: { data_dir: mkdtempSync(join(tmpdir(), "grok-channel-")) },
    grok: {
      enabled: true,
      handle: "+15550100001",
      port,
      token: "t".repeat(32),
      auth_mode: "both",
      answer_timeout_ms: 25_000,
      slow_reply: "later",
      max_message_chars: 1000,
      max_reply_chars: 700,
      requests_per_minute: 60,
      asks_per_minute: 6,
      max_auth_failures: 10,
      ...over,
    },
  } as unknown as Config;
}

const pipeline = { enqueue: () => {} } as unknown as SessionPipeline;
const contacts = { canon: (h: string) => h } as unknown as ContactBook;

describe("createGrokChannel", () => {
  test("a port that is already taken leaves Grok off instead of throwing", () => {
    const squatter = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("x") });
    closers.push(() => squatter.stop(true));
    const channel = createGrokChannel({
      config: configOn(squatter.port ?? 0),
      pipeline,
      contacts,
    });
    expect(channel).toBeNull();
  });

  test("starts on a free port and stops cleanly", () => {
    const channel = createGrokChannel({ config: configOn(0), pipeline, contacts });
    expect(channel).not.toBeNull();
    channel?.stop();
  });

  test("no token, no listener", () => {
    expect(
      createGrokChannel({ config: configOn(0, { token: "" }), pipeline, contacts }),
    ).toBeNull();
  });
});
