import { subscribe } from "../db/listen.js";

export function subscribeToDispatchLocations(subscriber: (payload: string) => void) {
  return subscribe("bussin_dispatch_location", subscriber);
}
