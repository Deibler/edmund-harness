import { Button } from "@/components/ui/Button";
import { useAuth } from "@/features/auth/AuthContext";
import { useLocation } from "react-router-dom";

const crumbs: Record<string, string> = {
  "/": "Overview",
  "/sessions": "Sessions",
  "/cron": "Cron",
  "/agents": "Agents",
  "/logs": "Logs",
  "/media": "Media",
  "/settings": "Settings",
  "/daemon": "Daemon",
};

export function TopBar() {
  const loc = useLocation();
  const { logout } = useAuth();
  const title = crumbs[loc.pathname] ?? (loc.pathname.startsWith("/sessions/") ? "Session" : "—");
  return (
    <header className="flex items-center justify-between h-14 px-5 border-b border-border bg-bg/80 backdrop-blur">
      <div className="text-sm text-muted">
        <span className="text-fg font-medium">{title}</span>
      </div>
      <div className="flex items-center gap-3">
        <span className="text-xs text-muted">LAN / PIN</span>
        <Button variant="ghost" size="sm" onClick={() => void logout()}>
          Log out
        </Button>
      </div>
    </header>
  );
}
