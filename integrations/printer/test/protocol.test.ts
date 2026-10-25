import { describe, expect, test } from "bun:test";
import { cutJpegs, describeFfmpegError, rtspUrl } from "../src/camera.ts";
import { frameHeader, jsonPrefixEnd, parseFileList, splitPayload } from "../src/ctrl.ts";
import {
  connectPacket,
  encodeLength,
  parsePublish,
  publishPacket,
  readPackets,
  subscribePacket,
} from "../src/mqtt.ts";

describe("MQTT framing", () => {
  test("remaining length uses 7-bit groups", () => {
    expect([...encodeLength(0)]).toEqual([0]);
    expect([...encodeLength(127)]).toEqual([127]);
    expect([...encodeLength(128)]).toEqual([0x80, 1]);
    expect([...encodeLength(16383)]).toEqual([0xff, 0x7f]);
    expect([...encodeLength(2097152)]).toEqual([0x80, 0x80, 0x80, 1]);
  });

  test("connect carries username and password flags", () => {
    const p = connectPacket("id", "bblp", "code1234");
    expect(p[0]).toBe(0x10);
    expect(p.includes(Buffer.from("MQTT"))).toBe(true);
    expect(p.includes(Buffer.from("bblp"))).toBe(true);
    expect(p.includes(Buffer.from([4, 0xc2]))).toBe(true);
  });

  test("a QoS 1 publish round-trips with its packet id skipped", () => {
    const pkt = publishPacket("device/X/request", '{"a":1}', 7);
    expect(pkt[0]).toBe(0x32);
    const { packets, rest } = readPackets(pkt);
    expect(rest.length).toBe(0);
    expect(parsePublish(packets[0]!.body, packets[0]!.flags)).toEqual({
      topic: "device/X/request",
      payload: '{"a":1}',
    });
  });

  test("a QoS 0 publish keeps the whole payload", () => {
    const { packets } = readPackets(publishPacket("t", "hello"));
    expect(parsePublish(packets[0]!.body, packets[0]!.flags).payload).toBe("hello");
  });

  test("a packet split across reads waits for the rest", () => {
    const whole = Buffer.concat([
      subscribePacket(1, "device/X/report"),
      publishPacket("t", "x".repeat(300)),
    ]);
    const first = readPackets(whole.subarray(0, whole.length - 10));
    expect(first.packets).toHaveLength(1);
    const second = readPackets(Buffer.concat([first.rest, whole.subarray(whole.length - 10)]));
    expect(second.packets).toHaveLength(1);
    expect(second.rest.length).toBe(0);
  });
});

describe("the port 6000 file service framing", () => {
  test("headers are little-endian length, magic, sequence", () => {
    const h = frameHeader(16, 0x0101013f, 5);
    expect(h.readUInt32LE(0)).toBe(16);
    expect(h.readUInt32LE(4)).toBe(0x0101013f);
    expect(h.readUInt32LE(8)).toBe(5);
    expect(h.length).toBe(16);
  });

  test("JSON is split from the binary after the blank line, braces in strings ignored", () => {
    const payload = Buffer.concat([
      Buffer.from('{"a":"}{","b":{"c":1}}\n\n'),
      Buffer.from([0xff, 0xd8, 1, 2]),
    ]);
    expect(jsonPrefixEnd(payload)).toBe(22);
    const r = splitPayload(payload)!;
    expect(r.json).toEqual({ a: "}{", b: { c: 1 } });
    expect([...r.binary]).toEqual([0xff, 0xd8, 1, 2]);
  });

  test("file lists decode the printer's HTML entities in names but keep the path verbatim", () => {
    const files = parseFileList({
      reply: {
        file_lists: [
          {
            name: "Sam&apos;s_axolotl.gcode.3mf",
            path: "/userdata/model/history/Sam&apos;s_axolotl.gcode.3mf",
            size: 5,
            time: 9,
            model_name: "Sam&apos;s",
            duration_ms: 3,
          },
        ],
      },
    });
    expect(files[0]!.name).toBe("Sam's_axolotl.gcode.3mf");
    expect(files[0]!.path).toContain("&apos;");
    expect(files[0]!.modelName).toBe("Sam's");
  });
});

describe("the camera", () => {
  test("JPEGs are cut out of a stream at their markers, the partial tail kept", () => {
    const a = Buffer.from([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9]);
    const b = Buffer.from([0xff, 0xd8, 9, 9]);
    const { frames, rest } = cutJpegs(Buffer.concat([Buffer.from([7, 7]), a, b]));
    expect(frames).toHaveLength(1);
    expect([...frames[0]!]).toEqual([...a]);
    expect([...rest]).toEqual([...b]);
  });

  test("a refused stream says which printer setting to turn on", () => {
    expect(describeFfmpegError("Connection refused")).toContain("LAN Only Liveview");
    expect(describeFfmpegError("401 Unauthorized")).toContain("access code");
  });

  test("the access code is URL-encoded in the stream address", () => {
    expect(rtspUrl("10.0.0.2", "a/b c")).toBe(
      "rtsps://bblp:a%2Fb%20c@10.0.0.2:322/streaming/live/1",
    );
  });
});
