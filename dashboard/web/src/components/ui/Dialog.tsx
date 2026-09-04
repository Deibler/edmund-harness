import { cn } from "@/lib/cn";
import * as D from "@radix-ui/react-dialog";
import type { PropsWithChildren, ReactNode } from "react";

type Props = PropsWithChildren<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  footer?: ReactNode;
  className?: string;
}>;

export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  footer,
  className,
  children,
}: Props) {
  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm reveal" />
        <D.Content
          className={cn(
            "fixed left-1/2 top-1/2 z-50 w-[92vw] max-w-lg -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-card shadow-xl reveal",
            className,
          )}
        >
          <div className="px-5 py-4 border-b border-border">
            <D.Title className="text-sm font-semibold text-fg">{title}</D.Title>
            {description ? (
              <D.Description className="text-xs text-muted mt-1">{description}</D.Description>
            ) : null}
          </div>
          <div className="px-5 py-4">{children}</div>
          {footer ? (
            <div className="px-5 py-3 border-t border-border flex justify-end gap-2">{footer}</div>
          ) : null}
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}
