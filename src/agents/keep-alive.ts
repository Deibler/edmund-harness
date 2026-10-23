import { AgentStore } from "./store.ts";

/** How often a sub-agent's heartbeat is stamped while one of its tool calls runs. */
export const TOOL_CALL_HEARTBEAT_MS = 60_000;

/**
 * Keep a sub-agent alive in the reaper's eyes while one of its tool calls
 * runs. The reaper reads silence from the CLI's output, and the CLI prints
 * nothing while a tool call is in flight. The 15-minute limit was measured
 * when a sub-agent's background tools returned at once; they now run inline
 * (dispatchOrRun), and an inline generate_video polls for up to 600s while a
 * long transcription or video analysis has no limit. A plain session key is
 * passed straight through.
 */
export async function withAgentHeartbeat<T>(
  sessionKey: string,
  dataDir: string,
  fn: () => Promise<T>,
  everyMs = TOOL_CALL_HEARTBEAT_MS,
): Promise<T> {
  if (!sessionKey.startsWith("agent:")) return fn();
  const id = sessionKey.slice("agent:".length);
  let store: AgentStore | null = null;
  const beat = () => {
    try {
      store ??= new AgentStore(dataDir);
      store.heartbeat(id);
    } catch {
      // A missed beat is retried on the next tick; the tool call goes on.
    }
  };
  beat();
  const timer = setInterval(beat, everyMs);
  try {
    return await fn();
  } finally {
    clearInterval(timer);
    beat();
    (store as AgentStore | null)?.close();
  }
}
