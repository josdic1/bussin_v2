import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode
} from "react";
import {
  authResponseSchema,
  changePasswordSchema,
  loginSchema,
  type SignedInMember
} from "@bussin/shared";

type AuthValue = {
  member: SignedInMember | null | undefined;
  tenant: { key: string; name: string } | null;
  loadError: string | null;
  login: (identity: string, password: string) => Promise<void>;
  changePassword: (currentPassword: string, newPassword: string) => Promise<void>;
  logout: () => Promise<void>;
};

const AuthContext = createContext<AuthValue | null>(null);

async function responseError(response: Response): Promise<Error> {
  const body: unknown = await response.json().catch(() => null);
  if (
    body !== null &&
    typeof body === "object" &&
    "error" in body &&
    typeof body.error === "string"
  ) {
    return new Error(body.error);
  }
  return new Error(`Request failed (${response.status})`);
}

export function AuthProvider({ children }: { children: ReactNode }) {
  // undefined means we have not checked the existing session yet.
  const [member, setMember] = useState<SignedInMember | null | undefined>();
  const [tenant, setTenant] = useState<{ key: string; name: string } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    let retryTimer: number | null = null;

    // A redeploy or dead zone must not strand the phone: keep retrying every
    // 3s, show "can't connect" meanwhile, and clear it the moment the server answers.
    async function loadSession() {
      const attempt = new AbortController();
      const stop = () => attempt.abort();
      controller.signal.addEventListener("abort", stop);
      const attemptTimeout = window.setTimeout(stop, 10_000);
      try {
        const response = await fetch("/api/auth/me", {
          signal: attempt.signal,
          credentials: "same-origin"
        });

        if (response.status === 401) {
          setMember(null);
          setTenant(null);
        } else if (response.ok) {
          const data = authResponseSchema.parse(await response.json());
          setMember(data.member);
          setTenant(data.tenant);
        } else {
          throw await responseError(response);
        }
        setLoadError(null);
      } catch {
        if (!controller.signal.aborted) {
          setLoadError("Cannot reach the Bussin server. Retrying...");
          retryTimer = window.setTimeout(() => void loadSession(), 3_000);
        }
      } finally {
        window.clearTimeout(attemptTimeout);
        controller.signal.removeEventListener("abort", stop);
      }
    }

    void loadSession();
    return () => {
      controller.abort();
      if (retryTimer !== null) window.clearTimeout(retryTimer);
    };
  }, []);

  async function login(identity: string, password: string) {
    const body = loginSchema.parse({ identity, password });
    const response = await fetch("/api/auth/login", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });

    if (!response.ok) throw await responseError(response);
    const data = authResponseSchema.parse(await response.json());
    setMember(data.member);
    setTenant(data.tenant);
    setLoadError(null);
  }

  async function changePassword(
    currentPassword: string,
    newPassword: string
  ) {
    const body = changePasswordSchema.parse({
      currentPassword,
      newPassword
    });

    const response = await fetch("/api/auth/change-password", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });

    if (!response.ok) throw await responseError(response);
    setMember(null); // The server revoked all sessions. Sign in again.
    setTenant(null);
  }

  async function logout() {
    const response = await fetch("/api/auth/logout", {
      method: "POST",
      credentials: "same-origin"
    });

    if (!response.ok) throw await responseError(response);
    setMember(null);
    setTenant(null);
  }

  return (
    <AuthContext.Provider
      value={{ member, tenant, loadError, login, changePassword, logout }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth requires AuthProvider");
  return context;
}
