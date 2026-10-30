import { lazy, Suspense, useEffect, type CSSProperties } from "react";
import type { BoardTrip } from "@bussin/shared";
import { time } from "../ops/format";
import "./wall.css";

const DispatchMap = lazy(async () => ({ default: (await import("./DispatchMap")).DispatchMap }));

/*
 * Full screen: the map and every bus on the road, big enough to read from across the room.
 * For the office TV or a laptop on the desk. Esc or the button goes back to Today.
 */

export type WallBus = {
  trip: BoardTrip; num: string; label: string; color: string;
  tone: "bad" | "warn" | "ok" | "idle"; tag: string; big: string; small: string;
  progress: { done: number; total: number } | null;
  kids: { aboard: number; total: number } | null;
};

export function LiveWall({ camp, headline, sub, buses, colorOf, now, onOpen, onClose }: {
  camp: string; headline: string; sub: string; buses: WallBus[]; colorOf: (busId: string) => string; now: number;
  onOpen: (tripId: string) => void; onClose: () => void;
}) {
  useEffect(() => {
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    document.addEventListener("keydown", key);
    document.body.style.overflow = "hidden";
    return () => { document.removeEventListener("keydown", key); document.body.style.overflow = ""; };
  }, [onClose]);

  const running = buses.filter((bus) => bus.trip.status === "active").map((bus) => bus.trip);
  const labels = Object.fromEntries(buses.map((bus) => [bus.trip.id, bus.big]));

  return <div className="wall" role="dialog" aria-modal="true" aria-label="Live view">
    <header className="wall-top">
      <div><small>{camp}</small><h1 className={buses.some((bus) => bus.tone === "bad" || bus.tone === "warn") ? "bad" : ""}>{headline}</h1></div>
      <div className="wall-meta"><b>{time(new Date(now).toISOString())}</b><span>{sub}</span></div>
      <button type="button" className="wall-close" onClick={onClose}>Exit full screen</button>
    </header>
    <div className="wall-body">
      <section className="wall-map">
        <Suspense fallback={<div className="mapfill" />}>
          <DispatchMap trips={running} colorForBus={colorOf} selectedTripId={null} onSelect={onOpen} now={now} fixedAll labels={labels} />
        </Suspense>
        {!running.length && <p className="wall-empty">No buses on the road right now.</p>}
      </section>
      <aside className="wall-list" aria-label="Buses">
        {buses.map((bus) => {
          const pct = bus.progress && bus.progress.total > 1 ? Math.round(bus.progress.done / bus.progress.total * 100) : 0;
          return <button key={bus.trip.id} type="button" className={`wall-bus ${bus.tone}`} style={{ "--c": bus.color } as CSSProperties} onClick={() => onOpen(bus.trip.id)}>
            <span className="wall-num">{bus.num}</span>
            <span className="wall-text">
              <span className="wall-row"><b>{bus.label}</b><em className={bus.tone}>{bus.tag}</em></span>
              <strong>{bus.big}</strong>
              {bus.small && <small>{bus.small}</small>}
              {bus.progress && <i className="wall-bar"><i style={{ width: `${pct}%` }} /></i>}
              {bus.kids && <small className="wall-kids">{bus.trip.status === "active" ? `${bus.kids.aboard} of ${bus.kids.total} kids on` : `${bus.kids.total} kids`}</small>}
            </span>
          </button>;
        })}
        {!buses.length && <p className="wall-none">No trips today.</p>}
      </aside>
    </div>
  </div>;
}
