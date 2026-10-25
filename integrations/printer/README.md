# printer

Edmund's hands and eyes on a Bambu Lab printer (built and verified against a
P2S with an AMS 2 Pro, firmware 01.03). Every conversation can read the
printer, slice and preview, find models on MakerWorld, and ask for a print.
A print starts only after the approver says yes in Messages.

## What it does

- **See everything**: state, progress, time left, temperatures, every AMS
  slot (material, color, RFID, remaining), humidity, errors in Bambu's own
  words (2,000+ HMS and device codes, refreshed weekly from Bambu), the
  camera, timelapses, the model files on the printer.
- **Wake-ups**: at a percent or layer, at the end (with a photo), on a pause
  or state change, on a new error, or when the AMS filament changes. Every
  print Edmund starts gets progress, finish, error and pause wake-ups for the
  conversation that asked.
- **Slice with Bambu Studio's engine**, headless, with any setting, for one
  model, a multi-part multi-color assembly, or a MakerWorld project; scale,
  rotate, recolor, pick a plate. Every slicer warning and error (overhangs
  that need support, floating parts, collisions) comes back in the app's
  words, and every requested setting is checked against the G-code's own
  config block, so nothing is silently ignored.
- **Preview** the toolpaths from any side, by feature or filament, one layer
  at a time, with seams in red, supports or overhangs picked out, plus an
  analysis (layers, seams aligned or scattered, supports, bridges, filament
  changes, time by feature). A small software renderer draws them, so it
  works with the screen locked.
- **Jobs and approval**: a sliced file becomes a job; the requester's design
  OK is recorded; the filament plan says which slot each color comes from
  and exactly what to load or swap; the ask goes to the approver (in the
  group if they are in it, else their DM); their reply is read from chat.db.
- **A live page per print** at `<shelf origin>/print/<token>/`: camera,
  progress, time left, temperatures, filament, and at the end the photo and
  the timelapse.
- **MakerWorld**: search, read a model's profiles and license, fetch photos
  to send, download a project to print or alter, and package a print for
  publishing.

## Setup

1. `config.toml`:

   ```toml
   [printer]
   enabled = true
   host = "<printer IP>"
   access_code = "<8 characters from the printer's network screen>"
   serial = "<printer serial>"
   name = "the P2S"
   plate = "textured_pei"
   ```

   The serial is also the CN of the printer's TLS certificate, which every
   connection pins. Approvers default to `[security] operator_handles`.
2. `brew install --cask bambu-studio` (slicing) and `brew install ffmpeg`
   (camera).
3. On the printer's screen, network settings:
   - **LAN Only Liveview** on, for the camera and the live page's video.
   - **LAN Only Mode**, then **Developer Mode**, for Edmund to start, cancel
     or resume prints. Bambu's firmware rejects unsigned print commands
     otherwise; Developer Mode is Bambu's supported way to allow local
     control. LAN Only Mode turns off Bambu Handy and cloud printing. Without
     it Edmund still reads, slices, previews, plans and asks; the approver
     starts the print from the printer or Bambu Studio.
4. MakerWorld downloads: in the approver's DM, Edmund runs `makerworld_login`
   (Bambu emails a one-time code; no password is stored). The token is kept
   owner-readable in `data/printer/bambu-cloud.json` and lasts about a year.
5. `edmund restart` starts the runtime and restarts the kitchen host, which
   publishes `/print/` pages through its named tunnel.

## Safety model

- **One path moves the printer.** Only the daemon's runtime
  (`src/runtime.ts`) sends a print, cancel or resume. Session tools ask it
  over a loopback API with a per-boot secret, and it re-checks everything
  itself. A structural test fails if any other file sends a print command.
- **The start gate** (`src/gate.ts`, every condition break-tested):
  the conversation calling is the one that asked; an ask exists for this job;
  an approver's plain yes (or like on the ask) appears in chat.db after the
  ask and within `approval_ttl_hours`; the printer is idle, fresh, in
  Developer Mode, with no serious errors; every filament is loaded where the
  approved plan put it (a re-slice or a new color voids the yes); Edmund took
  a camera frame after the yes; and an independent model, told nothing about
  the job, looked at a fresh frame and said the plate is CLEAR.
- **Cancel and resume** each need their own fresh yes. **Pause does not
  exist**: no tool offers it, the API refuses it, and the MQTT link throws on
  it.
- A yes is spent once (a failed start gives it back), and two starts of the
  same job cannot both win.

## How it fits together

```
session tools (tools.ts) ── loopback API + secret ──> daemon runtime (src/runtime.ts)
   read-only fallback: direct MQTT / port 6000             │ one MQTT link (8883, TLS, CN pinned)
                                                           │ camera (RTSPS 322 via ffmpeg, on demand)
                                                           │ file service (port 6000: uploads, timelapses)
                                                           │ chat.db (approvals), printer.db (jobs, watches)
                                                           └ /print/<token>/ page, mounted on the kitchen host
```

Protocol notes, verified on this printer 2026-10-25: status and `system`
commands (the chamber light) work in any mode; the P2S serves its file list,
downloads and uploads on TLS port 6000 (not FTPS, which follows a USB stick);
the camera is RTSPS on 322, not the P1's JPEG stream; `print.fun` bit 29 set
means Developer Mode is off. Starting a print uploads the `.gcode.3mf` into
the model cache over port 6000 and sends `project_file` with
`brtc://emmc/<name>`, the same as Bambu Studio's LAN print.

## Data

- `data/printer/printer.db`: jobs, approvals, watches, events.
- `data/printer/jobs/<id>/`: plate render, final photo, timelapse.
- `data/printer/frames/`: camera frames (kept a day).
- `data/printer/hms-en.json`: Bambu's error text, refreshed weekly
  (falls back to `data/hms-en.json` here).
- `data/printer/runtime.json`: the runtime's loopback port and secret.
- `data/web-mounts.json`: `/print/` -> the runtime's port, for the kitchen host.

## Tests

`bun test ./integrations/printer/test`: protocol framing, state parsing,
error decoding, color and filament planning, approvals against a temporary
chat.db, every start-gate condition, watches, G-code analysis and rendering,
slicer log and config parsing, the page, the store's races, structural
guards, and the runtime's HTTP surface.
