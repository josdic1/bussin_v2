import assert from "node:assert/strict";
import { test } from "node:test";
import { isDemoTenant } from "./demo/mode.js";

// The demo switch must never turn on for the real camp's database.
test("demo mode only for tenants ending in -demo", () => {
  assert.equal(isDemoTenant("jcc-demo"), true);
  assert.equal(isDemoTenant("jcc"), false);
  assert.equal(isDemoTenant("demo-camp"), false);
  assert.equal(isDemoTenant("jcc-demo-camp"), false);
});
