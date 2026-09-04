import { Shell } from "@/components/Shell";
import { Toaster } from "@/components/ui/sonner";
import { PortalError, loadPage } from "@/lib/api";
import { Analytics } from "@/pages/Analytics";
import { Artifacts } from "@/pages/Artifacts";
import { Credits } from "@/pages/Credits";
import { Files } from "@/pages/Files";
import { Home } from "@/pages/Home";
import { Media } from "@/pages/Media";
import { Memory } from "@/pages/Memory";
import { Privacy } from "@/pages/Privacy";
import { Proactive } from "@/pages/Proactive";
import { Schedules } from "@/pages/Schedules";
import { Skills } from "@/pages/Skills";
import { Tips } from "@/pages/Tips";
import { WhatsNew } from "@/pages/WhatsNew";
import { type TabId, tabFromHash, visibleTabs } from "@/tabs";
import type { PortalPageData } from "@/types";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Wordmark } from "./components/Wordmark";

type State =
  | { kind: "loading" }
  | { kind: "error"; message: string; status: number }
  | { kind: "ready"; data: PortalPageData };

export function App() {
  const [state, setState] = useState<State>({ kind: "loading" });

  const reload = useCallback(async () => {
    try {
      const data = await loadPage();
      setState({ kind: "ready", data });
    } catch (err) {
      const e = err instanceof PortalError ? err : new PortalError("Could not load.", 0);
      setState({ kind: "error", message: e.message, status: e.status });
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Coming back from Stripe: say so once, then clean the address.
  useEffect(() => {
    const q = new URLSearchParams(location.search);
    if (q.get("paid") === "1") {
      history.replaceState(null, "", location.pathname + location.hash);
      toast.success("Payment received. Your credit lands within a minute.");
    }
  }, []);

  return (
    <>
      {state.kind === "ready" ? (
        <Portal data={state.data} reload={reload} />
      ) : state.kind === "error" ? (
        <Gone message={state.message} />
      ) : (
        <Loading />
      )}
      <Toaster position="bottom-center" richColors={false} />
    </>
  );
}

function Portal({ data, reload }: { data: PortalPageData; reload: () => Promise<void> }) {
  const tabs = useMemo(
    () => visibleTabs({ isGroup: data.isGroup, hasCredits: data.credits !== null }),
    [data.isGroup, data.credits],
  );
  const [tab, setTab] = useState<TabId>(() => tabFromHash(location.hash, tabs));

  useEffect(() => {
    const onHash = () => {
      setTab(tabFromHash(location.hash, tabs));
      window.scrollTo({ top: 0 });
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, [tabs]);

  const go = useCallback((id: TabId) => {
    if (location.hash.replace(/^#/, "") === id) return;
    location.hash = id;
  }, []);

  useEffect(() => {
    document.title = `Edmund · ${data.label}`;
  }, [data.label]);

  const page = (() => {
    switch (tab) {
      case "proactive":
        return <Proactive data={data} />;
      case "credits":
        return data.credits ? (
          <Credits data={data} credits={data.credits} />
        ) : (
          <Home data={data} go={go} />
        );
      case "media":
        return <Media data={data} />;
      case "files":
        return <Files data={data} />;
      case "artifacts":
        return <Artifacts data={data} />;
      case "skills":
        return <Skills data={data} />;
      case "whatsnew":
        return <WhatsNew data={data} />;
      case "schedules":
        return <Schedules data={data} reload={reload} />;
      case "analytics":
        return <Analytics data={data} />;
      case "memory":
        return <Memory data={data} />;
      case "tips":
        return <Tips data={data} />;
      case "privacy":
        return <Privacy data={data} reload={reload} />;
      default:
        return <Home data={data} go={go} />;
    }
  })();

  return (
    <Shell label={data.label} isGroup={data.isGroup} tabs={tabs} active={tab} go={go}>
      {page}
    </Shell>
  );
}

function Loading() {
  return (
    <div className="min-h-dvh flex flex-col">
      <header className="h-14 border-b border-border/70 flex items-center px-4">
        <Wordmark />
      </header>
      <div className="mx-auto w-full max-w-2xl px-4 py-8 space-y-4">
        <div className="h-8 w-40 rounded-md bg-muted animate-pulse" />
        <div className="h-4 w-72 rounded-md bg-muted animate-pulse" />
        <div className="grid grid-cols-3 gap-3 pt-4">
          <div className="h-20 rounded-xl bg-muted animate-pulse" />
          <div className="h-20 rounded-xl bg-muted animate-pulse" />
          <div className="h-20 rounded-xl bg-muted animate-pulse" />
        </div>
      </div>
    </div>
  );
}

function Gone({ message }: { message: string }) {
  return (
    <div className="min-h-dvh flex flex-col">
      <header className="h-14 border-b border-border/70 flex items-center px-4">
        <Wordmark />
      </header>
      <main className="mx-auto w-full max-w-md px-6 py-16 text-center">
        <h1 className="text-2xl mb-3">{message}</h1>
        <p className="text-muted-foreground">
          Text Edmund <span className="text-foreground">“send me my portal link”</span> and he will
          send a fresh one.
        </p>
      </main>
    </div>
  );
}
