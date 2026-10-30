#!/bin/zsh
# FaceTime call diagnostics: the same evidence on any Mac, so two Macs' calls
# can be lined up side by side.
#
#   call-diag.sh watch [seconds]        run DURING a call: every 2 s, each audio
#                                       device's sample rate and default flags
#   call-diag.sh report START END       after a call: what FaceTime's audio
#                                       engine, Control Center and the call
#                                       service logged between START and END
#                                       ("YYYY-MM-DD HH:MM:SS", local time)
#   call-diag.sh report-last MINUTES    the same, for the last MINUTES
#
# Uses /usr/bin/log explicitly: a shell function named `log` silently returns
# nothing on some Macs. Keep windows short; multi-hour queries hang.

set -u
LOG=/usr/bin/log

devices() {
  system_profiler SPAudioDataType 2>/dev/null | awk '
    /^        [^ ].*:$/ { if (name) print line; name=$0; sub(/^ +/, "", name); sub(/:$/, "", name); line=name; next }
    /Current SampleRate:/ { line=line " | rate=" $3 }
    /Default Input Device: Yes/ { line=line " | default-in" }
    /Default Output Device: Yes/ { line=line " | default-out" }
    /Transport:/ { line=line " | " $2 }
    END { if (name) print line }'
}

watch_devices() {
  local seconds=${1:-60} end=$((SECONDS + ${1:-60}))
  while (( SECONDS < end )); do
    print -- "== $(date '+%Y-%m-%d %H:%M:%S')"
    devices
    sleep 2
  done
}

range_args() {
  if [[ $1 == last ]]; then print -- "--last ${2}m"; else print -- "--start|$1|--end|$2"; fi
}

show() {
  # $1 = predicate; remaining = range spec
  local predicate=$1; shift
  if [[ $1 == last ]]; then
    $LOG show --style compact --last "${2}m" --predicate "$predicate" 2>/dev/null
  else
    $LOG show --style compact --start "$1" --end "$2" --predicate "$predicate" 2>/dev/null
  fi | grep -vE '^Timestamp|^\s|^\}|^\)'
}

report() {
  print "### 1. FaceTime microphone health (avconferenced, one line per ~5 s)"
  print "### idle background stream (packetsSent=0 while mic procs run) omitted"
  show 'process == "avconferenced" AND eventMessage CONTAINS "Health: AudioIO"' "$@" |
    awk '{
      t=$1" "$2; m=""; p=""; v=""; a="";
      for (i=1;i<=NF;i++) {
        if ($i ~ /^micProcsCalled=/) m=$i; if ($i ~ /^packetsSent=/) p=$i;
        if ($i ~ /^voiceActivityCount=/) v=$i; if ($i ~ /^averageInputPower=/) a=$i;
      }
      gsub(/,/, "", m); gsub(/,/, "", p); gsub(/,/, "", v); gsub(/,/, "", a);
      split(p, pp, "="); split(m, mm, "=");
      if (pp[2] == 0 && mm[2] > 0) next;
      print t "  " m "  " p "  " v "  " a }'

  print "\n### 2. Input device FaceTime selected, and mute state (avconferenced)"
  show 'process == "avconferenced" AND (eventMessage CONTAINS "as default input device" OR eventMessage CONTAINS "Muted=")' "$@" |
    sed -E 's/^([0-9-]+ [0-9:.]+).*(Selected .*|Muted=[0-9]+).*$/\1  \2/' | cut -c1-160 | uniq -f2

  print "\n### 3. Control Center mic mode and voice processing for FaceTime"
  show 'process == "ControlCenter" AND (eventMessage CONTAINS "supportedModes" OR eventMessage CONTAINS "activeMicMode" OR eventMessage CONTAINS "vpBypassed" OR eventMessage CONTAINS "hiddenModes")' "$@" |
    sed -E 's/^([0-9-]+ [0-9:.]+) .*(supportedModes.*|activeMicMode.*|vpBypassed.*|hiddenModes.*)$/\1  \2/' | cut -c1-200 |
    awk '{ k = substr($0, 26) } !seen[k]++'   # each distinct value once, first time seen

  print "\n### 4. Call service decisions (Do Not Disturb, screening, filtering)"
  show 'process == "callservicesd" AND (eventMessage CONTAINS "DND" OR eventMessage CONTAINS "did not pass" OR eventMessage CONTAINS "shouldSilence" OR eventMessage CONTAINS "filtered out")' "$@" |
    sed -E 's/^([0-9-]+ [0-9:.]+) [A-Za-z]+ [^ ]+ (\[[^]]*\] )?/\1  /' | cut -c1-180
}

case ${1:-} in
  watch) watch_devices "${2:-60}" ;;
  report) [[ $# -eq 3 ]] || { print -u2 "usage: $0 report 'YYYY-MM-DD HH:MM:SS' 'YYYY-MM-DD HH:MM:SS'"; exit 64; }
          report "$2" "$3" ;;
  report-last) report last "${2:-10}" ;;
  *) print -u2 "usage: $0 watch [seconds] | report START END | report-last MINUTES"; exit 64 ;;
esac
