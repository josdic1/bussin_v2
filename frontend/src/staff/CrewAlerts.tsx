import { useCallback, useEffect, useState } from "react";
import { TRIP_ALERT_CHOICES, tripAlertSchema, tripAlertsResponseSchema, type TripAlert, type TripAlertKind } from "@bussin/shared";
import { clock } from "../terminal/useTerminalTrip";

/*
 * The counselor's line to Dispatch. "Update Dispatch": one tap for the usual things
 * (running late, bathroom stop). "Emergency": accident, medical, breakdown, sent with the
 * phone's location and shown to Dispatch as an urgent alarm. Both land in the trip record.
 */

type Fix = { latitude: number; longitude: number; observedAt: number } | null;

/** This trip's alerts, so the sender sees when Dispatch has seen them. */
export function useCrewAlerts(enabled: boolean) {
  const [alerts, setAlerts] = useState<TripAlert[]>([]);
  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/alerts/mine", { credentials: "same-origin" });
      if (response.ok) setAlerts(tripAlertsResponseSchema.parse(await response.json()).alerts);
    } catch { /* no signal: keep the last list */ }
  }, []);
  useEffect(() => {
    if (!enabled) return;
    void load();
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void load(); }, 15_000);
    return () => window.clearInterval(timer);
  }, [enabled, load]);
  return { alerts, reload: load, add: (alert: TripAlert) => setAlerts((list) => [alert, ...list]) };
}

/** A fresh location for an emergency: the lead's GPS if recent, otherwise ask the phone once (4s max). */
function currentPlace(fix: Fix): Promise<{ latitude: number; longitude: number } | null> {
  if (fix && Date.now() - fix.observedAt < 2 * 60_000) return Promise.resolve({ latitude: fix.latitude, longitude: fix.longitude });
  if (!("geolocation" in navigator)) return Promise.resolve(null);
  return new Promise((resolve) => {
    const timer = window.setTimeout(() => resolve(null), 4_000);
    navigator.geolocation.getCurrentPosition(
      (position) => { window.clearTimeout(timer); resolve({ latitude: position.coords.latitude, longitude: position.coords.longitude }); },
      () => { window.clearTimeout(timer); resolve(null); },
      { enableHighAccuracy: true, timeout: 4_000, maximumAge: 60_000 });
  });
}

export function AlertSheet({ kind, fix, preview, officePhone, onClose, onSent }: {
  kind: TripAlertKind; fix: Fix; preview: boolean; officePhone: string | null; onClose: () => void; onSent: (alert: TripAlert) => void;
}) {
  const choices = Object.entries(TRIP_ALERT_CHOICES[kind]) as [string, string][];
  const [code, setCode] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [sent, setSent] = useState<TripAlert | null>(null);
  const emergency = kind === "emergency";

  async function send() {
    if (!code) return;
    if (code === "other" && !note.trim() && !emergency) { setError("Write what's happening."); return; }
    if (preview) { setError("Preview only. Nothing is sent."); return; }
    setSending(true); setError("");
    try {
      const place = emergency ? await currentPlace(fix) : null;
      const response = await fetch("/api/alerts", {
        method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind, code, note: note.trim() || null, ...(place ?? {}) })
      });
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        // Signed in as someone else on this phone (another tab switched): say so plainly.
        setError(response.status === 401 || response.status === 403
          ? "This phone isn't signed in as you anymore, so that didn't send. Call the office now, then reload Bussin."
          : body && typeof body === "object" && "error" in body && typeof body.error === "string" ? `${body.error} Call the office.` : "That didn't send. Call the office.");
        return;
      }
      const alert = tripAlertSchema.parse(body);
      setSent(alert);
      onSent(alert);
    } catch {
      setError(emergency ? "No signal. Call Dispatch, or 911 if anyone is hurt." : "No signal, so that didn't send. Try again when you have signal.");
    } finally {
      setSending(false);
    }
  }

  return <div className="cr-sheet" role="dialog" aria-modal="true" aria-label={emergency ? "Emergency" : "Update Dispatch"}>
    <div className={`cr-sheet-in${emergency ? " em" : ""}`}>
      <div className="cr-sheet-top"><h2>{emergency ? "Emergency" : "Update Dispatch"}</h2>
        <button type="button" onClick={onClose}>Close</button></div>
      {sent ? <div className="cr-sent">
        <b>{emergency ? "Emergency sent" : "Sent"} at {clock(sent.createdAt)}</b>
        <p>{emergency ? "Dispatch has an alarm on screen now, with your location. Stay with the kids." : "Dispatch sees it now."}</p>
        {emergency && <a className="cr-911" href="tel:911">If anyone is hurt, call 911</a>}
        <button type="button" className="cr-main" onClick={onClose}>Done</button>
      </div> : <>
        {emergency && <a className="cr-911" href="tel:911">Anyone hurt? Call 911 first</a>}
        <div className={`cr-choices${emergency ? " em" : ""}`}>{choices.map(([key, label]) =>
          <button key={key} type="button" className={code === key ? "on" : ""} aria-pressed={code === key}
            onClick={() => { setCode(key); setError(""); }}>{label}</button>)}</div>
        <label className="cr-note"><span>Add a note <i>(optional{code === "other" && !emergency ? ", but say what's going on" : ""})</i></span>
          <textarea rows={2} maxLength={300} value={note} onChange={(event) => setNote(event.target.value)}
            placeholder={emergency ? "What happened, where you are" : "e.g. stuck on Route 10 near the mall"} /></label>
        {error && <p className="cr-sheet-err" role="alert">{error}</p>}
        {/* Whatever goes wrong, there's always a way to reach a person. */}
        {error && !preview && <div className="cr-fallback">
          {officePhone && <a className="cr-call" href={`tel:${officePhone.replace(/[^\d+]/g, "")}`}>Call the office · {officePhone}</a>}
          {emergency && <a className="cr-911" href="tel:911">Call 911</a>}
          {/This phone isn't signed in/.test(error) && <button type="button" className="cr-reload" onClick={() => location.reload()}>Reload Bussin</button>}
        </div>}
        <button type="button" className={`cr-main${emergency ? " em" : ""}`} disabled={!code || sending} onClick={() => void send()}>
          {sending ? "Sending…" : !code ? "Pick one above" : emergency ? `Send emergency: ${TRIP_ALERT_CHOICES.emergency[code as keyof typeof TRIP_ALERT_CHOICES.emergency]}` : "Send to Dispatch"}</button>
      </>}
    </div>
  </div>;
}

/** The two buttons, and what's been sent on this trip. */
export function CrewHelp({ alerts, onOpen }: { alerts: TripAlert[]; onOpen: (kind: TripAlertKind) => void }) {
  return <section className="cr-help">
    <div className="cr-help-btns">
      <button type="button" className="cr-btn plain" onClick={() => onOpen("update")}>Update Dispatch</button>
      <button type="button" className="cr-btn em" onClick={() => onOpen("emergency")}>Emergency</button>
    </div>
    {alerts.length > 0 && <ul className="cr-sentlist">{alerts.slice(0, 3).map((alert) =>
      <li key={alert.id} className={alert.kind}><b>{alert.label}</b><span>{clock(alert.createdAt)} · {alert.resolvedAt
        ? `seen by ${alert.resolvedBy ?? "Dispatch"}` : "not seen yet"}</span></li>)}</ul>}
  </section>;
}
