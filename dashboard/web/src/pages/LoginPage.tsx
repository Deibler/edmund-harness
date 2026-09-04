import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { useAuth } from "@/features/auth/AuthContext";
import { useEffect, useId, useState } from "react";
import { Navigate, useLocation, useNavigate } from "react-router-dom";

export function LoginPage() {
  const { login, status, loading } = useAuth();
  const nav = useNavigate();
  const pinId = useId();
  const loc = useLocation();
  const [pin, setPin] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: setErr is a stable setState identity
  useEffect(() => setErr(null), [pin]);

  if (loading) return null;
  if (status?.authenticated) {
    const dest = (loc.state as { from?: string } | null)?.from ?? "/";
    return <Navigate to={dest} replace />;
  }

  const pinConfigured = status?.pinConfigured ?? false;

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    try {
      await login(pin);
      nav("/", { replace: true });
    } catch (e) {
      setErr(e instanceof Error ? e.message : "login failed");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-6">
      <form
        onSubmit={onSubmit}
        className="w-full max-w-sm bg-card border border-border rounded-xl p-6 shadow-xl"
      >
        <h1 className="text-lg font-semibold text-fg">edmund-harness</h1>
        <p className="text-xs text-muted mb-5">Enter PIN to continue.</p>
        {!pinConfigured ? (
          <div className="mb-4 rounded-md border border-warn/40 bg-warn/10 p-3 text-xs text-warn">
            PIN not configured. Run{" "}
            <code className="font-mono">bun run dashboard:set-pin &lt;pin&gt;</code>.
          </div>
        ) : null}
        <label className="block text-xs text-muted mb-1" htmlFor={pinId}>
          PIN
        </label>
        <Input
          id={pinId}
          type="password"
          inputMode="numeric"
          autoComplete="one-time-code"
          autoFocus
          value={pin}
          onChange={(e) => setPin(e.target.value)}
          disabled={!pinConfigured || submitting}
        />
        {err ? <p className="text-xs text-danger mt-2">{err}</p> : null}
        <Button
          type="submit"
          variant="primary"
          size="lg"
          className="w-full mt-4"
          disabled={!pinConfigured || submitting || !pin}
        >
          {submitting ? "…" : "Continue"}
        </Button>
      </form>
    </div>
  );
}
