#!/usr/bin/env python3
"""Safely reap expired or explicitly stopped instant-share leases.

Only PIDs recorded in a state file are considered, and each PID is validated
against its expected command, artifact, local port, and (for legacy states)
start time before a signal is sent. Permanent/named Cloudflare tunnels are
therefore outside this script's reach.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shlex
import signal
import subprocess
import time
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path

QUICK_TUNNEL = re.compile(r"(?:^|/)cloudflared\s+tunnel\s+--url\s+http://127\.0\.0\.1:(\d+)(?:\s|$)")


@dataclass(frozen=True)
class ProcessInfo:
    pid: int
    command: str
    started_at: datetime | None


def read_state(path: Path) -> dict[str, str]:
    state: dict[str, str] = {}
    for raw in path.read_text(errors="replace").splitlines():
        if "=" not in raw:
            continue
        key, value = raw.split("=", 1)
        state[key.strip()] = value.strip()
    return state


def parse_utc(value: str) -> datetime | None:
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return parsed.replace(tzinfo=parsed.tzinfo or timezone.utc).astimezone(timezone.utc)
    except (TypeError, ValueError):
        return None


def process_info(pid_text: str | None) -> ProcessInfo | None:
    if not pid_text or not pid_text.isdigit():
        return None
    pid = int(pid_text)
    result = subprocess.run(
        ["/bin/ps", "-p", str(pid), "-o", "lstart=", "-o", "command="],
        capture_output=True,
        text=True,
    )
    line = result.stdout.strip()
    if result.returncode != 0 or not line:
        return None
    fields = line.split(maxsplit=5)
    if len(fields) < 6:
        return None
    started: datetime | None = None
    try:
        local = datetime.strptime(" ".join(fields[:5]), "%a %b %d %H:%M:%S %Y").astimezone()
        started = local.astimezone(timezone.utc)
    except ValueError:
        pass
    return ProcessInfo(pid=pid, command=fields[5], started_at=started)


def server_owned(process: ProcessInfo | None, state: dict[str, str], server_script: Path) -> bool:
    if not process:
        return False
    artifact = state.get("ARTIFACT_PATH", "")
    return bool(artifact and str(server_script) in process.command and artifact in process.command)


def listening_port(pid: int) -> str | None:
    result = subprocess.run(
        ["/usr/sbin/lsof", "-Pan", "-p", str(pid), "-iTCP", "-sTCP:LISTEN", "-Fn"],
        capture_output=True,
        text=True,
    )
    for line in result.stdout.splitlines():
        match = re.search(r"127\.0\.0\.1:(\d+)$", line)
        if match:
            return match.group(1)
    return None


def started_with_lease(process: ProcessInfo, state: dict[str, str]) -> bool:
    lease_started = parse_utc(state.get("STARTED", ""))
    if not lease_started or not process.started_at:
        return False
    return abs((process.started_at - lease_started).total_seconds()) <= 5 * 60


def tunnel_owned(
    process: ProcessInfo | None,
    state: dict[str, str],
    server: ProcessInfo | None,
    owns_server: bool,
) -> bool:
    if not process or not QUICK_TUNNEL.search(process.command):
        return False
    port = state.get("PORT")
    if not port and owns_server and server:
        port = listening_port(server.pid)
    if port:
        try:
            argv = shlex.split(process.command)
        except ValueError:
            return False
        expected = f"http://127.0.0.1:{port}"
        return any(argv[i] == "--url" and argv[i + 1] == expected for i in range(len(argv) - 1))
    # Legacy state did not record PORT. Start-time correlation prevents a stale
    # PID from claiming a newer quick tunnel after PID reuse.
    return started_with_lease(process, state)


def expiry_time(state: dict[str, str]) -> datetime | None:
    started = parse_utc(state.get("STARTED", ""))
    try:
        minutes = int(state.get("EXPIRE_MINUTES", "0"))
    except ValueError:
        return None
    if not started or minutes <= 0:
        return None
    return started + timedelta(minutes=minutes)


def terminate(process: ProcessInfo, still_owned, dry_run: bool) -> bool:
    if dry_run:
        return True
    try:
        os.kill(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        return True
    except PermissionError:
        return False
    for _ in range(20):
        time.sleep(0.1)
        current = process_info(str(process.pid))
        if not current:
            return True
        if not still_owned(current):
            return False
    current = process_info(str(process.pid))
    if current and still_owned(current):
        try:
            os.kill(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    return True


def remove_registry_entry(config_dir: Path, artifact_id: str, dry_run: bool) -> None:
    path = config_dir / "artifact_registry.json"
    if dry_run or not artifact_id or not path.exists():
        return
    try:
        registry = json.loads(path.read_text())
        artifacts = registry.get("artifacts", {})
        if artifact_id not in artifacts:
            return
        del artifacts[artifact_id]
        temp = path.with_suffix(".json.tmp")
        temp.write_text(json.dumps(registry, indent=2) + "\n")
        temp.replace(path)
    except (OSError, ValueError, TypeError):
        pass


def matching_target(state: dict[str, str], target: str | None) -> bool:
    if not target:
        return True
    target_base = Path(target).name
    artifact_id = state.get("ARTIFACT_ID", "")
    artifact_path = state.get("ARTIFACT_PATH", "")
    return (
        target == artifact_id
        or target == artifact_path
        or target_base == artifact_id
        or target_base == Path(artifact_path).name
    )


def run(config_dir: Path, stop_all: bool, target: str | None, dry_run: bool) -> dict[str, int]:
    tunnels_dir = config_dir / "tunnels"
    server_script = Path(__file__).with_name("secure_server.py").resolve()
    now = datetime.now(timezone.utc)
    result = {"examined": 0, "stopped": 0, "expired": 0, "stale": 0, "preserved": 0}
    if not tunnels_dir.exists():
        return result

    for path in sorted(tunnels_dir.glob("*.state")):
        try:
            state = read_state(path)
        except OSError:
            continue
        result["examined"] += 1
        if target and not matching_target(state, target):
            result["preserved"] += 1
            continue

        server = process_info(state.get("SERVER_PID"))
        tunnel = process_info(state.get("TUNNEL_PID"))
        owns_server = server_owned(server, state, server_script)
        owns_tunnel = tunnel_owned(tunnel, state, server, owns_server)
        lease_expiry = expiry_time(state)
        is_expired = bool(lease_expiry and now >= lease_expiry)
        is_stale = not owns_server and not owns_tunnel
        is_broken = owns_server != owns_tunnel
        should_stop = stop_all or bool(target) or is_expired or is_broken

        if not should_stop and not is_stale:
            result["preserved"] += 1
            continue
        if is_expired:
            result["expired"] += 1
        if is_stale:
            result["stale"] += 1

        stopped_any = False
        if owns_tunnel and tunnel:
            stopped_any |= terminate(
                tunnel,
                lambda current: tunnel_owned(current, state, server, owns_server),
                dry_run,
            )
        if owns_server and server:
            stopped_any |= terminate(
                server,
                lambda current: server_owned(current, state, server_script),
                dry_run,
            )
        if stopped_any:
            result["stopped"] += 1

        if not dry_run:
            path.unlink(missing_ok=True)
            remove_registry_entry(config_dir, state.get("ARTIFACT_ID", ""), dry_run=False)
            legacy = config_dir / "active_tunnel.state"
            try:
                if legacy.exists() and read_state(legacy).get("ARTIFACT_ID") == state.get("ARTIFACT_ID"):
                    legacy.unlink(missing_ok=True)
                    (config_dir / "active_tunnel.url").unlink(missing_ok=True)
            except OSError:
                pass
    return result


def main() -> None:
    default_config = Path(__file__).resolve().parent.parent / ".config"
    parser = argparse.ArgumentParser()
    parser.add_argument("--config-dir", type=Path, default=default_config)
    parser.add_argument("--all", action="store_true", help="stop every tracked lease")
    parser.add_argument("--target", help="artifact id or path to stop")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    result = run(args.config_dir.resolve(), args.all, args.target, args.dry_run)
    if args.json:
        print(json.dumps(result, sort_keys=True))
    else:
        print(
            "instant-share: "
            f"examined={result['examined']} stopped={result['stopped']} "
            f"expired={result['expired']} stale={result['stale']} preserved={result['preserved']}"
        )


if __name__ == "__main__":
    main()
