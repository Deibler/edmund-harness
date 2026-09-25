---
name: skycam
description: The sky camera over the house (openskycam, camera sky01, Lancaster County PA), through the `mcp__openskycam__*` tools. Use when someone asks what the sky looks like, to see the camera, for a picture of the sky at some moment, for recorded footage, for what the detection models found (planes, birds, meteors), or to build and run a detection workflow. Photos come from recorded video, one to three minutes behind live.
---

# skycam

The camera records the sky continuously. Video goes to openskycam (SkyVision:
a Pi uploads 60-second segments to Cloudflare R2), and the Mac mini runs
detection workflows over it. You reach all of it through the openskycam MCP
server: `guide`, `footage`, `workflows`, `runs`, `images`, `buckets`,
`models`. Each takes an `action`.

The tools load on first use (search for `openskycam` if they aren't listed). The
server's rules come with its instructions, and they bind: read `guide` before
acting, times are UTC, preview before any delete, verify every change by
reading it back.

## Triggers

- "what's the sky look like", "show me the camera", "anything overhead": a photo of now
- "what did the sky look like at sunset / at 3 this morning": a photo at that time
- "did the camera catch anything", "any planes / birds / meteors today": detections from runs
- "send me the video from 9pm": footage download
- "run the plane detector on last night": a workflow run
- "is the camera working": `footage`, action `cameras`

## A photo of right now

1. `footage` with action `cameras`. Take `newest_recording` for camera `sky01`.
   It is one to three minutes behind real time; say so if it matters.
   If `receiving` is false, the camera or its uploader is down. Say that
   rather than sending an old frame.
2. `footage` with action `photo`, `camera: "sky01"`, and `at` about 30 seconds
   after `newest_recording`, since the time must fall inside a recording. It
   takes about 5 seconds. If only a `photo_id` comes back, call `photo` again
   with that `photo_id`.
3. Look at the preview it returns and describe what is actually there: cloud
   cover, light, anything in frame. Report `captured_at` in Eastern time,
   not UTC.
4. To show it, download the full frame into this conversation's folder and
   send the file:
   ```bash
   curl -fsSL -o "sky-$(date +%Y%m%d-%H%M%S).jpg" "<full_size.url>"
   ```
   Then `send_attachment(file_path=<that file>, caption=<one line>)`. The file
   is 3840x2160, about 1 MB.

**Never paste a download link into a chat.** Links grant access to their file
for an hour, and the server's rule is to give them only to the user. Download
and send the file instead.

## A past moment

Use `footage` with action `days` for the month, then action `list` with
`from`/`to` around the moment. Then take a `photo` inside a listed recording,
between `start` and `start + seconds`. For a series of frames, such as a
sunset or a before and after, take several photos. For many frames at a fixed
interval, build a workflow instead.

## What the models found

- `images`, action `search`: filter by `class`, `min_confidence`, `camera`,
  `from`/`to`, `bucket_id` or `run_id`. Newest first.
- `images`, action `view`: shows up to four images at 768 px, with their
  detections drawn in.
- `images`, action `link`: full size. Download it and send the file, as above.

Say what was detected and when, and how confident the model was. Don't claim
a detection is a specific object when the class is generic.

## Workflows and runs

Follow `guide` with `build-a-workflow` and `verify-changes`. The order is
fixed: `runs` action `test` before `start`, then `watch` until the run
finishes. Each `watch` waits at most 45 seconds, so call it again. The Mac
mini runs one workflow at a time: a new run waits behind an unfinished one,
and `waiting_behind` says which. Starting a long run is the operator's call;
check before starting one someone else asked for.

## Changes and deletes

Create, update or delete workflows, buckets, models or devices only when you
were asked to, in so many words. Edits carry the revision you last read; on a
conflict, read again and reapply. A delete returns a preview first. Confirm
only what was asked for, then read it back and report what you observed.

## When it's broken

- `receiving: false`, or no recording in the last few minutes: the camera or
  its Pi uploader is down.
- Photos never finish: `runs`, action `runtimes`. The Mac mini processor
  (launchd `org.openskycam.workshop`) must have checked in recently.

Tell the person what is down. Don't describe a frame you didn't get.
