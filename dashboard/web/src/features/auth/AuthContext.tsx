import { api } from "@/lib/api";
import type { AuthStatus } from "@api/types";
import {
  type PropsWithChildren,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";

type Ctx = {
  status: AuthStatus | null;
  loading: boolean;
  login: (pin: string) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
};

const AuthContext = createContext<Ctx | null>(null);

export function useAuth(): Ctx {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth outside AuthProvider");
  return ctx;
}

export function AuthProvider({ children }: PropsWithChildren) {
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const s = await api<AuthStatus>("/api/auth/status");
      setStatus(s);
    } catch {
      setStatus({ authenticated: false, pinConfigured: false });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    const handler = () => {
      setStatus((s) => (s ? { ...s, authenticated: false } : s));
    };
    window.addEventListener("edh:unauthorized", handler);
    return () => window.removeEventListener("edh:unauthorized", handler);
  }, []);

  const login = useCallback(
    async (pin: string) => {
      await api("/api/auth/login", { method: "POST", body: { pin } });
      await refresh();
    },
    [refresh],
  );

  const logout = useCallback(async () => {
    await api("/api/auth/logout", { method: "POST" });
    setStatus({ authenticated: false, pinConfigured: status?.pinConfigured ?? false });
  }, [status?.pinConfigured]);

  return (
    <AuthContext.Provider value={{ status, loading, login, logout, refresh }}>
      {children}
    </AuthContext.Provider>
  );
}
