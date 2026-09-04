import type { LogLine } from "@api/types";
import { useEffect, useRef, useState } from "react";

const MAX_KEEP = 5000;

/**
 * Subscribes to /api/logs/stream via EventSource and keeps a ring buffer of
 * the most recent lines in state. Reconnects automatically on close.
 */
export function useLogStream(): { lines: LogLine[]; connected: boolean; clear: () => void } {
  const [lines, setLines] = useState<LogLine[]>([]);
  const [connected, setConnected] = useState(false);
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    let cancelled = false;
    let retryHandle: ReturnType<typeof setTimeout> | null = null;

    function open() {
      if (cancelled) return;
      const es = new EventSource("/api/logs/stream", { withCredentials: true });
      esRef.current = es;
      es.addEventListener("open", () => setConnected(true));
      es.addEventListener("line", (ev) => {
        try {
          const line = JSON.parse((ev as MessageEvent).data) as LogLine;
          setLines((cur) => {
            const next = [...cur, line];
            return next.length > MAX_KEEP ? next.slice(next.length - MAX_KEEP) : next;
          });
        } catch {}
      });
      es.addEventListener("error", () => {
        setConnected(false);
        es.close();
        if (!cancelled) retryHandle = setTimeout(open, 2000);
      });
    }
    open();
    return () => {
      cancelled = true;
      if (retryHandle) clearTimeout(retryHandle);
      esRef.current?.close();
    };
  }, []);

  return { lines, connected, clear: () => setLines([]) };
}
