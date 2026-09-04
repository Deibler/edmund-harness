import type { ReactNode } from "react";

/** A section's opening: serif title, one plain sentence under it. */
export function PageTitle({
  title,
  lede,
  aside,
}: { title: string; lede?: ReactNode; aside?: ReactNode }) {
  return (
    <div className="mb-6 flex items-start justify-between gap-4">
      <div className="min-w-0">
        <h1 className="text-[1.75rem] leading-tight">{title}</h1>
        {lede ? (
          <p className="mt-1.5 text-[15px] leading-relaxed text-muted-foreground">{lede}</p>
        ) : null}
      </div>
      {aside ? <div className="shrink-0 pt-1">{aside}</div> : null}
    </div>
  );
}

/** A small uppercase label above a group of things. */
export function Eyebrow({ children }: { children: ReactNode }) {
  return (
    <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
      {children}
    </div>
  );
}

/** Nothing to show, said plainly. */
export function Empty({ children }: { children: ReactNode }) {
  return <p className="py-8 text-center text-[15px] text-muted-foreground">{children}</p>;
}

/** A big number with a small label — the serif does the work. */
export function Stat({
  value,
  label,
  onClick,
}: { value: ReactNode; label: string; onClick?: () => void }) {
  const inner = (
    <>
      <div className="font-heading tnum text-[1.65rem] leading-none text-foreground">{value}</div>
      <div className="mt-1.5 text-[12.5px] text-muted-foreground">{label}</div>
    </>
  );
  const cls = "rounded-xl bg-card px-4 py-3.5 ring-1 ring-foreground/10 text-left";
  return onClick ? (
    <button
      type="button"
      onClick={onClick}
      className={`${cls} transition-colors hover:ring-foreground/25`}
    >
      {inner}
    </button>
  ) : (
    <div className={cls}>{inner}</div>
  );
}
