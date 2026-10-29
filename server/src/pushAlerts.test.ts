import assert from "node:assert/strict";
import test from "node:test";
import { dueAlerts, kidList, type TripFacts } from "./push/alerts.js";

// Parent phone alerts: the right message at the right moment, and nothing stale or pointless.

const now = new Date("2026-07-14T20:00:00Z"); // 4:00 PM in New Jersey
const min = (n: number) => new Date(now.getTime() + n * 60_000);
const pm: TripFacts = {
  busLabel: "Bus 2", servicePeriod: "PM", stopLabel: "JCC", firstStopLabel: "Camp", stopIsFirst: false,
  leftFirstStopAt: null, arrivedAt: null, etaAt: null, kids: ["Ava", "Noah"]
};
const kinds = (facts: TripFacts) => dueAlerts(facts, now).map((alert) => alert.kind);

test("afternoon: left camp, 10 minutes out, at JCC", () => {
  assert.deepEqual(kinds(pm), [], "nothing before the bus moves");
  const left = dueAlerts({ ...pm, leftFirstStopAt: min(-1), etaAt: min(35) }, now);
  assert.deepEqual(left.map((a) => a.kind), ["left"]);
  assert.equal(left[0]!.title, "Bus 2 left Camp");
  assert.equal(left[0]!.body, "Ava and Noah · about 4:35 PM at JCC");
  assert.deepEqual(kinds({ ...pm, leftFirstStopAt: min(-30), etaAt: min(9) }), ["near"], "an old departure isn't news");
  assert.equal(dueAlerts({ ...pm, etaAt: min(9) }, now)[0]!.title, "Bus 2 is 9 min from JCC");
  assert.deepEqual(kinds({ ...pm, etaAt: min(25) }), [], "25 minutes out is too early");
  const there = dueAlerts({ ...pm, arrivedAt: min(-1), etaAt: min(0) }, now);
  assert.deepEqual(there.map((a) => a.kind), ["arrived"], "arrived replaces near");
  assert.equal(there[0]!.body, "Ava and Noah are getting off now.");
  assert.deepEqual(kinds({ ...pm, arrivedAt: min(-45) }), [], "an old arrival isn't news");
});

test("morning at the first stop: no 'left' or 'arrived' for the people standing there", () => {
  const am: TripFacts = { ...pm, servicePeriod: "AM", stopLabel: "JCC", firstStopLabel: "JCC", stopIsFirst: true, kids: ["Ava"] };
  assert.deepEqual(kinds({ ...am, leftFirstStopAt: min(-1) }), []);
  assert.deepEqual(kinds({ ...am, arrivedAt: min(-1) }), []);
  assert.deepEqual(kinds({ ...am, etaAt: min(8) }), ["near"], "but 'almost here' still helps");
});

test("no kids riding, no alerts", () => {
  assert.deepEqual(kinds({ ...pm, kids: [], leftFirstStopAt: min(-1) }), []);
  assert.equal(kidList(["Ava", "Noah", "Eli"]), "Ava, Noah and Eli");
});
