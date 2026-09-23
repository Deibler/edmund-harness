/**
 * Contact screenshots against the real screen.
 *
 * A contact's capture draws only the granted apps' windows and blacks out
 * whatever is not theirs, with rectangles placed at the windows' real screen
 * positions. If the capture draws the windows anywhere else, the rectangles
 * miss and other people's conversations show. That happened on macOS 26: a
 * filter that includes only some apps captured just the box around their
 * windows, stretched to fill the image, and a test capture as a contact showed
 * every other conversation in the sidebar.
 *
 * CI has no screen, so this runs only on the Mac itself, with Messages open
 * and not hidden: EDMUND_LIVE_SCREEN=1 bun test ./tests/computer-use-live.test.ts
 */

import { describe, expect, test } from "bun:test";
import sharp from "sharp";
import { NativeHelper } from "../src/mcp/computer-use/native.ts";

const live = process.env.EDMUND_LIVE_SCREEN === "1";
const MESSAGES = "com.apple.MobileSMS";

async function pixels(jpeg: string) {
  const { data, info } = await sharp(Buffer.from(jpeg, "base64"))
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, channels: info.channels };
}

describe.skipIf(!live)("contact captures on the real screen", () => {
  test("an included app's window is drawn where it is on the screen", async () => {
    const n = new NativeHelper();
    try {
      const display = (await n.displays()).find((d) => d.main)!;
      const running = await n.running();
      expect(running.some((r) => r.bundleId === MESSAGES && !r.hidden)).toBe(true);
      const frame = (await n.inspect(MESSAGES, [])).windows.find((w) => w.frame)?.frame;
      expect(frame).toBeDefined();

      const width = 1460;
      const height = Math.round((width * display.height) / display.width);
      // The same window two ways: the owner's kind of capture with every
      // other app left out, and a contact's, with Messages alone included.
      const others = running.map((r) => r.bundleId).filter((id) => id && id !== MESSAGES);
      // The open conversation, clear of the translucent sidebar, the shadow
      // and the rounded corners.
      const sx = width / display.width;
      const sy = height / display.height;
      const left = frame!.x - display.x;
      const top = frame!.y - display.y;
      const x0 = Math.round((left + frame!.width * 0.4) * sx);
      const x1 = Math.round((left + frame!.width * 0.9) * sx);
      const y0 = Math.round((top + frame!.height * 0.2) * sy);
      const y1 = Math.round((top + frame!.height * 0.8) * sy);

      // Measured 2026-09-23: a correct capture differs on 0% of these pixels,
      // the stretched one on 44%, every time. Something animating between
      // the two captures (a typing indicator) can spoil one attempt, so the
      // best of three decides; a misplaced window fails all three.
      const differing: number[] = [];
      for (let attempt = 0; attempt < 3; attempt++) {
        const reference = await pixels(
          (await n.capture({ display: display.id, exclude: others, width, height })).data,
        );
        const contact = await pixels(
          (
            await n.capture({
              display: display.id,
              exclude: [],
              include: [MESSAGES],
              width,
              height,
            })
          ).data,
        );
        let off = 0;
        let count = 0;
        for (let y = y0; y < y1; y++) {
          for (let x = x0; x < x1; x++) {
            const i = (y * contact.width + x) * contact.channels;
            let d = 0;
            for (let c = 0; c < 3; c++)
              d += Math.abs(contact.data[i + c]! - reference.data[i + c]!);
            if (d / 3 > 40) off++;
            count++;
          }
        }
        differing.push(off / count);
        if (off / count < 0.1) break;
      }
      expect(Math.min(...differing)).toBeLessThan(0.1);
    } finally {
      n.close();
    }
  });
});
