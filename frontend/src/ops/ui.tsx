import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { initials } from "./format";

export type Tone = "ok" | "bad" | "warn" | "";

export function Head({ eyebrow, title, sub, actions }: {
  eyebrow: string; title: ReactNode; sub?: ReactNode; actions?: ReactNode;
}) {
  return <header className="head">
    <div>
      <p className="eyebrow">{eyebrow}</p>
      <h1>{title}</h1>
      {sub && <p className="desc">{sub}</p>}
    </div>
    <div className="hact">{actions}</div>
  </header>;
}

export function LivePill({ state }: { state: "live" | "connecting" | "reconnecting" }) {
  if (state === "live") return <span className="live-pill"><i />LIVE</span>;
  return <span className="live-pill off" title="Live updates reconnecting. The page still refreshes every 15 seconds.">
    <i />{state === "connecting" ? "CONNECTING" : "RECONNECTING"}
  </span>;
}

export function Tile({ label, value, sub, className = "", onClick, pressed }: {
  label: string; value: ReactNode; sub: ReactNode; className?: string;
  onClick?: () => void; pressed?: boolean;
}) {
  const content = <><span>{label}</span><strong>{value}</strong><small>{sub}</small></>;
  return onClick
    ? <button type="button" className={`tile ${className}`} onClick={onClick} aria-pressed={pressed}>{content}</button>
    : <div className={`tile ${className}`}>{content}</div>;
}

export function Seg<T extends string | number>({ items, value, onChange, label }: {
  items: [T, string][]; value: T; onChange: (value: T) => void; label?: string;
}) {
  return <div className="seg" role="group" aria-label={label}>
    {items.map(([key, text]) => <button key={String(key)} type="button"
      className={key === value ? "on" : ""} aria-pressed={key === value}
      onClick={() => onChange(key)}>{text}</button>)}
  </div>;
}

export function Search({ value, onChange, placeholder, label }: {
  value: string; onChange: (value: string) => void; placeholder: string; label?: string;
}) {
  return <label className="search">{label}
    <input type="search" value={value} placeholder={placeholder} autoComplete="off"
      aria-label={label ? undefined : placeholder} onChange={(event) => onChange(event.target.value)} />
  </label>;
}

export function Plus({ label, onClick }: { label: string; onClick: () => void }) {
  return <button type="button" className="plus" aria-label={label} onClick={onClick}>+</button>;
}

export function Dot({ tone }: { tone: Tone }) {
  return <span className={`dot ${tone}`} />;
}

/** Plain-language row used by the phone simple views. */
export function SRow({ tone, children, small, smallTone, onClick }: {
  tone: Tone; children: ReactNode; small?: ReactNode; smallTone?: Tone; onClick?: () => void;
}) {
  const inner = <>
    <Dot tone={tone} />
    <span>{children}{small && <small className={smallTone ?? ""}>{small}</small>}</span>
    {onClick && <span className="go">&rsaquo;</span>}
  </>;
  return onClick
    ? <button type="button" className="srow" onClick={onClick}>{inner}</button>
    : <div className="srow">{inner}</div>;
}

export function Bar({ done, total, color }: { done: number; total: number; color: string }) {
  const percent = total ? Math.round(done / total * 100) : 0;
  return <div className="prog" style={{ "--c": color } as CSSProperties}>
    <span className="bar"><b style={{ width: `${percent}%` }} /></span>
    <span>{done}/{total}</span>
  </div>;
}

export function Avatar({ name, color, size = 40 }: { name: string; color: string; size?: number }) {
  return <span className="av" style={{ "--c": color, "--s": `${size}px` } as CSSProperties}>{initials(name)}</span>;
}

export function Swatch({ color }: { color: string }) {
  return <span className="sw" style={{ background: color }} />;
}

export function ErrorNote({ text }: { text: string }) {
  return text ? <p className="err" role="alert">{text}</p> : null;
}

export function NoMatch({ children }: { children: ReactNode }) {
  return <p className="nomatch">{children}</p>;
}

export function Confirm({ text, yes, onYes, onNo, busy, danger }: {
  text: string; yes: string; onYes: () => void; onNo: () => void; busy?: boolean; danger?: boolean;
}) {
  return <div className="confirm">
    <span>{text}</span>
    <button type="button" className={`btn ${danger ? "btn-danger" : "btn-primary"}`} disabled={busy} onClick={onYes}>{yes}</button>
    <button type="button" className="btn" onClick={onNo}>Go back</button>
  </div>;
}

/**
 * A trip's crew as pills: the lead counselor first (marked LEAD, required to start),
 * then the other counselors, then the driver when asked for.
 */
export function CrewPills({ lead, counselors, driver }: {
  lead: { displayName: string } | null;
  counselors: { id: string; displayName: string }[];
  driver?: { name: string } | null;
}) {
  return <span className="crewp">
    {lead
      ? <span className="cp lead" title="Lead counselor"><b>Lead</b>{lead.displayName}</span>
      : <span className="cp nolead" title="A trip can't start without a lead counselor">No lead</span>}
    {counselors.map((person) => <span key={person.id} className="cp">{person.displayName}</span>)}
    {driver !== undefined && (driver
      ? <span className="cp drv" title="Driver"><b>Driver</b>{driver.name}</span>
      : <span className="cp nodrv">No driver</span>)}
  </span>;
}

/**
 * A slim rail in the left gutter of a long list: Top, then the first letters that
 * exist in the list. Click a letter to jump to the first row with it. The row with
 * id `${idPrefix}-${letter}` is the target; the letter you're looking at is lit.
 */
export function JumpRail({ letters, idPrefix, label }: { letters: string[]; idPrefix: string; label: string }) {
  const [scrolled, setScrolled] = useState(false);
  const [current, setCurrent] = useState<string | null>(null);
  useEffect(() => {
    const update = () => {
      setScrolled(window.scrollY > 200);
      let lit: string | null = null;
      for (const letter of letters) {
        const row = document.getElementById(`${idPrefix}-${letter}`);
        if (row && row.getBoundingClientRect().top < 160) lit = letter;
      }
      setCurrent(lit);
    };
    update();
    window.addEventListener("scroll", update, { passive: true });
    return () => window.removeEventListener("scroll", update);
  }, [letters, idPrefix]);
  const jump = (letter: string) =>
    document.getElementById(`${idPrefix}-${letter}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  return <nav className="jumprail" aria-label={label}>
    <button type="button" className="jr-top" disabled={!scrolled} onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
      aria-label="Back to top"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5m-6 6 6-6 6 6" /></svg><span>Top</span></button>
    {letters.length > 1 && <div className="jr-letters">{letters.map((letter) =>
      <button key={letter} type="button" className={letter === current ? "on" : ""} onClick={() => jump(letter)}
        aria-label={`Jump to ${letter}`}>{letter}</button>)}</div>}
  </nav>;
}
