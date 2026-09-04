export type CronJob = {
  id: string;
  /** Session key to deliver into (imessage:dm:... or imessage:group:...) */
  sessionKey: string;
  /** The message the model sees when the job fires. E.g. "Reminder: stand up" */
  systemEvent: string;
  /** Schedule spec — either unix-ms (one-shot) or 5-field cron expr (recurring) */
  schedule: JobSchedule;
  nextFireMs: number;
  createdAt: number;
  lastFiredMs: number | null;
  status: "active" | "done" | "canceled" | "paused";
  /**
   * How many ms past nextFireMs the job may still run. If the daemon was
   * down and resumes 4 hours late, a morning-brief job with gracePeriodMs=
   * 1800000 (30 min) will be skipped rather than fired stale. Null = no
   * grace (always fires when due, used for system events like pokes/retries).
   */
  gracePeriodMs: number | null;
  /**
   * Absolute image paths the fire path should embed as multimodal content
   * blocks on the next model turn. Used when the wake-up references an
   * image the model needs to SEE (not just know the path of) — e.g. a
   * generate_image bg-job completion, or an annotation-submit cron that
   * carries the user's marked-up PNG. Null/undefined = text-only wake-up.
   */
  attachImages: string[] | null;
};

export type JobSchedule =
  | { kind: "once"; atMs: number }
  | { kind: "cron"; expr: string; tz?: string };

export type JobInput = {
  sessionKey: string;
  systemEvent: string;
  schedule: JobSchedule;
  /** Grace period in ms. Defaults to null (no grace) for system events; set
   *  explicitly for user-facing scheduled reminders. */
  gracePeriodMs?: number | null;
  /** See CronJob.attachImages. Omit for text-only wake-ups. */
  attachImages?: string[];
};
