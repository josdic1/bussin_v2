import { useState } from "react";
import { tripActionSchema, type BoardTrip } from "@bussin/shared";
import { message, send } from "./api";
import { earlyStartMinutes } from "./fleetModel";

export type TripActionType = "start" | "arrive" | "depart" | "undo_arrival" | "complete" | "cancel";
export type PendingConfirm = { tripId: string; type: "start" | "complete" | "cancel"; early: number };

/**
 * Trip controls shared by Dispatch and My Bus. Early starts, completion and
 * cancellation ask for confirmation inline; stop events go straight through.
 */
export function useTripActions(onDone: () => void, toast: (text: string) => void) {
  const [pending, setPending] = useState<PendingConfirm | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(tripId: string, type: TripActionType, stopId?: string) {
    const action = tripActionSchema.safeParse({ type, ...(stopId ? { stopId } : {}) });
    if (!action.success || busy) return;
    setBusy(true);
    try {
      await send("POST", `/api/dispatch/trips/${tripId}/actions`, action.data, "Could not update trip.");
      setPending(null);
      onDone();
    } catch (cause) {
      toast(message(cause, "Could not update trip."));
    } finally {
      setBusy(false);
    }
  }

  function request(trip: BoardTrip, type: TripActionType, stopId?: string) {
    if (type === "start") {
      const early = earlyStartMinutes(trip, Date.now());
      if (early > 0) { setPending({ tripId: trip.id, type, early }); return; }
    }
    if (type === "cancel" || type === "complete") {
      setPending({ tripId: trip.id, type, early: 0 });
      return;
    }
    void run(trip.id, type, stopId);
  }

  return {
    pending,
    busy,
    request,
    confirm: () => { if (pending) void run(pending.tripId, pending.type); },
    dismiss: () => setPending(null)
  };
}

export type TripActions = ReturnType<typeof useTripActions>;
