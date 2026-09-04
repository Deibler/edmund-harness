import { api } from "@/lib/api";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

export type BrownNoseRow = {
  sessionKey: string;
  label: string;
  isGroup: boolean;
  members: string[];
  lastInboundMs: number | null;
  lastOutboundMs: number | null;
  enrolled: boolean;
  enabled: boolean;
  disabledReason: string | null;
  snoozedUntilMs: number | null;
  weeklyCap: number | null;
  cooldownMultiplier: number | null;
  timezone: string | null;
  activeHours: Array<{ dow: string; start: string; end: string }>;
  focusSuggestionCount: number;
  lastFireAtMs: number | null;
  lastFireOutcome: "engaged" | "ignored" | "pushed_back" | null;
  firesThisWeek: number;
  firesToday: number;
};

export type BrownNoseBudget = {
  enrolledCount: number;
  enabledCount: number;
  firesThisWeek: number;
  firesToday: number;
  maxGhostTicksPerDay: number;
};

export type BrownNoseGlobals = {
  enabled: boolean;
  intensity: number;
  intensityParams: {
    cooldownHours: number;
    weeklyCap: number;
    sweepMin: number;
    sweepMax: number;
    eagerness: string;
  };
  dmsEnabledByDefault: boolean;
  groupsEnabledByDefault: boolean;
  maxConcurrentFires: number;
};

export type FocusSuggestion = {
  topic: string;
  usageCount: number;
  expiresAtMs: number | null;
  createdAtMs: number;
};

export type FireRecord = {
  id: number;
  sessionKey: string;
  firedAtMs: number;
  brief: string;
  tags: string[];
  outcome: "engaged" | "ignored" | "pushed_back" | null;
  outcomeAtMs: number | null;
};

/** Loose decision shape — the log has evolved (gates, snoozes, contextFiles). */
export type StoredDecision = {
  act: boolean;
  tickAtMs: number;
  reason?: string;
  gate?: unknown;
  snoozeUntilMs?: number;
  fireAtMs?: number;
  brief?: string;
  tags?: string[];
  expiresAtMs?: number;
  confidence?: string;
  contextFiles?: string[];
};

export type BrownNoseStats = {
  decisionsTotal: number;
  acts: number;
  modelNos: number;
  gateNos: number;
  snoozesSet: number;
  parseErrors: number;
  firesByOutcome: Record<string, number>;
};

export type WorkspaceFile = {
  path: string;
  rel: string;
  sizeBytes: number;
  modifiedAtMs: number;
};

export type QueuedFire = {
  jobId: string;
  nextFireMs: number;
  createdAt: number;
  brief: string;
  tags: string[];
  expiresAtMs: number | null;
  confidence: "low" | "medium" | "high" | null;
};

export type BrownNoseDetail = {
  sessionKey: string;
  label: string;
  isGroup: boolean;
  handle: string;
  members: string[];
  lastInboundMs: number | null;
  lastOutboundMs: number | null;
  prefs: {
    enabled: boolean;
    disabledReason: string | null;
    disabledAtMs: number | null;
    weeklyCap: number;
    cooldownMultiplier: number;
    timezone: string;
    activeHours: Array<{ dow: string; start: string; end: string }>;
    focusSuggestions: FocusSuggestion[];
    snoozeUntilMs: number | null;
    snoozeSetAtMs: number | null;
    snoozeActive: boolean;
    updatedAtMs: number;
  } | null;
  stats: BrownNoseStats;
  queued: QueuedFire[];
  recentFires: FireRecord[];
  decisions: StoredDecision[];
  workspace: { currentNotes: string | null; files: WorkspaceFile[] };
};

export type InvokeResult = {
  decision: StoredDecision;
  enqueue?: { enqueued: boolean; jobId?: string; jitteredFireAtMs?: number; reason?: string };
};

/** List every session with brown-nose summary + globals. */
export function useBrownNoseList() {
  return useQuery({
    queryKey: ["brownnose", "list"],
    queryFn: () =>
      api<{ sessions: BrownNoseRow[]; globals: BrownNoseGlobals; budget: BrownNoseBudget }>(
        "/api/brownnose",
      ),
    refetchInterval: 15_000,
  });
}

export function useBrownNoseDetail(sessionKey: string | null) {
  return useQuery({
    queryKey: ["brownnose", "detail", sessionKey],
    enabled: !!sessionKey,
    queryFn: () => api<BrownNoseDetail>(`/api/brownnose/${encodeURIComponent(sessionKey!)}`),
    refetchInterval: 10_000,
  });
}

export function useEnable() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (sessionKey: string) =>
      api(`/api/brownnose/${encodeURIComponent(sessionKey)}/enable`, { method: "POST" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["brownnose"] }),
  });
}

export function useDisable() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ sessionKey, reason }: { sessionKey: string; reason?: string }) =>
      api(`/api/brownnose/${encodeURIComponent(sessionKey)}/disable`, {
        method: "POST",
        body: { reason: reason ?? "dashboard" },
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["brownnose"] }),
  });
}

export function useReset() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (sessionKey: string) =>
      api(`/api/brownnose/${encodeURIComponent(sessionKey)}/reset`, { method: "POST" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["brownnose"] }),
  });
}

export function useClearSnooze() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (sessionKey: string) =>
      api(`/api/brownnose/${encodeURIComponent(sessionKey)}/snooze/clear`, { method: "POST" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["brownnose"] }),
  });
}

/** Cancel a queued (not-yet-fired) brown-nose. */
export function useCancelQueued() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ sessionKey, jobId }: { sessionKey: string; jobId: string }) =>
      api(
        `/api/brownnose/${encodeURIComponent(sessionKey)}/queued/${encodeURIComponent(jobId)}/cancel`,
        { method: "POST" },
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["brownnose"] }),
  });
}

/** Move a queued brown-nose to a new fire time (extends payload expiry if needed). */
export function useRescheduleQueued() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      sessionKey,
      jobId,
      atMs,
    }: {
      sessionKey: string;
      jobId: string;
      atMs: number;
    }) =>
      api<{ ok: boolean; nextFireMs: number; expiryExtended: boolean }>(
        `/api/brownnose/${encodeURIComponent(sessionKey)}/queued/${encodeURIComponent(jobId)}/reschedule`,
        { method: "POST", body: { atMs } },
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["brownnose"] }),
  });
}

/** Replace a session's allowed brown-nose hours (and optionally timezone). */
export function useSetHours() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      sessionKey,
      activeHours,
      timezone,
    }: {
      sessionKey: string;
      activeHours: Array<{ dow: string; start: string; end: string }>;
      timezone?: string;
    }) =>
      api(`/api/brownnose/${encodeURIComponent(sessionKey)}/hours`, {
        method: "POST",
        body: { activeHours, timezone },
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["brownnose"] }),
  });
}

/** Force a real ghost tick. The tick is a tool-using agent run — it can
 *  take several minutes; keep the button in a loading state. */
export function useInvoke() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ sessionKey, fireNow }: { sessionKey: string; fireNow?: boolean }) =>
      api<InvokeResult>(`/api/brownnose/${encodeURIComponent(sessionKey)}/invoke`, {
        method: "POST",
        body: { force: true, fireNow: fireNow ?? false },
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["brownnose"] }),
  });
}
