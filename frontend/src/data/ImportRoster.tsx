import { useRef, useState } from "react";
import {
  rosterImportPreviewSchema, rosterImportResultSchema,
  type RosterImportItem, type RosterImportPreview
} from "@bussin/shared";
import { Overlay } from "../ops/OpsShell";
import { message, send } from "../ops/api";
import { parseCsv } from "./csv";

// Upload a roster CSV: pick the file, see every change, then apply or cancel.
// Nothing is written until "Apply". The easiest start is "Download CSV", edit it, upload it back.

type Loaded = { name: string; headers: string[]; rows: string[][] };

const KIND_LABEL: Record<RosterImportItem["kind"], string> = {
  new: "New", update: "Changes", same: "No change", skip: "Skipped", error: "Problem"
};

export function ImportRoster({ onClose, onApplied }: { onClose: () => void; onApplied: (summary: string) => void }) {
  const [file, setFile] = useState<Loaded | null>(null);
  const [preview, setPreview] = useState<RosterImportPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [showSame, setShowSame] = useState(false);
  const picker = useRef<HTMLInputElement>(null);

  async function choose(chosen: File | undefined) {
    if (!chosen) return;
    setError("");
    setPreview(null);
    if (!/\.csv$/i.test(chosen.name)) {
      setError("Choose a .csv file. In Excel or Numbers, use File > Save As (or Export) > CSV.");
      return;
    }
    if (chosen.size > 1_500_000) {
      setError("That file is too big (over 1.5 MB). Split it into smaller files.");
      return;
    }
    const all = parseCsv(await chosen.text());
    if (all.length < 2) {
      setError("That file has no rows under the header line.");
      return;
    }
    const loaded = { name: chosen.name, headers: all[0]!, rows: all.slice(1) };
    setFile(loaded);
    setBusy(true);
    try {
      const body = await send("POST", "/api/data/import/preview", { headers: loaded.headers, rows: loaded.rows },
        "Couldn't check that file.");
      setPreview(rosterImportPreviewSchema.parse(body));
    } catch (cause) {
      setError(message(cause, "Couldn't check that file."));
    } finally {
      setBusy(false);
    }
  }

  async function apply() {
    if (!file || !preview) return;
    setBusy(true);
    setError("");
    try {
      const body = await send("POST", "/api/data/import/apply",
        { headers: file.headers, rows: file.rows, token: preview.token }, "Import failed. Nothing was changed.");
      const r = rosterImportResultSchema.parse(body);
      const parts = [
        r.created && `${r.created} added`, r.updated && `${r.updated} updated`,
        r.newGuardians && `${r.newGuardians} new guardian${r.newGuardians === 1 ? "" : "s"}`
      ].filter(Boolean);
      onApplied(parts.length ? `Roster imported: ${parts.join(", ")}.` : "Roster imported.");
    } catch (cause) {
      setError(message(cause, "Import failed. Nothing was changed."));
    } finally {
      setBusy(false);
    }
  }

  const c = preview?.counts;
  const willApply = c ? c.new + c.update : 0;
  const shown = preview?.items.filter((i) => showSame || i.kind !== "same") ?? [];

  return <Overlay onClose={onClose}>
    <div className="im">
      <p className="eyebrow">Riders</p>
      <h2>Upload roster CSV</h2>
      <p className="im-help">Easiest way: <b>Download CSV</b>, edit it in Excel or Google Sheets, save as CSV, upload it here.
        Leave Rider key blank to add a new rider. Nothing changes until you press Apply, and nobody is ever deleted.</p>

      <input ref={picker} type="file" accept=".csv,text/csv" hidden
        onChange={(event) => { void choose(event.target.files?.[0]); event.target.value = ""; }} />
      <button type="button" className="btn" disabled={busy} onClick={() => picker.current?.click()}>
        {file ? "Choose a different file" : "Choose CSV file"}
      </button>
      {file && <span className="im-file">{file.name} · {file.rows.length} {file.rows.length === 1 ? "row" : "rows"}</span>}

      {busy && <p className="im-note">{preview ? "Applying…" : "Checking every row…"}</p>}
      {error && <p className="im-bad" role="alert">{error}</p>}

      {preview && preview.missingColumns.length > 0 && <p className="im-bad" role="alert">
        This file is missing the {preview.missingColumns.join(" and ")} column{preview.missingColumns.length > 1 ? "s" : ""}.
        Start from Download CSV so the headers match.
      </p>}

      {preview && c && preview.missingColumns.length === 0 && <>
        <div className="im-counts">
          <span><b>{c.new}</b> new</span>
          <span><b>{c.update}</b> changed</span>
          <span><b>{c.same}</b> no change</span>
          {c.newGuardians > 0 && <span><b>{c.newGuardians}</b> new guardians</span>}
          {c.skip > 0 && <span className="warn"><b>{c.skip}</b> skipped</span>}
          {c.error > 0 && <span className="bad"><b>{c.error}</b> with problems</span>}
        </div>
        {c.error > 0 && <p className="im-bad">Rows with problems are skipped. Fix them in the file and upload again,
          or apply the rest now.</p>}

        <ul className="im-list">
          {shown.map((item) => <li key={item.line} className={`im-${item.kind}`}>
            <div><b>{item.rider}</b><small>Line {item.line}</small><em>{KIND_LABEL[item.kind]}</em></div>
            {item.error && <p>{item.error}</p>}
            {item.changes.length > 0 && <p>{item.changes.join(" · ")}</p>}
          </li>)}
          {shown.length === 0 && <li className="im-same"><div><b>Nothing to change.</b></div></li>}
        </ul>
        {c.same > 0 && <button type="button" className="linkish" onClick={() => setShowSame(!showSame)}>
          {showSame ? "Hide" : "Show"} {c.same} unchanged {c.same === 1 ? "row" : "rows"}
        </button>}

        <div className="im-actions">
          <button type="button" className="btn" disabled={busy} onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary" disabled={busy || willApply === 0} onClick={() => void apply()}>
            {willApply === 0 ? "Nothing to apply" : `Apply ${willApply} ${willApply === 1 ? "rider" : "riders"}`}
          </button>
        </div>
      </>}
    </div>
  </Overlay>;
}
