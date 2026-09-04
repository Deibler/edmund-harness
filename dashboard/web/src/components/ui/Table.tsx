import { cn } from "@/lib/cn";
import type { HTMLAttributes, PropsWithChildren, TdHTMLAttributes, ThHTMLAttributes } from "react";

export function Table({ className, ...rest }: HTMLAttributes<HTMLTableElement>) {
  return (
    <div className="overflow-auto">
      <table className={cn("w-full text-sm", className)} {...rest} />
    </div>
  );
}

export function Thead({ children }: PropsWithChildren) {
  return <thead className="bg-card text-muted text-xs uppercase tracking-wider">{children}</thead>;
}

export function Tr({ className, ...rest }: HTMLAttributes<HTMLTableRowElement>) {
  return <tr className={cn("border-b border-border hover:bg-card/70", className)} {...rest} />;
}

export function Th({ className, ...rest }: ThHTMLAttributes<HTMLTableCellElement>) {
  return (
    <th className={cn("text-left font-medium px-3 py-2 whitespace-nowrap", className)} {...rest} />
  );
}

export function Td({ className, ...rest }: TdHTMLAttributes<HTMLTableCellElement>) {
  return <td className={cn("px-3 py-2 align-middle", className)} {...rest} />;
}
