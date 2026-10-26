/**
 * `[printer]` configuration for the printer integration.
 *
 * The schema lives with the package; core keeps the raw table opaque. The
 * access code is a LAN password, so it belongs in the gitignored config.toml
 * only, never in config.example.toml.
 */

import { z } from "zod";
import { defineSection } from "../../src/integrations/section.ts";

export const PLATES = [
  "textured_pei",
  "smooth_pei",
  "cool_plate",
  "engineering_plate",
  "supertack",
] as const;
export type Plate = (typeof PLATES)[number];

export const Schema = z
  .object({
    /** Master switch. False = no tools and no runtime. */
    enabled: z.boolean().default(false),
    /** The printer's LAN address. */
    host: z.string().default(""),
    /** LAN access code from the printer's network screen. */
    access_code: z.string().default(""),
    /** Serial number: the MQTT topic and the TLS certificate CN that is pinned. */
    serial: z.string().default(""),
    /** What people call it ("the P2S"). Used in messages and on the print page. */
    name: z.string().default("the printer"),
    /**
     * Handles whose yes starts or cancels a print. Empty falls back to the
     * operator handles in [security] / [alerts].
     */
    approvers: z.array(z.string()).default([]),
    /** How the approver is addressed in asks ("Alex"). Empty uses [owner].name's first word. */
    approver_name: z.string().default(""),
    /** The plate normally on the bed; slicing and the print command use it unless a job says otherwise. */
    plate: z.enum(PLATES).default("textured_pei"),
    /** Record a timelapse of every print Edmund starts. */
    timelapse: z.boolean().default(true),
    /** Bambu Studio's executable, for slicing. */
    slicer_path: z.string().default("/Applications/BambuStudio.app/Contents/MacOS/BambuStudio"),
    /** Base for the print page link. Empty uses [shelf].origin. */
    page_origin: z.string().default(""),
    /** Model for the independent empty-plate check. Empty uses [claude].agent_model, then [claude].model. */
    vision_model: z.string().default(""),
    /** A yes older than this no longer starts a print; ask again. */
    approval_ttl_hours: z.number().positive().default(12),
    /** Progress wake-ups set automatically on every print Edmund starts, in percent. */
    auto_progress: z.array(z.number().int().min(1).max(99)).default([25, 50, 75]),
    /** Camera frames per second while someone is watching. */
    camera_fps: z.number().positive().max(5).default(1),
    /**
     * How starts reach the printer. "lan" needs Developer Mode (LAN Only Mode,
     * no Bambu Handy); "bambu_connect" sends through Bambu's desktop app, signed
     * in to the Bambu account, so the printer stays in cloud mode; "auto" uses
     * the LAN when Developer Mode is on and Bambu Connect otherwise.
     */
    send_via: z.enum(["auto", "lan", "bambu_connect"]).default("auto"),
    /** Where Bambu Connect is installed. */
    bambu_connect_app: z.string().default("/Applications/Bambu Connect.app"),
  })
  .default({});

export type PrinterConfig = z.infer<typeof Schema>;

export const printerConfig = defineSection("printer", Schema);

/** True when the section names a printer the integration can talk to. */
export function isConfigured(cfg: PrinterConfig): boolean {
  return cfg.enabled && !!cfg.host && !!cfg.access_code && !!cfg.serial;
}
