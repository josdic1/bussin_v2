import assert from "node:assert/strict";
import test from "node:test";
import { trackingHealth, type TrackingEvidence } from "../src/staff/trackingHealth.ts";
const now = 1_000_000;
const live: TrackingEvidence = { now, active: true, online: true, visible: true, gpsAllowed: true,
  fixAt: now - 1000, accuracy: 8, acceptedFixAt: now - 1000, receivedAt: now - 500,
  tripCheckedAt: now - 1000, queued: 0, wakeHeld: true };
test("green requires fresh GPS, accepted sample, server receipt, trip confirmation and screen protection", () => {
  assert.equal(trackingHealth(live).tone, "good");
  for (const change of [{ fixAt: now - 21_000 }, { acceptedFixAt: now - 21_000 }, { receivedAt: null },
    { queued: 1 }, { tripCheckedAt: now - 46_000 }, { accuracy: 200 }, { wakeHeld: false },
    { active: false }, { fixAt: now + 60_000 }]) assert.notEqual(trackingHealth({ ...live, ...change }).tone, "good");
});
test("recent receipt of an old offline sample is delayed, never live", () => {
  assert.equal(trackingHealth({ ...live, receivedAt: now, acceptedFixAt: now - 120_000 }).title, "Location delivery delayed");
});
test("offline, backgrounded and permission denied are explicit failures", () => {
  for (const change of [{ online: false }, { visible: false }, { gpsAllowed: false }])
    assert.equal(trackingHealth({ ...live, ...change }).tone, "bad");
});
test("idle trip is never reported as live tracking", () => {
  assert.equal(trackingHealth({ ...live, active: false }).title, "Ready · tracking not started");
});
