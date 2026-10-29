/**
 * The daemon must not run at background QoS. The installed plist had been set
 * to Interactive by hand on 2026-07-24, but the tracked template still said
 * Background, and the next `service.sh install` (2026-10-25) re-rendered it:
 * every model worker, MCP server and Messages ran on the efficiency cores for
 * four days, and a worker's load went from 2.0-2.4 s to 5.6-6.1 s.
 */

import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BACKGROUND_PRI, schedulingPriority, throttledQosWarning } from "../src/boot/qos.ts";

const TEMPLATE = join(import.meta.dir, "..", "scripts", "launchd", "com.edmund-harness.plist");

function plistValue(xml: string, key: string): string | null {
  const m = xml.match(new RegExp(`<key>${key}</key>\\s*<(?:string|integer)>([^<]*)</`));
  return m ? m[1]! : null;
}

describe("daemon launchd template", () => {
  const xml = readFileSync(TEMPLATE, "utf8");

  test("asks for Interactive, the only ProcessType that keeps the performance cores", () => {
    expect(plistValue(xml, "ProcessType")).toBe("Interactive");
  });

  test("does not lower the daemon's priority with Nice", () => {
    const nice = plistValue(xml, "Nice");
    expect(nice === null || Number(nice) <= 0).toBe(true);
  });
});

describe("throttledQosWarning", () => {
  test("warns in the background band and is quiet above it", () => {
    expect(throttledQosWarning(BACKGROUND_PRI)).toContain("background QoS");
    expect(throttledQosWarning(31)).toBeNull();
    expect(throttledQosWarning(null)).toBeNull();
  });
});

describe("schedulingPriority", () => {
  async function priorityOf(argv: string[]): Promise<number | null> {
    const child = spawn(argv[0]!, argv.slice(1), { stdio: "ignore" });
    try {
      await Bun.sleep(300);
      return schedulingPriority(child.pid);
    } finally {
      child.kill();
    }
  }

  test("reads the background band from a process taskpolicy throttled", async () => {
    const pri = await priorityOf(["/usr/sbin/taskpolicy", "-b", "/bin/sleep", "5"]);
    expect(throttledQosWarning(pri)).not.toBeNull();
  });

  test("reads a normal process as not throttled", async () => {
    const pri = await priorityOf(["/bin/sleep", "5"]);
    expect(pri).not.toBeNull();
    expect(throttledQosWarning(pri)).toBeNull();
  });
});
