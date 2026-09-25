export const DEFAULT_DWELL_SECONDS = 30;

export type EtaStopState = {
  arrivedAt: string | null;
  departedAt: string | null;
};

export function remainingCurrentStopDwellSeconds(
  stop: EtaStopState,
  nowMs = Date.now(),
  dwellSeconds = DEFAULT_DWELL_SECONDS
): number {
  if (!stop.arrivedAt || stop.departedAt) return 0;

  const arrivedMs = Date.parse(stop.arrivedAt);
  if (!Number.isFinite(arrivedMs)) return 0;

  const elapsedSeconds = Math.max(0, (nowMs - arrivedMs) / 1000);

  return Math.max(0, dwellSeconds - elapsedSeconds);
}

export function dwellBeforeStopSeconds(
  remainingStops: EtaStopState[],
  targetIndex: number,
  nowMs = Date.now(),
  dwellSeconds = DEFAULT_DWELL_SECONDS
): number {
  if (targetIndex <= 0) return 0;

  let totalSeconds = 0;

  for (let index = 0; index < targetIndex; index += 1) {
    const stop = remainingStops[index];

    if (index === 0 && stop.arrivedAt && !stop.departedAt) {
      totalSeconds += remainingCurrentStopDwellSeconds(
        stop,
        nowMs,
        dwellSeconds
      );
    } else if (!stop.departedAt) {
      totalSeconds += dwellSeconds;
    }
  }

  return totalSeconds;
}
