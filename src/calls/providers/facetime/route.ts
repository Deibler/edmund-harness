/**
 * Whether the caller can hear Edmund: the call's audio process must be
 * listening on Edmund's microphone and nothing else, and playing the call to
 * real speakers. Judged from what Core Audio reports per process (EdmundMouth
 * `route`), never from the default device, which says nothing about when
 * FaceTime's microphone opened or what it opened.
 *
 * OpenClaw's FaceTime companion gates on the same two conditions. A virtual
 * output is refused because the caller's voice would loop back into the
 * microphone and be sent straight back to them.
 */

import type { JsonMessage } from "./json-lines.ts";

export type ProcessRoute = {
  pid: number;
  bundleID: string;
  inputs: string[];
  outputs: { name: string; physical: boolean }[];
};

export type RouteReport = { defaultInput: string | null; processes: ProcessRoute[] };

export type RouteVerdict = { ok: true } | { ok: false; detail: string };

export function parseRoute(raw: unknown): RouteReport {
  const message = (raw ?? {}) as JsonMessage;
  const processes = Array.isArray(message.processes) ? message.processes : [];
  return {
    defaultInput: typeof message.defaultInput === "string" ? message.defaultInput : null,
    processes: processes.map((p: JsonMessage) => ({
      pid: Number(p.pid),
      bundleID: String(p.bundleID ?? ""),
      inputs: Array.isArray(p.inputs) ? p.inputs.map(String) : [],
      outputs: Array.isArray(p.outputs)
        ? p.outputs.map((o: JsonMessage) => ({
            name: String(o.name),
            physical: o.physical === true,
          }))
        : [],
    })),
  };
}

export function judgeRoute(report: RouteReport, mic: string): RouteVerdict {
  const inputs = [...new Set(report.processes.flatMap((p) => p.inputs))];
  const outputs = report.processes.flatMap((p) => p.outputs);
  const fallback =
    report.defaultInput && report.defaultInput !== mic
      ? ` (the Mac's default input is ${report.defaultInput}, not ${mic})`
      : "";
  if (inputs.length === 0) {
    return { ok: false, detail: `FaceTime has not opened a microphone${fallback}` };
  }
  const others = inputs.filter((name) => name !== mic);
  if (others.length > 0) {
    return {
      ok: false,
      detail: `FaceTime is listening on ${others.join(", ")}, not ${mic}${fallback}`,
    };
  }
  if (outputs.length === 0) {
    return { ok: false, detail: "FaceTime has not opened a speaker" };
  }
  const virtual = outputs.filter((o) => !o.physical).map((o) => o.name);
  if (virtual.length > 0) {
    return {
      ok: false,
      detail: `FaceTime plays the call into ${virtual.join(", ")}, which is not a real speaker`,
    };
  }
  return { ok: true };
}
