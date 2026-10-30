import { useEffect, useState } from "react";
import { parseTypedTime, timeLabel } from "@bussin/shared";

/*
 * Type a time the way you'd write it: 634am, 6:34, 634p, 6p, 1830. Next to the box it says
 * what it understood ("6:34 AM"), so a guess is never hidden. value and onChange use "HH:MM".
 */
export function TimeField({ id, value, onChange, disabled, placeholder = "e.g. 8am or 3:30p" }: {
  id: string; value: string; onChange: (hhmm: string) => void; disabled?: boolean; placeholder?: string;
}) {
  const [text, setText] = useState(value ? timeLabel(value) : "");
  // A new value from outside (another record opened) replaces what's typed.
  useEffect(() => { if (value !== (parseTypedTime(text) ?? "")) setText(value ? timeLabel(value) : ""); }, [value]); // eslint-disable-line react-hooks/exhaustive-deps
  const parsed = parseTypedTime(text);
  const bad = text.trim() !== "" && !parsed;
  return <span className="timef">
    <input id={id} type="text" inputMode="text" autoComplete="off" value={text} disabled={disabled} placeholder={placeholder}
      aria-invalid={bad} aria-describedby={`${id}-read`}
      onChange={(event) => { setText(event.target.value); onChange(parseTypedTime(event.target.value) ?? ""); }}
      onBlur={() => { if (parsed) setText(timeLabel(parsed)); }} />
    <small id={`${id}-read`} className={bad ? "bad" : ""}>{bad ? "Try 8am or 3:30p" : parsed && text !== timeLabel(parsed) ? timeLabel(parsed) : ""}</small>
  </span>;
}
