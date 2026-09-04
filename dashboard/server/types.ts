/**
 * Shared API types. Imported by both server routes and web hooks so the
 * request/response shape is a single source of truth.
 */

export type AuthStatus = { authenticated: boolean; pinConfigured: boolean };

// ── generation credits (routes/credits.ts) ──────────────────────────

/** One row of the Credits page: a known conversation (or an added person)
 *  with what it pays with right now, live numbers from OpenRouter and Stripe
 *  when they could be read, and what the paywall has done to it. */
export type WalletDto = {
  sessionKey: string;
  handle: string;
  label: string;
  kind: "dm" | "group";
  /** The operator's own DM — house by default, wallet only by explicit flip. */
  isOperator: boolean;
  /** What the NEXT generation will bill to, via the shared resolver. */
  paysWith: "wallet" | "house-operator" | "house-override" | "house-group";
  billingMode: "wallet" | "house";
  hasKey: boolean;
  keyHash: string | null;
  disabled: boolean;
  createdAtMs: number | null;
  /** Last inbound message on this conversation (null = no session yet). */
  lastInboundMs: number | null;
  /** True when the numbers below were read from OpenRouter on this request. */
  live: boolean;
  remainingUsd: number | null;
  usageUsd: number | null;
  limitUsd: number | null;
  /** From Stripe on this request; null when unreadable or not a wallet. */
  paidTotalUsd: number | null;
  creditedTotalUsd: number | null;
  /** limit − (starter + Stripe credit): a gift from the operator when positive. */
  operatorAdjustUsd: number | null;
  payments: PaymentDto[];
  paywallHits: number;
  lastPaywallAtMs: number | null;
  lastPaywallGeneration: "image" | "video" | "audio" | null;
  /** When the live read failed, when the fallback snapshot was taken. */
  lastSeenAtMs: number | null;
};

/** One Stripe payment, read live from Stripe. */
export type PaymentDto = {
  paymentIntent: string;
  checkoutSession: string | null;
  createdMs: number;
  paidUsd: number;
  creditedUsd: number;
  receiptUrl: string | null;
  invoicePdfUrl: string | null;
};

export type CreditEventDto = {
  id: number;
  sessionKey: string;
  handle: string;
  label: string;
  kind:
    | "refused-exhausted"
    | "refused-short"
    | "refused-unavailable"
    | "refused-disabled"
    | "refused-account";
  generation: "image" | "video" | "audio";
  atMs: number;
  remainingUsd: number | null;
  costUsd: number | null;
  detail: string | null;
};

export type CreditsOverviewDto = {
  enabled: boolean;
  provisioningConfigured: boolean;
  stripeConfigured: boolean;
  webhookConfigured: boolean;
  operatorHandle: string;
  settings: {
    starterUsd: number;
    lowWatermarkUsd: number;
    creditRatio: number;
    minTopupUsd: number;
    maxTopupUsd: number;
    presetsUsd: number[];
  };
  wallets: WalletDto[];
  /** Newest paywall hits across everyone. */
  paywall: CreditEventDto[];
  /** How long the live OpenRouter + Stripe reads took for this response. */
  liveMs: number;
};

export type LiabilityDto = {
  accountRemainingUsd: number | null;
  outstandingUsd: number;
  wallets: number;
  walletsRead: number;
  short: boolean;
  checkedAtMs: number;
};

export type SessionSummary = {
  sessionKey: string;
  label: string;
  isGroup: boolean;
  chatGuid: string | null;
  claudeSessionId: string | null;
  lastInboundMs: number;
  lastOutboundMs: number;
  createdAt: number;
  activeCrons: number;
  activeAgents: number;
};

export type CronJobDto = {
  id: string;
  sessionKey: string;
  sessionLabel: string;
  systemEvent: string;
  schedule: unknown;
  scheduleSummary: string;
  kind: "scheduled" | "poke" | "retry" | "agent-done" | "team-done";
  nextFireMs: number;
  createdAt: number;
  lastFiredMs: number | null;
  status: "active" | "canceled" | "done";
};

export type AgentDto = {
  id: string;
  parentSessionKey: string;
  parentSessionLabel: string;
  task: string;
  taskPreview: string;
  status: "pending" | "running" | "done" | "failed" | "canceled";
  pid: number | null;
  spawnedAt: number;
  finishedAt: number | null;
  exitCode: number | null;
  teamId: string | null;
  role: string | null;
  deliveredAt: number | null;
  sandboxPath: string;
  resultPath: string;
  logPath: string;
};

export type LogLine = {
  ts: number;
  level: "debug" | "info" | "warn" | "error" | "plain";
  tag: string | null;
  text: string;
  /** Monotonic ID so the client can dedupe / key a virtualized list. */
  seq: number;
};

export type MediaItem = {
  sessionKey: string | null;
  sessionLabel: string;
  kind: "image" | "video" | "audio" | "other";
  direction: "generated" | "received";
  path: string;
  relativeUrl: string;
  sizeBytes: number;
  mtimeMs: number;
};

export type ChatLine = {
  rowId: number;
  timestampMs: number;
  fromHandle: string;
  fromLabel: string;
  fromMe: boolean;
  text: string;
};

export type DaemonStatus = {
  loaded: boolean;
  running: boolean;
  pid: number | null;
  lastExitCode: number | null;
  debug: "on" | "off" | "unset";
  raw: string;
};

export type ActivityEvent =
  | { kind: "inbound"; ts: number; sessionKey: string; sessionLabel: string; preview: string }
  | { kind: "outbound"; ts: number; sessionKey: string; sessionLabel: string; preview: string }
  | {
      kind: "agent";
      ts: number;
      sessionKey: string;
      sessionLabel: string;
      agentId: string;
      status: AgentDto["status"];
      taskPreview: string;
    }
  | {
      kind: "cron";
      ts: number;
      sessionKey: string;
      sessionLabel: string;
      jobId: string;
      summary: string;
    }
  | { kind: "error"; ts: number; tag: string | null; text: string };

type BgJobDto = {
  id: string;
  sessionKey: string;
  label: string;
  sandboxPath: string;
  toolName: string;
  argsJson: string;
  status: "pending" | "running" | "done" | "failed";
  pid: number | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  resultPath: string | null;
  resultSummary: string | null;
  errorText: string | null;
  wakeFiredAt: number | null;
};

export type AnnotationDto = {
  id: string;
  sessionKey: string;
  sessionLabel: string;
  senderHandle: string;
  imagePath: string;
  instruction: string;
  createdAtMs: number;
  expiresAtMs: number;
  usedAtMs: number | null;
  submittedAtMs: number | null;
  submittedJson: string | null;
  tunnelPid: number | null;
  status: "pending" | "answered" | "expired" | "used";
};

export type SkillDto = {
  name: string;
  source: string;
  version: string | null;
  sha: string | null;
  installedAt: number;
  needsApproval: boolean;
  approvedAt: number | null;
  hasScripts: boolean;
  disabled: boolean;
};

export type RecallCoverage = {
  indexedMsgs: number;
  totalInWindow: number;
  pendingMsgs: number;
  indexedArtifacts: number;
  totalArtifacts: number;
  indexedPeople: number;
  totalPeople: number;
  dbBytes: number;
  lastIndexedAtMs: number | null;
  reindexing: boolean;
};

export type AlertDto = {
  id: number;
  category: string;
  signature: string;
  text: string;
  context: string | null;
  firedAtMs: number;
  delivered: boolean;
};

export type AlertMuteDto = {
  category: string;
  untilMs: number;
};

export type RecoveryRowDto = {
  sessionKey: string;
  label: string;
  lastInboundMs: number | null;
  lastOutboundMs: number | null;
  stuckSeconds: number;
  healFailures: number;
  lastErrorText: string | null;
  cooldownUntilMs: number | null;
};

export type PoolStatsDto = {
  enabled: boolean;
  maxWorkers: number;
  poolSize: number;
  hits: number;
  misses: number;
  rebinds: number;
  deadDiscards: number;
  idleEvictions: number;
  lruEvictions: number;
  windowStartMs: number;
};

type PeopleRunDto = {
  id: number;
  sessionKey: string;
  label: string;
  ranAtMs: number;
  dryRun: boolean;
  filesTouched: string[];
  summary: string;
  errorText: string | null;
};

export type ContactDto = {
  name?: string;
  handles: string[];
  notes?: string;
};

export type OverviewSnapshot = {
  daemon: DaemonStatus;
  sessions: { total: number; dms: number; groups: number };
  agents: { active: number; stuck: number; last24h: number };
  crons: { active: number; nextDueMs: number | null };
  errorsLastHour: number;
  recent: ActivityEvent[];
};
