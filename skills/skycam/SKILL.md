---
name: skycam
description: Snapshot and review the SkyStream live sky camera (Lancaster County, PA). Use when someone asks what the sky/weather looks like right now, to "show me the camera", check for planes/birds/anything overhead, or confirm the camera is up. Grabs a fresh still, lets you describe what's visible, and can send it into the chat. Not for historical sightings, recorded clips, detections, reports, or stats — that's the `skystream` skill.
---

# skycam

One fresh frame off the live sky camera, then look at it and (optionally) send it.

## Triggers

- "what's the sky look like" / "how's the weather out" (a real look, not a forecast — that's `weather`)
- "show me the camera" / "snapshot the sky cam" / "what's overhead right now"
- "anything in the sky?" / "any planes / birds / UFOs right now?"
- "is the camera working / online?"

## Flow

1. Capture a frame:
   ```bash
   SHOT=$(bash skills/skycam/scripts/snap.sh)
   ```
   `$SHOT` is the absolute path to a JPEG in the conversation sandbox. The script self-heals
   across capture methods (app API → camsnap → direct RTSP), so just run it.
2. **Review it** — view `$SHOT` and describe what's actually visible: time of day, cloud/clear,
   anything notable in frame (aircraft, birds, contrails, the moon). Be specific and brief.
3. If they wanted to *see* it (not just hear about it), send it:
   ```
   send_attachment(file_path=$SHOT, caption="<one-line what's up there>")
   ```
   Your final text reply is auto-sent, so a short caption + a sentence of description is plenty.

## Example

```bash
SHOT=$(bash skills/skycam/scripts/snap.sh)
# -> <repo>/sandbox/<conversation>/skycam-20260531-2312.jpg
```
Then look at the image and reply, e.g. "Clear night, no traffic overhead right now — just a few
stars." Attach it if they asked to see it.

## Notes

- The camera host comes from `$SKYCAM_CAMERA_HOST` and the SkyStream app from `$SKYSTREAM_API_HOSTS`
  (space-separated, first reachable wins; defaults to `http://127.0.0.1:8080`). The app is the primary
  source and always points at the current camera, so prefer letting the script handle it.
- For "is anything flying right now", the live answer is in the SkyStream app's tracked-objects
  feed, but a snapshot is the quick visual confirmation.
- If the ask drifts to *what's been detected*, a *clip/report*, *stats*, or the *live model/cloud
  status* — that's the `skystream` skill (`bash skills/skystream/scripts/sky.sh`), not a snapshot.

## Anti-patterns

- Using this for the *forecast* — that's the `weather` skill. This is a literal look at the sky.
- Hardcoding or guessing the camera IP / building your own ffmpeg line — run `snap.sh`; it has the
  fallbacks and the right URL.
- Sending the snapshot without looking at it first. Review, then decide whether a still even helps
  (a pitch-black night frame isn't worth sending — say so instead).
- Capturing a burst of frames. One still answers "what's up there"; only loop if explicitly asked
  to watch for motion.
