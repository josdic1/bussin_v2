import assert from "node:assert/strict";
import test from "node:test";
import { busChecks, busDetailsInputSchema } from "@bussin/shared";

// The bus checklist: missing, expired and expiring-soon items, worked out from the dates on file.

test("bus checklist", () => {
  const empty = busChecks({ plate: null, company: null, seats: null, inspectionDue: null, insuranceExpires: null }, "2027-07-01", false);
  assert.deepEqual(empty.map((c) => c.state), ["missing", "missing", "missing", "missing", "missing", "missing"]);
  const full = busChecks({ plate: "ABC123", company: "Lakeland", seats: 44, inspectionDue: "2027-07-20", insuranceExpires: "2027-06-30" }, "2027-07-01", true);
  assert.deepEqual(full.map((c) => [c.key, c.state]), [
    ["plate", "ok"], ["company", "ok"], ["seats", "ok"], ["inspection", "soon"], ["insurance", "expired"], ["gps", "ok"]]);
  assert.match(full.find((c) => c.key === "insurance")!.text, /expired Jun 30, 2027/);
  assert.equal(busChecks({ plate: "x", company: "y", seats: 1, inspectionDue: "2027-09-01", insuranceExpires: "2027-09-01" }, "2027-07-01", true)
    .every((c) => c.state === "ok"), true);

  const input = busDetailsInputSchema.parse({ label: " Bus 1 ", plate: " ", company: "", seats: null, inspectionDue: "", insuranceExpires: "2027-06-30", notes: "" });
  assert.deepEqual(input, { label: "Bus 1", plate: null, company: null, seats: null, inspectionDue: null, insuranceExpires: "2027-06-30", notes: null });
  assert.equal(busDetailsInputSchema.safeParse({ ...input, seats: 0 }).success, false);
});
