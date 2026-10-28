import { useCallback, useEffect, useState } from "react";
import { pairCodeResponseSchema, trackersResponseSchema, type PairCodeResponse, type Tracker } from "@bussin/shared";
import { getJson, message, send } from "../ops/api";
import { age, time } from "../ops/format";
import { ErrorNote } from "../ops/ui";

/**
 * The phone mounted on this bus. Make a code here, type it on the phone at /bus,
 * and the phone becomes this bus's GPS. One phone per bus.
 */
export function TrackerPanel({ busId, busLabel, busActive, now }: { busId: string; busLabel: string; busActive: boolean; now: number }) {
  const [tracker, setTracker] = useState<Tracker | null | undefined>();
  const [code, setCode] = useState<PairCodeResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const data = await getJson("/api/fleet/trackers", trackersResponseSchema);
      setTracker(data.trackers.find((item) => item.busId === busId) ?? null);
    } catch (cause) {
      setError(message(cause, "Could not load the tracker."));
    }
  }, [busId]);
  useEffect(() => { void load(); }, [load]);

  // While a code is showing, check every few seconds so the panel flips to Paired by itself.
  const live = code && Date.parse(code.expiresAt) > now;
  useEffect(() => {
    if (!live) return;
    const timer = window.setInterval(() => void load(), 4_000);
    return () => window.clearInterval(timer);
  }, [live, load]);
  useEffect(() => {
    if (code && tracker && Date.parse(tracker.pairedAt) >= Date.parse(code.expiresAt) - 15 * 60_000) setCode(null);
  }, [code, tracker]);

  async function makeCode() {
    if (tracker && !window.confirm(`${busLabel} already has a paired phone. A new phone will replace it. Continue?`)) return;
    setBusy(true); setError("");
    try {
      setCode(pairCodeResponseSchema.parse(await send("POST", `/api/fleet/buses/${busId}/pair-code`, undefined, "Could not make a code.")));
    } catch (cause) {
      setError(message(cause, "Could not make a code."));
    } finally { setBusy(false); }
  }

  async function unpair() {
    if (!window.confirm(`Unpair the phone on ${busLabel}? It stops sending GPS right away.`)) return;
    setBusy(true); setError("");
    try {
      await send("DELETE", `/api/fleet/buses/${busId}/tracker`, undefined, "Could not unpair.");
      setCode(null);
      await load();
    } catch (cause) {
      setError(message(cause, "Could not unpair."));
    } finally { setBusy(false); }
  }

  const seen = tracker?.lastSeenAt ? now - Date.parse(tracker.lastSeenAt) : null;
  const status = tracker === undefined ? "Checking…"
    : tracker === null ? "No phone paired"
      : seen === null ? "Paired, not opened yet"
        : seen < 90_000 ? `Online · seen ${age(tracker.lastSeenAt, now)}` : `Offline · last seen ${age(tracker.lastSeenAt, now)}`;

  return <>
    <div className="d-sec"><h3>Bus phone (GPS)</h3><span className={tracker && seen !== null && seen < 90_000 ? "trk-on" : ""}>{status}</span></div>
    {live && <div className="trk-code">
      <b aria-label={`Pairing code ${code.code.split("").join(" ")}`}>{code.code.slice(0, 3)} {code.code.slice(3)}</b>
      <p>On the bus phone, open <strong>{location.host}/bus</strong> and enter this code. Works once, until {time(code.expiresAt)}.</p>
    </div>}
    <ErrorNote text={error} />
    <div className="acts">
      {busActive && <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void makeCode()}>
        {live ? "New code" : tracker ? "Replace phone" : "Make pairing code"}</button>}
      {tracker && <button type="button" className="btn" disabled={busy} onClick={() => void unpair()}>Unpair</button>}
    </div>
  </>;
}
