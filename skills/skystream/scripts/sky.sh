#!/usr/bin/env bash
# sky.sh — one CLI over the whole SkyStream backend (FastAPI on :8080).
#
# SkyStream is the sky-object-detection app: a Dahua 4K turret -> MediaMTX ->
# a YOLO/motion/diff worker that tracks planes, wildlife, meteors and "UAP"
# anomalies, writes clips/cutouts/streaks, runs CLIP zero-shot + a trained
# identity model, and serves it all over HTTP. This wraps that API into clean
# subcommands so the assistant can answer "what's been flying over", pull a
# clip into the chat, generate a PDF report, read the analytics, fix a label,
# or watch the sky live — without hand-rolling curl every time.
#
# Host discovery, JSON parsing (jq), and media download into the conversation
# sandbox are all handled here. Media commands print an absolute file path on
# stdout (ready for send_attachment); query commands print readable text.
#
# Usage: bash sky.sh <command> [args]   — run with no args for the command list.
set -uo pipefail

# Space-separated host list from the environment; first reachable wins.
# Override with SKYSTREAM_API_HOSTS="http://127.0.0.1:8080 http://10.0.0.5:8080".
read -r -a API_HOSTS <<< "${SKYSTREAM_API_HOSTS:-http://127.0.0.1:8080}"
SANDBOX="${EDMUND_SANDBOX_PATH:-/tmp}"
TIMEOUT=12

# ---- host discovery (first reachable wins; cached for the process) ----
BASE=""
_base() {
  [ -n "$BASE" ] && { echo "$BASE"; return 0; }
  for h in "${API_HOSTS[@]}"; do
    if curl -fs --max-time 4 -o /dev/null "$h/api/model" 2>/dev/null; then
      BASE="$h"; echo "$BASE"; return 0
    fi
  done
  echo "ERROR: SkyStream API not reachable on ${API_HOSTS[*]} (is the app running on :8080?)" >&2
  return 1
}

_get()  { local b; b=$(_base) || return 1; curl -fs --max-time "$TIMEOUT" "$b$1"; }
_post() { local b; b=$(_base) || return 1; curl -fs --max-time 60 -X POST -H 'Content-Type: application/json' -d "${2:-}" "$b$1"; }
_patch(){ local b; b=$(_base) || return 1; curl -fs --max-time "$TIMEOUT" -X PATCH -H 'Content-Type: application/json' -d "$2" "$b$1"; }

# Download an URL path to the sandbox; echo the saved file path. $2 = filename.
_download() {
  local b out; b=$(_base) || return 1
  out="$SANDBOX/$2"; mkdir -p "$SANDBOX"
  if curl -fs --max-time 90 -o "$out" "$b$1" 2>/dev/null && [ -s "$out" ]; then
    echo "$out"; return 0
  fi
  echo "ERROR: could not download $1" >&2; return 1
}

# jq helper: seconds-ago -> "3m ago" / "2h ago" / "4d ago"
JQ_AGO='def ago: (now - .) as $s | if $s<90 then "\($s|floor)s ago" elif $s<5400 then "\($s/60|floor)m ago" elif $s<172800 then "\($s/3600|floor)h ago" else "\($s/86400|floor)d ago" end;'
# jq helper: best human label for a sighting (corrected > predicted > clip > class)
JQ_LABEL='def lbl: (.corrected_label // .predicted_label // .clip_label // .class_name // "—");'

# Render a sightings array (from {sightings:[...]}) as an aligned table.
_table() {
  jq -r "$JQ_AGO $JQ_LABEL"'
    .sightings[] | [
      .id,
      (.start_ts|ago),
      .class_name,
      (lbl),
      ((.peak_confidence*100)|floor|tostring + "%"),
      ("uap " + (.uap_score|tostring)),
      ((.duration_sec*10|round/10|tostring) + "s"),
      (if (.object_count // 1) > 1 then "x\(.object_count)" else "" end),
      (if .bookmarked then "★" else "" end)
    ] | @tsv' | column -t -s $'\t'
}

usage() {
  cat <<'EOF'
sky.sh — SkyStream control surface

LIVE
  status                 active model, sun/cloud, today's tallies, flagged count
  snap                   capture one fresh camera frame (-> jpg path)  [delegates to skycam]
  watch [secs]           stream NEW detections as they happen (default 120, max 1800)
  sun                    sunrise/sunset + day|twilight|night
  route                  auto model-routing status (current + matched rule)

DETECTIONS
  recent [N]             last N sightings (default 12)
  sightings [filters]    filtered list. flags: --class N --status new|kept|discarded
                         --min-uap N --min-conf 0-1 --bookmarked --hour-start H
                         --hour-end H --after EPOCH --before EPOCH --limit N
  show <id>              full detail + downloads cutout & keyframe to view
  similar <id>           visually similar past sightings (CLIP)

MEDIA  (all print a file path for send_attachment)
  clip <id> [--boxes] [--quality original|high|medium|low] [--start S --end E]
  cutout <id> | keyframe <id> | streak <id> | image <id>
  report <id>            generate the PDF report, download it (-> pdf path)

DATA / MODELS
  stats                  analytics: per-day, by class/label, busiest hours, spreads
  forecast               detections/hour forecast + identity-model accuracy
  reports [N]            recent generated reports

CORRECTIONS  (teach the model from chat)
  label <id> <text>      set the human-verified label (retrains use it, weighted)
  keep <id> | discard <id> | bookmark <id> [on|off]
  labels                 list the zero-shot vocabulary

Raw: any command + --json prints the underlying JSON instead of formatted text.
EOF
}

cmd="${1:-}"; [ -n "$cmd" ] && shift || true
JSON=0
args=(); for a in "$@"; do if [ "$a" = "--json" ]; then JSON=1; else args+=("$a"); fi; done
set -- ${args[@]+"${args[@]}"}

case "$cmd" in
  ""|-h|--help|help) usage ;;

  status)
    model=$(_get /api/model) || exit 1
    sun=$(_get /api/sun); route=$(_get /api/routing); stats=$(_get /api/stats)
    if [ "$JSON" = 1 ]; then jq -n --argjson m "$model" --argjson s "${sun:-null}" --argjson r "${route:-null}" --argjson t "${stats:-null}" '{model:$m,sun:$s,routing:$r,stats:$t}'; exit 0; fi
    echo "$model" | jq -r '"Model:   \(.label) [\(.name)] · conf \(.confidence) · \(.process_fps)fps · \(.device)"'
    [ -n "$sun" ] && echo "$sun" | jq -r '"Sun:     \(.state) · sunrise \(.sunrise_local) · sunset \(.sunset_local) · elev \(.sun_elevation // "?")°"'
    [ -n "$route" ] && echo "$route" | jq -r 'if .enabled then "Routing: ON · cloud \(.context.cloud)% · rule \(.target.rule_name // "none") -> \(.target.model // .active_model)" else "Routing: off · cloud \((.context.cloud) // "?")%" end'
    [ -n "$stats" ] && echo "$stats" | jq -r '"Totals:  \(.total) sightings · flagged \(.flagged)" , "         " + ([.by_class|to_entries[]|"\(.key) \(.value)"]|join(" · "))'
    ;;

  snap)
    here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    if [ -x "$here/../../skycam/scripts/snap.sh" ]; then bash "$here/../../skycam/scripts/snap.sh"
    else _download /api/camera/snapshot "skycam-$(date +%Y%m%d-%H%M%S).jpg"; fi
    ;;

  sun)  s=$(_get /api/sun) || exit 1; [ "$JSON" = 1 ] && { echo "$s"; exit; }
        echo "$s" | jq -r '"\(.state) · sunrise \(.sunrise_local), sunset \(.sunset_local) (civil \(.civil_begin_local)–\(.civil_end_local)) · sun \(.sun_elevation // "?")° · src \(.source)"' ;;

  route) r=$(_get /api/routing) || exit 1; [ "$JSON" = 1 ] && { echo "$r"; exit; }
         echo "$r" | jq -r '"auto-route: \(if .enabled then "ON" else "off" end) · active \(.active_model)",
            (if .context then "context: \(.context.sun), cloud \(.context.cloud)%, hour \(.context.hour)" else empty end),
            (if .target then "matched rule \"\(.target.rule_name)\" -> \(.target.model)" else empty end),
            "rules:", (.rules[]? | "  [\(if .enabled then "x" else " " end)] \(.name) -> \(.model)  when \(.when|tostring)")' ;;

  recent)
    n="${1:-12}"; r=$(_get "/api/sightings?limit=$n") || exit 1
    [ "$JSON" = 1 ] && { echo "$r"; exit; }
    echo "$r" | _table ;;

  sightings)
    q="limit=60"
    while [ $# -gt 0 ]; do case "$1" in
      --class) q="$q&class_id=$2"; shift 2;;
      --status) q="$q&status=$2"; shift 2;;
      --min-uap) q="$q&min_uap=$2"; shift 2;;
      --min-conf) q="$q&min_conf=$2"; shift 2;;
      --bookmarked) q="$q&bookmarked=true"; shift;;
      --hour-start) q="$q&hour_start=$2"; shift 2;;
      --hour-end) q="$q&hour_end=$2"; shift 2;;
      --after) q="$q&after=$2"; shift 2;;
      --before) q="$q&before=$2"; shift 2;;
      --limit) q="limit=$2${q#limit=60}"; shift 2;;
      *) shift;;
    esac; done
    r=$(_get "/api/sightings?$q") || exit 1
    [ "$JSON" = 1 ] && { echo "$r"; exit; }
    echo "$r" | jq -r '"\(.total) match · showing \(.sightings|length):"'
    echo "$r" | _table ;;

  show)
    id="${1:?usage: show <id>}"; d=$(_get "/api/sightings/$id") || exit 1
    [ "$JSON" = 1 ] && { echo "$d"; exit; }
    echo "$d" | jq -r "$JQ_LABEL"'
      "Sighting \(.id)  ·  \(.class_name)  ·  best label: \(lbl)",
      "  conf \((.peak_confidence*100)|floor)%  ·  uap \(.uap_score)  ·  \(.duration_sec)s  ·  \(.frame_count) frames  ·  \(.object_count // 1) object(s)  ·  by \(.detector // "?")",
      "  clip-label \(.clip_label // "—") (\((.clip_score // 0)*100|floor)%)  ·  model-predicted \(.predicted_label // "—") (\((.predicted_conf // 0)*100|floor)%)  ·  corrected \(.corrected_label // "—")",
      (if .anomaly then "  anomaly: \(.anomaly.reasons|join("; "))" else empty end),
      (if .sky_context then "  sky: \(.sky_context|tostring|.[0:300])" else empty end),
      (if .trajectory then "  trajectory: \(.trajectory|length) pts across \([.trajectory[].track_id]|unique|length) track(s)" else empty end)'
    co=$(_download "/api/cutout/$id" "$id-cutout.jpg" 2>/dev/null) && echo "cutout:   $co"
    kf=$(_download "/api/keyframe/$id" "$id-keyframe.jpg" 2>/dev/null) && echo "keyframe: $kf"
    echo "(view those images to describe the object; clip available via: sky.sh clip $id)" ;;

  similar)
    id="${1:?usage: similar <id>}"; r=$(_get "/api/sightings/$id/similar") || exit 1
    [ "$JSON" = 1 ] && { echo "$r"; exit; }
    echo "$r" | jq -r "$JQ_AGO $JQ_LABEL"'.similar[] | "\(.id)  \(.start_ts|ago)  \(.class_name)  \(lbl)  sim \((.similarity//0)*100|floor)%"' ;;

  clip)
    id="${1:?usage: clip <id> [--boxes] [--quality Q] [--start S --end E]}"; shift
    boxes=0; quality=""; start=""; end=""
    while [ $# -gt 0 ]; do case "$1" in
      --boxes) boxes=1; shift;; --quality) quality="$2"; shift 2;;
      --start) start="$2"; shift 2;; --end) end="$2"; shift 2;; *) shift;;
    esac; done
    if [ -n "$quality" ] || [ -n "$start" ] || [ -n "$end" ]; then
      qp=""; [ -n "$start" ] && qp="$qp&start=$start"; [ -n "$end" ] && qp="$qp&end=$end"
      [ -n "$quality" ] && qp="$qp&quality=$quality"; [ "$boxes" = 1 ] && qp="$qp&boxes=1"
      _download "/api/clip/$id/export?${qp#&}" "$id-export.mp4"
    else
      [ "$boxes" = 1 ] && _download "/api/clip/$id?boxes=1" "$id-boxed.mp4" || _download "/api/clip/$id" "$id.mp4"
    fi ;;

  cutout)   id="${1:?id}"; _download "/api/cutout/$id" "$id-cutout.jpg" ;;
  keyframe) id="${1:?id}"; _download "/api/keyframe/$id" "$id-keyframe.jpg" ;;
  streak)   id="${1:?id}"; _download "/api/streak/$id" "$id-streak.jpg" ;;
  image)    id="${1:?id}"; _download "/api/image/$id?w=1280" "$id-thumb.jpg" ;;

  report)
    id="${1:?usage: report <id>}"
    rep=$(_post "/api/sightings/$id/report" "{}") || { echo "report generation failed" >&2; exit 1; }
    rid=$(echo "$rep" | jq -r '.id')
    echo "$rep" | jq -r '"report \(.id): \(.title)"'
    _download "/api/reports/$rid/pdf" "$rid.pdf" ;;

  reports)
    n="${1:-10}"; r=$(_get "/api/reports?limit=$n") || exit 1
    [ "$JSON" = 1 ] && { echo "$r"; exit; }
    echo "$r" | jq -r "$JQ_AGO"'.reports[] | "\(.id)  \(.created_ts|ago)  \(.title)  (sighting \(.sighting_id))"' ;;

  stats)
    r=$(_get /api/analytics/stats) || exit 1
    [ "$JSON" = 1 ] && { echo "$r"; exit; }
    echo "$r" | jq -r '
      "Span:    \(.span_days)d · \(.total) sightings · ~\(.per_day_avg|floor)/day",
      "Class:   " + ([.by_class|to_entries[]|"\(.key) \(.value)"]|join(" · ")),
      "Label:   " + ([.by_label|to_entries|sort_by(-.value)[:8][]|"\(.key) \(.value)"]|join(" · ")),
      "Speed:   median \(.speed.median|.*1000|round/1000) (p25 \(.speed.p25|.*1000|round/1000) – p75 \(.speed.p75|.*1000|round/1000))",
      "Straight:median \(.straightness.median) · Duration median \(.duration.median)s",
      "Clouds:  " + ([.cloud_buckets|to_entries[]|"\(.key) \(.value)"]|join(" · ")),
      ([.hour_counts|to_entries|max_by(.value)] as $p | "Busiest: hour \($p[0].key):00 (\($p[0].value) detections)")' ;;

  forecast)
    r=$(_get /api/analytics/models) || exit 1
    [ "$JSON" = 1 ] && { echo "$r"; exit; }
    echo "$r" | jq -r '
      (if .identity then "Identity model: \(.identity.n_classes // (.identity.classes|length)) classes · acc \((.identity.accuracy//0)*100|floor)% (balanced \((.identity.balanced_accuracy//0)*100|floor)%) · \(.identity.samples) samples" else "Identity model: not trained" end),
      (if .identity.feature_importance then "  top features: " + ([.identity.feature_importance[:5][]|.feature]|join(", ")) else empty end),
      (if .rate then "Rate model: R² \((.rate.r2//0)*100|round/100) · MAE \((.rate.mae//0)*10|round/10)/hr · mean \((.rate.mean_per_hour//0)*10|round/10)/hr over \(.rate.hours_observed)h" else "Rate model: not trained" end),
      (if .rate.forecast_24h then "Next 6h forecast (per hour): " + ([.rate.forecast_24h[:6][]|"\(.hour):00=\(.predicted|round)"]|join(" ")) else empty end)' ;;

  labels) r=$(_get /api/labels) || exit 1; [ "$JSON" = 1 ] && { echo "$r"; exit; }
          echo "$r" | jq -r '.labels|join(", ")' ;;

  label)
    id="${1:?usage: label <id> <text>}"; shift; txt="$*"
    _patch "/api/sightings/$id" "{\"corrected_label\":\"$txt\"}" | jq -r '"\(.id) -> corrected: \(.corrected_label)"' ;;

  keep)     id="${1:?id}"; _patch "/api/sightings/$id" '{"status":"kept"}' | jq -r '"\(.id) -> \(.status)"' ;;
  discard)  id="${1:?id}"; _patch "/api/sightings/$id" '{"status":"discarded"}' | jq -r '"\(.id) -> \(.status)"' ;;
  bookmark) id="${1:?id}"; on="${2:-on}"; v=$([ "$on" = off ] && echo false || echo true)
            _patch "/api/sightings/$id" "{\"bookmarked\":$v}" | jq -r '"\(.id) -> bookmarked \(.bookmarked)"' ;;

  watch)
    secs="${1:-120}"; [ "$secs" -gt 1800 ] 2>/dev/null && secs=1800
    last=$(_get "/api/sightings?limit=1" | jq -r '.sightings[0].id // ""')
    echo "watching for new detections for ${secs}s (since ${last:-start})… Ctrl-C / returns when done"
    end=$(( $(date +%s) + secs ))
    while [ "$(date +%s)" -lt "$end" ]; do
      sleep 5
      r=$(_get "/api/sightings?limit=10" 2>/dev/null) || continue
      new=$(echo "$r" | jq -r --arg last "$last" "$JQ_AGO $JQ_LABEL"'[.sightings[] | select(.id > $last)] | .[] | "  NEW \(.id)  \(.class_name)  \(lbl)  conf \((.peak_confidence*100)|floor)%  uap \(.uap_score)"')
      if [ -n "$new" ]; then echo "$new"; last=$(echo "$r" | jq -r '.sightings[0].id'); fi
    done
    echo "…watch window ended." ;;

  *) echo "unknown command: $cmd" >&2; echo >&2; usage >&2; exit 2 ;;
esac
