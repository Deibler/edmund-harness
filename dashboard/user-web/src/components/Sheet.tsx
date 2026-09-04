import { cn } from "@/lib/utils";
import type { ReactNode } from "react";

/**
 * A sheet of paper: the card everything sits on. Kept deliberately quiet so
 * the type does the talking — one hairline ring, generous padding.
 */
export function Paper({
  title,
  description,
  children,
  className,
  padded = true,
}: {
  title?: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  className?: string;
  padded?: boolean;
}) {
  return (
    <section className={cn("mb-4 rounded-xl bg-card ring-1 ring-foreground/10", className)}>
      {title || description ? (
        <header className="px-4 pt-4 sm:px-5 sm:pt-5">
          {title ? <h2 className="text-[1.15rem] leading-snug">{title}</h2> : null}
          {description ? (
            <p className="mt-1 text-[14px] leading-relaxed text-muted-foreground">{description}</p>
          ) : null}
        </header>
      ) : null}
      <div className={cn(padded ? "p-4 sm:p-5" : "", title || description ? "pt-3 sm:pt-4" : "")}>
        {children}
      </div>
    </section>
  );
}

/** One line of a list: main text, a right-hand thing, a hairline under. */
export function Row({
  children,
  right,
  className,
}: {
  children: ReactNode;
  right?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex items-center justify-between gap-3 border-b border-border/70 py-3 last:border-b-0 last:pb-0 first:pt-0",
        className,
      )}
    >
      <div className="min-w-0 flex-1 [overflow-wrap:anywhere]">{children}</div>
      {right ? <div className="shrink-0">{right}</div> : null}
    </div>
  );
}

/** A status word in small caps. Emerald is reserved for "done"/"good". */
export function Tag({
  tone = "neutral",
  children,
}: {
  tone?: "neutral" | "ok" | "warn" | "bad";
  children: ReactNode;
}) {
  const cls = {
    neutral: "bg-secondary text-muted-foreground",
    ok: "bg-emerald/10 text-emerald",
    warn: "bg-accent text-accent-foreground",
    bad: "bg-destructive/10 text-destructive",
  }[tone];
  return (
    <span
      className={cn(
        "inline-block rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-[0.08em]",
        cls,
      )}
    >
      {children}
    </span>
  );
}
