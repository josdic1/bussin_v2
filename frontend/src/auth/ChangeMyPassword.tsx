import { useState, type FormEvent } from "react";
import { useAuth } from "./AuthProvider";

/**
 * Change your own password, any time. Needs the current one. Afterwards every device
 * is signed out, including this one, and you sign in with the new password.
 */
export function ChangeMyPassword({ onCancel }: { onCancel: () => void }) {
  const { changePassword } = useAuth();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (next.length < 12) { setError("The new password needs at least 12 characters."); return; }
    if (next !== again) { setError("The two new passwords don't match."); return; }
    setBusy(true); setError("");
    try {
      await changePassword(current, next);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not change the password.");
      setBusy(false);
    }
  }

  return <form className="pw-form" onSubmit={(event) => void submit(event)} noValidate>
    <p className="pw-hint">After you change it, every device signs out, including this one. Sign back in with the new password.</p>
    <label>Current password<input type="password" autoComplete="current-password" value={current} onChange={(event) => setCurrent(event.target.value)} /></label>
    <label>New password <small>12 characters or more</small><input type="password" autoComplete="new-password" value={next} onChange={(event) => setNext(event.target.value)} /></label>
    <label>New password again<input type="password" autoComplete="new-password" value={again} onChange={(event) => setAgain(event.target.value)} /></label>
    {error && <p className="pw-err" role="alert">{error}</p>}
    <div className="pw-acts">
      <button type="button" className="btn" onClick={onCancel}>Cancel</button>
      <button type="submit" className="btn btn-primary" disabled={busy || !current || !next}>{busy ? "Saving…" : "Change password"}</button>
    </div>
  </form>;
}
