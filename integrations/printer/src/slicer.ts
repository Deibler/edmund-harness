import { spawn } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, join, resolve } from "node:path";
import { MAX_TRIANGLES, type MeshReport, countTriangles, printableMeshes } from "./mesh.ts";
import {
  type Profile,
  applyOverrides,
  filamentProfileName,
  machineName,
  processName,
  profilesDir,
  resolveProfile,
} from "./profiles.ts";
import { BED_TYPES, type PlateInfo, readSliced, zipEntry } from "./threemf.ts";

/**
 * Slicing with Bambu Studio's own engine, headless.
 *
 * The CLI takes flattened system profiles plus overrides, so the result is
 * what the app would produce with the same choices, including Bambu's P2S
 * start G-code and its per-plate Z offsets. Two input shapes:
 *
 *  - one model file (STL, OBJ, STEP or a 3MF, which may carry its own
 *    per-part filament assignments), arranged onto the plate;
 *  - parts: STL or OBJ files modelled in one coordinate frame, each with a
 *    filament number, merged into one object with their positions kept.
 *    This is how a multi-color design made as separate solids prints.
 *
 * Every run has a watchdog: the thumbnail stage opens an OpenGL context, and
 * that hangs forever while the Mac's console is locked.
 */

export type FilamentChoice = { type: string; color: string; infoIdx?: string };

export type SliceRequest = {
  slicerPath: string;
  outDir: string;
  name: string;
  model?: string;
  parts?: Array<{ path: string; filament: number }>;
  filaments: FilamentChoice[];
  plate: keyof typeof BED_TYPES;
  quality?: string;
  nozzle?: string;
  settings?: Record<string, string | number | boolean>;
  copies?: number;
  orient?: boolean;
  /** Uniform scale factor (1.5 = 150%). */
  scale?: number;
  /** Rotation in degrees about Z, X and Y, applied before arranging. */
  rotate?: { z?: number; x?: number; y?: number };
  /** Slice only this plate of a multi-plate project (1-based); default all. */
  plateIndex?: number;
  /** "print" slices to a print-ready file; "project" exports an editable project with the settings embedded. */
  mode?: "print" | "project";
  timeoutMs?: number;
};

export type SliceReport = {
  /** How much mesh went in and how much the print file carries, and any simplifying done. */
  mesh?: MeshReport;
  /** What the slicer warned about, as Bambu Studio would show it (overhangs needing support, and so on). */
  warnings: string[];
  /** What stopped it, if anything. */
  errors: string[];
  /** Seconds spent on each kind of extrusion, from the slicer's own estimate. */
  featureTimes: Record<string, number>;
  filamentChanges: number;
  totalS: number;
  modelS: number;
  layerHeight: number | null;
  infill: number | null;
  walls: number | null;
};

export type SliceResult = {
  file: string;
  preview: string;
  plate: PlateInfo | null;
  bedType: string;
  process: string;
  filamentProfiles: string[];
  ignored: string[];
  log: string;
  report: SliceReport;
  /** The overrides that were applied, to show and to repeat. */
  settings: Record<string, string | number | boolean>;
};

/**
 * Every warning and error the slicer logged, the same messages the app shows
 * in its notification area. The CLI writes them to its log, not its result
 * file, and on a failed slice the result file only says "failed".
 */
export function parseSlicerLog(log: string): { warnings: string[]; errors: string[] } {
  const warnings = new Set<string>();
  const errors = new Set<string>();
  for (const line of log.split("\n")) {
    let m = line.match(/found NON_CRITICAL slicing warnings: (.+)$/);
    if (m) {
      warnings.add(m[1]!.trim());
      continue;
    }
    m = line.match(/found slicing warnings: (.+?)(, no_check=\d)?$/);
    if (m) {
      warnings.add(m[1]!.trim());
      continue;
    }
    m = line.match(/got warnings: (.+)$/);
    if (m) {
      warnings.add(m[1]!.trim());
      continue;
    }
    m = line.match(/got error when validate: (.+)$/);
    if (m) {
      errors.add(m[1]!.trim());
      continue;
    }
    if (/found slicing result conflict/.test(line))
      errors.add("Toolpaths from different objects collide (G-code path conflict).");
    else if (/found gcode unprintable/.test(line))
      errors.add("Part of the G-code falls outside the printable area.");
    else if (/found some filament unprintable on current bed/.test(line)) {
      errors.add("A filament cannot print on the chosen build plate.");
    } else if (/slice time .* exceeds the limit/.test(line))
      errors.add("Slicing took too long and was stopped.");
  }
  return { warnings: [...warnings], errors: [...errors] };
}

function readResultJson(outDir: string): Partial<SliceReport> & { errorString?: string } {
  try {
    const r = JSON.parse(readFileSync(join(outDir, "result.json"), "utf8")) as {
      error_string?: string;
      layer_height?: number;
      sparse_infill_density?: number;
      wall_loops?: number;
      sliced_plates?: Array<{
        feature_type_times?: Record<string, number>;
        filament_change_times?: number;
        total_predication?: number;
        main_predication?: number;
        warning_message?: string;
      }>;
    };
    const p = r.sliced_plates?.[0];
    return {
      errorString: r.error_string,
      featureTimes: Object.fromEntries(
        Object.entries(p?.feature_type_times ?? {}).map(([k, v]) => [k, Math.round(v)]),
      ),
      filamentChanges: p?.filament_change_times ?? 0,
      totalS: Math.round(p?.total_predication ?? 0),
      modelS: Math.round(p?.main_predication ?? 0),
      layerHeight: r.layer_height ? Math.round(r.layer_height * 1000) / 1000 : null,
      infill: r.sparse_infill_density ?? null,
      walls: r.wall_loops ?? null,
      warnings: p?.warning_message ? [p.warning_message] : [],
    };
  } catch {
    return {};
  }
}

const MODEL_EXT = [".stl", ".3mf", ".step", ".stp", ".obj"];
const PART_EXT = [".stl", ".obj"];

/** Where a sliced file's report lives, so later previews can show what the slicer said. */
export function sidecarPath(file: string): string {
  return `${file.replace(/(\.gcode)?\.3mf$/i, "")}.slice.json`;
}

export function readSidecar(file: string): SliceResult | null {
  try {
    return JSON.parse(readFileSync(sidecarPath(file), "utf8")) as SliceResult;
  } catch {
    return null;
  }
}

/** Every setting the slicer used, from the `; key = value` lines between CONFIG_BLOCK_START and _END. */
export function parseConfigBlock(gcode: string): Record<string, string> {
  const start = gcode.indexOf("; CONFIG_BLOCK_START");
  const end = gcode.indexOf("; CONFIG_BLOCK_END", start);
  if (start < 0 || end < 0) return {};
  const out: Record<string, string> = {};
  for (const line of gcode.slice(start, end).split("\n")) {
    const m = line.match(/^; ([a-z0-9_]+) = (.*)$/);
    if (m) out[m[1]!] = m[2]!;
  }
  return out;
}

const norm = (v: string | number | boolean) =>
  typeof v === "boolean" ? (v ? "1" : "0") : String(v).trim();

/** Requested settings the G-code does not show, with what it shows instead. */
export function notApplied(
  wanted: Record<string, string | number | boolean>,
  config: Record<string, string>,
): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(wanted)) {
    const got = config[k];
    if (got === undefined) {
      out.push(`${k} (no such setting)`);
      continue;
    }
    const first = got.split(",")[0]!.trim();
    const want = norm(v);
    const same = got === want || first === want || (Number(first) === Number(want) && want !== "");
    if (!same) out.push(`${k} (asked ${want}, slicer used ${got.slice(0, 60)})`);
  }
  return out;
}

/**
 * The slicer's full list of settings with their P2S defaults, made once per
 * Bambu Studio version by slicing a small cube, so print_settings can search
 * keys that no profile file mentions.
 */
export async function referenceConfig(
  slicerPath: string,
  cacheDir: string,
): Promise<Record<string, string>> {
  const version = existsSync(slicerPath) ? String(statSync(slicerPath).mtimeMs) : "none";
  const cache = join(cacheDir, "slicer-settings.json");
  try {
    const c = JSON.parse(readFileSync(cache, "utf8")) as {
      version: string;
      config: Record<string, string>;
    };
    if (c.version === version) return c.config;
  } catch {}
  const tmp = mkdtempSync(join(tmpdir(), "edmund-refcube-"));
  try {
    const stl = join(tmp, "cube.stl");
    writeFileSync(stl, cubeStl(10));
    const r = await slice({
      slicerPath,
      outDir: tmp,
      name: "reference",
      model: stl,
      filaments: [{ type: "PLA", color: "#FFFFFF" }],
      plate: "textured_pei",
    });
    const gcode = zipEntry(r.file, "Metadata/plate_1.gcode");
    const config = gcode ? parseConfigBlock(gcode.toString("utf8")) : {};
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(cache, JSON.stringify({ version, config }));
    return config;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function cubeStl(s: number): string {
  const v = [0, s].flatMap((x) => [0, s].flatMap((y) => [0, s].map((z) => [x, y, z])));
  const f = [
    [0, 1, 3],
    [0, 3, 2],
    [4, 6, 7],
    [4, 7, 5],
    [0, 4, 5],
    [0, 5, 1],
    [2, 3, 7],
    [2, 7, 6],
    [0, 2, 6],
    [0, 6, 4],
    [1, 5, 7],
    [1, 7, 3],
  ];
  const facets = f
    .map(
      (t) =>
        ` facet normal 0 0 0\n  outer loop\n${t.map((i) => `   vertex ${v[i]!.join(" ")}`).join("\n")}\n  endloop\n endfacet`,
    )
    .join("\n");
  return `solid c\n${facets}\nendsolid c\n`;
}

export function safeName(raw: string): string {
  return (
    raw
      .replace(/\.(gcode\.)?3mf$/i, "")
      .replace(/[^A-Za-z0-9 ._-]+/g, "")
      .trim()
      .replace(/\s+/g, "_")
      .slice(0, 60) || "print"
  );
}

/** Build the CLI arguments. Pure, so the shape of a call can be tested without running the slicer. */
export function sliceArgs(r: {
  datadir: string;
  settingsFiles: string[];
  filamentFiles: string[];
  colors: string[];
  outDir: string;
  outName: string;
  mode: "print" | "project";
  model?: string;
  assembleList?: string;
  copies?: number;
  orient?: boolean;
  scale?: number;
  rotate?: { z?: number; x?: number; y?: number };
  plateIndex?: number;
}): string[] {
  const a = ["--datadir", r.datadir, "--debug", "2"];
  if (r.mode === "print") a.push("--slice", String(r.plateIndex ?? 0));
  if (r.scale && r.scale !== 1) a.push("--scale", String(r.scale));
  if (r.rotate?.z) a.push("--rotate", String(r.rotate.z));
  if (r.rotate?.x) a.push("--rotate-x", String(r.rotate.x));
  if (r.rotate?.y) a.push("--rotate-y", String(r.rotate.y));
  a.push("--arrange", "1", "--orient", r.orient ? "1" : "0");
  a.push("--load-settings", r.settingsFiles.join(";"));
  a.push("--load-filaments", r.filamentFiles.join(";"));
  a.push("--filament-colour", r.colors.join(";"));
  if (r.model && r.copies && r.copies > 1) a.push("--clone-objects", String(r.copies));
  a.push("--outputdir", r.outDir, "--export-3mf", r.outName);
  if (r.assembleList) a.push("--load-assemble-list", r.assembleList);
  else if (r.model) a.push(r.model);
  return a;
}

function run(bin: string, args: string[], home: string, logPath: string, timeoutMs: number) {
  return new Promise<{ code: number | null; timedOut: boolean }>((done) => {
    const proc = spawn(bin, args, {
      env: { ...process.env, HOME: home },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const out: Buffer[] = [];
    proc.stdout.on("data", (d: Buffer) => out.push(d));
    proc.stderr.on("data", (d: Buffer) => out.push(d));
    let timedOut = false;
    const t = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGKILL");
    }, timeoutMs);
    proc.on("exit", (code) => {
      clearTimeout(t);
      writeFileSync(logPath, Buffer.concat(out).subarray(-200_000));
      done({ code, timedOut });
    });
    proc.on("error", () => {
      clearTimeout(t);
      done({ code: -1, timedOut: false });
    });
  });
}

/** The slicer's own explanation of a failure: the specific errors and warnings first, its summary last. */
function failure(outDir: string, logPath: string): string {
  const log = existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
  const { warnings, errors } = parseSlicerLog(log);
  const summary = readResultJson(outDir).errorString;
  const parts = [...errors, ...warnings];
  if (summary && summary !== "Success.") parts.push(summary);
  if (parts.length) return parts.join(" ");
  const raw = log.split("\n").filter((l) => /\[error\]/.test(l) && !/Invalid T command/.test(l));
  return (
    raw
      .slice(-3)
      .map((l) => l.replace(/^.*\[error\]\s*/, ""))
      .join("; ") || "the slicer failed"
  );
}

export async function slice(req: SliceRequest): Promise<SliceResult> {
  const mode = req.mode ?? "print";
  if (!existsSync(req.slicerPath)) {
    throw new Error(
      `Bambu Studio is not installed at ${req.slicerPath} (brew install --cask bambu-studio)`,
    );
  }
  if (!req.model && !req.parts?.length) throw new Error("give a model file or parts");
  if (req.model) {
    if (!existsSync(req.model)) throw new Error(`model not found: ${req.model}`);
    if (!MODEL_EXT.includes(extname(req.model).toLowerCase())) {
      throw new Error(`cannot slice ${extname(req.model)} files; use STL, OBJ, STEP or 3MF`);
    }
  }
  for (const p of req.parts ?? []) {
    if (!existsSync(p.path)) throw new Error(`part not found: ${p.path}`);
    if (!PART_EXT.includes(extname(p.path).toLowerCase()))
      throw new Error(`parts must be STL or OBJ: ${p.path}`);
    if (p.filament < 1 || p.filament > req.filaments.length) {
      throw new Error(
        `part ${basename(p.path)} uses filament ${p.filament}, but only ${req.filaments.length} are listed`,
      );
    }
  }
  if (req.filaments.length === 0) throw new Error("list at least one filament");
  if (req.filaments.length > 16) throw new Error("at most 16 filaments");
  const bed = BED_TYPES[req.plate];
  if (!bed) throw new Error(`unknown plate ${req.plate}`);

  const dir = profilesDir(req.slicerPath);
  const nozzle = req.nozzle || "0.4";
  const machine = machineName(nozzle);
  const procName = processName(req.quality ?? "standard", nozzle);
  const machineProfile = resolveProfile(dir, "machine", machine);
  let processProfile = resolveProfile(dir, "process", procName);
  const filamentNames = req.filaments.map((f) =>
    filamentProfileName(dir, machine, f.type, f.infoIdx),
  );
  let filamentProfiles: Profile[] = filamentNames.map((n) => resolveProfile(dir, "filament", n));

  // Overrides land on the process when it has the key, else on every filament
  // that does. A key in neither (profiles store only what differs from the
  // app's defaults, so brim_type and many others are absent) still goes to
  // the process; whether it took is read back from the G-code afterwards.
  const overrides = req.settings ?? {};
  const forProcess: Record<string, string | number | boolean> = {};
  const forFilament: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(overrides)) {
    if (filamentProfiles.some((f) => k in f) && !(k in processProfile)) forFilament[k] = v;
    else forProcess[k] = v;
  }
  for (const [k, v] of Object.entries(forProcess)) {
    if (!(k in processProfile))
      processProfile[k] = typeof v === "boolean" ? (v ? "1" : "0") : String(v);
  }
  processProfile = applyOverrides(processProfile, forProcess).profile;
  filamentProfiles = filamentProfiles.map((f) => applyOverrides(f, forFilament).profile);
  processProfile.curr_bed_type = bed.studio;

  const work = mkdtempSync(join(tmpdir(), "edmund-slice-"));
  try {
    // Far more triangles than a nozzle can print make a print file too big
    // to send; thin them here, where every model passes (mesh.ts).
    const meshes = await printableMeshes({ model: req.model, parts: req.parts }, work);
    const files = {
      machine: join(work, "machine.json"),
      process: join(work, "process.json"),
      filaments: filamentProfiles.map((_, i) => join(work, `filament${i + 1}.json`)),
    };
    writeFileSync(files.machine, JSON.stringify(machineProfile));
    writeFileSync(files.process, JSON.stringify(processProfile));
    filamentProfiles.forEach((f, i) => writeFileSync(files.filaments[i]!, JSON.stringify(f)));

    let assembleList: string | undefined;
    if (meshes.parts?.length) {
      assembleList = join(work, "assemble.json");
      writeFileSync(
        assembleList,
        JSON.stringify({
          plates: [
            {
              plate_name: req.name,
              need_arrange: true,
              plate_params: { curr_bed_type: bed.studio },
              objects: meshes.parts.map((p) => ({
                path: resolve(p.path),
                count: 1,
                filaments: [p.filament],
                assemble_index: [1],
              })),
            },
          ],
        }),
      );
    }

    const outDir = join(work, "out");
    mkdirSync(outDir, { recursive: true });
    const outName = `${safeName(req.name)}${mode === "print" ? ".gcode.3mf" : ".3mf"}`;
    const args = sliceArgs({
      datadir: join(work, "data"),
      settingsFiles: [files.machine, files.process],
      filamentFiles: files.filaments,
      colors: req.filaments.map((f) => f.color),
      outDir,
      outName,
      mode,
      model: meshes.model ? resolve(meshes.model) : undefined,
      assembleList,
      copies: req.copies,
      orient: req.orient,
      scale: req.scale,
      rotate: req.rotate,
      plateIndex: req.plateIndex,
    });
    mkdirSync(req.outDir, { recursive: true });
    const logPath = join(req.outDir, `${safeName(req.name)}.slice-log.txt`);
    const r = await run(req.slicerPath, args, work, logPath, req.timeoutMs ?? 240_000);
    const produced = join(outDir, outName);
    if (r.timedOut) {
      throw new Error(
        "the slicer hung (its preview renderer cannot run while the Mac's screen is locked); try again with the screen unlocked",
      );
    }
    if (r.code !== 0 || !existsSync(produced)) throw new Error(failure(outDir, logPath));

    const file = join(req.outDir, outName);
    copyFileSync(produced, file);
    const sliced = readSliced(file);
    // The plate that was sliced: the one asked for, else the first with G-code.
    const plate =
      sliced.plates.find((p) => p.index === req.plateIndex) ??
      sliced.plates.find((p) => p.predictionS > 0) ??
      sliced.plates[0] ??
      null;
    const png = zipEntry(file, `Metadata/plate_${plate?.index ?? 1}.png`);
    const preview = join(req.outDir, `${safeName(req.name)}.plate.png`);
    if (png) writeFileSync(preview, png);
    if (mode === "print" && !sliced.hasGcode) throw new Error("the slicer produced no G-code");
    // The G-code's own config block is the record of what was applied.
    const gcode =
      mode === "print" ? zipEntry(file, `Metadata/plate_${plate?.index ?? 1}.gcode`) : null;
    const ignored = gcode ? notApplied(overrides, parseConfigBlock(gcode.toString("utf8"))) : [];
    const fromLog = parseSlicerLog(readFileSync(logPath, "utf8"));
    const fromJson = readResultJson(outDir);
    // The file itself is the record of how much mesh went to the printer.
    const sentTriangles = countTriangles(file);
    const meshWarnings =
      sentTriangles !== null && sentTriangles > MAX_TRIANGLES * 1.5
        ? [
            `The print file still carries ${sentTriangles.toLocaleString("en-US")} triangles (painted with color groups, or a finely meshed STEP), which can stall sending it. Re-export the model with coarser detail.`,
          ]
        : [];
    const report: SliceReport = {
      mesh: { ...meshes.report, after: sentTriangles ?? meshes.report.after },
      warnings: [...new Set([...fromLog.warnings, ...(fromJson.warnings ?? []), ...meshWarnings])],
      errors: fromLog.errors,
      featureTimes: fromJson.featureTimes ?? {},
      filamentChanges: fromJson.filamentChanges ?? 0,
      totalS: fromJson.totalS || plate?.predictionS || 0,
      modelS: fromJson.modelS ?? 0,
      layerHeight: fromJson.layerHeight ?? null,
      infill: fromJson.infill ?? null,
      walls: fromJson.walls ?? null,
    };
    const result: SliceResult = {
      file,
      preview: png ? preview : "",
      plate,
      bedType: bed.studio,
      process: procName,
      filamentProfiles: filamentNames,
      ignored,
      log: logPath,
      report,
      settings: overrides,
    };
    writeFileSync(sidecarPath(file), JSON.stringify(result, null, 1));
    return result;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
