type Name = "bus" | "gps" | "cloud" | "screen" | "message" | "clock" | "check" | "alert" | "refresh";
const paths: Record<Name, string> = {
  bus: "M5 17V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v12H5Zm0-7h14M5 17v4m14-4v4M8 14h.01M16 14h.01",
  gps: "M12 2v3m0 14v3M2 12h3m14 0h3M19 12a7 7 0 1 1-14 0 7 7 0 0 1 14 0Zm-4 0a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z",
  cloud: "M7 18H6a4 4 0 0 1-.6-7.95A7 7 0 0 1 19 9a4.5 4.5 0 0 1 .5 8.97M12 21V11m-4 4 4-4 4 4",
  screen: "M3 4h18v13H3V4Zm5 17h8m-4-4v4",
  message: "M21 4H3v13h5l4 4v-4h9V4ZM7 9h10M7 13h6",
  clock: "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM12 7v5l3 2",
  check: "m5 12 4 4L19 6",
  alert: "m12 3 10 18H2L12 3Zm0 6v5m0 3h.01",
  refresh: "M20 7v5h-5M4 17v-5h5M6 6a8 8 0 0 1 14 6M4 12a8 8 0 0 0 14 6"
};
export function DriverIcon({ name }: { name: Name }) {
  return <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d={paths[name]} /></svg>;
}
