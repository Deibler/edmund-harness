import { spawnSync } from "node:child_process";
import type { Need } from "./filament.ts";

/**
 * What a print-ready .gcode.3mf says about itself: plates, filaments, time,
 * weight, and the plate type it was sliced for. Read with the system unzip,
 * which every Mac has.
 */

export function zipEntries(path: string): string[] {
  const r = spawnSync("/usr/bin/unzip", ["-Z1", path], { encoding: "utf8", maxBuffer: 16 << 20 });
  if (r.status !== 0) return [];
  return r.stdout.split("\n").filter(Boolean);
}

export function zipEntry(path: string, entry: string): Buffer | null {
  const r = spawnSync("/usr/bin/unzip", ["-p", path, entry], { maxBuffer: 512 << 20 });
  return r.status === 0 && r.stdout.length > 0 ? r.stdout : null;
}

export type PlateInfo = {
  index: number;
  predictionS: number;
  weightG: number;
  needs: Need[];
  supportUsed: boolean;
  objects: string[];
};

const attr = (tag: string, name: string) =>
  tag.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1] ?? "";

export function parseSliceInfo(xml: string): PlateInfo[] {
  const plates: PlateInfo[] = [];
  for (const block of xml.split("<plate>").slice(1)) {
    const meta = (k: string) =>
      block.match(new RegExp(`<metadata key="${k}" value="([^"]*)"`))?.[1] ?? "";
    const needs: Need[] = [];
    for (const tag of block.match(/<filament [^>]*\/>/g) ?? []) {
      needs.push({
        index: Number(attr(tag, "id")),
        type: attr(tag, "type"),
        color: attr(tag, "color").toUpperCase().slice(0, 7),
        grams: Number(attr(tag, "used_g")) || 0,
        infoIdx: attr(tag, "tray_info_idx") || undefined,
      });
    }
    plates.push({
      index: Number(meta("index")) || plates.length + 1,
      predictionS: Number(meta("prediction")) || 0,
      weightG: Number(meta("weight")) || 0,
      needs,
      supportUsed: meta("support_used") === "true",
      objects: (block.match(/<object [^>]*\/>/g) ?? []).map((t) => attr(t, "name")),
    });
  }
  return plates;
}

/** The plate type the file was sliced for, from the gcode's config block or the plate's settings. */
export function slicedBedType(path: string, plate: number): string {
  const settings = zipEntry(path, "Metadata/model_settings.config")?.toString("utf8") ?? "";
  for (const block of settings.split("<plate>").slice(1)) {
    const id = block.match(/<metadata key="plater_id" value="(\d+)"/)?.[1];
    const bed = block.match(/<metadata key="bed_type" value="([^"]*)"/)?.[1];
    if (Number(id) === plate && bed) return bed;
  }
  const project = zipEntry(path, "Metadata/project_settings.config")?.toString("utf8") ?? "";
  return project.match(/"curr_bed_type":\s*"([^"]*)"/)?.[1] ?? "";
}

export type SlicedFile = { plates: PlateInfo[]; hasGcode: boolean; gcodePlates: number[] };

export function readSliced(path: string): SlicedFile {
  const entries = zipEntries(path);
  const xml = zipEntry(path, "Metadata/slice_info.config")?.toString("utf8") ?? "";
  const gcodePlates = entries
    .map((e) => e.match(/^Metadata\/plate_(\d+)\.gcode$/)?.[1])
    .filter((x): x is string => !!x)
    .map(Number)
    .sort((a, b) => a - b);
  return { plates: xml ? parseSliceInfo(xml) : [], hasGcode: gcodePlates.length > 0, gcodePlates };
}

/** The plate a print-ready file prints: the first one that has G-code. */
export function printablePlate(path: string): PlateInfo | null {
  const s = readSliced(path);
  const n = s.gcodePlates[0];
  if (n === undefined) return null;
  return s.plates.find((p) => p.index === n) ?? null;
}

/** Bambu Studio's plate names, and what the print command calls each. */
export const BED_TYPES: Record<string, { studio: string; command: string; label: string }> = {
  textured_pei: {
    studio: "Textured PEI Plate",
    command: "textured_plate",
    label: "textured PEI plate",
  },
  smooth_pei: { studio: "High Temp Plate", command: "hot_plate", label: "smooth PEI plate" },
  cool_plate: { studio: "Cool Plate", command: "cool_plate", label: "cool plate" },
  engineering_plate: {
    studio: "Engineering Plate",
    command: "eng_plate",
    label: "engineering plate",
  },
  supertack: {
    studio: "Supertack Plate",
    command: "supertack_plate",
    label: "Cool Plate SuperTack",
  },
};

export function bedCommandFor(studioName: string): string {
  for (const v of Object.values(BED_TYPES)) if (v.studio === studioName) return v.command;
  return "auto";
}

export function bedLabelFor(studioName: string): string {
  for (const v of Object.values(BED_TYPES)) if (v.studio === studioName) return v.label;
  return studioName || "the plate it was sliced for";
}
