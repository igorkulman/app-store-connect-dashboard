const test = require("node:test");
const assert = require("node:assert/strict");

const { buildSalesMetricsCacheKey } = require("../lib/cacheStore");

test("preserves daily cache keys and namespaces annual report keys", () => {
  assert.equal(buildSalesMetricsCacheKey("2026-08-28", "DAILY"), "2026-08-28");
  assert.equal(buildSalesMetricsCacheKey("2025", "YEARLY"), "YEARLY:2025");
});
