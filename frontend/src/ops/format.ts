export const MIN = 60_000;

export function time(value: string | number | null | undefined) {
  if (value === null || value === undefined) return "—";
  return new Date(value).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

export function timeWithSeconds(value: string | number) {
  return new Date(value).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit" });
}

/** "just now", "12s ago", "3m ago", "2h ago", or an em dash for no value. */
export function age(value: string | number | null | undefined, now: number) {
  if (value === null || value === undefined) return "—";
  const seconds = Math.max(0, Math.floor((now - new Date(value).getTime()) / 1000));
  if (seconds < 10) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ago`;
}

export function ageShort(value: string | number | null | undefined, now: number) {
  return age(value, now).replace(" ago", "");
}

export function duration(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return minutes ? `${minutes}m${rest ? ` ${rest}s` : ""}` : `${rest}s`;
}

export function plural(count: number, one: string, many: string) {
  return count === 1 ? one : many;
}

export function localDate(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function shiftDay(day: string, offset: number) {
  const date = new Date(`${day}T12:00:00`);
  date.setDate(date.getDate() + offset);
  return localDate(date);
}

export function dayBounds(day: string, days = 1) {
  const start = new Date(`${day}T00:00:00`);
  const end = new Date(start);
  end.setDate(end.getDate() + days);
  return { from: start.toISOString(), to: end.toISOString() };
}

export function dayOffset(day: string, today = localDate(new Date())) {
  return Math.round((new Date(`${day}T12:00:00`).getTime() - new Date(`${today}T12:00:00`).getTime()) / 86_400_000);
}

export function dayName(day: string, today = localDate(new Date())) {
  const offset = dayOffset(day, today);
  if (offset === 0) return "Today";
  if (offset === -1) return "Yesterday";
  if (offset === 1) return "Tomorrow";
  return new Date(`${day}T12:00:00`).toLocaleDateString("en-US", { weekday: "long" });
}

export function dateLabel(day: string) {
  return new Date(`${day}T12:00:00`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

export function initials(name: string) {
  const words = name.trim().split(/\s+/);
  return ((words[0]?.[0] ?? "") + (words.length > 1 ? words.at(-1)![0] : "")).toUpperCase();
}

export const PALETTE = ["#c14345", "#20834e", "#d88412", "#2065b5", "#8442a1", "#148783"];

export function hashColor(id: string) {
  let total = 0;
  for (const char of id) total += char.charCodeAt(0);
  return PALETTE[total % PALETTE.length];
}

/** Route names often already end in AM/PM; add the period only when missing. */
export function routeWithPeriod(name: string, period: string) {
  return new RegExp(`[\\s_-]${period}$`, "i").test(name.trim()) ? name : `${name} ${period}`;
}
