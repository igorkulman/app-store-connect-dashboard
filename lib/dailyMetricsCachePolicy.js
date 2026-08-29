const DAILY_METRICS_CACHE_POLICY_VERSION = 2;
const DEFAULT_RECHECK_WINDOW_DAYS = 90;
const DEFAULT_REFRESH_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_YEARLY_REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function shouldRefreshCachedDailyMetrics(reportDate, cached, options = {}) {
  if (options.forceRefresh === true) {
    return true;
  }

  const fetchedAt = Number(cached?.fetchedAt);
  if (!Number.isFinite(fetchedAt) || fetchedAt <= 0) {
    return true;
  }

  const reportDateValue = parseDateUtc(reportDate);
  if (!reportDateValue) {
    return true;
  }

  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const recheckWindowDays = positiveInteger(
    options.recheckWindowDays,
    DEFAULT_RECHECK_WINDOW_DAYS
  );
  const refreshTtlMs = positiveInteger(options.refreshTtlMs, DEFAULT_REFRESH_TTL_MS);
  const recheckWindowStart = addDaysUtc(startOfTodayUtc(now), -recheckWindowDays);

  if (reportDateValue < recheckWindowStart) {
    return false;
  }

  if (cached?.payload?.cachePolicyVersion !== DAILY_METRICS_CACHE_POLICY_VERSION) {
    return true;
  }

  return now - fetchedAt >= refreshTtlMs;
}

function shouldRefreshCachedSalesMetrics(reportDate, frequency, cached, options = {}) {
  if (String(frequency || "").toUpperCase() === "DAILY") {
    return shouldRefreshCachedDailyMetrics(reportDate, cached, options);
  }

  if (options.forceRefresh === true) {
    return true;
  }

  const fetchedAt = Number(cached?.fetchedAt);
  if (!Number.isFinite(fetchedAt) || fetchedAt <= 0) {
    return true;
  }

  if (cached?.payload?.cachePolicyVersion !== DAILY_METRICS_CACHE_POLICY_VERSION) {
    return true;
  }

  const reportYear = Number.parseInt(String(reportDate), 10);
  if (!Number.isInteger(reportYear)) {
    return true;
  }

  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const latestCompletedYear = new Date(now).getUTCFullYear() - 1;
  if (reportYear !== latestCompletedYear) {
    return false;
  }

  const refreshTtlMs = positiveInteger(
    options.yearlyRefreshTtlMs,
    DEFAULT_YEARLY_REFRESH_TTL_MS
  );
  return now - fetchedAt >= refreshTtlMs;
}

function startOfTodayUtc(now = Date.now()) {
  const date = new Date(now);
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function addDaysUtc(date, deltaDays) {
  const value = new Date(date.getTime());
  value.setUTCDate(value.getUTCDate() + deltaDays);
  return value;
}

function parseDateUtc(value) {
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

module.exports = {
  DAILY_METRICS_CACHE_POLICY_VERSION,
  DEFAULT_RECHECK_WINDOW_DAYS,
  DEFAULT_REFRESH_TTL_MS,
  DEFAULT_YEARLY_REFRESH_TTL_MS,
  shouldRefreshCachedDailyMetrics,
  shouldRefreshCachedSalesMetrics,
};
