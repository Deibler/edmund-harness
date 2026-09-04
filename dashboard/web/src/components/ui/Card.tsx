import { cn } from "@/lib/cn";
import type { HTMLAttributes, PropsWithChildren } from "react";

export function Card({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("bg-card border border-border rounded-xl overflow-hidden", className)}
      {...rest}
    />
  );
}

export function CardHeader({
  title,
  subtitle,
  right,
}: PropsWithChildren<{ title: string; subtitle?: string; right?: React.ReactNode }>) {
  return (
    <div className="flex items-start justify-between gap-3 px-4 py-3 border-b border-border">
      <div>
        <h3 className="text-sm font-semibold text-fg">{title}</h3>
        {subtitle ? <p className="text-xs text-muted mt-0.5">{subtitle}</p> : null}
      </div>
      {right}
    </div>
  );
}

export function CardBody({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("p-4", className)} {...rest} />;
}
