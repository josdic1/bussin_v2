import assert from "node:assert/strict";
import test from "node:test";
import { hasArrivalEvidence, hasDepartureEvidence } from "./staff/journey.js";

// Real phones report a fix every 1-3s. These tests use that cadence; the old
// suite used 6-7s gaps, which hid the bug where auto arrival/departure could
// never satisfy its time span.
const stop = { latitude: 40.7484, longitude: -74.2600 };
const base = Date.parse("2026-10-02T14:50:00.000Z");
const metersNorth = (m: number) => stop.latitude + m / 111_320;
const fix = (seconds: number, northM: number, speedMps: number | null = 0, accuracyM = 5) => ({
  observedAt: new Date(base + seconds * 1000),
  latitude: metersNorth(northM),
  longitude: stop.longitude,
  accuracyM,
  speedMps
});

test("auto-arrival fires when parked at the stop with 1s fixes", () => {
  const fixes = Array.from({ length: 10 }, (_, i) => fix(i, 4 + (i % 2), 0.1));
  assert.equal(hasArrivalEvidence(fixes, stop), true);
});

test("auto-arrival fires when parked at the stop with 3s fixes (iOS idle cadence)", () => {
  const fixes = [0, 3, 6, 9].map((s) => fix(s, 6, 0));
  assert.equal(hasArrivalEvidence(fixes, stop), true);
});

test("auto-arrival waits for the time span, not just 3 fixes", () => {
  const fixes = [0, 1, 2, 3].map((s) => fix(s, 3, 0));
  assert.equal(hasArrivalEvidence(fixes, stop), false);
});

test("auto-arrival does not fire while driving through the stop", () => {
  const fixes = Array.from({ length: 12 }, (_, i) => fix(i, 10, 11));
  assert.equal(hasArrivalEvidence(fixes, stop), false);
});

test("auto-arrival ignores a stop at a red light 100m before the pickup", () => {
  const fixes = Array.from({ length: 20 }, (_, i) => fix(i, 100, 0));
  assert.equal(hasArrivalEvidence(fixes, stop), false);
});

test("auto-departure fires when driving off at 1s cadence", () => {
  // Parked, then accelerating away: 0 -> ~11 m/s.
  const fixes = [
    ...Array.from({ length: 5 }, (_, i) => fix(i, 3, 0)),
    ...Array.from({ length: 25 }, (_, i) => fix(5 + i, 3 + (i + 1) * (i + 1) * 0.6, Math.min(11, i)))
  ];
  assert.equal(hasDepartureEvidence(fixes, stop), true);
});

test("auto-departure survives a red light just outside the stop", () => {
  const fixes = [
    ...Array.from({ length: 6 }, (_, i) => fix(i, 80 + i * 8, 8)),
    ...Array.from({ length: 10 }, (_, i) => fix(6 + i, 128 + (i % 2) * 2 - 1, 0))
  ];
  assert.equal(hasDepartureEvidence(fixes, stop), true);
});

test("auto-departure does not fire for a bus parked 80m off a misplaced pin", () => {
  const fixes = Array.from({ length: 30 }, (_, i) => fix(i, 80 + (i % 3) * 2, 0));
  assert.equal(hasDepartureEvidence(fixes, stop), false);
});

test("auto-departure ignores one wild GPS jump", () => {
  const fixes = [
    ...Array.from({ length: 10 }, (_, i) => fix(i, 3, 0)),
    fix(10, 300, 0, 30),
    fix(11, 3, 0)
  ];
  assert.equal(hasDepartureEvidence(fixes, stop), false);
});

test("poor accuracy fixes never count", () => {
  const fixes = Array.from({ length: 15 }, (_, i) => fix(i, 3, 0, 60));
  assert.equal(hasArrivalEvidence(fixes, stop), false);
});

test("departure never fires for a bus sitting still 150m+ from a misplaced pin", () => {
  // Driver tapped Arrived far from a bad pin; kids are boarding. Distance alone must not depart.
  const fixes = Array.from({ length: 40 }, (_, i) => fix(i, 160 + (i % 3), 0));
  assert.equal(hasDepartureEvidence(fixes, stop), false);
});

test("departure fires when driving off from far away with real speed", () => {
  const fixes = Array.from({ length: 12 }, (_, i) => fix(i, 160 + i * 1, 4));
  assert.equal(hasDepartureEvidence(fixes, stop), true);
});

test("a long GPS gap breaks arrival evidence", () => {
  // Two fixes 60s apart at the stop prove nothing about the time between.
  const fixes = [fix(0, 3, 0), fix(60, 3, 0), fix(61, 3, 0)];
  assert.equal(hasArrivalEvidence(fixes, stop), false);
});

test("a long GPS gap breaks departure evidence", () => {
  const fixes = [fix(0, 100, 8), fix(40, 200, 8), fix(41, 210, 8)];
  assert.equal(hasDepartureEvidence(fixes, stop), false);
});
