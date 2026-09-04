import { cn } from "@/lib/cn";
import * as T from "@radix-ui/react-tabs";
import type { PropsWithChildren, ReactNode } from "react";

type RootProps = PropsWithChildren<{
  value: string;
  onValueChange: (v: string) => void;
  className?: string;
}>;

export function Tabs({ value, onValueChange, className, children }: RootProps) {
  return (
    <T.Root value={value} onValueChange={onValueChange} className={className}>
      {children}
    </T.Root>
  );
}

export function TabsList({ children }: PropsWithChildren) {
  return (
    <T.List className="flex items-center gap-1 border-b border-border mb-4">{children}</T.List>
  );
}

export function TabsTrigger({ value, children }: { value: string; children: ReactNode }) {
  return (
    <T.Trigger
      value={value}
      className={cn(
        "px-3 py-2 text-sm text-muted data-[state=active]:text-fg data-[state=active]:border-b-2 data-[state=active]:border-accent -mb-px",
      )}
    >
      {children}
    </T.Trigger>
  );
}

export function TabsContent({ value, children }: { value: string; children: ReactNode }) {
  return <T.Content value={value}>{children}</T.Content>;
}
