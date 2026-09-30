import { subscribe } from "../db/listen.js";

export function subscribeToStaffTrips(subscriber: (payload: string) => void) {
  return subscribe("bussin_staff_trip", subscriber);
}
