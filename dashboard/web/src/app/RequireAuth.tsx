import { useAuth } from "@/features/auth/AuthContext";
import type { PropsWithChildren } from "react";
import { Navigate, useLocation } from "react-router-dom";

export function RequireAuth({ children }: PropsWithChildren) {
  const { status, loading } = useAuth();
  const loc = useLocation();
  if (loading) {
    return <div className="p-10 text-sm text-muted">Loading…</div>;
  }
  if (!status?.authenticated) {
    return <Navigate to="/login" replace state={{ from: loc.pathname }} />;
  }
  return <>{children}</>;
}
