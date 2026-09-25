export const MAX_LOCATION_AGE_MS = 60_000;
export const MAX_LOCATION_FUTURE_SKEW_MS = 30_000;
export const MAX_LOCATION_ACCURACY_M = 100;

export type LocationSampleRejectionReason =
  | "stale"
  | "future"
  | "poor_accuracy";

export function locationSampleRejectionReason(
  sample: { observedAt: string; accuracyM: number },
  nowMs = Date.now()
): LocationSampleRejectionReason | null {
  const observedMs = Date.parse(sample.observedAt);

  if (observedMs < nowMs - MAX_LOCATION_AGE_MS) return "stale";
  if (observedMs > nowMs + MAX_LOCATION_FUTURE_SKEW_MS) return "future";
  if (sample.accuracyM > MAX_LOCATION_ACCURACY_M) return "poor_accuracy";
  return null;
}

export function locationDatabaseRejectionReason(
  error: unknown
): LocationSampleRejectionReason | null {
  if (typeof error !== "object" || error === null || !("code" in error) || error.code !== "P0001") {
    return null;
  }

  const message = "message" in error && typeof error.message === "string" ? error.message : "";
  if (message.includes("GPS sample is stale")) return "stale";
  if (message.includes("GPS sample is too far in the future")) return "future";
  if (message.includes("GPS sample accuracy is too poor")) return "poor_accuracy";
  return null;
}
