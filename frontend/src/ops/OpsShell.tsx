import {
  createContext, lazy, Suspense, useCallback, useContext, useEffect, useRef, useState, type ReactNode
} from "react";
import { NavLink, Outlet, useLocation } from "react-router";
import { ChangeMyPassword } from "../auth/ChangeMyPassword";
import { useAuth } from "../auth/AuthProvider";
import { initials } from "./format";
import { loadWatch, saveWatch, ViewAsDock, ViewAsPicker, type Watch } from "./ViewAs";

// The message form, loaded only when the floating button is pressed.
const Compose = lazy(() => import("../messages/MessagesPage").then((module) => ({ default: module.Compose })));

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

type Page = { path: string; mark: string; label: string; group: "daily" | "setup"; adminOnly?: boolean; desktopOnly?: boolean };

// Daily: what you open every day. Setup: what you open to change the plan.
// Danger zone lives at the bottom of Data.
const PAGES: Page[] = [
  { path: "/", mark: "T", label: "Today", group: "daily" },
  { path: "/families", mark: "K", label: "Kids", group: "daily", adminOnly: true },
  { path: "/messages", mark: "M", label: "Messages", group: "daily", adminOnly: true },
  { path: "/transit", mark: "H", label: "History", group: "daily" },
  { path: "/reports", mark: "R", label: "Reports", group: "daily", desktopOnly: true },
  { path: "/lines", mark: "L", label: "Lines", group: "setup" },
  { path: "/fleet", mark: "B", label: "Buses", group: "setup" },
  { path: "/team", mark: "S", label: "Team", group: "setup", adminOnly: true },
  { path: "/data", mark: "D", label: "Data", group: "setup", adminOnly: true, desktopOnly: true }
];
// Old addresses that now open another page (Routes and Timetable are Lines, and so on).
const ALIASES: Record<string, string> = { "/routes": "/lines", "/timetable": "/lines", "/members": "/team" };

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
  const here = Object.entries(ALIASES).find(([path]) => location.pathname.startsWith(path))?.[1] ?? location.pathname;
  const current = pages.find((page) => page.path === "/" ? here === "/" : here.startsWith(page.path));

  // Phones: the daily pages plus Lines along the bottom; the rest of Setup is linked at the foot of every page.
  const phoneTabs = pages.filter((page) => !page.desktopOnly && (page.group === "daily" || page.path === "/lines"));

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
  // Send families a message from any page. Hidden on Messages, which has the form already.
  const [composing, setComposing] = useState(false);
  const quickSend = isAdmin && here !== "/messages" && !(watch && !watchHidden && mode !== "desktop")
    && <button type="button" className={`qsend${docked ? " docked" : ""}`} onClick={() => setComposing(true)}>Message families</button>;
  const quickSheet = composing && <Overlay onClose={() => setComposing(false)}>
    <Suspense fallback={<p className="hint">Loading…</p>}><Compose sheet onSent={() => setComposing(false)} /></Suspense>
  </Overlay>;
  const tenantName = tenant?.name ?? "Bussin";
  const name = member?.display_name ?? "";
  const link = (page: Page) => <NavLink key={page.path} to={page.path} end={page.path === "/"}
    className={({ isActive }) => isActive || current?.path === page.path ? "on" : ""}>
    <span className="ico">{page.mark}</span>{page.label}
  </NavLink>;

  const body = mode === "desktop"
    ? <div className={`app d${docked ? " docked" : ""}`}>
      <aside className="sidebar">
        <div className="brand"><div className="brandmark" aria-hidden="true">B</div>
          <div><b>BUSSIN</b><small>{tenantName}</small></div></div>
        <nav className="nav" aria-label="Daily">{pages.filter((page) => page.group === "daily").map(link)}</nav>
        <div className="nav-label">Setup</div>
        <nav className="nav" aria-label="Setup">{pages.filter((page) => page.group === "setup").map(link)}</nav>
        <div className="side-foot">
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
        <nav className="mfoot-setup" aria-label="Setup">{pages.filter((page) => page.group === "setup" && !page.desktopOnly && !phoneTabs.includes(page)).map((page) =>
          <NavLink key={page.path} to={page.path}>{page.label}</NavLink>)}</nav>
        <div className="mfoot"><button type="button" onClick={signOut}>Sign out {name}</button>
          {" · "}<button type="button" onClick={() => setChangingPassword(true)}>Change password</button></div>
      </main>
      <nav className="tabs" aria-label="Main" style={{ gridTemplateColumns: `repeat(${phoneTabs.length},1fr)` }}>
        {phoneTabs.map((page) => <NavLink key={page.path} to={page.path} end={page.path === "/"}
          className={({ isActive }) => isActive || current?.path === page.path ? "on" : ""}>
          <span>{page.mark}</span>{page.label}
        </NavLink>)}
      </nav>
    </div>;

  return <OpsContext.Provider value={{ mode, isAdmin, toast }}>
    <div className="ops">
      {body}
      {passwordSheet}
      {viewAsSheet}
      {quickSend}
      {quickSheet}
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
