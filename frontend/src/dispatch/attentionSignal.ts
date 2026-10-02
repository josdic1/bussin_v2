import { useEffect, useRef } from "react";

/** One short two-tone chime. Silently does nothing if the browser blocks audio. */
function chime() {
  try {
    const AudioCtx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    [880, 660].forEach((frequency, index) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = frequency;
      const start = ctx.currentTime + index * 0.18;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.25, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.16);
      osc.connect(gain).connect(ctx.destination);
      osc.start(start);
      osc.stop(start + 0.17);
    });
    window.setTimeout(() => void ctx.close().catch(() => undefined), 800);
  } catch {
    // Audio unavailable: the tab title still shows the count.
  }
}

/**
 * Makes urgent Dispatch alerts (a silent bus, a late start) reach a dispatcher
 * who is on another tab: the count goes in the tab title, and a new urgent
 * alert plays one chime. No repeating sound.
 */
export function useAttentionSignal(urgentCount: number) {
  const previous = useRef(urgentCount);
  useEffect(() => {
    document.title = urgentCount > 0 ? `(${urgentCount}) Needs attention · Bussin` : "Bussin";
    if (urgentCount > previous.current) chime();
    previous.current = urgentCount;
  }, [urgentCount]);
  useEffect(() => () => { document.title = "Bussin"; }, []);
}
