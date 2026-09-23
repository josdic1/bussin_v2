import { NavLink, Outlet, Route, Routes } from "react-router";

const pages = [
  { path: "/", label: "Dispatch", mark: "D" },
  { path: "/fleet", label: "Fleet", mark: "F" },
  { path: "/members", label: "Members", mark: "M" },
  { path: "/transit", label: "Transit", mark: "T" }
];

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
          <span>JCC</span>
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
      <Route element={<AppShell />}>
        <Route index element={<Page title="Dispatch" description="Monitor every active bus in one place." />} />
        <Route path="fleet" element={<Page title="Fleet" description="Manage buses and their assignments." />} />
        <Route path="members" element={<Page title="Members" description="Manage staff and family access." />} />
        <Route path="transit" element={<Page title="Transit" description="See each trip and every recorded event." />} />
      </Route>
    </Routes>
  );
}
