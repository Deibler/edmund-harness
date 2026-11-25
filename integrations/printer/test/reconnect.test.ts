/**
 * With the printer switched off the daemon logged one reconnect line 4,290
 * times in a minute (2026-11-17). A connection attempt that failed also
 * reported itself as a dropped connection, the link answered each report by
 * starting a second retry loop beside the one already running, and the loops
 * doubled every round.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { type Server, createServer } from "node:net";
import { PrinterLink } from "../src/link.ts";
import { openMqtt } from "../src/mqtt.ts";

let server: Server | null = null;
afterEach(() => {
  server?.close();
  server = null;
});

/** A port that accepts the connection and never says anything: a printer that is off. */
function silentPort(): Promise<number> {
  return new Promise((resolve) => {
    server = createServer((socket) => socket.on("error", () => {}));
    server.listen(0, "127.0.0.1", () => resolve((server!.address() as { port: number }).port));
  });
}

describe("a printer that does not answer", () => {
  test("an attempt that never connected is a failure, not a dropped connection", async () => {
    const port = await silentPort();
    const drops: string[] = [];
    const attempt = openMqtt({
      host: "127.0.0.1",
      port,
      username: "bblp",
      password: "x",
      topic: "device/TEST/report",
      onMessage: () => {},
      onClose: (why) => drops.push(why),
      timeoutMs: 80,
    });
    await expect(attempt).rejects.toThrow("did not answer");
    await Bun.sleep(80);
    expect(drops).toEqual([]);
  });

  test("starting a link that is already retrying does not add a second retry loop", async () => {
    const port = await silentPort();
    const lines: string[] = [];
    const link = new PrinterLink({
      host: "127.0.0.1",
      port,
      accessCode: "x",
      serial: "TEST",
      persistent: true,
      connectTimeoutMs: 60,
      onLog: (line) => lines.push(line),
    });
    // What a burst of drop reports used to amount to: start, start, start.
    link.start();
    link.start();
    link.start();
    await Bun.sleep(400);
    link.close();
    // One loop: an attempt at 0 ms, the next no sooner than 2 s later.
    expect(lines.filter((l) => l.includes("connect failed")).length).toBe(1);
  });
});
