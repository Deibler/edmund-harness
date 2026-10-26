import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { z } from "zod";
import {
  dmChatGuid,
  getGroupParticipants,
  latestMessageInGuids,
} from "../../src/imessage/participants.ts";
import { sendMessage } from "../../src/imessage/send.ts";
import type { ToolContext } from "../../src/mcp/context.ts";
import { recordToolSend } from "../../src/mcp/tools/message.ts";
import type { ToolDef, ToolResult } from "../../src/mcp/tools/types.ts";
import { chatIdFromKey, isGroupSession, normalizeHandle } from "../../src/sessions/key.ts";
import { shelveFile } from "../../src/shelf/shelf.ts";
import { assertPathSafe } from "../../src/util/path-safety.ts";
import { PLATES, isConfigured, printerConfig } from "./config.ts";
import { PrinterAccess } from "./src/access.ts";
import { findAskGuid, findDecision } from "./src/approval.ts";
import { colorName } from "./src/color.ts";
import { CtrlSession } from "./src/ctrl.ts";
import { describeJob, describePlan, describeStatus, describeWatch } from "./src/describe.ts";
import { type Need, describeNeed, planFilaments, trayFingerprint } from "./src/filament.ts";
import { chooseRoute } from "./src/gate.ts";
import { describeToolpaths, parseGcode } from "./src/gcode.ts";
import { describeError, loadErrorDb, lookupCode, wikiLink } from "./src/hms.ts";
import {
  SORTS as MW_SORTS,
  fetchPicture,
  design as mwDesign,
  designId as mwDesignId,
  downloadProfile as mwDownload,
  search as mwSearch,
  sendLoginCode as mwSendCode,
  verifyLoginCode as mwVerify,
  readCloud,
} from "./src/makerworld.ts";
import { VIEWS, legend, render } from "./src/preview.ts";
import { copyIntoJobDir } from "./src/runtime.ts";
import { approverName, approvers, framesDir, pageUrl } from "./src/settings.ts";
import { type SliceResult, readSidecar, referenceConfig, safeName, slice } from "./src/slicer.ts";
import { type Job, PrinterStore, type WatchKind } from "./src/store.ts";
import { bedLabelFor, printablePlate, readSliced, slicedBedType, zipEntry } from "./src/threemf.ts";
import { describeTrays } from "./src/watches.ts";
import { allTrays, formatMinutes } from "./src/watches.ts";

/**
 * The printer, as tools. Reading is open to every conversation: status,
 * camera, filament, errors, timelapses, slicing and previews. Moving the
 * printer is not: a print starts only through print_start, after the
 * approver's yes in chat.db, from the conversation that asked, with the
 * approved colors loaded and an empty plate; cancel and resume need their
 * own yes; pausing does not exist. The daemon re-checks all of it.
 */

const text = (body: string, isError = false): ToolResult => ({
  content: [{ type: "text", text: body }],
  isError,
});
const image = (png: Buffer, mime = "image/png") => ({
  type: "image" as const,
  data: png.toString("base64"),
  mimeType: mime,
});

const FilamentInput = z.object({
  tray: z
    .number()
    .int()
    .optional()
    .describe(
      "Use exactly what is loaded in this AMS tray: 1-4 for AMS 1 slots 1-4 (5-8 for a second AMS). Overrides type/color.",
    ),
  type: z.string().optional().describe('Material, e.g. "PLA", "PETG", "TPU". Default PLA.'),
  color: z.string().optional().describe('Hex color, e.g. "#C12E1F".'),
});

const SliceInput = z.object({
  name: z
    .string()
    .describe('What the print is called, e.g. "Sam\'s dragon". Shown on the printer and the page.'),
  model: z
    .string()
    .optional()
    .describe(
      "One model file: STL, OBJ, STEP or 3MF (a 3MF may carry per-part filament assignments).",
    ),
  parts: z
    .array(z.object({ path: z.string(), filament: z.number().int().min(1) }))
    .optional()
    .describe(
      "Instead of model: STL/OBJ parts modelled in one coordinate frame, each with a filament number; merged into one object with positions kept. This is how a multi-color design prints.",
    ),
  filaments: z
    .array(FilamentInput)
    .min(1)
    .describe("The project's filaments in order: filament 1, 2, ..."),
  plate: z
    .enum(PLATES)
    .optional()
    .describe("Build plate. Default: the one usually on the printer ([printer].plate)."),
  quality: z
    .enum(["extra_fine", "fine", "balanced", "standard", "draft"])
    .optional()
    .describe("Layer height preset for the 0.4 nozzle: 0.08, 0.12, 0.16, 0.20 (default), 0.24 mm."),
  settings: z
    .record(z.union([z.string(), z.number(), z.boolean()]))
    .optional()
    .describe(
      'Any Bambu Studio process or filament setting by its key, e.g. {"enable_support": true, "support_type": "tree(auto)", "sparse_infill_density": "25%", "wall_loops": 3, "seam_position": "back", "brim_type": "outer_only"}. Find keys with print_settings.',
    ),
  copies: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .describe("How many of the model to put on the plate."),
  scale: z
    .number()
    .positive()
    .max(10)
    .optional()
    .describe("Scale the whole model, e.g. 1.5 for 150% (keeps painted colors)."),
  rotate_z: z.number().optional().describe("Rotate about Z in degrees."),
  rotate_x: z
    .number()
    .optional()
    .describe("Tip it over about X in degrees (e.g. 90 to lay it down)."),
  rotate_y: z.number().optional().describe("Rotate about Y in degrees."),
  plate_index: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe("For a multi-plate project (many MakerWorld files): slice only this plate."),
  orient: z
    .boolean()
    .optional()
    .describe("Let the slicer choose the orientation (default: keep yours)."),
  mode: z
    .enum(["print", "project"])
    .optional()
    .describe(
      '"print" (default) slices to a print-ready file. "project" exports an editable Bambu Studio project with these settings embedded, for the approver or for MakerWorld.',
    ),
});

const PreviewInput = z.object({
  file: z.string().optional().describe("A sliced .gcode.3mf. Or give job_id."),
  job_id: z.number().int().optional(),
  views: z
    .array(z.enum(VIEWS))
    .max(4)
    .optional()
    .describe(
      'Up to four: iso, iso_back, top, front, back, left, right, seams (seam positions in red), supports, overhangs, layer (one layer from above, with seams), first_layer. Default ["iso", "seams"].',
    ),
  layer: z.number().int().min(1).optional().describe("Layer number for the layer view."),
  color_by: z
    .enum(["feature", "filament"])
    .optional()
    .describe("Default feature, like the slicer's preview."),
});

const JobInput = z.object({
  action: z.enum(["create", "get", "list", "update", "plan"]),
  job_id: z.number().int().optional(),
  file: z.string().optional().describe("create/update: the sliced .gcode.3mf from print_slice."),
  title: z.string().optional(),
  requester: z
    .string()
    .optional()
    .describe("create: who the print is for, by name. Defaults to this DM's contact."),
  design_ok: z
    .string()
    .optional()
    .describe(
      "update: the requester's own words approving the design (quote them). Required before asking to print.",
    ),
  prefer: z
    .record(z.number().int())
    .optional()
    .describe(
      'update: substitutes the person accepted, filament number -> tray (1-based slot), e.g. {"2": 3} to print filament 2 from AMS 1 slot 3.',
    ),
});

const ApprovalInput = z.object({
  action: z
    .enum(["start", "cancel", "resume", "plate"])
    .describe(
      "start, cancel or resume a print; plate: after the yes to a print, when print_start's plate check is unsure, send the approver your photo of the plate to confirm it is clear.",
    ),
  job_id: z
    .number()
    .int()
    .optional()
    .describe("start and plate: the job. cancel/resume: the job if it is one of Edmund's."),
  frame_id: z
    .number()
    .int()
    .optional()
    .describe("plate: the printer_camera frame_id of the photo to send, taken after the yes."),
  message: z
    .string()
    .describe(
      'Your ask in your own voice, e.g. "Hey Alex, Sam wants to print a dragon. Can you put red PLA in slot 4?" For a plate check, say what you see: "Can you confirm the plate is clear? I think I see a faint line at the front, but it looks fine to print." The facts and how to answer are added after it.',
    ),
});

const WatchInput = z.object({
  action: z.enum(["add", "list", "remove"]),
  kind: z
    .enum(["progress", "layer", "finish", "state", "error", "filament"])
    .optional()
    .describe(
      "progress (needs percent), layer (needs layer), finish, state (any change, e.g. paused), error, filament (an AMS change, optionally one slot).",
    ),
  percent: z.number().int().min(1).max(100).optional(),
  layer: z.number().int().min(1).optional(),
  slot: z.number().int().min(1).optional().describe("filament: only this tray (1-based)."),
  note: z.string().optional().describe("What to do when it fires; you will see it then."),
  repeat: z
    .boolean()
    .optional()
    .describe("Fire every time rather than once (state, error, filament)."),
  id: z.number().int().optional().describe("remove: the watch id."),
});

export function printerTools(ctx: ToolContext): ToolDef[] {
  const cfg = printerConfig(ctx.config);
  if (!cfg.enabled) return [];
  const configured = isConfigured(cfg);
  const notReady = () =>
    text(
      "The printer is not set up on this machine ([printer] host, access_code and serial in config.toml).",
      true,
    );
  const access = () => new PrinterAccess(ctx.config, ctx.dataDir);
  const store = () => new PrinterStore(ctx.dataDir);
  const workDir = join(ctx.sandboxPath, "prints");
  const approverList = approvers(ctx.config);
  const approver = approverName(ctx.config);
  const isApproverSession =
    !isGroupSession(ctx.sessionKey) &&
    approverList.includes(normalizeHandle(chatIdFromKey(ctx.sessionKey)));

  const withStore = <T>(f: (s: PrinterStore) => T): T => {
    const s = store();
    try {
      return f(s);
    } finally {
      s.close();
    }
  };

  const trayById = async (oneBased: number) => {
    const snap = await access().snapshot();
    const t = allTrays(snap.state).find((x) => x.trayId === oneBased - 1);
    return { snap, tray: t };
  };

  return [
    {
      name: "printer_status",
      description: `Everything about ${cfg.name} (the Bambu Lab 3D printer) right now: state, progress, time left, temperatures, every AMS slot's filament (material, color, how much is left), humidity, errors in Bambu's own words, and whether it can take a print from you. Read the 'printing' skill before planning or troubleshooting a print.`,
      inputSchema: z.object({}),
      handler: async () => {
        if (!configured) return notReady();
        try {
          const snap = await access().snapshot();
          const body = describeStatus(snap.state, loadErrorDb(ctx.dataDir), {
            name: cfg.name,
            via: snap.via,
            modules: snap.modules,
            route: chooseRoute(
              cfg.send_via,
              snap.state.developerMode,
              existsSync(cfg.bambu_connect_app),
            ),
          });
          const extra = withStore((s) => {
            const jobs = s.jobs({ open: true, limit: 5 });
            const mine = s.activeWatches(ctx.sessionKey);
            const lines: string[] = [];
            if (jobs.length)
              lines.push(
                `Open print jobs: ${jobs.map((j) => `${j.id} "${j.title}" (${j.status.replace("_", " ")})`).join("; ")}.`,
              );
            if (mine.length) lines.push(`Your wake-ups: ${mine.map(describeWatch).join("; ")}.`);
            return lines.join("\n");
          });
          return text(
            `${body}${extra ? `\n${extra}` : ""}${snap.via === "direct" ? "\n(Read directly: Edmund's daemon runtime is not running, so starting, cancelling and wake-ups are unavailable until a restart.)" : ""}`,
          );
        } catch (e) {
          return text(`Could not reach the printer: ${(e as Error).message}`, true);
        }
      },
    },
    {
      name: "printer_camera",
      description:
        "A live picture from the printer's camera (chamber light switched on for it). Look at it: the plate, the print in progress, a failure. Returns a frame_id; print_start needs the id of a frame you took after the approver's yes, to show you checked the plate is empty.",
      inputSchema: z.object({
        save_to: z
          .string()
          .optional()
          .describe("Also copy the picture to this path, e.g. to send it."),
      }),
      handler: async (args) => {
        if (!configured) return notReady();
        try {
          const f = await access().frame();
          let saved = f.path;
          if (args.save_to) {
            assertPathSafe(args.save_to);
            writeFileSync(args.save_to, f.jpeg);
            saved = args.save_to;
          }
          return {
            content: [
              {
                type: "text",
                text: `frame_id ${f.id}, taken ${new Date(f.id).toLocaleTimeString("en-US", { timeZone: "America/New_York" })}, saved at ${saved}`,
              },
              image(f.jpeg, "image/jpeg"),
            ],
          };
        } catch (e) {
          return text(`No picture: ${(e as Error).message}`, true);
        }
      },
    },
    {
      name: "printer_watch",
      description:
        "Wake yourself when something happens at the printer: a percent or layer is reached, the print ends (you get a photo), it pauses or changes state, an error appears, or the filament in the AMS changes (e.g. after asking someone to swap a spool). Every print you start already wakes you at 25/50/75%, at the end, on errors and on pauses.",
      inputSchema: WatchInput,
      handler: async (args) => {
        if (!configured) return notReady();
        if (args.action === "list") {
          return text(
            withStore((s) => s.activeWatches(ctx.sessionKey).map(describeWatch).join("\n")) ||
              "No wake-ups set in this conversation.",
          );
        }
        if (args.action === "remove") {
          if (!args.id) return text("Give the id to remove.", true);
          return withStore((s) =>
            s.removeWatch(args.id!, ctx.sessionKey)
              ? text(`Removed #${args.id}.`)
              : text(`No active wake-up #${args.id} here.`, true),
          );
        }
        const kind = args.kind as WatchKind | undefined;
        if (!kind) return text("Say which kind.", true);
        if (kind === "progress" && !args.percent)
          return text("A progress wake-up needs a percent.", true);
        if (kind === "layer" && !args.layer) return text("A layer wake-up needs a layer.", true);
        let printKey = "";
        let baseline = "";
        try {
          const snap = await access().snapshot();
          if (["progress", "layer", "finish"].includes(kind)) printKey = snap.printKey;
          if (kind === "filament") {
            baseline = trayFingerprint(
              allTrays(snap.state),
              args.slot ? [args.slot - 1] : undefined,
            );
          }
        } catch (e) {
          if (kind === "filament")
            return text(`Cannot read the AMS to set this: ${(e as Error).message}`, true);
        }
        const w = withStore((s) =>
          s.addWatch({
            sessionKey: ctx.sessionKey,
            kind,
            threshold: kind === "progress" ? args.percent : kind === "layer" ? args.layer : null,
            slot: args.slot ? args.slot - 1 : null,
            note: args.note,
            printKey,
            repeat: args.repeat ?? false,
            baseline,
          }),
        );
        return text(
          `Set: ${describeWatch(w)}.${printKey === "" && ["progress", "layer", "finish"].includes(kind) ? " Nothing is printing, so it applies to the next print that starts." : ""}`,
        );
      },
    },
    {
      name: "printer_timelapse",
      description:
        "The printer's timelapse videos: list them, or fetch one (the latest by default) into this chat's folder, optionally onto their shelf for a permanent link. Look at it with your video tool before describing it.",
      inputSchema: z.object({
        action: z.enum(["list", "get"]),
        name: z
          .string()
          .optional()
          .describe("get: the file name from the list. Default the newest."),
        share: z
          .boolean()
          .optional()
          .describe("get: also put it on this person's shelf and return the link."),
      }),
      handler: async (args) => {
        if (!configured) return notReady();
        let s: CtrlSession | null = null;
        try {
          s = await CtrlSession.open({
            host: cfg.host,
            accessCode: cfg.access_code,
            expectCn: cfg.serial,
          });
          const files = (await s.list("timelapse")).sort((a, b) => b.time - a.time);
          if (args.action === "list") {
            return text(
              files
                .slice(0, 25)
                .map(
                  (f) =>
                    `${f.name}: "${f.modelName}", ${new Date(f.time * 1000).toLocaleString("en-US", { timeZone: "America/New_York" })}, ${(f.size / 1e6).toFixed(1)} MB, ${(f.durationMs / 1000).toFixed(1)} s`,
                )
                .join("\n") || "No timelapses on the printer.",
            );
          }
          const f = args.name ? files.find((x) => x.name === args.name) : files[0];
          if (!f) return text("No such timelapse.", true);
          const data = await s.download(f.path);
          mkdirSync(join(workDir, "timelapses"), { recursive: true });
          const out = join(workDir, "timelapses", `${safeName(f.modelName || "print")}-${f.name}`);
          writeFileSync(out, data);
          let link = "";
          if (args.share && ctx.config.shelf?.origin) {
            link = shelveFile({
              dataDir: ctx.dataDir,
              sessionKey: ctx.sessionKey,
              src: out,
              origin: ctx.config.shelf.origin,
              title: `Timelapse: ${f.modelName}`,
            }).url;
          }
          return text(
            `Saved "${f.modelName}" timelapse (${(data.length / 1e6).toFixed(1)} MB) at ${out}${link ? `\nPermanent link: ${link}` : ""}`,
          );
        } catch (e) {
          return text(`Timelapse: ${(e as Error).message}`, true);
        } finally {
          s?.close();
        }
      },
    },
    {
      name: "printer_error_lookup",
      description:
        "What a Bambu error code means, in Bambu's words, for codes a person reads off the screen or the app (0300_0100_0001_0007, 0300-400C, HMS_...). Current printer errors already come decoded in printer_status.",
      inputSchema: z.object({ code: z.string() }),
      handler: (args) => {
        const e = lookupCode(args.code, loadErrorDb(ctx.dataDir));
        if (!e) return text(`"${args.code}" does not look like a Bambu error code.`, true);
        return text(
          `${describeError(e)}\nHelp: ${wikiLink(e)}${e.known ? "" : "\nThis code is not in Bambu's list for this printer; search the wiki for it."}`,
        );
      },
    },
    {
      name: "print_slice",
      description:
        "Slice a model for the P2S with Bambu Studio's own engine and any settings, and see the result: time, filament per color, time per feature, every slicer warning and error (overhangs that need support, floating parts, collisions), a render of the plate and the toolpath preview. Re-run with changed settings until the preview and warnings are right. Use print_preview for more views (seams, layers, supports).",
      inputSchema: SliceInput,
      handler: async (args) => {
        try {
          for (const p of [
            args.model,
            ...((args.parts ?? []) as Array<{ path: string }>).map((x) => x.path),
          ])
            if (p) assertPathSafe(p);
          const filaments = [];
          for (const f of args.filaments) {
            if (f.tray !== undefined) {
              if (!configured) return notReady();
              const { tray } = await trayById(f.tray);
              if (!tray?.loaded) return text(`Tray ${f.tray} is empty.`, true);
              filaments.push({
                type: tray.type,
                color: tray.color,
                infoIdx: tray.infoIdx || undefined,
              });
            } else filaments.push({ type: f.type ?? "PLA", color: f.color ?? "#FFFFFF" });
          }
          let nozzle = "0.4";
          if (configured) {
            const snap = await access()
              .snapshot()
              .catch(() => null);
            if (snap?.state.nozzle.diameter) nozzle = snap.state.nozzle.diameter;
          }
          const r = await slice({
            slicerPath: cfg.slicer_path,
            outDir: workDir,
            name: args.name,
            model: args.model,
            parts: args.parts,
            filaments,
            plate: args.plate ?? cfg.plate,
            quality: args.quality,
            nozzle,
            settings: args.settings,
            copies: args.copies,
            orient: args.orient,
            scale: args.scale,
            rotate: { z: args.rotate_z, x: args.rotate_x, y: args.rotate_y },
            plateIndex: args.plate_index,
            mode: args.mode,
          });
          return sliceResult(r, args.mode ?? "print");
        } catch (e) {
          return text(
            `Slicing failed: ${(e as Error).message}\nFix what it names (orientation, supports, a setting) and slice again.`,
            true,
          );
        }
      },
    },
    {
      name: "print_preview",
      description:
        "Look at sliced toolpaths like the slicer's preview: from any side, by feature or filament, seams in red, supports or overhangs picked out, or one layer from above. Also returns the analysis (layers, seams, supports, overhangs, filament changes) and the slicer's warnings. Check seams and overhangs before showing a design is ready.",
      inputSchema: PreviewInput,
      handler: async (args) => {
        try {
          let file = args.file;
          if (!file && args.job_id) file = withStore((s) => s.job(args.job_id!)?.file);
          if (!file || !existsSync(file)) return text("Give a sliced file or a job id.", true);
          assertPathSafe(file);
          const info = printablePlate(file);
          const gcode = info ? zipEntry(file, `Metadata/plate_${info.index}.gcode`) : null;
          if (!gcode) return text("That file has no G-code; slice it in print mode first.", true);
          const t = parseGcode(gcode.toString("utf8"));
          const colors = (info?.needs ?? []).sort((a, b) => a.index - b.index).map((n) => n.color);
          const views = args.views?.length ? args.views : ["iso", "seams"];
          const content: ToolResult["content"] = [];
          for (const v of views) {
            const r = render(t, {
              view: v as (typeof VIEWS)[number],
              layer: args.layer,
              colorBy: args.color_by,
              filamentColors: colors,
            });
            content.push({ type: "text", text: r.caption });
            content.push(image(r.png));
          }
          const side = readSidecar(file);
          const lines = [
            ...describeToolpaths(t),
            `Colors: ${legend(t, { view: "iso", colorBy: args.color_by, filamentColors: colors })}.`,
          ];
          if (side) {
            lines.push(...reportLines(side));
          }
          content.unshift({ type: "text", text: lines.join("\n") });
          return { content };
        } catch (e) {
          return text(`Preview failed: ${(e as Error).message}`, true);
        }
      },
    },
    {
      name: "print_settings",
      description:
        'Find Bambu Studio setting keys and their P2S default values (all of them, not just those in profiles), to change them in print_slice. Search by words like "support", "seam", "infill", "brim", "wall", "ironing", "temperature".',
      inputSchema: z.object({
        query: z.string().describe("Words to match in setting names."),
      }),
      handler: async (args) => {
        try {
          const config = await referenceConfig(cfg.slicer_path, join(ctx.dataDir, "printer"));
          const words: string[] = String(args.query)
            .toLowerCase()
            .split(/[\s,]+/)
            .filter(Boolean);
          const lines = Object.entries(config)
            .filter(([k]) => words.some((w) => k.includes(w)))
            .slice(0, 80)
            .map(([k, v]) => `${k} = ${v.length > 80 ? `${v.slice(0, 80)}...` : v}`);
          return text(
            lines.length
              ? `P2S defaults (0.20 mm standard, PLA, textured PEI):\n${lines.join("\n")}`
              : `No setting matches "${args.query}".`,
          );
        } catch (e) {
          return text(`Could not read the settings: ${(e as Error).message}`, true);
        }
      },
    },
    {
      name: "print_job",
      description:
        "Print jobs: create one from a sliced file (it becomes the thing the approver says yes to), see or list them, record the requester's approval of the design (design_ok, their words), pin substitute filaments, swap in a re-sliced file, or plan: which AMS slots it will use and exactly what someone has to load or swap first.",
      inputSchema: JobInput,
      handler: async (args) => {
        if (args.action === "list") {
          return text(
            withStore((s) => s.jobs({ limit: 15 }))
              .map(
                (j) =>
                  `${j.id} "${j.title}" for ${j.requester || "?"}: ${j.status.replace("_", " ")}`,
              )
              .join("\n") || "No print jobs yet.",
          );
        }
        if (args.action === "create") {
          if (!args.file || !existsSync(args.file))
            return text("Give the sliced .gcode.3mf from print_slice.", true);
          assertPathSafe(args.file);
          const plate = printablePlate(args.file);
          if (!plate)
            return text("That file is not sliced. Slice it with print_slice first.", true);
          const handle = isGroupSession(ctx.sessionKey) ? "" : chatIdFromKey(ctx.sessionKey);
          const requester =
            args.requester || (handle ? (ctx.contacts.displayName(handle) ?? "") : "");
          if (!requester) return text("Say who the print is for (requester).", true);
          const origin =
            latestMessageInGuids(ctx.chatDb, ctx.chatGuids)?.chatGuid ?? ctx.chatGuids[0] ?? "";
          const side = readSidecar(args.file);
          const job = withStore((s) => {
            const j = s.createJob({
              title:
                args.title ||
                basename(args.file!)
                  .replace(/\.gcode\.3mf$|\.3mf$/i, "")
                  .replace(/_/g, " "),
              requester,
              requesterHandle: handle,
              originSession: ctx.sessionKey,
              originChat: origin,
              file: args.file!,
              source: "",
              plate: plate.index,
              plateType: side?.bedType || slicedBedType(args.file!, plate.index),
              needs: plate.needs,
              estimateS: plate.predictionS,
              weightG: plate.weightG,
              settings: side?.settings ?? {},
              preview: "",
            });
            const png = zipEntry(args.file!, `Metadata/plate_${plate.index}.png`);
            if (png) {
              const tmp = join(workDir, `job-${j.id}-plate.png`);
              mkdirSync(workDir, { recursive: true });
              writeFileSync(tmp, png);
              s.updateJob(j.id, { preview: copyIntoJobDir(ctx.dataDir, j.id, tmp, "plate.png") });
            }
            return s.job(j.id)!;
          });
          let planText = "";
          if (configured) {
            try {
              const snap = await access().snapshot();
              planText = describePlan(
                planFilaments(job.needs, allTrays(snap.state), job.prefer),
                allTrays(snap.state),
              );
            } catch (e) {
              planText = `Could not read the AMS: ${(e as Error).message}`;
            }
          }
          return text(
            `${describeJob(job, null, "")}\n${planText}\nNext: show ${requester} the preview and get their OK on the design (record it with design_ok), then print_request_approval.`,
          );
        }
        const job = args.job_id ? withStore((s) => s.job(args.job_id!)) : null;
        if (!job) return text("No such job.", true);
        if (args.action === "get") {
          const a = withStore((s) => s.liveApproval(job.id, "start"));
          return text(describeJob(job, a, pageUrl(ctx.config, job.token)));
        }
        if (args.action === "plan") {
          if (!configured) return notReady();
          const snap = await access().snapshot();
          const plan = planFilaments(job.needs, allTrays(snap.state), job.prefer);
          return text(
            `${describePlan(plan, allTrays(snap.state))}\nLoaded now: ${describeTrays(snap.state)}.`,
          );
        }
        // update
        if (["printing", "starting"].includes(job.status))
          return text("This job is printing; it cannot be changed now.", true);
        const patch: Partial<Job> = {};
        if (args.title) patch.title = args.title;
        if (args.design_ok) patch.designNote = args.design_ok;
        if (args.prefer) {
          patch.prefer = Object.fromEntries(
            Object.entries(args.prefer).map(([f, t]) => [Number(f), Number(t) - 1]),
          );
        }
        let reset = false;
        if (args.file) {
          assertPathSafe(args.file);
          const plate = printablePlate(args.file);
          if (!plate) return text("That file is not sliced.", true);
          Object.assign(patch, {
            file: args.file,
            needs: plate.needs,
            estimateS: plate.predictionS,
            weightG: plate.weightG,
            plateType: readSidecar(args.file)?.bedType || slicedBedType(args.file, plate.index),
          });
          reset = true;
        }
        if (args.prefer) reset = true;
        withStore((s) => {
          s.updateJob(job.id, patch);
          // A yes was for the file and colors it saw; a different one needs a new yes.
          if (reset && ["awaiting_approval", "approved"].includes(job.status)) {
            const a = s.liveApproval(job.id, "start");
            if (a) s.expire(a.id);
            s.updateJob(job.id, { status: "draft" });
          }
        });
        const fresh = withStore((s) => s.job(job.id))!;
        return text(
          `${describeJob(fresh, null, "")}${reset && job.status !== "draft" ? "\nThe earlier approval no longer applies to the changed job; ask again." : ""}`,
        );
      },
    },
    {
      name: "print_request_approval",
      description: `Ask ${approver} to approve a print (or a cancel or resume). Nothing starts without their yes. It goes into this group if they are in it, otherwise to their DM, with the job's facts and the swaps it needs added after your words; the reply is read from Messages itself and you are woken when it comes. Needs the requester's design OK recorded first (print_job update design_ok). After the yes, if print_start's plate check is unsure, use action "plate" with your printer_camera frame_id to send them the photo and ask them to confirm the plate is clear; their yes counts as the plate check for 15 minutes.`,
      inputSchema: ApprovalInput,
      handler: async (args) => {
        if (!configured) return notReady();
        if (approverList.length === 0)
          return text(
            "No approver is configured ([printer].approvers or [security].operator_handles).",
            true,
          );
        const st = await access()
          .snapshot()
          .catch(() => null);
        const job = args.job_id ? withStore((s) => s.job(args.job_id!)) : null;
        let facts = "";
        let plan = null;
        let target = "";
        let attachments: string[] = [];
        let frameMs: number | null = null;
        if (args.action === "plate") {
          if (!job) return text("Which job? The plate check is for a print job.", true);
          if (job.originSession !== ctx.sessionKey)
            return text("Ask from the conversation the print belongs to.", true);
          const startAsk = withStore((s) => s.liveApproval(job.id, "start"));
          const yes = startAsk ? findDecision(ctx.chatDb, startAsk, approverList) : null;
          if (!startAsk || yes?.verdict !== "approve")
            return text(
              `${approver} has not said yes to this print yet; the plate check comes after that yes.`,
              true,
            );
          if (!args.frame_id)
            return text("Pass the frame_id of your printer_camera photo of the plate.", true);
          const photo = join(framesDir(ctx.dataDir), `${args.frame_id}.jpg`);
          if (!existsSync(photo))
            return text(`No frame ${args.frame_id}; take one with printer_camera.`, true);
          if (args.frame_id < yes.ms)
            return text(
              "That photo is from before the yes; take a new one with printer_camera.",
              true,
            );
          attachments = [photo];
          frameMs = args.frame_id;
          facts = `The plate for ${job.title}, just now. Reply yes if it is clear, or no.`;
        } else if (args.action === "start") {
          if (!job) return text("Which job? Create one with print_job first.", true);
          if (job.originSession !== ctx.sessionKey)
            return text("Ask from the conversation the print belongs to.", true);
          if (!job.designNote)
            return text(
              `Record ${job.requester || "the requester"}'s OK on the design first (print_job update design_ok with their words).`,
              true,
            );
          if (["printing", "starting", "finished", "failed", "cancelled"].includes(job.status))
            return text(`Job ${job.id} is ${job.status}.`, true);
          if (!st) return text("Cannot read the printer to plan the filament.", true);
          plan = planFilaments(job.needs, allTrays(st.state), job.prefer);
          const uses = [
            ...plan.assignments.map(
              (a) => `${colorName(a.need.color)} ${a.need.type} from ${a.tray.label}`,
            ),
            ...plan.swaps.map(
              (s) =>
                `${colorName(s.need.color)} ${s.need.type} in ${s.slot.label} (needs loading${s.replaces ? `, replacing the ${colorName(s.replaces.color)}` : ""})`,
            ),
          ];
          facts = `${job.title} for ${job.requester}: about ${formatMinutes(job.estimateS / 60)}, ${job.weightG.toFixed(0)} g, ${bedLabelFor(job.plateType)}. Filament: ${uses.join("; ")}. Reply yes to print it, or no.`;
          if (plan.unplaceable.length)
            return text(
              `This design needs more colors than the AMS can hold: ${plan.unplaceable.map(describeNeed).join("; ")}.`,
              true,
            );
        } else {
          if (!st) return text("Cannot read the printer.", true);
          target = st.state.taskName;
          facts = `"${target}" is ${st.state.stateLabel}${st.state.percent !== null ? ` at ${st.state.percent}%` : ""}. Reply yes to ${args.action} it, or no.`;
        }
        // Where to ask: this group when the approver is in it, else the approver's DM.
        let chatGuid = "";
        let to = "";
        let isGroup = false;
        const here = isGroupSession(ctx.sessionKey) ? chatIdFromKey(ctx.sessionKey) : "";
        if (here) {
          const members = getGroupParticipants(ctx.chatDb, here).map(normalizeHandle);
          if (approverList.some((a) => members.includes(a))) {
            chatGuid = here;
            to = here;
            isGroup = true;
          }
        }
        if (!to) {
          to = approverList[0]!;
          chatGuid = isApproverSession
            ? (latestMessageInGuids(ctx.chatDb, ctx.chatGuids)?.chatGuid ??
              dmChatGuid(ctx.chatDb, to))
            : dmChatGuid(ctx.chatDb, to);
        }
        const body = `${args.message.trim()}\n\n${facts}`;
        const askedMs = Date.now();
        const sent = await sendMessage({ to, isGroup, text: body, chatGuid, attachments });
        if (!sent.ok) return text(`Could not send the ask: ${sent.error}`, true);
        const ownChat = ctx.chatGuids.includes(chatGuid);
        if (ownChat) recordToolSend(ctx, body, chatGuid);
        const approval = withStore((s) => {
          const a = s.createApproval({
            jobId: job?.id ?? null,
            action: args.action,
            chatGuid,
            sessionKey: ctx.sessionKey,
            askedMs,
            askText: body,
            trays: st ? trayFingerprint(allTrays(st.state)) : "",
            plan,
            target,
            frameMs,
          });
          if (job && args.action === "start") s.updateJob(job.id, { status: "awaiting_approval" });
          s.log(
            "approval_asked",
            `${args.action} in ${isGroup ? "the group" : "the approver's DM"}`,
            job?.id ?? null,
          );
          return a;
        });
        // Find the ask in Messages so a tapback on it counts.
        for (let i = 0; i < 6; i++) {
          await Bun.sleep(1000);
          const guid = findAskGuid(ctx.chatDb, chatGuid, askedMs, args.message);
          if (guid) {
            withStore((s) => s.setAskGuid(approval.id, guid));
            break;
          }
        }
        const where = isGroup ? "in this group" : ownChat ? "here" : `in ${approver}'s DM`;
        if (args.action === "plate")
          return text(
            `Sent ${approver} the photo ${where}. Do not repeat it.${ownChat ? " It is already in this chat." : ""} When they say it is clear you will be woken; then call print_start with job_id ${job?.id} and frame_id ${frameMs}. Their yes stands for 15 minutes.`,
          );
        return text(
          `Asked ${where}. Do not repeat the ask.${ownChat ? " It is already in this chat, so do not send it again in your reply." : ` Tell ${job?.requester || "them"} you have asked ${approver} if useful.`} You will be woken when ${approver} answers${plan && !plan.ok ? "; meanwhile a filament wake-up (printer_watch kind filament) will tell you when the swap is done" : ""}.`,
        );
      },
    },
    {
      name: "print_start",
      description: `Start an approved print job. Only works from the conversation that asked for it, after ${approver}'s yes, with the approved filament loaded, and after you looked at the plate (frame_id from printer_camera taken after the yes); it then runs its own independent check that the plate is empty, unless ${approver} has just confirmed it from your photo (print_request_approval action "plate"). Returns the live page link to send the person who asked.`,
      inputSchema: z.object({
        job_id: z.number().int(),
        frame_id: z
          .number()
          .int()
          .describe(
            "A printer_camera frame_id taken after the yes, in which you saw an empty plate.",
          ),
      }),
      handler: async (args) => {
        if (!configured) return notReady();
        try {
          const r = await access().start(args.job_id, ctx.sessionKey, args.frame_id);
          if (!r.ok) return text(`Not started:\n- ${r.problems.join("\n- ")}`, true);
          return text(
            `${r.message}\nSend ${withStore((s) => s.job(args.job_id)?.requester) || "them"} the page link now.`,
          );
        } catch (e) {
          return text(`Not started: ${(e as Error).message}`, true);
        }
      },
    },
    {
      name: "print_control",
      description: `Cancel or resume a print (each only after ${approver} says yes to an ask from print_request_approval), or turn the chamber light on or off. There is no pause: Edmund never pauses a print.`,
      inputSchema: z.object({
        action: z.enum(["cancel", "resume", "light_on", "light_off"]),
        job_id: z.number().int().optional(),
      }),
      handler: async (args) => {
        if (!configured) return notReady();
        try {
          if (args.action === "light_on" || args.action === "light_off") {
            await access().light(args.action === "light_on");
            return text(`Chamber light ${args.action === "light_on" ? "on" : "off"}.`);
          }
          if (args.action !== "cancel" && args.action !== "resume") {
            return text(
              "Only cancel, resume and the light exist here. Edmund never pauses a print.",
              true,
            );
          }
          const r = await access().control(args.action, ctx.sessionKey, args.job_id ?? null);
          return text(
            r.ok
              ? r.message
              : `${r.message}${r.problems?.length ? `\n- ${r.problems.join("\n- ")}` : ""}`,
            !r.ok,
          );
        } catch (e) {
          return text((e as Error).message, true);
        }
      },
    },
    {
      name: "makerworld_search",
      description:
        "Search MakerWorld (Bambu's model site, millions of free printable models) for something to print. Returns the top models with their cover pictures (look at them), downloads, license and link. Covers are saved so you can send them to the person.",
      inputSchema: z.object({
        query: z.string(),
        sort: z
          .enum(MW_SORTS)
          .optional()
          .describe(
            "score (relevance, default), hotScore (trending), downloadCount, likeCount, newUploads.",
          ),
        page: z.number().int().min(1).optional(),
        pictures: z
          .number()
          .int()
          .min(0)
          .max(6)
          .optional()
          .describe("How many covers to look at (default 4)."),
      }),
      handler: async (args) => {
        try {
          const per = 8;
          const r = await mwSearch(String(args.query), {
            limit: per,
            offset: ((args.page ?? 1) - 1) * per,
            sort: args.sort,
          });
          if (!r.hits.length) return text(`Nothing on MakerWorld for "${args.query}".`);
          const dir = join(workDir, "makerworld");
          mkdirSync(dir, { recursive: true });
          const content: ToolResult["content"] = [];
          const lines = [
            `${r.total} results for "${args.query}"${args.page && args.page > 1 ? `, page ${args.page}` : ""}:`,
          ];
          const shown = Math.min(args.pictures ?? 4, r.hits.length);
          for (const [i, h] of r.hits.entries()) {
            let pic = "";
            if (i < shown && h.cover) {
              pic = await fetchPicture(h.cover, join(dir, `${h.id}-cover.jpg`), 768).catch(
                () => "",
              );
            }
            lines.push(
              `${i + 1}. ${h.title} by ${h.creator} (model ${h.id}): ${h.downloads.toLocaleString()} downloads, ${h.prints.toLocaleString()} prints, ${h.likes.toLocaleString()} likes. ${h.license}. ${h.url}${pic ? `\n   cover saved: ${pic}` : ""}`,
            );
            if (pic)
              content.push(
                { type: "text", text: `${i + 1}. ${h.title}` },
                image(readFileSync(pic), "image/jpeg"),
              );
          }
          lines.push(
            "makerworld_model shows a model's photos and print profiles; makerworld_download fetches it to slice and print.",
          );
          return { content: [{ type: "text", text: lines.join("\n") }, ...content] };
        } catch (e) {
          return text(`MakerWorld search failed: ${(e as Error).message}`, true);
        }
      },
    },
    {
      name: "makerworld_model",
      description:
        "One MakerWorld model in full: description, license (and whether remixes are allowed), and every print profile with its printer, time, grams and colors per plate, marked when it fits the P2S. Downloads its photos so you can look at them and send them to the person (send_attachment).",
      inputSchema: z.object({
        model: z.string().describe("Model id or makerworld.com link."),
        photos: z
          .number()
          .int()
          .min(0)
          .max(8)
          .optional()
          .describe("How many photos to fetch and look at (default 3)."),
      }),
      handler: async (args) => {
        const id = mwDesignId(String(args.model));
        if (!id) return text("Give a MakerWorld model id or link.", true);
        try {
          const d = await mwDesign(id);
          const dir = join(workDir, "makerworld", String(id));
          mkdirSync(dir, { recursive: true });
          const content: ToolResult["content"] = [];
          const saved: string[] = [];
          for (const [i, url] of d.pictures.slice(0, args.photos ?? 3).entries()) {
            const pic = await fetchPicture(url, join(dir, `photo-${i + 1}.jpg`), 1280).catch(
              () => "",
            );
            if (pic) {
              saved.push(pic);
              content.push(image(readFileSync(pic), "image/jpeg"));
            }
          }
          const profiles = d.profiles.map(
            (p) =>
              `  profile ${p.id} "${p.title}" for ${p.printer || "?"}${p.forP2S ? " (fits the P2S)" : ""}, ${p.layerHeight || "?"} mm layers: ${p.plates
                .map(
                  (pl) =>
                    `plate ${pl.index} ${formatMinutes(pl.minutes)} ${pl.grams} g [${pl.filaments.map((f) => `${colorName(f.color)} ${f.type}`).join(", ")}]`,
                )
                .join("; ")}${p.id === d.defaultProfile ? " (default)" : ""}`,
          );
          const lines = [
            `${d.title} by ${d.creator}: ${d.url}`,
            `${d.downloads.toLocaleString()} downloads, ${d.prints.toLocaleString()} prints, ${d.likes.toLocaleString()} likes. ${d.categories.join(", ")}.`,
            `License: ${d.license}${d.allowRemix ? "; remixes allowed" : "; remixes not allowed (fine to print and alter for personal use, not to publish)"}.`,
            `Print profiles:`,
            ...profiles,
            "",
            d.summary,
            saved.length ? `\nPhotos saved (send with send_attachment): ${saved.join(", ")}` : "",
          ];
          return { content: [{ type: "text", text: lines.join("\n") }, ...content] };
        } catch (e) {
          return text(`Could not read that model: ${(e as Error).message}`, true);
        }
      },
    },
    {
      name: "makerworld_download",
      description:
        "Download a MakerWorld model's project file (a print profile; the one made for the P2S, else the default) into this chat's folder, ready for print_slice, which re-slices it for the P2S with any changes: colors (the filament list), scale, rotation, settings, one plate of many. For changes to the shape itself, set export_parts to also get its objects as STL files to edit, then slice those as parts.",
      inputSchema: z.object({
        model: z.string().describe("Model id or makerworld.com link."),
        profile_id: z
          .number()
          .int()
          .optional()
          .describe("A specific print profile from makerworld_model."),
        export_parts: z
          .boolean()
          .optional()
          .describe(
            "Also export each object as an STL for editing (painted colors do not survive this).",
          ),
      }),
      handler: async (args) => {
        const id = mwDesignId(String(args.model));
        if (!id) return text("Give a MakerWorld model id or link.", true);
        try {
          const d = await mwDesign(id);
          const prof =
            d.profiles.find((p) => p.id === args.profile_id) ??
            d.profiles.find((p) => p.forP2S && p.id === d.defaultProfile) ??
            d.profiles.find((p) => p.forP2S) ??
            d.profiles.find((p) => p.id === d.defaultProfile) ??
            d.profiles[0];
          if (!prof) return text("That model has no downloadable print profile.", true);
          const dir = join(workDir, "makerworld", String(id));
          mkdirSync(dir, { recursive: true });
          const out = join(dir, `${safeName(d.title)}-${prof.id}.3mf`);
          await mwDownload(ctx.dataDir, prof.id, out);
          const info = readSliced(out);
          const lines = [
            `Downloaded "${d.title}" profile ${prof.id} "${prof.title}" (made for ${prof.printer || "?"}) to ${out}.`,
            `Plates: ${prof.plates.map((pl) => `${pl.index} (${formatMinutes(pl.minutes)}, ${pl.grams} g, ${pl.filaments.map((f) => `filament ${f.color} ${f.type}`).join(" + ")})`).join("; ") || "1"}.`,
            `License: ${d.license}.`,
          ];
          const content: ToolResult["content"] = [];
          const creatorPlate = zipEntry(out, "Metadata/plate_1.png");
          if (creatorPlate)
            content.push({ type: "text", text: "The creator's plate:" }, image(creatorPlate));
          if (args.export_parts) {
            const partsDir = join(dir, "parts");
            mkdirSync(partsDir, { recursive: true });
            const r = Bun.spawnSync(
              [
                cfg.slicer_path,
                "--datadir",
                join(dir, ".bs"),
                "--debug",
                "1",
                "--export-stls",
                partsDir,
                out,
              ],
              {
                env: { ...process.env, HOME: join(dir, ".bs") },
                // The slicer writes its result.json into the working directory.
                cwd: partsDir,
              },
            );
            const parts =
              r.exitCode === 0 ? readdirSync(partsDir).filter((f) => f.endsWith(".stl")) : [];
            lines.push(
              parts.length
                ? `Objects as STL in ${partsDir}: ${parts.join(", ")}`
                : "Could not export the objects as STL.",
            );
          }
          lines.push(
            `Next: print_slice with model "${out}", the filaments in order (${prof.plates[0]?.filaments.length ?? info.plates[0]?.needs.length ?? 1} of them; use tray numbers to print with what is loaded), plate_index for one plate of several, and any scale, rotation or settings changes. Then print_preview.`,
          );
          return { content: [{ type: "text", text: lines.join("\n") }, ...content] };
        } catch (e) {
          return text(`Download failed: ${(e as Error).message}`, true);
        }
      },
    },
    {
      name: "makerworld_login",
      description: `Sign Edmund in to ${approver}'s Bambu account so you can download MakerWorld files, with a code Bambu emails (no password). Only in ${approver}'s own DM. The sign-in lasts about a year.`,
      inputSchema: z.object({
        action: z.enum(["status", "send_code", "verify"]),
        email: z.string().optional().describe("send_code/verify: the account's email."),
        code: z.string().optional().describe("verify: the code from the email."),
      }),
      handler: async (args) => {
        const c = readCloud(ctx.dataDir);
        if (args.action === "status") {
          return text(
            c
              ? `Signed in as ${c.account} until ${new Date(c.expiresMs).toDateString()}.`
              : "Not signed in to Bambu.",
          );
        }
        if (!isApproverSession)
          return text(`Only ${approver}, in their own DM, can sign Edmund in to Bambu.`, true);
        const email = String(args.email ?? c?.account ?? "").trim();
        if (!email.includes("@")) return text("Which email is the Bambu account on?", true);
        try {
          if (args.action === "send_code") {
            await mwSendCode(email);
            return text(
              `Bambu emailed a code to ${email}. Ask ${approver} for it, then call verify.`,
            );
          }
          if (!args.code) return text("Give the code from the email.", true);
          const cloud = await mwVerify(ctx.dataDir, email, String(args.code));
          return text(
            `Signed in as ${cloud.account} until ${new Date(cloud.expiresMs).toDateString()}.`,
          );
        } catch (e) {
          return text((e as Error).message, true);
        }
      },
    },
    {
      name: "makerworld_package",
      description:
        "For publishing a print on MakerWorld (Bambu's model site), only when the approver asks, in their DM: builds the upload kit (Bambu Studio project file with the print profile, cover images including real photos, title, description, tags, category, license) and puts it on their shelf. Publishing itself is done in the browser with their account; the 'printing' skill has the steps.",
      inputSchema: z.object({
        job_id: z.number().int().optional(),
        file: z
          .string()
          .optional()
          .describe("A project .3mf or sliced .gcode.3mf, if not from a job."),
        title: z.string(),
        summary: z.string().describe("One or two sentences for the listing."),
        description: z
          .string()
          .optional()
          .describe("The longer write-up: what it is, how it was designed, print tips."),
        tags: z.array(z.string()).optional(),
        category: z.string().optional(),
        license: z.string().optional().describe('Default "Standard Digital File License".'),
        photos: z
          .array(z.string())
          .optional()
          .describe("Extra photos to include (real prints sell a listing)."),
      }),
      handler: (args) => {
        if (!isApproverSession)
          return text(`Only ${approver}, in their own DM, can ask for a MakerWorld package.`, true);
        try {
          const job = args.job_id ? withStore((s) => s.job(args.job_id!)) : null;
          const file = args.file ?? job?.file;
          if (!file || !existsSync(file)) return text("Give a job or a file.", true);
          assertPathSafe(file);
          const dir = join(workDir, "makerworld", safeName(args.title));
          mkdirSync(dir, { recursive: true });
          const projectName = `${safeName(args.title)}${file.endsWith(".gcode.3mf") ? ".gcode.3mf" : extname(file)}`;
          writeFileSync(join(dir, projectName), readFileSync(file));
          const images: string[] = [];
          const png = zipEntry(file, `Metadata/plate_${printablePlate(file)?.index ?? 1}.png`);
          if (png) {
            writeFileSync(join(dir, "cover-render.png"), png);
            images.push("cover-render.png");
          }
          for (const [i, p] of [job?.finalPhoto, ...(args.photos ?? [])]
            .filter((x): x is string => !!x && existsSync(x))
            .entries()) {
            assertPathSafe(p);
            const name = `photo-${i + 1}${extname(p) || ".jpg"}`;
            writeFileSync(join(dir, name), readFileSync(p));
            images.push(name);
          }
          const side = readSidecar(file);
          const plate = printablePlate(file) ?? readSliced(file).plates[0];
          const settings = side
            ? [
                `Layer height ${side.report.layerHeight ?? "?"} mm, ${side.report.walls ?? "?"} walls, ${side.report.infill ?? "?"}% infill, ${bedLabelFor(side.bedType)}.`,
                `About ${formatMinutes((side.report.totalS || plate?.predictionS || 0) / 60)}, ${plate?.weightG.toFixed(0) ?? "?"} g.`,
                `Filament: ${(plate?.needs ?? []).map((n) => `${colorName(n.color)} ${n.type}`).join(", ")}.`,
              ]
            : [];
          const listing = [
            `# ${args.title}`,
            "",
            args.summary,
            "",
            args.description ?? "",
            "",
            "## Print settings",
            ...settings,
            "",
            `Tags: ${(args.tags ?? []).join(", ")}`,
            `Category: ${args.category ?? "(choose on upload)"}`,
            `License: ${args.license ?? "Standard Digital File License"}`,
            "",
            "## Files",
            `- ${projectName}`,
            ...images.map((i) => `- ${i}`),
          ].join("\n");
          writeFileSync(join(dir, "listing.md"), listing);
          const zip = `${dir}.zip`;
          const r = Bun.spawnSync(["/usr/bin/zip", "-qr", zip, "."], { cwd: dir });
          if (r.exitCode !== 0) return text("Could not zip the package.", true);
          let link = "";
          if (ctx.config.shelf?.origin) {
            link = shelveFile({
              dataDir: ctx.dataDir,
              sessionKey: ctx.sessionKey,
              src: zip,
              origin: ctx.config.shelf.origin,
              title: `MakerWorld kit: ${args.title}`,
            }).url;
          }
          return text(
            `Package at ${dir} (${images.length} images).${link ? `\nLink: ${link}` : ""}\nListing text is in listing.md. To publish, follow the MakerWorld section of the printing skill (upload at makerworld.com with the approver's account; it needs at least one real photo of the print).`,
          );
        } catch (e) {
          return text(`Package failed: ${(e as Error).message}`, true);
        }
      },
    },
  ];

  function reportLines(r: SliceResult): string[] {
    const lines: string[] = [];
    if (r.report.errors.length) lines.push(`SLICER ERRORS: ${r.report.errors.join(" | ")}`);
    if (r.report.warnings.length) lines.push(`SLICER WARNINGS: ${r.report.warnings.join(" | ")}`);
    else lines.push("Slicer warnings: none.");
    const times = Object.entries(r.report.featureTimes)
      .filter(([, s]) => s >= 30)
      .sort((a, b) => b[1] - a[1])
      .map(([k, s]) => `${k} ${formatMinutes(s / 60)}`);
    if (times.length) lines.push(`Time by feature: ${times.join(", ")}.`);
    if (r.report.filamentChanges) lines.push(`Filament changes: ${r.report.filamentChanges}.`);
    return lines;
  }

  function sliceResult(r: SliceResult, mode: string): ToolResult {
    const p = r.plate;
    const lines = [
      `Sliced "${basename(r.file)}" (${r.process}, ${bedLabelFor(r.bedType)}).`,
      `File: ${r.file}`,
    ];
    if (p) {
      lines.push(
        `Time: ${formatMinutes((r.report.totalS || p.predictionS) / 60)} total. Filament: ${p.weightG.toFixed(1)} g.`,
      );
      for (const n of p.needs as Need[])
        lines.push(
          `  filament ${n.index}: ${colorName(n.color)} ${n.type} ${n.color}, ${n.grams.toFixed(1)} g`,
        );
      lines.push(`Supports: ${p.supportUsed ? "yes" : "none"}.`);
    }
    lines.push(`Profiles: ${r.filamentProfiles.join(", ")}.`);
    if (Object.keys(r.settings).length) lines.push(`Your settings: ${JSON.stringify(r.settings)}.`);
    if (r.ignored.length)
      lines.push(
        `NOT APPLIED: ${r.ignored.join("; ")}. Look the key and its allowed values up with print_settings.`,
      );
    lines.push(...reportLines(r));
    const content: ToolResult["content"] = [{ type: "text", text: lines.join("\n") }];
    if (r.preview && existsSync(r.preview)) {
      content.push({ type: "text", text: "The plate as the slicer renders it:" });
      content.push(image(readFileSync(r.preview)));
    }
    if (mode === "print") {
      const gcode = zipEntry(r.file, `Metadata/plate_${p?.index ?? 1}.gcode`);
      if (gcode) {
        const t = parseGcode(gcode.toString("utf8"));
        const colors = (p?.needs ?? []).sort((a, b) => a.index - b.index).map((n) => n.color);
        const v = render(t, {
          view: "iso",
          colorBy: colors.length > 1 ? "filament" : "feature",
          filamentColors: colors,
        });
        content.push({
          type: "text",
          text: `${v.caption} ${describeToolpaths(t).slice(2).join(" ")}`,
        });
        content.push(image(v.png));
      }
    }
    if (mode === "print")
      content.push({ type: "text", text: "When it looks right: print_job create with this file." });
    return { content };
  }
}
