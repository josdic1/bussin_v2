import { useState, type FormEvent } from "react";
import { Navigate, NavLink, Outlet, Route, Routes } from "react-router";
import { useAuth } from "./auth/AuthProvider";
import { FleetPage } from "./fleet/FleetPage";

const pages = [
  { path: "/", label: "Dispatch", mark: "D" },
  { path: "/fleet", label: "Fleet", mark: "F" },
  { path: "/members", label: "Members", mark: "M" },
  { path: "/transit", label: "Transit", mark: "T" }
];

function AuthScreen({
  title,
  description,
  children
}: {
  title: string;
  description: string;
  children?: React.ReactNode;
}) {
  return (
    <main className="auth-screen">
      <section className="auth-card">
        <div className="auth-brand">B</div>
        <p className="eyebrow">BUSSIN / JCC</p>
        <h1>{title}</h1>
        <p className="description">{description}</p>
        {children}
      </section>
    </main>
  );
}

function Login() {
  const { login } = useAuth();
  const [identity, setIdentity] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setBusy(true);

    try {
      await login(identity, password);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not sign in.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthScreen
      title="Sign in"
      description="Enter your Bussin username or email."
    >
      <form className="auth-form" onSubmit={submit}>
        <label htmlFor="login-identity">Username or email</label>
        <input
          id="login-identity"
          autoComplete="username"
          required
          value={identity}
          onChange={(event) => setIdentity(event.target.value)}
        />

        <label htmlFor="login-password">Password</label>
        <input
          id="login-password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />

        {error && <p className="auth-error" role="alert">{error}</p>}
        <button className="auth-button" disabled={busy}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </AuthScreen>
  );
}

function ChangePassword() {
  const { changePassword, logout } = useAuth();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");

    if (newPassword !== confirmation) {
      setError("New passwords do not match.");
      return;
    }

    setBusy(true);
    try {
      await changePassword(currentPassword, newPassword);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not change password.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthScreen
      title="Set your password"
      description="Change the starter password before using Bussin."
    >
      <form className="auth-form" onSubmit={submit}>
        <label htmlFor="current-password">Current password</label>
        <input
          id="current-password"
          type="password"
          autoComplete="current-password"
          required
          value={currentPassword}
          onChange={(event) => setCurrentPassword(event.target.value)}
        />

        <label htmlFor="new-password">New password</label>
        <input
          id="new-password"
          type="password"
          autoComplete="new-password"
          minLength={12}
          required
          value={newPassword}
          onChange={(event) => setNewPassword(event.target.value)}
        />

        <label htmlFor="confirm-password">Confirm new password</label>
        <input
          id="confirm-password"
          type="password"
          autoComplete="new-password"
          required
          value={confirmation}
          onChange={(event) => setConfirmation(event.target.value)}
        />

        {error && <p className="auth-error" role="alert">{error}</p>}
        <button className="auth-button" disabled={busy}>
          {busy ? "Saving…" : "Change password"}
        </button>
      </form>
      <button className="auth-text-button" onClick={() => void logout()}>
        Sign out
      </button>
    </AuthScreen>
  );
}

function AuthGate() {
  const { member, loadError } = useAuth();

  if (loadError) {
    return (
      <AuthScreen title="Connection unavailable" description={loadError}>
        <button className="auth-button" onClick={() => location.reload()}>
          Retry
        </button>
      </AuthScreen>
    );
  }

  if (member === undefined) {
    return <AuthScreen title="Opening Bussin" description="Checking your session…" />;
  }

  if (member === null) return <Login />;
  if (member.passwordChangeRequired) return <ChangePassword />;

  if (!member.roles.some((role) => role === "admin" || role === "dispatch")) {
    return (
      <AuthScreen
        title="Portal coming soon"
        description="Your account is active. Your portal is being built."
      >
        <SignOut />
      </AuthScreen>
    );
  }

  return <Outlet />;
}

function SignOut() {
  const { logout } = useAuth();
  const [error, setError] = useState("");

  async function signOut() {
    try {
      await logout();
    } catch {
      setError("Could not sign out. Try again.");
    }
  }

  return (
    <>
      <button className="auth-text-button" onClick={() => void signOut()}>
        Sign out
      </button>
      {error && <span role="alert">{error}</span>}
    </>
  );
}

function AppShell() {
  return (
    <div className="app">
      <aside className="rail">
        <div className="brand" aria-label="Bussin">B</div>
        <nav aria-label="Main navigation">
          {pages.map((page) => (
            <NavLink
              key={page.path}
              to={page.path}
              end={page.path === "/"}
              className={({ isActive }) =>
                `rail-link${isActive ? " rail-link-active" : ""}`
              }
              aria-label={page.label}
              title={page.label}
            >
              {page.mark}
            </NavLink>
          ))}
        </nav>
      </aside>

      <div className="workspace">
        <header className="topbar">
          <span>BUSSIN / OPERATIONS</span>
          <div className="topbar-actions">
            <span>JCC</span>
            <SignOut />
          </div>
        </header>
        <main className="content">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

function Page({ title, description }: { title: string; description: string }) {
  return (
    <>
      <p className="eyebrow">OPERATIONS</p>
      <h1>{title}</h1>
      <p className="description">{description}</p>
      <section className="empty-state">
        <span className="empty-mark" aria-hidden="true">○</span>
        <h2>No data yet</h2>
        <p>This page will show information from the new Bussin system.</p>
      </section>
    </>
  );
}

export function App() {
  return (
    <Routes>
      <Route element={<AuthGate />}>
        <Route element={<AppShell />}>
          <Route index element={<Page title="Dispatch" description="Monitor every active bus in one place." />} />
          <Route path="fleet" element={<FleetPage />} />
          <Route path="members" element={<Page title="Members" description="Manage staff and family access." />} />
          <Route path="transit" element={<Page title="Transit" description="See each trip and every recorded event." />} />
        </Route>
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
