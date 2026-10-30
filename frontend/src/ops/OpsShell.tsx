import {
  createContext, Suspense, useCallback, useContext, useEffect, useRef, useState, type ReactNode
} from "react";
import { NavLink, Outlet, useLocation } from "react-router";
import { ChangeMyPassword } from "../auth/ChangeMyPassword";
import { useAuth } from "../auth/AuthProvider";
import { initials } from "./format";
import { DangerZone } from "./DangerZone";
import { loadWatch, saveWatch, ViewAsDock, ViewAsPicker, type Watch } from "./ViewAs";

/** Desktop gets the sidebar and three-pane layouts; phones get stacked cards and bottom tabs. */
export type ViewMode = "desktop" | "adv";

type OpsValue = {
  mode: ViewMode;
  /** False for dispatchers, and for an admin using View as: Dispatch. */
  isAdmin: boolean;
  toast: (message: string) => void;
};

const OpsContext = createContext<OpsValue | null>(null);

export function useOps(): OpsValue {
  const value = useContext(OpsContext);
  if (!value) throw new Error("useOps requires OpsShell");
  return value;
}

const DESKTOP_MIN = 1024;

type Page = { path: string; mark: string; label: string; group: "live" | "records"; adminOnly?: boolean; desktopOnly?: boolean };

const PAGES: Page[] = [
  { path: "/", mark: "D", label: "Dispatch", group: "live" },
  { path: "/check", mark: "RC", label: "Ride Check", group: "live" },
  { path: "/fleet", mark: "F", label: "Fleet", group: "live" },
  { path: "/lines", mark: "L", label: "Lines", group: "live" },
  { path: "/team", mark: "TM", label: "Team", group: "records", adminOnly: true },
  { path: "/families", mark: "R", label: "Riders", group: "records", adminOnly: true },
  { path: "/messages", mark: "MS", label: "Messages", group: "records", adminOnly: true },
  { path: "/data", mark: "DA", label: "Data", group: "records", adminOnly: true, desktopOnly: true },
  { path: "/transit", mark: "T", label: "Transit", group: "records" },
  { path: "/reports", mark: "RP", label: "Reports", group: "records" }
];

export function OpsShell() {
  const { member, tenant, logout } = useAuth();
  const location = useLocation();
  const [width, setWidth] = useState(() => window.innerWidth);
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
  const realAdmin = member?.roles.includes("admin") ?? false;

  // ---------- View as (admin only) ----------
  const [dispatchView, setDispatchView] = useState(false);
  const [watch, setWatchState] = useState<Watch | null>(() => realAdmin ? loadWatch() : null);
  const [watchHidden, setWatchHidden] = useState(false);
  const [picking, setPicking] = useState(false);
  const setWatch = (next: Watch | null) => { setWatchState(next); saveWatch(next); setWatchHidden(false); };
  const isAdmin = realAdmin && !dispatchView;
  const docked = !!watch && !watchHidden && mode === "desktop";

  const pages = PAGES.filter((page) => !page.adminOnly || isAdmin);
  const current = pages.find((page) => page.path === "/" ? location.pathname === "/" : location.pathname.startsWith(page.path));

  const signOut = () => { void logout().catch(() => toast("Could not sign out. Try again.")); };
  const [changingPassword, setChangingPassword] = useState(false);
  const passwordSheet = changingPassword && <Overlay onClose={() => setChangingPassword(false)}>
    <p className="eyebrow">YOUR LOGIN</p><h2 className="dt">Change my password</h2>
    <ChangeMyPassword onCancel={() => setChangingPassword(false)} />
  </Overlay>;
  const viewAsSheet = picking && <Overlay onClose={() => setPicking(false)}>
    <ViewAsPicker watching={watch} dispatchView={dispatchView}
      onWatch={(next) => { setWatch(next); setPicking(false); }}
      onDispatchView={(on) => { setDispatchView(on); setPicking(false); toast(on ? "Dispatch view. Admin pages are hidden." : "Admin view."); }} />
  </Overlay>;
  const viewAsButton = realAdmin && <button type="button" className={`va-btn${dispatchView || watch ? " on" : ""}`} onClick={() => setPicking(true)}>
    View as{dispatchView ? ": Dispatch" : watch ? `: ${watch.name}` : ""}</button>;
  const tenantName = tenant?.name ?? "Bussin";
  const name = member?.display_name ?? "";
  const link = (page: Page) => <NavLink key={page.path} to={page.path} end={page.path === "/"}
    className={({ isActive }) => isActive ? "on" : ""}>
    <span className="ico">{page.mark}</span>{page.label}
  </NavLink>;

  const body = mode === "desktop"
    ? <div className={`app d${docked ? " docked" : ""}`}>
      <aside className="sidebar">
        <div className="brand"><div className="brandmark" aria-hidden="true">B</div>
          <div><b>BUSSIN</b><small>{tenantName}</small></div></div>
        <div className="nav-label">Live operations</div>
        <nav className="nav" aria-label="Live operations">{pages.filter((page) => page.group === "live").map(link)}</nav>
        <div className="nav-label">People and records</div>
        <nav className="nav" aria-label="People and records">{pages.filter((page) => page.group === "records").map(link)}</nav>
        <div className="side-foot">
          {isAdmin && <DangerZone />}
          {viewAsButton}
          <div className="who-row"><div><b>{name}</b>{realAdmin ? "Admin" : "Dispatch"}</div>
            <div className="who-acts"><button type="button" onClick={() => setChangingPassword(true)}>Password</button>
              <button type="button" onClick={signOut}>Sign out</button></div></div>
        </div>
      </aside>
      <div className="ws">
        <header className="topbar">
          <div className="crumb">BUSSIN / {current?.label ?? "Operations"}</div>
          <div className="top-actions">
            <span className="avatar" title={name}>{initials(name)}</span>
          </div>
        </header>
        {dispatchView && <div className="va-banner">Viewing as Dispatch. Admin pages are hidden.
          <button type="button" onClick={() => { setDispatchView(false); toast("Admin view."); }}>Back to Admin</button></div>}
        <main className="content"><Suspense fallback={<p className="hint">Loading…</p>}><Outlet /></Suspense></main>
      </div>
      {docked && <div className="va-space" aria-hidden="true" />}
    </div>
    : <div className="app m adv">
      <div className="mtop">
        <div className="brand"><div className="brandmark" aria-hidden="true">B</div><div><b>BUSSIN</b><small>{tenantName}</small></div></div>
        {viewAsButton}
      </div>
      {dispatchView && <div className="va-banner">Viewing as Dispatch.
        <button type="button" onClick={() => { setDispatchView(false); toast("Admin view."); }}>Back to Admin</button></div>}
      <main className="mc">
        <Suspense fallback={<p className="hint">Loading…</p>}><Outlet /></Suspense>
        <div className="mfoot"><button type="button" onClick={signOut}>Sign out {name}</button>
          {" · "}<button type="button" onClick={() => setChangingPassword(true)}>Change password</button>
          {isAdmin && <> · <DangerZone compact /></>}</div>
      </main>
      <nav className="tabs" aria-label="Main" style={{ gridTemplateColumns: `repeat(${pages.filter((page) => !page.desktopOnly).length},1fr)` }}>
        {pages.filter((page) => !page.desktopOnly).map((page) => <NavLink key={page.path} to={page.path} end={page.path === "/"}
          className={({ isActive }) => isActive ? "on" : ""}>
          <span>{page.mark}</span>{page.label}
        </NavLink>)}
      </nav>
    </div>;

  return <OpsContext.Provider value={{ mode, isAdmin, toast }}>
    <div className="ops">
      {body}
      {passwordSheet}
      {viewAsSheet}
      {watch && realAdmin && <ViewAsDock watch={watch} desktop={mode === "desktop"} hidden={watchHidden} onHide={setWatchHidden}
        onChange={() => setPicking(true)} onClose={() => setWatch(null)} />}
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
