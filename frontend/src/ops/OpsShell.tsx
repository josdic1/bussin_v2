import {
  createContext, Suspense, useCallback, useContext, useEffect, useRef, useState, type ReactNode
} from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router";
import { useAuth } from "../auth/AuthProvider";
import { initials } from "./format";
import { DangerZone } from "./DangerZone";

/** Desktop gets the sidebar and three-pane layouts; phones get stacked cards and bottom tabs. */
export type ViewMode = "desktop" | "adv";
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

type Page = { path: string; mark: string; label: string; group: "live" | "records"; adminOnly?: boolean; desktopOnly?: boolean };

const MONITOR_PAGES: Page[] = [
  { path: "/", mark: "D", label: "Dispatch", group: "live" },
  { path: "/check", mark: "RC", label: "Ride Check", group: "live" },
  { path: "/fleet", mark: "F", label: "Fleet", group: "live" },
  { path: "/routes", mark: "RT", label: "Routes", group: "live", desktopOnly: true },
  { path: "/members", mark: "M", label: "Members", group: "records", adminOnly: true },
  { path: "/families", mark: "R", label: "Riders", group: "records", adminOnly: true },
  { path: "/messages", mark: "MS", label: "Messages", group: "records", adminOnly: true },
  { path: "/transit", mark: "T", label: "Transit", group: "records" }
];
/** Driver mode never shows child counts: Ride Check becomes My Bus. */
const DRIVER_PAGES: Page[] = MONITOR_PAGES.map((page) =>
  page.path === "/check" ? { ...page, path: "/mybus", mark: "MB", label: "My Bus" } : page);

const LockClosed = () => <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor"
  strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
  <rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></svg>;
const LockOpen = () => <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor"
  strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
  <rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V8a4 4 0 0 1 7.5-2" /></svg>;

/** Monitor/Driver switch behind a lock: double-click to unlock, relocks after 10s or a change. */
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

  const mode: ViewMode = width >= DESKTOP_MIN ? "desktop" : "adv";
  const isAdmin = member?.roles.includes("admin") ?? false;
  const pages = (role === "driver" ? DRIVER_PAGES : MONITOR_PAGES)
    .filter((page) => !page.adminOnly || isAdmin);
  const current = pages.find((page) => page.path === "/" ? location.pathname === "/" : location.pathname.startsWith(page.path));

  // The URL is the source of truth for the page; keep it consistent with the role.
  useEffect(() => {
    if (role === "driver" && location.pathname === "/check") navigate("/mybus", { replace: true });
    if (role === "monitor" && location.pathname === "/mybus") navigate("/check", { replace: true });
  }, [role, location.pathname, navigate]);

  function setRole(next: Role) {
    setRoleState(next);
    writeSetting("bussin.role", next);
    toast(next === "driver" ? "Driver mode. Child counts are hidden." : "Monitor mode.");
  }

  const signOut = () => { void logout().catch(() => toast("Could not sign out. Try again.")); };
  const roleControl = <RoleControl role={role} setRole={setRole} toast={toast} />;
  const tenantName = tenant?.name ?? "Bussin";
  const name = member?.display_name ?? "";
  const link = (page: Page) => <NavLink key={page.path} to={page.path} end={page.path === "/"}
    className={({ isActive }) => isActive ? "on" : ""}>
    <span className="ico">{page.mark}</span>{page.label}
  </NavLink>;

  const body = mode === "desktop"
    ? <div className="app d">
      <aside className="sidebar">
        <div className="brand"><div className="brandmark" aria-hidden="true">B</div>
          <div><b>BUSSIN</b><small>{tenantName}</small></div></div>
        <div className="nav-label">Live operations</div>
        <nav className="nav" aria-label="Live operations">{pages.filter((page) => page.group === "live").map(link)}</nav>
        <div className="nav-label">People and records</div>
        <nav className="nav" aria-label="People and records">{pages.filter((page) => page.group === "records").map(link)}</nav>
        <div className="side-foot">
          {isAdmin && <DangerZone />}
          {roleControl}
          <div className="who-row"><div><b>{name}</b>{isAdmin ? "Admin" : "Dispatch"}</div>
            <button type="button" onClick={signOut}>Sign out</button></div>
        </div>
      </aside>
      <div className="ws">
        <header className="topbar">
          <div className="crumb">BUSSIN / {current?.label ?? "Operations"}</div>
          <div className="top-actions">
            {location.pathname === "/" && <span className="hint"><span className="kbd">J</span><span className="kbd">K</span> buses
              <span className="kbd">Esc</span> close</span>}
            <span className="avatar" title={name}>{initials(name)}</span>
          </div>
        </header>
        <main className="content"><Suspense fallback={<p className="hint">Loading…</p>}><Outlet /></Suspense></main>
      </div>
    </div>
    : <div className="app m adv">
      <div className="mtop">
        <div className="brand"><div className="brandmark" aria-hidden="true">B</div><div><b>BUSSIN</b><small>{tenantName}</small></div></div>
        {roleControl}
      </div>
      <main className="mc">
        <Suspense fallback={<p className="hint">Loading…</p>}><Outlet /></Suspense>
        <div className="mfoot"><button type="button" onClick={signOut}>Sign out {name}</button>
          {isAdmin && <> · <DangerZone compact /></>}</div>
      </main>
      <nav className="tabs" aria-label="Main" style={{ gridTemplateColumns: `repeat(${pages.filter((page) => !page.desktopOnly).length},1fr)` }}>
        {pages.filter((page) => !page.desktopOnly).map((page) => <NavLink key={page.path} to={page.path} end={page.path === "/"}
          className={({ isActive }) => isActive ? "on" : ""}>
          <span>{page.mark}</span>{page.label}
        </NavLink>)}
      </nav>
    </div>;

  return <OpsContext.Provider value={{ mode, role, isAdmin, toast }}>
    <div className="ops">
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
