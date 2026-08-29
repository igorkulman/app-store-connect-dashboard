const test = require("node:test");
const assert = require("node:assert/strict");

const {
  DAILY_METRICS_CACHE_POLICY_VERSION,
  shouldRefreshCachedDailyMetrics,
  shouldRefreshCachedSalesMetrics,
} = require("../lib/dailyMetricsCachePolicy");

const now = Date.parse("2026-08-29T12:00:00.000Z");
const freshCachedReport = {
  fetchedAt: now - 60 * 60 * 1000,
  payload: { cachePolicyVersion: DAILY_METRICS_CACHE_POLICY_VERSION },
};

test("rechecks a recent report after its refresh TTL", () => {
  assert.equal(
    shouldRefreshCachedDailyMetrics("2026-08-13", freshCachedReport, {
      now,
      recheckWindowDays: 90,
      refreshTtlMs: 30 * 60 * 1000,
    }),
    true
  );
});

test("rechecks recent cache entries written with an older policy", () => {
  assert.equal(
    shouldRefreshCachedDailyMetrics(
      "2026-08-13",
      { fetchedAt: now, payload: { cachePolicyVersion: 1 } },
      { now, recheckWindowDays: 90, refreshTtlMs: 24 * 60 * 60 * 1000 }
    ),
    true
  );
});

test("rechecks the latest completed annual report but keeps older annual reports", () => {
  const cachedAnnualReport = {
    fetchedAt: now - 31 * 24 * 60 * 60 * 1000,
    payload: { cachePolicyVersion: DAILY_METRICS_CACHE_POLICY_VERSION },
  };

  assert.equal(
    shouldRefreshCachedSalesMetrics("2025", "YEARLY", cachedAnnualReport, { now }),
    true
  );
  assert.equal(
    shouldRefreshCachedSalesMetrics("2024", "YEARLY", cachedAnnualReport, { now }),
    false
  );
});

test("keeps old historical reports cached unless manually refreshed", () => {
  const legacyCachedReport = { fetchedAt: now, payload: { cachePolicyVersion: 1 } };

  assert.equal(
    shouldRefreshCachedDailyMetrics("2026-01-01", legacyCachedReport, {
      now,
      recheckWindowDays: 90,
    }),
    false
  );
  assert.equal(
    shouldRefreshCachedDailyMetrics("2026-01-01", legacyCachedReport, {
      now,
      forceRefresh: true,
    }),
    true
  );
});
