import assert from "node:assert/strict";
import test from "node:test";
import { FailureLimiter } from "./http.js";

test("login limiter blocks after the limit and clears on success", () => {
  const limiter = new FailureLimiter(3, 60_000);
  const start = 1_000_000;
  for (let i = 0; i < 3; i += 1) {
    assert.equal(limiter.retryAfter("ip|dana", start + i), 0);
    limiter.fail("ip|dana", start + i);
  }
  assert.ok(limiter.retryAfter("ip|dana", start + 10) > 0, "fourth attempt waits");
  assert.equal(limiter.retryAfter("ip|dana", start + 60_001), 0, "window expires");
  limiter.fail("ip|sam", start);
  limiter.clear("ip|sam");
  assert.equal(limiter.retryAfter("ip|sam", start), 0);
});
