#!/bin/bash
# Fishing data platform API (FastAPI on :8087). Lives in a SEPARATE repo; this
# wrapper cd's there and execs the uv-managed server so launchd supervises it
# alongside the harness/dashboard. Logs go to edmund-harness/data/fishing.launchd.*.
# Override the location with FISHING_DATA_PLATFORM if you cloned it elsewhere.
cd "${FISHING_DATA_PLATFORM:-$HOME/fishing-data-platform}" || exit 1
UV="$(command -v uv || echo /opt/homebrew/bin/uv)"
exec "$UV" run fishctl serve
