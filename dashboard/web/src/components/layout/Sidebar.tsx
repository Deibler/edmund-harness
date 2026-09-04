import { cn } from "@/lib/cn";
import { NavLink } from "react-router-dom";

type Item = { to: string; label: string };
type Group = { title: string; items: Item[] };
type Region = { title?: string; groups: Group[] };

/**
 * Two-level sidebar. Top-level regions (Activity / State / Ops / Config)
 * stay visible at all times. Inside Config, sub-groups (Conversation,
 * iMessage, Models, etc.) collect related config sections so the nav
 * doesn't read as one long flat list. The settings sections live here
 * statically — we used to derive them from SECTIONS but the order +
 * grouping is editorial, not data-driven.
 */
const regions: Region[] = [
  {
    title: "Activity",
    groups: [
      {
        title: "",
        items: [
          { to: "/", label: "Overview" },
          { to: "/sessions", label: "Sessions" },
          { to: "/credits", label: "Credits" },
          { to: "/cron", label: "Cron" },
          { to: "/agents", label: "Agents" },
          { to: "/bgjobs", label: "Bg jobs" },
          { to: "/brownnose", label: "Brown nose" },
        ],
      },
    ],
  },
  {
    title: "State",
    groups: [
      {
        title: "",
        items: [
          { to: "/recall", label: "Recall" },
          { to: "/people", label: "People" },
          { to: "/annotations", label: "Annotate" },
          { to: "/media", label: "Media" },
          { to: "/logs", label: "Logs" },
        ],
      },
    ],
  },
  {
    title: "Ops",
    groups: [
      {
        title: "",
        items: [
          { to: "/orchestrator", label: "Orchestrator" },
          { to: "/recovery", label: "Recovery" },
          { to: "/alerts", label: "Alerts" },
          { to: "/skills", label: "Skills" },
          { to: "/daemon", label: "Daemon" },
        ],
      },
    ],
  },
  {
    title: "Config",
    groups: [
      {
        title: "Conversation",
        items: [
          { to: "/settings/behavior", label: "Behavior" },
          { to: "/settings/identity", label: "Identity" },
          { to: "/settings/self", label: "Self handles" },
          { to: "/settings/allowlist", label: "Allowlist" },
          { to: "/contacts", label: "Contacts" },
        ],
      },
      {
        title: "iMessage",
        items: [
          { to: "/settings/imessage_watcher", label: "Watcher" },
          { to: "/settings/imessage_send", label: "Send" },
          { to: "/settings/imessage_actions", label: "Actions" },
          { to: "/settings/outbound", label: "Outbound mode" },
        ],
      },
      {
        title: "Models",
        items: [
          { to: "/models", label: "Model picker" },
          { to: "/settings/claude", label: "Claude" },
          { to: "/settings/claude_pool", label: "Claude pool" },
          { to: "/settings/claude_auto_compact", label: "Auto-compact" },
          { to: "/settings/openrouter", label: "OpenRouter" },
          { to: "/settings/tools", label: "Tools" },
        ],
      },
      {
        title: "Proactive",
        items: [
          { to: "/settings/brown_nose", label: "Brown-nose" },
          { to: "/settings/people_maintainer", label: "People maintainer" },
        ],
      },
      {
        title: "Memory",
        items: [
          { to: "/settings/memory_recall", label: "Recall (index)" },
          { to: "/settings/memory_recall_auto", label: "Recall (auto-recall)" },
        ],
      },
      {
        title: "Integrations",
        items: [
          { to: "/settings/skills_marketplace", label: "Skills marketplace" },
          { to: "/settings/cloudflare", label: "Cloudflare" },
          { to: "/settings/keys", label: "API keys" },
        ],
      },
      {
        title: "System",
        items: [
          { to: "/settings/recovery", label: "Recovery sweeper" },
          { to: "/settings/alerts", label: "Operator alerts" },
          { to: "/settings/dashboard", label: "Dashboard" },
          { to: "/settings/paths", label: "Paths" },
        ],
      },
    ],
  },
];

export function Sidebar() {
  return (
    <aside className="hidden md:flex w-56 shrink-0 flex-col border-r border-border bg-card/30">
      <div className="px-4 py-5">
        <div className="text-sm font-semibold">edmund-harness</div>
        <div className="text-xs text-muted">dashboard</div>
      </div>
      <nav className="flex-1 px-2 pb-4 overflow-auto">
        {regions.map((region) => (
          <div key={region.title} className="mb-4 last:mb-0">
            {region.title ? (
              <div className="px-3 pt-1 pb-1.5 text-[10px] uppercase tracking-wider font-semibold text-fg/70">
                {region.title}
              </div>
            ) : null}
            {region.groups.map((g, idx) => (
              <div key={g.title || idx} className="mb-1.5 last:mb-0">
                {g.title ? (
                  <div className="px-3 pt-1 pb-0.5 text-[10px] uppercase tracking-wider text-muted">
                    {g.title}
                  </div>
                ) : null}
                <div className="flex flex-col gap-0.5">
                  {g.items.map((i) => (
                    <NavLink
                      key={i.to}
                      to={i.to}
                      end={i.to === "/"}
                      className={({ isActive }) =>
                        cn(
                          "block px-3 py-1 rounded-md text-sm leading-tight",
                          // Sub-group entries are slightly indented to reinforce hierarchy.
                          g.title ? "pl-5" : "",
                          isActive
                            ? "bg-accent/15 text-fg font-medium"
                            : "text-muted hover:text-fg hover:bg-card",
                        )
                      }
                    >
                      {i.label}
                    </NavLink>
                  ))}
                </div>
              </div>
            ))}
          </div>
        ))}
      </nav>
    </aside>
  );
}
