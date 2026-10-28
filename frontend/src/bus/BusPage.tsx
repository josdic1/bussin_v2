import { lazy, Suspense, useCallback, useEffect, useState, type FormEvent } from "react";
import { deviceMeResponseSchema, pairDeviceInputSchema, type DeviceMe } from "@bussin/shared";

const DriverTerminal = lazy(async () => ({ default: (await import("../terminal/DriverTerminal")).DriverTerminal }));

/**
 * /bus: the phone mounted on a bus. Not a person's login.
 * First visit: enter the 6-digit code from Fleet. After that it opens straight to
 * the bus's trip and sends GPS while the trip runs.
 */
export function BusPage() {
  const [me, setMe] = useState<DeviceMe | null | undefined>();
  const [loadError, setLoadError] = useState("");

  const check = useCallback(async () => {
    setLoadError("");
    try {
      const response = await fetch("/api/device/me", { credentials: "same-origin" });
      if (response.status === 401) { setMe(null); return; }
      if (!response.ok) throw new Error();
      setMe(deviceMeResponseSchema.parse(await response.json()));
    } catch {
      setLoadError("Can't reach Bussin. Check signal, then retry.");
    }
  }, []);
  useEffect(() => { void check(); }, [check]);

  if (loadError) return <Screen title="No connection" description={loadError}>
    <button className="auth-button" onClick={() => void check()}>Retry</button></Screen>;
  if (me === undefined) return <Screen title="Bus tracker" description="Checking this phone…" />;
  if (me === null) return <PairForm onPaired={setMe} />;
  return <Suspense fallback={<Screen title={me.bus.label} description="Loading…" />}>
    <DriverTerminal deviceBus={me.bus.label} mode={{ kind: "device", onUnpaired: () => setMe(null) }} />
  </Suspense>;
}

function Screen({ title, description, children }: { title: string; description: string; children?: React.ReactNode }) {
  return <main className="auth-screen"><section className="auth-card">
    <div className="auth-brand">B</div>
    <p className="eyebrow">BUS TRACKER</p>
    <h1>{title}</h1>
    <p className="description">{description}</p>
    {children}
  </section></main>;
}

function PairForm({ onPaired }: { onPaired: (me: DeviceMe) => void }) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const input = pairDeviceInputSchema.safeParse({ code });
    if (!input.success) { setError("Enter the 6-digit code from Fleet."); return; }
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/device/pair", {
        method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input.data)
      });
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        setError(body && typeof body === "object" && "error" in body && typeof body.error === "string"
          ? body.error : "Could not pair this phone.");
        return;
      }
      onPaired(deviceMeResponseSchema.parse(body));
    } catch {
      setError("Can't reach Bussin. Check signal and try again.");
    } finally {
      setBusy(false);
    }
  }

  return <Screen title="Pair this phone" description="In Bussin on a computer: Fleet, pick the bus, Make pairing code. Enter it here.">
    <form className="auth-form" onSubmit={(event) => void submit(event)}>
      <label htmlFor="pair-code">6-digit code</label>
      <input id="pair-code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} required
        className="pair-code" value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 6))} />
      {error && <p className="auth-error" role="alert">{error}</p>}
      <button className="auth-button" disabled={busy || code.length !== 6}>{busy ? "Pairing…" : "Pair phone"}</button>
    </form>
  </Screen>;
}
