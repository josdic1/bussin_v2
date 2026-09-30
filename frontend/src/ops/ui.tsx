import type { CSSProperties, ReactNode } from "react";
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
