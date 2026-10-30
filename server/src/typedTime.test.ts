import assert from "node:assert/strict";
import test from "node:test";
import { parseTypedTime, timeLabel } from "@bussin/shared";

// Times typed the way people write them. The screen shows what was understood.

test("typed times", () => {
  const cases: [string, string | null][] = [
    ["634am", "06:34"], ["634a", "06:34"], ["6:34 a.m.", "06:34"], ["6:34", "06:34"], ["634p", "18:34"],
    ["6p", "18:00"], ["8", "08:00"], ["800", "08:00"], ["330", "15:30"], ["3:30", "15:30"], ["0130", "01:30"],
    ["1830", "18:30"], ["18:30", "18:30"], ["noon", "12:00"], ["12p", "12:00"], ["12a", "00:00"], ["12:15", "12:15"],
    ["13:61", null], ["25", null], ["13pm", null], ["abc", null], ["", null]
  ];
  for (const [typed, want] of cases) assert.equal(parseTypedTime(typed), want, typed);
  assert.equal(timeLabel("06:34"), "6:34 AM");
  assert.equal(timeLabel("00:05"), "12:05 AM");
  assert.equal(timeLabel("12:00"), "12:00 PM");
});
