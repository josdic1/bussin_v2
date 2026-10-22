import { useEffect, useRef, useState } from "react";
import { DRIVER_MESSAGES, driverMessageInputSchema, driverMessageReceiptSchema, messageReachSchema, type MessageReach } from "@bussin/shared";
import { DriverIcon } from "./DriverIcon";

type Preset = keyof typeof DRIVER_MESSAGES;
type Request = { tripId: string; clientMessageId: string; preset: Preset };
async function post(path: string, body: unknown) {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(`/api/messages/${path}`, { method: "POST", credentials: "same-origin",
      signal: controller.signal, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await response.json();
    if (!response.ok) throw new Error(typeof data?.error === "string" ? data.error : "Message could not be confirmed.");
    return data;
  } finally { window.clearTimeout(timer); }
}
export function DriverMessages({ tripId, routeName, memberId, locked }: {
  tripId: string; routeName: string; memberId: string; locked: boolean;
}) {
  const key = `bussin-driver-message:${memberId}:${tripId}`;
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<Preset | null>(null);
  const [audience, setAudience] = useState<MessageReach | null>(null);
  const [error, setError] = useState("");
  const [receipt, setReceipt] = useState("");
  const [busy, setBusy] = useState(false);
  const request = useRef<Request | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    try {
      const saved = driverMessageInputSchema.safeParse(JSON.parse(sessionStorage.getItem(key) ?? "null"));
      if (saved.success && saved.data.tripId === tripId) {
        request.current = saved.data; setSelected(saved.data.preset);
        setError("An earlier send was not confirmed. Retry checks the same message without posting it twice.");
      }
    } catch { /* Storage may be unavailable; in-memory retries still use the same ID. */ }
  }, [key, tripId]);
  useEffect(() => {
    if (!open) return;
    cancelRef.current?.focus();
    let current = true;
    setAudience(null);
    void post("staff/preview", { tripId }).then(data => {
      if (current) setAudience(messageReachSchema.parse(data));
    }).catch(cause => { if (current) setError(cause instanceof Error ? cause.message : "Could not check recipients."); });
    return () => { current = false; };
  }, [open, tripId]);
  async function send() {
    if (!selected || busy || locked || !audience?.guardians) return;
    const input = request.current ?? { tripId, preset: selected, clientMessageId: crypto.randomUUID() };
    request.current = input;
    try { sessionStorage.setItem(key, JSON.stringify(input)); } catch { /* Keep in memory. */ }
    setBusy(true); setError("");
    try {
      const saved = driverMessageReceiptSchema.parse(await post("staff", input));
      request.current = null;
      try { sessionStorage.removeItem(key); } catch { /* No stored request. */ }
      setReceipt(`Posted to ${saved.guardians} guardian${saved.guardians === 1 ? "" : "s"} · ${saved.withLogin} with active family access. SMS and push were not sent.`);
      setSelected(null); setOpen(false);
    } catch (cause) {
      setError(`${cause instanceof Error ? cause.message : "No confirmation received."} Retry uses the same message ID.`);
    } finally { setBusy(false); }
  }
  return <section className="driver-messages" aria-labelledby="driver-message-title">
    <div><h2 id="driver-message-title">Let families know</h2><p>Quick updates for this trip. Send while stopped.</p></div>
    <button className="driver-message-open" disabled={locked} onClick={() => setOpen(true)}><DriverIcon name="message" />{locked ? "Messages · stop to use" : "Message families"}</button>
    <p className="driver-message-channel">Family inbox · SMS and push not connected</p>
    {receipt && <p className="driver-message-receipt" role="status">{receipt}</p>}
    {open && <div className="driver-modal-backdrop" onKeyDown={event => {
      if (event.key === "Escape" && !busy) setOpen(false);
      if (event.key === "Tab") {
        const controls = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"));
        const first = controls[0], last = controls.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    }}><div className="driver-message-dialog" role="dialog" aria-modal="true" aria-labelledby="driver-dialog-title">
      <div className="driver-dialog-top"><div><span className="driver-kicker">THIS TRIP ONLY</span><h2 id="driver-dialog-title">{routeName}</h2></div>
        <button ref={cancelRef} disabled={busy} onClick={() => setOpen(false)}>Close</button></div>
      <p>{audience ? `${audience.guardians} linked guardians · ${audience.withLogin} with active family access` : "Checking recipients…"}</p>
      <div className="driver-presets">{(Object.keys(DRIVER_MESSAGES) as Preset[]).map(preset => <button key={preset}
        aria-pressed={selected === preset} disabled={busy || locked || (!!request.current && request.current.preset !== preset)}
        onClick={() => { setSelected(preset); if (!request.current) setError(""); }}>
        <DriverIcon name={preset === "resumed" ? "bus" : "clock"} />{DRIVER_MESSAGES[preset].label}</button>)}</div>
      {selected && <blockquote>{DRIVER_MESSAGES[selected].body}</blockquote>}
      {error && <p className="ferror" role="alert">{error}</p>}
      {locked && <p role="status">The bus is moving. Stop before sending.</p>}
      <button className="driver-send" disabled={!selected || busy || locked || !audience?.guardians} onClick={() => void send()}>
        {busy ? "Sending…" : request.current ? "Retry same message" : "Post to family inbox"}</button>
      <p className="driver-message-channel">Posts inside Bussin. This does not send an SMS or phone notification. Recipient access can change before sending.</p>
    </div></div>}
  </section>;
}
