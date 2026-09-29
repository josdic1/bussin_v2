import {
  createContext, Suspense, useCallback, useContext, useEffect, useRef, useState, type ReactNode
} from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router";
import { useAuth } from "../auth/AuthProvider";

export type ViewMode = "desktop" | "adv" | "simple";
export type Role = "monitor" | "driver";

type OpsValue = {
  mode: ViewMode;
  role: Role;
  isAdmin: boolean;
  toast: (message: string) => void;
};

const OpsContext = createContext<OpsValue | null>(null);

export function useOps(): OpsValue {
  const value = useContext(OpsContext);
  if (!value) throw new Error("useOps requires OpsShell");
  return value;
}

/** Browser storage is a per-viewer convenience only; every read and write may fail. */
function readSetting(key: string) {
  try { return window.localStorage.getItem(key); } catch { return null; }
}
function writeSetting(key: string, value: string) {
  try { window.localStorage.setItem(key, value); } catch { /* storage unavailable */ }
}

const DESKTOP_MIN = 1024;

type Page = { path: string; mark: string; label: string; adminOnly?: boolean };

const MONITOR_PAGES: Page[] = [
  { path: "/", mark: "D", label: "Dispatch" },
  { path: "/check", mark: "C", label: "Check" },
  { path: "/fleet", mark: "F", label: "Fleet" },
  { path: "/members", mark: "M", label: "Members", adminOnly: true },
  { path: "/families", mark: "R", label: "Riders", adminOnly: true },
  { path: "/transit", mark: "T", label: "Transit" }
];
const DRIVER_PAGES: Page[] = MONITOR_PAGES.map((page) =>
  page.path === "/check" ? { path: "/mybus", mark: "B", label: "My Bus" } : page);

const LockClosed = () => <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor"
  strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
  <rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></svg>;
const LockOpen = () => <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor"
  strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
  <rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V8a4 4 0 0 1 7.5-2" /></svg>;

function RoleControl({ role, setRole, toast }: {
  role: Role; setRole: (role: Role) => void; toast: (message: string) => void;
}) {
  const [locked, setLocked] = useState(true);
  const lastClick = useRef(0);
  const relock = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(relock.current), []);

  function changeLock(next: boolean) {
    setLocked(next);
    window.clearTimeout(relock.current);
    if (!next) relock.current = window.setTimeout(() => setLocked(true), 10_000);
  }

  function clickLock() {
    const now = Date.now();
    if (now - lastClick.current < 450) {
      changeLock(!locked);
      lastClick.current = 0;
    } else {
      lastClick.current = now;
      toast(locked ? "Double-click the lock to unlock" : "Double-click the lock to lock");
    }
  }

  function choose(next: Role) {
    if (locked) {
      toast("Locked. Double-click the lock to change mode.");
      return;
    }
    setRole(next);
    changeLock(true);
  }

  return <div className={`rolectl ${locked ? "locked" : "open"}`}>
    <button type="button" className="lockbtn" onClick={clickLock}
      aria-label={locked ? "Locked. Double-click to unlock mode switch" : "Unlocked. Double-click to lock"}
      title={locked ? "Double-click to unlock" : "Double-click to lock"}>
      {locked ? <LockClosed /> : <LockOpen />}
    </button>
    <div className="rseg" role="group" aria-label="Mode">
      {(["monitor", "driver"] as const).map((item) => <button key={item} type="button"
        className={role === item ? "on" : ""} aria-disabled={locked || undefined}
        aria-pressed={role === item} onClick={() => choose(item)}>
        {item === "monitor" ? "Monitor" : "Driver"}
      </button>)}
    </div>
  </div>;
}

export function OpsShell() {
  const { member, tenant, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [width, setWidth] = useState(() => window.innerWidth);
  const [simple, setSimple] = useState(() => readSetting("bussin.phoneView") !== "advanced");
  const [role, setRoleState] = useState<Role>(() =>
    readSetting("bussin.role") === "driver" ? "driver" : "monitor");
  const [toastText, setToastText] = useState("");
  const [toastShown, setToastShown] = useState(false);
  const toastTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    let timer: number | undefined;
    const resize = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setWidth(window.innerWidth), 120);
    };
    window.addEventListener("resize", resize);
    return () => { window.removeEventListener("resize", resize); window.clearTimeout(timer); };
  }, []);

  const toast = useCallback((message: string) => {
    setToastText(message);
    setToastShown(true);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToastShown(false), 2600);
  }, []);

  const mode: ViewMode = width >= DESKTOP_MIN ? "desktop" : simple ? "simple" : "adv";
  const isAdmin = member?.roles.includes("admin") ?? false;
  const pages = (role === "driver" ? DRIVER_PAGES : MONITOR_PAGES)
    .filter((page) => !page.adminOnly || isAdmin);

  // The URL is the source of truth for the page; keep it consistent with the role.
  useEffect(() => {
    if (role === "driver" && location.pathname === "/check") navigate("/mybus", { replace: true });
    if (role === "monitor" && location.pathname === "/mybus") navigate("/check", { replace: true });
  }, [role, location.pathname, navigate]);

  function setRole(next: Role) {
    setRoleState(next);
    writeSetting("bussin.role", next);
  }

  function setPhoneView(nextSimple: boolean) {
    setSimple(nextSimple);
    writeSetting("bussin.phoneView", nextSimple ? "simple" : "advanced");
    window.scrollTo(0, 0);
  }

  const framed = mode !== "desktop" && width > 430;
  const signOut = () => { void logout().catch(() => toast("Could not sign out. Try again.")); };
  const roleControl = <RoleControl role={role} setRole={setRole} toast={toast} />;
  const tenantName = tenant?.name ?? "Bussin";

  const body = mode === "desktop"
    ? <div className="app d">
      <aside className="rail">
        <div className="brand" aria-label="Bussin">B</div>
        <nav aria-label="Main">
          {pages.map((page) => <NavLink key={page.path} to={page.path} end={page.path === "/"}
            className={({ isActive }) => `rail-link${isActive ? " on" : ""}`}
            title={page.label} aria-label={page.label}>{page.mark}</NavLink>)}
        </nav>
      </aside>
      <div className="ws">
        <header className="top">
          <span>BUSSIN / {role === "driver" ? "DRIVER" : "OPERATIONS"}</span>
          <div><span>{tenantName}</span>{roleControl}
            <button type="button" onClick={signOut}>Sign out</button></div>
        </header>
        <main className="content"><Suspense fallback={<p className="hint">Loading…</p>}><Outlet /></Suspense></main>
      </div>
    </div>
    : <div className={`app m ${mode}`}>
      <div className="mtop"><span>{tenantName}</span>{roleControl}</div>
      <main className="mc"><Suspense fallback={<p className="hint">Loading…</p>}><Outlet /></Suspense></main>
      <div className="mfoot">
        <button type="button" onClick={() => setPhoneView(mode !== "simple")}>
          {mode === "simple" ? "Switch to advanced view" : "Switch to simple view"}
        </button>
        <span className="dim"> · </span>
        <button type="button" onClick={signOut}>Sign out</button>
      </div>
      <nav className="tabs" aria-label="Main" style={{ gridTemplateColumns: `repeat(${pages.length},1fr)` }}>
        {pages.map((page) => <NavLink key={page.path} to={page.path} end={page.path === "/"}
          className={({ isActive }) => isActive ? "on" : ""}>
          <span>{page.mark}</span>{page.label}
        </NavLink>)}
      </nav>
    </div>;

  return <OpsContext.Provider value={{ mode, role, isAdmin, toast }}>
    <div className={`ops${framed ? " framed" : ""}`}>
      {body}
      <div className={`toast${toastShown ? " show" : ""}`} role="status" aria-live="polite">{toastText}</div>
    </div>
  </OpsContext.Provider>;
}

/** Drawer on desktop, bottom sheet on phones. Escape and backdrop close it. */
export function Overlay({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  const { mode } = useOps();
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") close.current(); };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, []);

  const backdrop = (event: React.MouseEvent) => { if (event.target === event.currentTarget) onClose(); };

  return mode === "desktop"
    ? <div className="bd" onMouseDown={backdrop}>
      <aside className="drawer" role="dialog" aria-modal="true">
        <button className="close" type="button" onClick={onClose}>Close</button>
        {children}
      </aside>
    </div>
    : <div className="bd sh" onMouseDown={backdrop}>
      <div className="sheet" role="dialog" aria-modal="true">
        <div className="grab" />
        <button className="close" type="button" onClick={onClose}>Close</button>
        {children}
      </div>
    </div>;
}
