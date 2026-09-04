import { cn } from "@/lib/cn";
import * as T from "@radix-ui/react-toast";
import { type PropsWithChildren, createContext, useCallback, useContext, useState } from "react";

type ToastItem = {
  id: number;
  title: string;
  description?: string;
  tone: "ok" | "danger" | "info";
};

type Ctx = { push: (t: Omit<ToastItem, "id">) => void };
const ToastCtx = createContext<Ctx | null>(null);

export function useToast() {
  const ctx = useContext(ToastCtx);
  if (!ctx) throw new Error("useToast outside ToastProvider");
  return ctx;
}

export function ToastProvider({ children }: PropsWithChildren) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const push = useCallback((t: Omit<ToastItem, "id">) => {
    setItems((cur) => [...cur, { ...t, id: Date.now() + Math.random() }]);
  }, []);
  return (
    <ToastCtx.Provider value={{ push }}>
      <T.Provider swipeDirection="right">
        {children}
        {items.map((i) => (
          <T.Root
            key={i.id}
            onOpenChange={(open) => {
              if (!open) setItems((cur) => cur.filter((x) => x.id !== i.id));
            }}
            className={cn(
              "rounded-lg border px-4 py-3 shadow-lg bg-card",
              i.tone === "ok" && "border-ok/40",
              i.tone === "danger" && "border-danger/40",
              i.tone === "info" && "border-border",
            )}
            duration={4000}
          >
            <T.Title className="text-sm font-medium text-fg">{i.title}</T.Title>
            {i.description ? (
              <T.Description className="text-xs text-muted mt-1">{i.description}</T.Description>
            ) : null}
          </T.Root>
        ))}
        <T.Viewport className="fixed top-4 right-4 z-50 flex w-80 flex-col gap-2" />
      </T.Provider>
    </ToastCtx.Provider>
  );
}
