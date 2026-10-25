import { randomBytes } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import type { Config } from "../../../src/config/config.ts";
import { ChatDb } from "../../../src/imessage/db.ts";
import { isDmSession } from "../../../src/sessions/key.ts";
import { atomicWriteFileSync } from "../../../src/util/atomic-write.ts";
import { log } from "../../../src/util/log.ts";
import { registerMount, unregisterMount } from "../../../src/web/mounts.ts";
import { type PrinterConfig, isConfigured } from "../config.ts";
import { type Decision, findDecision } from "./approval.ts";
import { CameraFeed } from "./camera.ts";
import { colorName } from "./color.ts";
import { CtrlSession } from "./ctrl.ts";
import { planFilaments, trayFingerprint } from "./filament.ts";
import { type PlateLook, checkControlGate, checkStartGate } from "./gate.ts";
import { type ErrorDb, loadErrorDb, refreshErrorDb } from "./hms.ts";
import { PrinterLink } from "./link.ts";
import { type PageStatus, renderPage } from "./page.ts";
import { lookAtPlate } from "./platecheck.ts";
import { type PrinterState, isActive, isIdle } from "./report.ts";
import {
  approverName,
  approvers,
  framesDir,
  jobDir,
  pageUrl,
  runtimeInfoPath,
  visionModel,
} from "./settings.ts";
import { safeName } from "./slicer.ts";
import { type Job, PrinterStore, type Watch, printerDir } from "./store.ts";
import { bedCommandFor, bedLabelFor, slicedBedType } from "./threemf.ts";
import { allTrays, evaluateWatch, formatMinutes, statusLine } from "./watches.ts";

/**
 * The printer's side of the daemon.
 *
 * It holds the one MQTT conversation with the printer, the camera feed, and
 * the job store, and it is the only code that sends a print, a cancel or a
 * resume. Tools in a session's process reach it over a loopback API with a
 * secret; they can read anything and turn the light on, and for everything
 * that moves the printer they ask, and this side checks the whole gate again
 * before it acts. A guard checked only by the caller is not a guard.
 *
 * It also watches: for the approver's answer in chat.db, for the conditions
 * people asked to be woken for, and for the end of a print, when it takes
 * the photo and fetches the timelapse.
 */

export type FireEvent = (
  sessionKey: string,
  text: string,
  opts?: { attachImages?: string[] },
) => void;

const TRAY_SETTLE_MS = 20_000;
const LIVE_AFTER_END_MS = 10 * 60_000;
const FRAME_KEEP_MS = 24 * 3600_000;

type StartResult = { ok: true; page: string; message: string } | { ok: false; problems: string[] };
type ControlResult = { ok: boolean; message: string; problems?: string[] };

export class PrinterRuntime {
  readonly store: PrinterStore;
  readonly link: PrinterLink;
  readonly camera: CameraFeed;
  private chatDb: ChatDb;
  private errorDb: ErrorDb;
  private server: ReturnType<typeof Bun.serve> | null = null;
  private secret = randomBytes(24).toString("hex");
  private timers: Array<ReturnType<typeof setInterval>> = [];
  private printKey = "";
  private lastState: PrinterState | null = null;
  private trays = { fp: "", since: 0 };
  private evaluating = false;
  private ending = new Set<number>();

  constructor(
    private readonly config: Config,
    private readonly cfg: PrinterConfig,
    private readonly dataDir: string,
    private readonly fire: FireEvent,
  ) {
    this.store = new PrinterStore(dataDir);
    this.chatDb = new ChatDb(config.paths.chat_db);
    this.errorDb = loadErrorDb(dataDir);
    this.link = new PrinterLink({
      host: cfg.host,
      accessCode: cfg.access_code,
      serial: cfg.serial,
      persistent: true,
      onState: (st, prev) => this.onState(st, prev),
      onLog: (m) => log.info("printer", m),
    });
    this.camera = new CameraFeed({
      host: cfg.host,
      accessCode: cfg.access_code,
      fps: cfg.camera_fps,
    });
    const saved = this.readPrintKey();
    if (saved) this.printKey = saved.key;
  }

  start(): void {
    this.link.start();
    this.server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (req) => this.handle(req),
    });
    const port = this.server.port ?? 0;
    mkdirSync(printerDir(this.dataDir), { recursive: true });
    atomicWriteFileSync(
      runtimeInfoPath(this.dataDir),
      JSON.stringify({ port, secret: this.secret, pid: process.pid, startedMs: Date.now() }),
    );
    registerMount(this.dataDir, "/print/", port);
    this.timers.push(setInterval(() => void this.tick(), 5_000));
    this.timers.push(setInterval(() => this.sweepFrames(), 3600_000));
    this.timers.push(setInterval(() => void this.refreshErrors(), 24 * 3600_000));
    void this.refreshErrors();
    log.info("printer", "runtime listening", { port });
  }

  async stop(): Promise<void> {
    for (const t of this.timers) clearInterval(t);
    this.camera.stop();
    this.link.close();
    this.server?.stop(true);
    unregisterMount(this.dataDir, "/print/");
    try {
      unlinkSync(runtimeInfoPath(this.dataDir));
    } catch {}
    this.store.close();
    this.chatDb.close();
  }

  private async refreshErrors() {
    try {
      if (await refreshErrorDb(this.dataDir, this.cfg.serial))
        this.errorDb = loadErrorDb(this.dataDir);
    } catch (e) {
      log.warn("printer", "could not refresh error text", { err: (e as Error).message });
    }
  }

  /* ── state and watches ──────────────────────────────────────────────── */

  private printKeyPath() {
    return join(printerDir(this.dataDir), "current-print.json");
  }

  private readPrintKey(): { key: string; task: string } | null {
    try {
      return JSON.parse(readFileSync(this.printKeyPath(), "utf8")) as { key: string; task: string };
    } catch {
      return null;
    }
  }

  private onState(st: PrinterState, prev: PrinterState | null) {
    const before = prev ?? this.lastState;
    this.lastState = st;
    // A print's identity: its name plus when it was first seen running. Kept
    // on disk so a daemon restart mid-print does not orphan its watches.
    if (isActive(st)) {
      const continuing =
        !!before && isActive(before) && before.taskName === st.taskName && !!this.printKey;
      if (!continuing) {
        const saved = this.readPrintKey();
        // First report after a restart, mid-print: the same print as before.
        const resumed = !before && saved?.task === st.taskName;
        this.printKey = resumed && saved ? saved.key : `${st.taskName}|${Date.now()}`;
        if (!resumed)
          writeFileSync(
            this.printKeyPath(),
            JSON.stringify({ key: this.printKey, task: st.taskName }),
          );
      }
    }
    const fp = trayFingerprint(allTrays(st));
    if (fp !== this.trays.fp) this.trays = { fp, since: Date.now() };
    void this.followJob(st, before);
    this.evaluate(before, st);
  }

  private async tick() {
    const st = this.link.state;
    if (st) this.evaluate(st, st);
    this.checkApprovals();
  }

  private evaluate(prev: PrinterState | null, cur: PrinterState) {
    if (this.evaluating) return;
    this.evaluating = true;
    try {
      const active = this.store.activeWatches();
      for (const w of active) {
        if (
          !w.printKey &&
          isActive(cur) &&
          (w.kind === "progress" || w.kind === "layer" || w.kind === "finish")
        ) {
          this.store.bindPrint(w.id, this.printKey);
          w.printKey = this.printKey;
        }
        const reason = evaluateWatch(w, prev, cur, {
          printKey: isActive(cur) || (prev && isActive(prev)) ? this.printKey : "",
          traysStable: Date.now() - this.trays.since >= TRAY_SETTLE_MS,
          db: this.errorDb,
        });
        if (!reason) continue;
        if (!this.store.markFired(w.id, Date.now())) continue;
        if (w.kind === "filament")
          this.store.setBaseline(
            w.id,
            trayFingerprint(allTrays(cur), w.slot === null ? undefined : [w.slot]),
          );
        void this.wake(w, reason, cur);
      }
    } catch (e) {
      log.warn("printer", "watch evaluation failed", { err: (e as Error).message });
    } finally {
      this.evaluating = false;
    }
  }

  private async wake(w: Watch, reason: string, st: PrinterState) {
    const job = w.jobId ? this.store.job(w.jobId) : null;
    const images: string[] = [];
    if (w.kind === "finish" || w.kind === "error") {
      const shot = await this.snapshot(
        job
          ? join(
              jobDir(this.dataDir, job.id),
              w.kind === "finish" ? "final.jpg" : `error-${Date.now()}.jpg`,
            )
          : undefined,
      ).catch(() => null);
      if (shot) images.push(shot.path);
    }
    const lines = [`[Printer] ${capitalize(reason)}.`, `Now: ${statusLine(st)}.`];
    if (job) {
      lines.push(
        `This is print job ${job.id}, "${job.title}"${job.requester ? `, for ${job.requester}` : ""}.`,
      );
      const url = pageUrl(this.config, job.token);
      if (url) lines.push(`Its page: ${url}`);
    }
    if (w.note) lines.push(`Your note when you set this: ${w.note}`);
    lines.push(guidanceFor(w.kind, approverName(this.config), images.length > 0));
    this.fire(w.sessionKey, lines.join("\n"), images.length ? { attachImages: images } : undefined);
    this.store.log("watch_fired", `${w.kind} #${w.id}: ${reason}`, w.jobId);
  }

  /* ── a job's print, from start to photo ─────────────────────────────── */

  private async followJob(st: PrinterState, prev: PrinterState | null) {
    const job = this.store.activeJob();
    if (!job) return;
    if (job.status === "starting" && isActive(st)) {
      this.store.updateJob(job.id, { status: "printing" });
    }
    const ended =
      prev && isActive(prev) && (st.gcodeState === "FINISH" || st.gcodeState === "FAILED");
    if (!ended || this.ending.has(job.id)) return;
    this.ending.add(job.id);
    const cancelled =
      st.gcodeState === "FAILED" && (st.printError === 0x0300400c || st.printError === 0x0500400e);
    const status = st.gcodeState === "FINISH" ? "finished" : cancelled ? "cancelled" : "failed";
    this.store.updateJob(job.id, {
      status,
      endedMs: Date.now(),
      endNote: status === "failed" ? describeEnd(st) : "",
    });
    this.store.log("print_ended", status, job.id);
    this.store.endPrintWatches(this.printKey);
    const dir = jobDir(this.dataDir, job.id);
    mkdirSync(dir, { recursive: true });
    const shot = await this.snapshot(join(dir, "final.jpg")).catch(() => null);
    if (shot) this.store.updateJob(job.id, { finalPhoto: shot.path });
    void this.fetchTimelapse(job.id, job.startedMs ?? Date.now() - 3600_000);
  }

  /** The timelapse appears a minute or two after the print ends. */
  private async fetchTimelapse(jobId: number, startedMs: number) {
    for (let attempt = 0; attempt < 20; attempt++) {
      await Bun.sleep(30_000);
      try {
        const s = await CtrlSession.open({
          host: this.cfg.host,
          accessCode: this.cfg.access_code,
          expectCn: this.cfg.serial,
        });
        try {
          const files = await s.list("timelapse");
          const hit = files
            .filter((f) => f.time * 1000 >= startedMs - 60_000)
            .sort((a, b) => b.time - a.time)[0];
          if (!hit) continue;
          const data = await s.download(hit.path);
          const out = join(jobDir(this.dataDir, jobId), "timelapse.mp4");
          writeFileSync(out, data);
          this.store.updateJob(jobId, { timelapse: out });
          this.store.log("timelapse_saved", `${hit.name} (${data.length} bytes)`, jobId);
          return;
        } finally {
          s.close();
        }
      } catch (e) {
        log.warn("printer", "timelapse fetch failed", { err: (e as Error).message });
      }
    }
  }

  /** A frame with the chamber light on, saved to `path` (or the frames dir). */
  async snapshot(path?: string): Promise<{ path: string; ms: number; jpeg: Buffer }> {
    const st = this.link.state;
    const lightWas = st?.lights.chamber_light;
    if (this.link.connected && lightWas && lightWas !== "on") {
      await this.setLight(true).catch(() => {});
      await Bun.sleep(1500);
    }
    try {
      const f = await this.camera.frame(lightWas && lightWas !== "on" ? 0 : 3_000);
      const out = path ?? join(framesDir(this.dataDir), `${f.ms}.jpg`);
      mkdirSync(join(out, ".."), { recursive: true });
      writeFileSync(out, f.jpeg);
      return { path: out, ms: f.ms, jpeg: f.jpeg };
    } finally {
      if (this.link.connected && lightWas && lightWas !== "on")
        void this.setLight(false).catch(() => {});
    }
  }

  async setLight(on: boolean): Promise<void> {
    const r = await this.link.command("system", {
      command: "ledctrl",
      led_node: "chamber_light",
      led_mode: on ? "on" : "off",
      led_on_time: 500,
      led_off_time: 500,
      loop_times: 1,
      interval_time: 1000,
    });
    if (String(r.result).toLowerCase() !== "success")
      throw new Error(`light: ${String(r.reason || r.result)}`);
  }

  private sweepFrames() {
    const dir = framesDir(this.dataDir);
    if (!existsSync(dir)) return;
    for (const f of readdirSync(dir)) {
      const p = join(dir, f);
      if (Date.now() - statSync(p).mtimeMs > FRAME_KEEP_MS) {
        try {
          unlinkSync(p);
        } catch {}
      }
    }
  }

  /* ── approvals ──────────────────────────────────────────────────────── */

  private decisionFor(approvalId: number): Decision | null {
    const a = this.store.approval(approvalId);
    if (!a) return null;
    return findDecision(this.chatDb, a, approvers(this.config));
  }

  /** Read chat.db for answers to open asks; record them and tell the conversation that asked. */
  checkApprovals(): void {
    let pending: ReturnType<PrinterStore["pendingApprovals"]>;
    try {
      pending = this.store.pendingApprovals();
    } catch {
      return;
    }
    for (const a of pending) {
      if (Date.now() - a.askedMs > this.cfg.approval_ttl_hours * 3600_000) {
        this.store.expire(a.id);
        continue;
      }
      let d: Decision | null;
      try {
        d = findDecision(this.chatDb, a, approvers(this.config));
      } catch (e) {
        log.warn("printer", "approval check failed", { err: (e as Error).message });
        continue;
      }
      if (!d) continue;
      const status = d.verdict === "approve" ? "approved" : "declined";
      if (!this.store.decide(a.id, status, d.by, d.text, d.ms)) continue;
      const job = a.jobId ? this.store.job(a.jobId) : null;
      if (job && a.action === "start") {
        this.store.transition(
          job.id,
          ["awaiting_approval"],
          status === "approved" ? "approved" : "declined",
        );
      }
      this.store.log(`approval_${status}`, `${a.action}: "${d.text}"`, a.jobId);
      // The approver's reply already wakes a DM it was sent in; anywhere else
      // (a group, or a different person's DM) the asking conversation is told.
      const sameDm = a.chatGuid && job?.originChat === a.chatGuid && isDmSession(a.sessionKey);
      if (!sameDm) {
        const who = approverName(this.config);
        const what = job
          ? `print job ${job.id}, "${job.title}"`
          : `the ${a.action} of "${a.target}"`;
        const next =
          status !== "approved"
            ? `Tell ${job?.requester || "whoever asked"} kindly, and ask ${who} what to change if it is not clear.`
            : a.action === "start"
              ? `Next: take a printer_camera frame and look at the plate yourself, then call print_start with job_id ${job?.id} and that frame_id. print_start checks the colors and runs its own plate check.`
              : `Next: call print_control with action "${a.action}".`;
        this.fire(
          a.sessionKey,
          `[Printer] ${who} ${status === "approved" ? "said yes" : "said no"} to ${what}: "${d.text}". ${next}`,
        );
      }
    }
  }

  /* ── the gated actions ──────────────────────────────────────────────── */

  async startJob(jobId: number, session: string, frameId: number | null): Promise<StartResult> {
    const job = this.store.job(jobId);
    if (!job) return { ok: false, problems: [`No print job ${jobId}.`] };
    const approval = this.store.liveApproval(job.id, "start");
    const decision = approval ? this.decisionFor(approval.id) : null;
    const st = this.link.state;
    const trays = st ? allTrays(st) : [];
    const plan = planFilaments(job.needs, trays, job.prefer);
    const framePath = frameId ? join(framesDir(this.dataDir), `${frameId}.jpg`) : "";
    const ownLookMs = frameId && existsSync(framePath) ? frameId : null;
    const base = {
      now: Date.now(),
      callerSession: session,
      job,
      approval,
      decision,
      approvers: approvers(this.config),
      ttlMs: this.cfg.approval_ttl_hours * 3600_000,
      state: st,
      stateAgeMs: st ? Date.now() - this.link.updatedMs : Number.POSITIVE_INFINITY,
      plan,
      ownLookMs,
    };
    // Everything but the plate first; the independent look costs a model call.
    const pre = checkStartGate({
      ...base,
      plateLook: { verdict: "CLEAR", frameMs: Date.now(), note: "" },
    });
    if (!pre.ok) return { ok: false, problems: pre.problems };
    let look: PlateLook;
    try {
      const shot = await this.snapshot();
      look = await lookAtPlate(shot.path, shot.ms, visionModel(this.config));
    } catch (e) {
      look = {
        verdict: "UNSURE",
        frameMs: Date.now(),
        note: `no camera picture: ${(e as Error).message}`,
      };
    }
    this.store.log("plate_check", `${look.verdict}: ${look.note}`, job.id);
    const gate = checkStartGate({ ...base, now: Date.now(), plateLook: look });
    if (!gate.ok) return { ok: false, problems: gate.problems };

    // Win the job and spend the yes exactly once.
    if (approval && approval.status === "pending" && decision) {
      this.store.decide(approval.id, "approved", decision.by, decision.text, decision.ms);
    }
    if (!approval || !this.store.consume(approval.id)) {
      return { ok: false, problems: ["The approval was already used by another start."] };
    }
    if (!this.store.transition(job.id, ["approved", "awaiting_approval"], "starting")) {
      this.store.restore(approval.id);
      return { ok: false, problems: ["Another start of this job is already underway."] };
    }
    const giveBack = (why: string): StartResult => {
      this.store.updateJob(job.id, { status: "approved" });
      this.store.restore(approval.id);
      this.store.log("start_failed", why, job.id);
      return { ok: false, problems: [why] };
    };

    const remoteName = `${safeName(job.title)}.gcode.3mf`;
    try {
      const s = await CtrlSession.open({
        host: this.cfg.host,
        accessCode: this.cfg.access_code,
        expectCn: this.cfg.serial,
      });
      try {
        await s.upload(readFileSync(job.file), remoteName, "emmc");
      } finally {
        s.close();
      }
    } catch (e) {
      return giveBack(`Could not send the file to the printer: ${(e as Error).message}`);
    }
    const bedStudio = job.plateType || slicedBedType(job.file, job.plate);
    let reply: Record<string, unknown>;
    try {
      reply = await this.link.command(
        "print",
        {
          command: "project_file",
          param: `Metadata/plate_${job.plate}.gcode`,
          project_id: "0",
          profile_id: "0",
          task_id: "0",
          subtask_id: "0",
          subtask_name: job.title,
          file: remoteName,
          url: `brtc://emmc/${remoteName}`,
          md5: "from_sd_card",
          bed_type: bedCommandFor(bedStudio),
          bed_leveling: true,
          auto_bed_leveling: 2,
          flow_cali: true,
          extrude_cali_flag: 2,
          vibration_cali: true,
          nozzle_offset_cali: 2,
          layer_inspect: true,
          timelapse: this.cfg.timelapse,
          cfg: this.cfg.timelapse ? "4" : "0",
          use_ams: true,
          ams_mapping: plan.amsMapping,
          ams_mapping2: plan.amsMapping2,
        },
        { timeoutMs: 20_000 },
      );
    } catch (e) {
      return giveBack(`The printer did not take the print command: ${(e as Error).message}`);
    }
    const result = String(reply.result ?? "").toLowerCase();
    if (result && result !== "success") {
      return giveBack(
        `The printer refused the print (${String(reply.reason || reply.err_code || result)}).`,
      );
    }
    let started: PrinterState;
    try {
      started = await this.link.waitFor((s) => isActive(s) && s.taskName === job.title, 90_000);
    } catch {
      // The command was accepted; whether it is running is for the system of record to say.
      const now = this.link.state;
      return giveBack(
        `The printer accepted the command but has not started "${job.title}" after 90 seconds (it is ${now?.stateLabel ?? "not reporting"}). Look at the printer before trying again.`,
      );
    }
    // onState saw the print begin and named it before waitFor returned.
    this.store.updateJob(job.id, { status: "printing", startedMs: Date.now(), remoteName });
    this.store.log("print_started", `${remoteName} on ${bedLabelFor(bedStudio)}`, job.id);
    const watches = this.autoWatches(job, session);
    const url = pageUrl(this.config, job.token);
    return {
      ok: true,
      page: url,
      message: [
        `Printing "${job.title}" now (${statusLine(started)}).`,
        `Filament: ${plan.assignments.map((a) => `${colorName(a.need.color)} ${a.need.type} from ${a.tray.label}`).join(", ")}.`,
        url
          ? `Live page for ${job.requester || "the person who asked"}: ${url}`
          : "No page origin is configured, so there is no live page link.",
        `Wake-ups set: ${watches}.`,
      ].join("\n"),
    };
  }

  /** Progress, finish, error and pause wake-ups for the conversation that asked, on every print Edmund starts. */
  private autoWatches(job: Job, session: string): string {
    const set: string[] = [];
    const long = job.estimateS >= 20 * 60;
    if (long) {
      for (const p of this.cfg.auto_progress) {
        this.store.addWatch({
          sessionKey: session,
          kind: "progress",
          threshold: p,
          jobId: job.id,
          printKey: this.printKey,
          auto: true,
        });
      }
      set.push(`progress at ${this.cfg.auto_progress.join("%, ")}%`);
    }
    this.store.addWatch({
      sessionKey: session,
      kind: "finish",
      jobId: job.id,
      printKey: this.printKey,
      auto: true,
    });
    this.store.addWatch({
      sessionKey: session,
      kind: "error",
      jobId: job.id,
      printKey: this.printKey,
      repeat: true,
      auto: true,
    });
    this.store.addWatch({
      sessionKey: session,
      kind: "state",
      jobId: job.id,
      printKey: this.printKey,
      repeat: true,
      auto: true,
    });
    set.push("finish (with a photo)", "any error", "pauses");
    return set.join(", ");
  }

  async control(
    action: "cancel" | "resume",
    session: string,
    jobId: number | null,
  ): Promise<ControlResult> {
    const st = this.link.state;
    const approval = this.store.liveApproval(jobId, action);
    const decision = approval ? this.decisionFor(approval.id) : null;
    const gate = checkControlGate({
      now: Date.now(),
      callerSession: session,
      approval,
      decision,
      approvers: approvers(this.config),
      ttlMs: this.cfg.approval_ttl_hours * 3600_000,
      action,
    });
    const problems = [...gate.problems];
    if (!st) problems.push("No status from the printer.");
    else if (action === "cancel" && !isActive(st))
      problems.push(`Nothing to cancel: the printer is ${st.stateLabel}.`);
    else if (action === "resume" && st.gcodeState !== "PAUSE")
      problems.push(`Nothing to resume: the printer is ${st.stateLabel}.`);
    if (st?.developerMode === false) {
      problems.push(
        "The printer is not in Developer Mode, so it will not take this command from Edmund.",
      );
    }
    if (approval?.target && st && approval.target !== st.taskName) {
      problems.push(
        `The yes was for "${approval.target}", but the printer is running "${st.taskName}".`,
      );
    }
    if (problems.length) return { ok: false, message: "Not done.", problems };
    if (approval && approval.status === "pending" && decision) {
      this.store.decide(approval.id, "approved", decision.by, decision.text, decision.ms);
    }
    if (!approval || !this.store.consume(approval.id))
      return { ok: false, message: "The approval was already used." };
    try {
      const r = await this.link.command(
        "print",
        { command: action === "cancel" ? "stop" : "resume", param: "" },
        { qos1: true },
      );
      if (String(r.result ?? "success").toLowerCase() !== "success") {
        this.store.restore(approval.id);
        return {
          ok: false,
          message: `The printer refused: ${String(r.reason || r.err_code || r.result)}`,
        };
      }
    } catch (e) {
      this.store.restore(approval.id);
      return { ok: false, message: (e as Error).message };
    }
    const want =
      action === "cancel"
        ? (s: PrinterState) => isIdle(s)
        : (s: PrinterState) => s.gcodeState === "RUNNING";
    const after = await this.link.waitFor(want, 60_000).catch(() => this.link.state);
    this.store.log(`print_${action}`, `approved by "${decision?.text}"`, jobId);
    return {
      ok: !!after && want(after),
      message:
        after && want(after)
          ? `Done: the printer is ${after.stateLabel}.`
          : `Sent, but the printer still says ${after?.stateLabel ?? "nothing"}.`,
    };
  }

  /* ── HTTP: the private API and the public page ──────────────────────── */

  private async handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/print/")) return this.servePage(req, url);
    if (req.headers.get("authorization") !== `Bearer ${this.secret}`)
      return new Response("forbidden", { status: 403 });
    try {
      if (url.pathname === "/api/state") {
        return Response.json({
          connected: this.link.connected,
          lastError: this.link.lastError,
          updatedMs: this.link.updatedMs,
          state: this.link.state,
          printKey: this.printKey,
          modules: this.link.modules,
        });
      }
      if (url.pathname === "/api/frame") {
        const shot = await this.snapshot();
        return new Response(new Uint8Array(shot.jpeg), {
          headers: {
            "Content-Type": "image/jpeg",
            "X-Frame-Id": String(shot.ms),
            "X-Frame-Path": shot.path,
          },
        });
      }
      const body = req.method === "POST" ? ((await req.json()) as Record<string, unknown>) : {};
      if (url.pathname === "/api/light") {
        await this.setLight(body.on === true);
        return Response.json({ ok: true });
      }
      if (url.pathname === "/api/start") {
        return Response.json(
          await this.startJob(
            Number(body.jobId),
            String(body.session ?? ""),
            body.frameId ? Number(body.frameId) : null,
          ),
        );
      }
      if (url.pathname === "/api/control") {
        const action =
          body.action === "resume" ? "resume" : body.action === "cancel" ? "cancel" : null;
        if (!action)
          return Response.json({
            ok: false,
            message: "Only cancel and resume exist. Edmund does not pause prints.",
          });
        return Response.json(
          await this.control(
            action,
            String(body.session ?? ""),
            body.jobId ? Number(body.jobId) : null,
          ),
        );
      }
      if (url.pathname === "/api/check-approvals") {
        this.checkApprovals();
        return Response.json({ ok: true });
      }
      return new Response("not found", { status: 404 });
    } catch (e) {
      return Response.json({ ok: false, error: (e as Error).message }, { status: 500 });
    }
  }

  pageStatus(job: Job): PageStatus {
    const st = this.link.state;
    const current =
      st && (job.status === "printing" || job.status === "starting") && st.taskName === job.title
        ? st
        : null;
    const phase: PageStatus["phase"] =
      job.status === "finished"
        ? "finished"
        : job.status === "failed"
          ? "failed"
          : job.status === "cancelled"
            ? "cancelled"
            : current?.gcodeState === "PAUSE"
              ? "paused"
              : current?.gcodeState === "RUNNING"
                ? "printing"
                : current
                  ? "preparing"
                  : "waiting";
    const labels: Record<PageStatus["phase"], string> = {
      waiting: "Waiting to start",
      preparing: "Getting ready",
      printing: "Printing",
      paused: "Paused",
      finished: "Finished",
      failed: "Stopped",
      cancelled: "Cancelled",
    };
    const ended = job.endedMs ?? 0;
    const live =
      !!current ||
      (ended > 0 &&
        Date.now() - ended < LIVE_AFTER_END_MS &&
        st?.liveview === true &&
        phase !== "finished");
    return {
      title: job.title,
      requester: job.requester,
      printer: this.cfg.name,
      phase,
      phaseLabel: labels[phase],
      stage: current?.stageLabel && current.stageLabel !== "printing" ? current.stageLabel : "",
      percent: current?.percent ?? (phase === "finished" ? 100 : null),
      layer: current?.layer ?? null,
      totalLayers: current?.totalLayers ?? null,
      remainingMin: current?.remainingMin ?? null,
      etaMs: current?.remainingMin != null ? Date.now() + current.remainingMin * 60_000 : null,
      startedMs: job.startedMs,
      endedMs: job.endedMs,
      nozzle: { temp: current?.nozzle.temp ?? null, target: current?.nozzle.target ?? null },
      bed: { temp: current?.bed.temp ?? null, target: current?.bed.target ?? null },
      speed: current?.speedName ?? "",
      filaments: job.needs.map((n) => ({
        color: n.color,
        name: capitalize(colorName(n.color)),
        type: n.type,
        grams: n.grams,
      })),
      estimateS: job.estimateS,
      live: live && (st?.liveview ?? false),
      hasPreview: !!job.preview && existsSync(job.preview),
      hasFinalPhoto: !!job.finalPhoto && existsSync(job.finalPhoto),
      hasTimelapse: !!job.timelapse && existsSync(job.timelapse),
      updatedMs: this.link.updatedMs,
    };
  }

  private async servePage(req: Request, url: URL): Promise<Response> {
    const m = url.pathname.match(/^\/print\/([a-f0-9]{32})(\/(.*))?$/);
    if (!m) return new Response("Not found", { status: 404 });
    const job = this.store.jobByToken(m[1]!);
    if (!job || ["draft", "declined"].includes(job.status))
      return new Response("Not found", { status: 404 });
    if (m[2] === undefined) return Response.redirect(`${url.pathname}/`, 301);
    const name = m[3] ?? "";
    const headers = { "Cache-Control": "no-store", "X-Robots-Tag": "noindex" };
    const status = this.pageStatus(job);
    if (name === "")
      return new Response(renderPage(status), {
        headers: { ...headers, "Content-Type": "text/html; charset=utf-8" },
      });
    if (name === "status.json") return Response.json(status, { headers });
    if (name === "frame.jpg") {
      if (!status.live) return new Response("Not live", { status: 404, headers });
      try {
        const f = await this.camera.frame(2_500, 12_000);
        return new Response(new Uint8Array(f.jpeg), {
          headers: { ...headers, "Content-Type": "image/jpeg" },
        });
      } catch {
        return new Response("No picture", { status: 503, headers });
      }
    }
    const files: Record<string, [string, string]> = {
      "plate.png": [job.preview, "image/png"],
      "final.jpg": [job.finalPhoto, "image/jpeg"],
      "timelapse.mp4": [job.timelapse, "video/mp4"],
    };
    const f = files[name];
    if (!f || !f[0] || !existsSync(f[0]))
      return new Response("Not found", { status: 404, headers });
    return serveFile(req, f[0], f[1]);
  }
}

/** Byte ranges matter: iPhone Safari will not play a video from a server that ignores them. */
function serveFile(req: Request, path: string, type: string): Response {
  const file = Bun.file(path);
  const size = file.size;
  const headers: Record<string, string> = {
    "Content-Type": type,
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, max-age=60",
    "X-Robots-Tag": "noindex",
  };
  const range = req.headers.get("range")?.match(/^bytes=(\d*)-(\d*)$/);
  if (range && (range[1] || range[2])) {
    const start = Math.max(0, range[1] ? Number(range[1]) : size - Number(range[2]));
    const end = Math.min(size - 1, range[1] && range[2] ? Number(range[2]) : size - 1);
    if (start > end)
      return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
    return new Response(file.slice(start, end + 1), {
      status: 206,
      headers: {
        ...headers,
        "Content-Range": `bytes ${start}-${end}/${size}`,
        "Content-Length": String(end - start + 1),
      },
    });
  }
  return new Response(file, { headers: { ...headers, "Content-Length": String(size) } });
}

function capitalize(s: string): string {
  return s ? s[0]!.toUpperCase() + s.slice(1) : s;
}

function describeEnd(st: PrinterState): string {
  return st.printError
    ? `print error ${st.printError.toString(16).toUpperCase().padStart(8, "0")}`
    : "";
}

/** What Edmund should do with each kind of wake-up. */
export function guidanceFor(kind: Watch["kind"], approver: string, hasPhoto: boolean): string {
  switch (kind) {
    case "finish":
      return `Tell the person it is done${hasPhoto ? " and send them the photo (it is attached)" : ""}; the timelapse lands on the print page in a few minutes, and printer_timelapse can fetch it. Ask ${approver} to take it off the plate when they can.`;
    case "progress":
      return "Send a short progress note only if it is useful to them (a long print, or they asked); otherwise stay quiet.";
    case "layer":
      return "Do what you meant to do at this layer.";
    case "error":
      return `Look at the photo, read the error with printer_status, and if it needs hands at the printer tell ${approver}. Do not cancel or resume without their yes.`;
    case "state":
      return `If it paused on its own (filament out, an error), find out why with printer_status and tell ${approver}; Edmund never pauses a print, and resumes only with their yes.`;
    case "filament":
      return "Check whether the new filament is what the job needs (print_job plan), then carry on: if it is right, ask for the go-ahead to print.";
  }
  return "";
}

/** The integration's runtime factory, for index.ts. */
export function startRuntime(
  config: Config,
  cfg: PrinterConfig,
  dataDir: string,
  fire: FireEvent,
): PrinterRuntime | null {
  if (!isConfigured(cfg)) return null;
  const rt = new PrinterRuntime(config, cfg, dataDir, fire);
  rt.start();
  return rt;
}

export function copyIntoJobDir(dataDir: string, jobId: number, src: string, name?: string): string {
  if (!src || !existsSync(src)) return "";
  const dir = jobDir(dataDir, jobId);
  mkdirSync(dir, { recursive: true });
  const dest = join(dir, name ?? basename(src));
  copyFileSync(src, dest);
  return dest;
}

export { formatMinutes };
