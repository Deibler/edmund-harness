#!/usr/bin/env bash
# Manage the edmund-harness LaunchAgent.
#
# Usage:
#   scripts/launchd/service.sh install     # copy plist to ~/Library/LaunchAgents and bootstrap
#   scripts/launchd/service.sh uninstall   # bootout and remove the plist
#   scripts/launchd/service.sh start       # kickstart (force run now)
#   scripts/launchd/service.sh stop        # stop the service (will auto-restart unless uninstalled)
#   scripts/launchd/service.sh restart     # stop then start
#   scripts/launchd/service.sh status      # is it loaded + running?
#   scripts/launchd/service.sh logs        # tail the daemon log
#   scripts/launchd/service.sh errors      # tail the launchd stderr log
#   scripts/launchd/service.sh debug on    # enable EDMUND_LOG_LEVEL=debug + restart
#   scripts/launchd/service.sh debug off   # disable debug logging + restart
#   scripts/launchd/service.sh debug       # show current state
#   scripts/launchd/service.sh dashboard {install|uninstall|start|stop|restart|status|logs}
#
# Notes:
#   - Uses user-level bootstrap (gui/$UID). Starts at login, not at boot.
#   - Once installed, macOS will auto-restart the daemon if it crashes.
#   - Any manually-started `bun run src/main.ts` will collide — install kills
#     them first.

set -euo pipefail

LABEL="com.edmund-harness"
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SRC_PLIST="$REPO_ROOT/scripts/launchd/$LABEL.plist"
DEST_PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DAEMON_LOG="$REPO_ROOT/data/daemon.log"
ERR_LOG="$REPO_ROOT/data/launchd.err.log"
DOMAIN="gui/$(id -u)"

DASH_LABEL="com.edmund-harness.dashboard"
DASH_SRC_PLIST="$REPO_ROOT/scripts/launchd/$DASH_LABEL.plist"
DASH_DEST_PLIST="$HOME/Library/LaunchAgents/$DASH_LABEL.plist"
DASH_LOG="$REPO_ROOT/data/dashboard.log"

TRADE_LABEL="com.edmund-harness.trading"
TRADE_SRC_PLIST="$REPO_ROOT/scripts/launchd/$TRADE_LABEL.plist"
TRADE_DEST_PLIST="$HOME/Library/LaunchAgents/$TRADE_LABEL.plist"
TRADE_LOG="$REPO_ROOT/data/trading.launchd.out.log"

FISH_LABEL="com.edmund-harness.fishing"
FISH_SRC_PLIST="$REPO_ROOT/scripts/launchd/$FISH_LABEL.plist"
FISH_DEST_PLIST="$HOME/Library/LaunchAgents/$FISH_LABEL.plist"
FISH_LOG="$REPO_ROOT/data/fishing.launchd.out.log"

cmd="${1:-status}"

# Render a plist template into place, substituting the machine-specific paths
# the committed templates leave as placeholders. The repo ships portable
# templates (__HARNESS_ROOT__ / __HOME__); the resolved copy lands in
# ~/Library/LaunchAgents. This is what makes a fresh checkout work on any
# machine without hand-editing absolute paths.
render_plist() {
  sed -e "s|__HARNESS_ROOT__|$REPO_ROOT|g" -e "s|__HOME__|$HOME|g" "$1" > "$2"
}

kill_stray_daemons() {
  # Any manually-started instance would fight launchd for the chat.db watcher.
  if pgrep -f 'bun run.*src/main.ts' >/dev/null 2>&1; then
    echo "→ killing stray 'bun run src/main.ts' processes"
    pkill -f 'bun run.*src/main.ts' || true
    sleep 1
  fi
}

case "$cmd" in
  install)
    echo "→ installing $LABEL"
    [[ -f "$SRC_PLIST" ]] || { echo "plist not found: $SRC_PLIST" >&2; exit 1; }
    mkdir -p "$HOME/Library/LaunchAgents"
    render_plist "$SRC_PLIST" "$DEST_PLIST"
    kill_stray_daemons
    # If already bootstrapped, replace cleanly.
    launchctl bootout "$DOMAIN/$LABEL" >/dev/null 2>&1 || true
    launchctl bootstrap "$DOMAIN" "$DEST_PLIST"
    launchctl enable "$DOMAIN/$LABEL"
    launchctl kickstart -k "$DOMAIN/$LABEL"
    sleep 1
    echo "→ installed. status:"
    "$0" status
    ;;

  uninstall)
    echo "→ uninstalling $LABEL"
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    rm -f "$DEST_PLIST"
    echo "→ done. (stray processes left alone; run 'stop' first if needed.)"
    ;;

  start)
    launchctl kickstart "$DOMAIN/$LABEL"
    ;;

  stop)
    # NOTE: with KeepAlive=true, launchd relaunches after ~30s throttle. Use
    # uninstall for a persistent stop.
    launchctl kill SIGTERM "$DOMAIN/$LABEL" || true
    ;;

  restart)
    launchctl kickstart -k "$DOMAIN/$LABEL"
    ;;

  status)
    if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
      launchctl print "$DOMAIN/$LABEL" | grep -E "state|pid|last exit code" | head -5
    else
      echo "not loaded — run: $0 install"
    fi
    ;;

  logs)
    tail -F "$DAEMON_LOG"
    ;;

  errors)
    tail -F "$ERR_LOG"
    ;;

  debug)
    # Flip EDMUND_LOG_LEVEL=debug in the plist + restart. Debug logging
    # surfaces stream events, per-tool arg payloads, scheduler rearm, and
    # lock waits — useful when chasing a bug, noisy otherwise.
    state="${2:-show}"
    case "$state" in
      on)
        /usr/libexec/PlistBuddy -c "Delete :EnvironmentVariables:EDMUND_LOG_LEVEL" "$SRC_PLIST" 2>/dev/null || true
        /usr/libexec/PlistBuddy -c "Add :EnvironmentVariables:EDMUND_LOG_LEVEL string debug" "$SRC_PLIST"
        echo "→ debug logging ON — reinstalling service"
        "$0" install
        ;;
      off)
        /usr/libexec/PlistBuddy -c "Delete :EnvironmentVariables:EDMUND_LOG_LEVEL" "$SRC_PLIST" 2>/dev/null || true
        echo "→ debug logging OFF — reinstalling service"
        "$0" install
        ;;
      show|"")
        current=$(/usr/libexec/PlistBuddy -c "Print :EnvironmentVariables:EDMUND_LOG_LEVEL" "$SRC_PLIST" 2>/dev/null || echo "(unset)")
        echo "EDMUND_LOG_LEVEL = $current"
        ;;
      *)
        echo "usage: $0 debug {on|off|show}" >&2
        exit 2
        ;;
    esac
    ;;

  dashboard)
    sub="${2:-status}"
    case "$sub" in
      install)
        echo "→ installing $DASH_LABEL"
        [[ -f "$DASH_SRC_PLIST" ]] || { echo "plist not found: $DASH_SRC_PLIST" >&2; exit 1; }
        mkdir -p "$HOME/Library/LaunchAgents"
        render_plist "$DASH_SRC_PLIST" "$DASH_DEST_PLIST"
        if pgrep -f 'bun.*dashboard/server/main.ts' >/dev/null 2>&1; then
          echo "→ killing stray dashboard processes"
          pkill -f 'bun.*dashboard/server/main.ts' || true
          sleep 1
        fi
        launchctl bootout "$DOMAIN/$DASH_LABEL" >/dev/null 2>&1 || true
        launchctl bootstrap "$DOMAIN" "$DASH_DEST_PLIST"
        launchctl enable "$DOMAIN/$DASH_LABEL"
        launchctl kickstart -k "$DOMAIN/$DASH_LABEL"
        sleep 1
        "$0" dashboard status
        ;;
      uninstall)
        launchctl bootout "$DOMAIN/$DASH_LABEL" 2>/dev/null || true
        rm -f "$DASH_DEST_PLIST"
        echo "→ dashboard uninstalled"
        ;;
      start)   launchctl kickstart "$DOMAIN/$DASH_LABEL" ;;
      stop)    launchctl kill SIGTERM "$DOMAIN/$DASH_LABEL" || true ;;
      restart) launchctl kickstart -k "$DOMAIN/$DASH_LABEL" ;;
      status)
        if launchctl print "$DOMAIN/$DASH_LABEL" >/dev/null 2>&1; then
          launchctl print "$DOMAIN/$DASH_LABEL" | grep -E "state|pid|last exit code" | head -5
        else
          echo "not loaded — run: $0 dashboard install"
        fi
        ;;
      logs)    tail -F "$DASH_LOG" ;;
      *)
        echo "usage: $0 dashboard {install|uninstall|start|stop|restart|status|logs}" >&2
        exit 2
        ;;
    esac
    ;;

  trading)
    sub="${2:-status}"
    case "$sub" in
      install)
        echo "→ installing $TRADE_LABEL"
        [[ -f "$TRADE_SRC_PLIST" ]] || { echo "plist not found: $TRADE_SRC_PLIST" >&2; exit 1; }
        mkdir -p "$HOME/Library/LaunchAgents"
        render_plist "$TRADE_SRC_PLIST" "$TRADE_DEST_PLIST"
        if pgrep -f 'bun.*integrations/trading/dashboard/main.ts' >/dev/null 2>&1; then
          echo "→ killing stray trading-dashboard processes"
          pkill -f 'bun.*integrations/trading/dashboard/main.ts' || true
          sleep 1
        fi
        launchctl bootout "$DOMAIN/$TRADE_LABEL" >/dev/null 2>&1 || true
        launchctl bootstrap "$DOMAIN" "$TRADE_DEST_PLIST"
        launchctl enable "$DOMAIN/$TRADE_LABEL"
        launchctl kickstart -k "$DOMAIN/$TRADE_LABEL"
        sleep 1
        "$0" trading status
        ;;
      uninstall)
        launchctl bootout "$DOMAIN/$TRADE_LABEL" 2>/dev/null || true
        rm -f "$TRADE_DEST_PLIST"
        echo "→ trading dashboard uninstalled"
        ;;
      start)   launchctl kickstart "$DOMAIN/$TRADE_LABEL" ;;
      stop)    launchctl kill SIGTERM "$DOMAIN/$TRADE_LABEL" || true ;;
      restart) launchctl kickstart -k "$DOMAIN/$TRADE_LABEL" ;;
      status)
        if launchctl print "$DOMAIN/$TRADE_LABEL" >/dev/null 2>&1; then
          launchctl print "$DOMAIN/$TRADE_LABEL" | grep -E "state|pid|last exit code" | head -5
        else
          echo "not loaded — run: $0 trading install"
        fi
        ;;
      logs)    tail -F "$TRADE_LOG" ;;
      *)
        echo "usage: $0 trading {install|uninstall|start|stop|restart|status|logs}" >&2
        exit 2
        ;;
    esac
    ;;

  fishing)
    sub="${2:-status}"
    case "$sub" in
      install)
        echo "→ installing $FISH_LABEL"
        [[ -f "$FISH_SRC_PLIST" ]] || { echo "plist not found: $FISH_SRC_PLIST" >&2; exit 1; }
        mkdir -p "$HOME/Library/LaunchAgents"
        render_plist "$FISH_SRC_PLIST" "$FISH_DEST_PLIST"
        if pgrep -f 'fishctl serve' >/dev/null 2>&1; then
          echo "→ killing stray fishing-service processes"
          pkill -f 'fishctl serve' || true
          sleep 1
        fi
        launchctl bootout "$DOMAIN/$FISH_LABEL" >/dev/null 2>&1 || true
        launchctl bootstrap "$DOMAIN" "$FISH_DEST_PLIST"
        launchctl enable "$DOMAIN/$FISH_LABEL"
        launchctl kickstart -k "$DOMAIN/$FISH_LABEL"
        sleep 1
        "$0" fishing status
        ;;
      uninstall)
        launchctl bootout "$DOMAIN/$FISH_LABEL" 2>/dev/null || true
        rm -f "$FISH_DEST_PLIST"
        echo "→ fishing service uninstalled"
        ;;
      start)   launchctl kickstart "$DOMAIN/$FISH_LABEL" ;;
      stop)    launchctl kill SIGTERM "$DOMAIN/$FISH_LABEL" || true ;;
      restart) launchctl kickstart -k "$DOMAIN/$FISH_LABEL" ;;
      status)
        if launchctl print "$DOMAIN/$FISH_LABEL" >/dev/null 2>&1; then
          launchctl print "$DOMAIN/$FISH_LABEL" | grep -E "state|pid|last exit code" | head -5
        else
          echo "not loaded — run: $0 fishing install"
        fi
        ;;
      logs)    tail -F "$FISH_LOG" ;;
      *)
        echo "usage: $0 fishing {install|uninstall|start|stop|restart|status|logs}" >&2
        exit 2
        ;;
    esac
    ;;

  *)
    echo "usage: $0 {install|uninstall|start|stop|restart|status|logs|errors|debug|dashboard|trading|fishing}" >&2
    exit 2
    ;;
esac
