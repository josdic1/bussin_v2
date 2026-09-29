import type {
  RiderCheckAction,
  RiderCheckEventType,
  RiderCheckState
} from "@bussin/shared";

export type TripStatus = "planned" | "active" | "completed" | "cancelled";

export type RiderEventRow = {
  eventType: RiderCheckEventType;
  occurredAt: Date;
  recordedByName: string;
};

export type DerivedRider = {
  state: RiderCheckState;
  stateAt: Date | null;
  stateBy: string | null;
  boardedAt: Date | null;
  handled: boolean;
};

/**
 * A rider's current state is the result of replaying their check events in
 * order. "handled" marks the current state as dealt with; any later state
 * change clears it.
 */
export function deriveRiderState(events: RiderEventRow[]): DerivedRider {
  const result: DerivedRider = {
    state: "expected",
    stateAt: null,
    stateBy: null,
    boardedAt: null,
    handled: false
  };

  for (const event of events) {
    if (event.eventType === "handled") {
      result.handled = true;
      continue;
    }

    result.handled = false;
    result.stateAt = event.occurredAt;
    result.stateBy = event.recordedByName;

    switch (event.eventType) {
      case "boarded":
        result.state = "aboard";
        result.boardedAt = event.occurredAt;
        break;
      case "dropped_off":
        result.state = "dropped";
        break;
      case "no_show":
        result.state = "no_show";
        break;
      case "not_riding":
        result.state = "not_riding";
        break;
      case "undone":
        result.state = "expected";
        result.stateAt = null;
        result.stateBy = null;
        result.boardedAt = null;
        break;
    }
  }

  return result;
}

const eventFor: Record<RiderCheckAction["type"], RiderCheckEventType> = {
  board: "boarded",
  drop: "dropped_off",
  no_show: "no_show",
  not_riding: "not_riding",
  undo: "undone",
  handled: "handled"
};

/**
 * Explicit transition table. Returns the event to append, or the reason the
 * action is not allowed right now.
 */
export function checkTransition(
  current: DerivedRider,
  action: RiderCheckAction["type"],
  tripStatus: TripStatus
): { ok: true; eventType: RiderCheckEventType } | { ok: false; error: string } {
  if (tripStatus === "cancelled") {
    return { ok: false, error: "This trip was cancelled." };
  }

  const running = tripStatus === "active" || tripStatus === "completed";
  const state = current.state;

  switch (action) {
    case "board":
      if (!running) return { ok: false, error: "Start the trip before checking riders on." };
      if (state !== "expected" && state !== "no_show") {
        return { ok: false, error: "Only a waiting or missed rider can board." };
      }
      break;
    case "drop":
      if (!running) return { ok: false, error: "Start the trip before checking riders off." };
      if (state !== "aboard") return { ok: false, error: "Only a rider on the bus can get off." };
      break;
    case "no_show":
      if (!running) return { ok: false, error: "A no-show can only be recorded once the trip is running." };
      if (state !== "expected") return { ok: false, error: "Only a waiting rider can be a no-show." };
      break;
    case "not_riding":
      if (tripStatus !== "planned" && tripStatus !== "active") {
        return { ok: false, error: "This trip is already finished." };
      }
      if (state !== "expected") return { ok: false, error: "Only a waiting rider can be marked not riding." };
      break;
    case "undo":
      if (state === "expected") return { ok: false, error: "There is nothing to undo for this rider." };
      if (tripStatus === "planned" && state !== "not_riding") {
        return { ok: false, error: "There is nothing to undo for this rider." };
      }
      break;
    case "handled":
      if (!running) return { ok: false, error: "Nothing to follow up yet." };
      if (state !== "no_show" && state !== "aboard") {
        return { ok: false, error: "Only a no-show or a rider still aboard needs follow-up." };
      }
      if (current.handled) return { ok: false, error: "Already marked handled." };
      break;
  }

  return { ok: true, eventType: eventFor[action] };
}
