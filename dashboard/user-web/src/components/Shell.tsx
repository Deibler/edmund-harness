import { Wordmark } from "@/components/Wordmark";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import type { TabDef, TabId } from "@/tabs";
import { MenuIcon } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";

type Props = {
  label: string;
  isGroup: boolean;
  tabs: TabDef[];
  active: TabId;
  go: (id: TabId) => void;
  children: ReactNode;
};

/**
 * Layout. One column on a phone: a sticky header (mark, chat name, menu) and
 * a horizontally scrolling row of section names that keeps the current one
 * in view. From 900px the sections move into a left rail and the header
 * loses the menu.
 */
export function Shell({ label, isGroup, tabs, active, go, children }: Props) {
  const [menuOpen, setMenuOpen] = useState(false);
  const stripRef = useRef<HTMLDivElement>(null);

  // Keep the active section visible in the strip.
  useEffect(() => {
    const el = stripRef.current?.querySelector<HTMLElement>(`[data-tab="${active}"]`);
    el?.scrollIntoView({ inline: "center", block: "nearest", behavior: "smooth" });
  }, [active]);

  const pick = (id: TabId) => {
    setMenuOpen(false);
    go(id);
  };

  return (
    <div className="min-h-dvh flex flex-col">
      <header className="sticky top-0 z-40 border-b border-border/70 bg-background/85 backdrop-blur-md supports-[backdrop-filter]:bg-background/70">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-3 px-4 lg:px-6">
          <button type="button" onClick={() => pick("home")} className="shrink-0" aria-label="Home">
            <Wordmark />
          </button>
          <span className="hidden h-5 w-px bg-border sm:block" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate text-[15px] text-muted-foreground">
            {label}
            {isGroup ? <span className="text-muted-foreground/70"> · group</span> : null}
          </span>
          <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
            <SheetTrigger
              render={
                <Button variant="ghost" size="icon" className="lg:hidden" aria-label="Sections" />
              }
            >
              <MenuIcon />
            </SheetTrigger>
            <SheetContent side="right" className="w-[300px] bg-background p-0">
              <div className="flex h-14 items-center border-b border-border/70 px-5">
                <SheetTitle className="font-heading text-lg font-normal">Sections</SheetTitle>
              </div>
              <nav className="flex flex-col p-2" aria-label="Sections">
                {tabs.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => pick(t.id)}
                    className={cn(
                      "flex flex-col items-start rounded-lg px-3 py-2.5 text-left transition-colors",
                      t.id === active ? "bg-secondary" : "hover:bg-secondary/60",
                    )}
                  >
                    <span className="text-[15px] font-medium">{t.name}</span>
                    <span className="text-[13px] text-muted-foreground">{t.desc}</span>
                  </button>
                ))}
              </nav>
            </SheetContent>
          </Sheet>
        </div>

        {/* Section strip — phones and tablets */}
        <div
          ref={stripRef}
          className="lg:hidden flex gap-1 overflow-x-auto px-3 pb-0 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              data-tab={t.id}
              onClick={() => pick(t.id)}
              className={cn(
                "relative shrink-0 px-2.5 pb-2.5 pt-1 text-[14px] font-medium whitespace-nowrap transition-colors",
                t.id === active ? "text-foreground" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {t.name}
              <span
                className={cn(
                  "absolute inset-x-2 bottom-0 h-[2px] rounded-full bg-ink transition-opacity",
                  t.id === active ? "opacity-100" : "opacity-0",
                )}
              />
            </button>
          ))}
        </div>
      </header>

      <div className="mx-auto flex w-full max-w-6xl flex-1 gap-10 px-4 lg:px-6">
        {/* Rail — desktop */}
        <nav
          className="hidden lg:block w-48 shrink-0 pt-10 sticky top-14 self-start max-h-[calc(100dvh-3.5rem)] overflow-y-auto"
          aria-label="Sections"
        >
          <ul className="space-y-0.5">
            {tabs.map((t) => (
              <li key={t.id}>
                <button
                  type="button"
                  onClick={() => pick(t.id)}
                  className={cn(
                    "w-full rounded-md px-3 py-1.5 text-left text-[15px] transition-colors",
                    t.id === active
                      ? "bg-secondary font-medium text-foreground"
                      : "text-muted-foreground hover:text-foreground hover:bg-secondary/60",
                  )}
                >
                  {t.name}
                </button>
              </li>
            ))}
          </ul>
        </nav>

        <main className="min-w-0 flex-1 max-w-2xl pb-24 pt-6 lg:pt-10">{children}</main>
      </div>

      <footer className="border-t border-border/70">
        <div className="mx-auto max-w-6xl px-4 py-6 text-[13px] leading-relaxed text-muted-foreground lg:px-6">
          This page is private to this conversation. The address is the key, so do not forward it.
          If you lose it, text Edmund “send me my portal link”.
        </div>
      </footer>
    </div>
  );
}
