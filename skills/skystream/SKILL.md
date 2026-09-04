---
name: skystream
description: Talk to the SkyStream sky-object-detection app (Lancaster County, PA) — everything beyond a quick snapshot. Use to answer "what's flown over today / lately", look up a past sighting, pull a detection clip or object cutout into the chat, generate a PDF report, read the analytics & forecasts (detections/hour, what shows up when, the trained identity model), check the live model/cloud/routing status, watch the sky for new detections over a window, or fix a wrong label from chat. For just a fresh still of the sky right now, use `skycam` instead.
---

# skystream

The SkyStream app is always running on `:8080`: a Dahua 4K turret → a YOLO/motion/diff
worker that tracks planes, wildlife, meteors and "UAP" anomalies, writes a clip + cutout +
keyframe for every event, runs CLIP zero-shot + a trained identity model, and serves it all
over HTTP. This skill is the chat-side remote control for it.

One script does everything. **Run it with no args once to see the full command list:**

```bash
bash skills/skystream/scripts/sky.sh
```

It auto-finds the API host, parses JSON, and downloads media into the conversation sandbox.
**Query commands print readable text** you fold straight into a reply; **media commands print
an absolute file path** ready for `send_attachment`. Add `--json` to any command for raw JSON.

## Triggers

- "what's flown over today / lately / overnight?" · "any planes/birds/meteors?" → `recent`, `sightings`
- "anything weird / any UFOs?" → `sightings --min-uap 50`
- "show me that hawk / the last detection / send the clip" → `show <id>`, then `clip` / `cutout`,
  then **offer a report**
- "make a report on that one" / "yeah send the report" → `report <id>` (PDF)
- "how busy is it / what's the busiest hour / how many per day?" → `stats`, `forecast`
- "what model is running / is it clear / day or night?" → `status`, `sun`, `route`
- "watch for the next 5 minutes and tell me what flies over" → `watch 300`
- "that's not an insect, it's a bird" → `label <id> bird` (teaches the model)

## Common flows

**What's been up there.** Lead with `status` (one-line situational picture), then `recent` or a
filtered `sightings`. Relay the table in your own words — don't paste raw IDs unless they ask.

```bash
bash skills/skystream/scripts/sky.sh status
bash skills/skystream/scripts/sky.sh recent 10
bash skills/skystream/scripts/sky.sh sightings --class 2 --min-uap 30   # interesting wildlife
```

Class IDs: **1 Plane · 2 WildLife · 3 Meteorite · 4 Motion**.

**Look at / send a specific sighting.** `show` prints the full record *and* downloads the cutout
+ keyframe so you can actually look before describing. Then attach what helps.

```bash
ID=20260602-152840-12
bash skills/skystream/scripts/sky.sh show $ID      # -> prints paths to cutout & keyframe
# view those images, describe the object, then if they want to see it:
CUT=$(bash skills/skystream/scripts/sky.sh cutout $ID)
# send_attachment(file_path=$CUT, caption="That's a red-tailed hawk — uap 56, 8 tracks over 35s.")
```

Close your read with the report offer (see "Review, then offer a report" below) when it's a
sighting worth one.

**Send a video clip.** Plain clips are full 4K and huge (100 MB+) — **for chat always export a
downsized copy.** `--boxes` burns on the bounding box + path.

```bash
CLIP=$(bash skills/skystream/scripts/sky.sh clip $ID --boxes --quality medium)  # ~10 MB
# send_attachment(file_path=$CLIP, caption="...")
```

**Review, then offer a report.** This is the default arc whenever you've actually *looked* at a
sighting. After you `show` one and describe it, **offer the full report** — don't generate it
unprompted (it's a multi-page PDF and takes ~10–30s), just ask:

1. `show $ID` → view the cutout/keyframe, give your read in a sentence or two.
2. End that reply with the offer, e.g. *"Want the full report? It's got the path, speed, sky
   position vs. known aircraft, and weather."*
3. **Only if they say yes**, generate and send it (next block).

Lean toward making the offer for anything *worth* a report — a high-uap anomaly, a clean wildlife
catch, a multi-object event, or anything they're clearly interested in. Skip the offer for noise /
empty-sky junk; for those, say it's not worth a report. One offer is enough — don't re-ask every turn.

**PDF report.** Generates the full multi-page report (imagery, kinematics, sky position vs
known aircraft/satellites, weather, classification) and downloads it. Run this **after** they
confirm.

```bash
PDF=$(bash skills/skystream/scripts/sky.sh report $ID | tail -1)
# send_attachment(file_path=$PDF, caption="Full report on that sighting.")
```

**Numbers / forecasts.** `stats` is the descriptive picture; `forecast` is the trained models
(detections-per-hour regression + the identity classifier's accuracy and top features).

```bash
bash skills/skystream/scripts/sky.sh stats
bash skills/skystream/scripts/sky.sh forecast
```

**Watch live.** Blocks for the window and prints each NEW detection as it lands (polls every 5s,
default 120s, max 1800). Good for "keep an eye out for a bit." Pick a bounded window; don't loop
forever.

```bash
bash skills/skystream/scripts/sky.sh watch 300
```

**Fix a label from chat (closes the loop into training).** Corrections are stored as
`corrected_label`, override the auto-label, and are weighted heavily on the next retrain — so
correcting from iMessage genuinely improves detection. Also `keep` / `discard` / `bookmark`.

```bash
bash skills/skystream/scripts/sky.sh label $ID bird     # vocabulary: run `labels` to see it
bash skills/skystream/scripts/sky.sh bookmark $ID
```

## Notes

- IDs are timestamps (`YYYYMMDD-HHMMSS-seq`) and sort chronologically — newest first in lists.
- `status` is cheap and orienting; open with it when the ask is vague ("what's going on up there").
- The best human label for a sighting is corrected → model-predicted → CLIP → class; the script
  already collapses that for you in `recent`/`sightings`/`show`.
- This and `skycam` share the same camera/app. `skycam` = one live still *right now*; `skystream`
  = the detections, history, media, data, and live status. Reach for whichever the ask wants.

## Anti-patterns

- Sending a plain `clip <id>` to chat — it's full 4K, often >100 MB. Use `clip … --quality medium`
  (or `low`) for anything you attach.
- Pasting raw JSON / ID tables into the reply. Summarize. Lead with the answer, offer the media.
- Hardcoding curl / the host / IPs — `sky.sh` does host discovery and has the right paths. If it
  prints "API not reachable", the app is down: say so (and `skycam`'s direct-RTSP snapshot may
  still work as a fallback look).
- `watch` with no bound, or polling `recent` in a tight loop to fake live — use `watch <secs>`.
- Describing a sighting's object without viewing the cutout `show` downloaded for you first.
- Generating a report unprompted, or re-asking about it every turn. Review → offer once → make it
  only on a yes. Equally, don't bury a genuinely interesting sighting without offering one.
- Correcting a label to something outside the vocabulary without checking `labels` (a new word is
  allowed, but check first so you're not fragmenting "hawk" vs "bird").
