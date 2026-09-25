export type EtaFreshness =
  | "live"
  | "aging"
  | "stale"
  | "calculating"
  | "off-route";

export type EtaAvailability = {
  freshness: EtaFreshness;
  available: boolean;
  ageSeconds: number | null;
};

export function etaAvailability(
  observedAt: string | null,
  offRoute: boolean,
  nowMs = Date.now()
): EtaAvailability {
  if (offRoute) {
    return {
      freshness: "off-route",
      available: false,
      ageSeconds: observedAt
        ? Math.max(0, (nowMs - Date.parse(observedAt)) / 1000)
        : null
    };
  }

  if (!observedAt) {
    return {
      freshness: "calculating",
      available: false,
      ageSeconds: null
    };
  }

  const observedMs = Date.parse(observedAt);

  if (!Number.isFinite(observedMs)) {
    return {
      freshness: "calculating",
      available: false,
      ageSeconds: null
    };
  }

  const ageSeconds = Math.max(0, (nowMs - observedMs) / 1000);

  if (ageSeconds <= 30) {
    return { freshness: "live", available: true, ageSeconds };
  }

  if (ageSeconds <= 60) {
    return { freshness: "aging", available: true, ageSeconds };
  }

  return {
    freshness: "stale",
    available: false,
    ageSeconds
  };
}
