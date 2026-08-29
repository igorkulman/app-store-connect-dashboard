require("dotenv").config();

const path = require("node:path");
const express = require("express");

const { AppStoreConnectClient } = require("./lib/appStoreConnectClient");
const {
  decodeSalesReport,
  aggregateDailyMetrics,
  mergePerAppTotals,
} = require("./lib/salesMetrics");
const { CacheStore, DAILY_METRICS_CACHE_VERSION } = require("./lib/cacheStore");
const {
  DAILY_METRICS_CACHE_POLICY_VERSION,
  DEFAULT_RECHECK_WINDOW_DAYS,
  DEFAULT_REFRESH_TTL_MS,
  DEFAULT_YEARLY_REFRESH_TTL_MS,
  shouldRefreshCachedSalesMetrics,
} = require("./lib/dailyMetricsCachePolicy");
const { FxService } = require("./lib/fxService");
const { IconService } = require("./lib/iconService");

const PORT = Number.parseInt(process.env.PORT || "3000", 10);
const APP_LIST_TTL_MS = 10 * 60 * 1000;
const IAP_INDEX_TTL_MS = 60 * 60 * 1000;
const REPORT_REFRESH_TTL_MS = positiveIntegerEnv(
  process.env.ASC_SALES_REPORT_REFRESH_TTL_MS,
  DEFAULT_REFRESH_TTL_MS
);
const REPORT_RECHECK_WINDOW_DAYS = positiveIntegerEnv(
  process.env.ASC_SALES_REPORT_RECHECK_DAYS,
  DEFAULT_RECHECK_WINDOW_DAYS
);
const YEARLY_REPORT_REFRESH_TTL_MS = positiveIntegerEnv(
  process.env.ASC_YEARLY_SALES_REPORT_REFRESH_TTL_MS,
  DEFAULT_YEARLY_REFRESH_TTL_MS
);

const app = express();
app.use(express.json());
app.use(express.static(path.join(process.cwd(), "public")));

let ascClient;
try {
  ascClient = AppStoreConnectClient.fromEnv();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

const cacheStore = new CacheStore({
  dbPath: process.env.CACHE_DB_PATH || path.join(process.cwd(), "cache.sqlite"),
});
const fxService = new FxService(cacheStore, {
  displayCurrency: process.env.DISPLAY_CURRENCY || "USD",
});
const iconService = new IconService(cacheStore);

const appListCache = {
  apps: [],
  expiresAt: 0,
};

const iapIndexCache = {
  map: new Map(),
  expiresAt: 0,
};

app.get("/api/health", (req, res) => {
  res.json({ ok: true });
});

app.get("/api/apps", async (req, res) => {
  try {
    const apps = await getApps();
    const iconUrls = await iconService.getIconUrls(apps.map((a) => a.id));
    const appsWithIcons = apps.map((a) => ({ ...a, iconUrl: iconUrls.get(a.id) || "" }));
    res.json({ data: appsWithIcons });
  } catch (error) {
    handleRouteError(res, error);
  }
});

app.get("/api/metrics", async (req, res) => {
  try {
    const reportRequest = parseReportRequest(req.query);
    const selectedAppId = typeof req.query.appId === "string" ? req.query.appId.trim() : "";
    const forceRefresh = String(req.query.refresh || "") === "1";

    const apps = await getApps();
    const appNameById = new Map(apps.map((entry) => [entry.id, entry.name]));
    const knownAppIds = new Set(apps.map((entry) => entry.id));
    const bundleIdMatchers = buildBundleIdMatchers(apps);
    const appSkuToAppIdMap = buildUniqueAppSkuMap(apps);
    const appNameMatchers = buildAppNameMatchers(apps);
    const iapToAppIdMap = await getIapToAppIdMap(apps, knownAppIds);

    if (selectedAppId && !appNameById.has(selectedAppId)) {
      return res.status(400).json({
        error: `Unknown appId '${selectedAppId}'. Use /api/apps to get valid IDs.`,
      });
    }

    const { frequency, granularity, days, startDate, endDate, reportDates } = reportRequest;

    const aggregationContext = {
      knownAppIds,
      bundleIdMatchers,
      appSkuToAppIdMap,
      appNameMatchers,
      iapToAppIdMap,
    };

    const reportData = await mapWithConcurrency(reportDates, 4, async (reportDate) => {
      const aggregated = await getMetricsForReportDate(reportDate, frequency, aggregationContext, {
        forceRefresh,
      });
      return { date: reportDate, ...aggregated };
    });

    let totalDownloads = 0;
    let totalPurchases = 0;
    const totalGrossSalesByCurrency = new Map();
    const totalProceedsByCurrency = new Map();
    const perAppTotals = new Map();

    const series = reportData.map((item) => {
      const scoped = selectedAppId
        ? item.byApp.get(selectedAppId) || createEmptyPerAppMetrics()
        : item;

      totalDownloads += scoped.downloads;
      totalPurchases += scoped.purchases;
      mergeCurrencyTotals(totalGrossSalesByCurrency, scoped.grossSalesByCurrency);
      mergeCurrencyTotals(totalProceedsByCurrency, scoped.proceedsByCurrency);

      if (!selectedAppId) {
        mergePerAppTotals(perAppTotals, item.byApp);
      }

      return {
        date: item.date,
        downloads: roundMetric(scoped.downloads),
        purchases: roundMetric(scoped.purchases),
      };
    });

    const appBreakdown = apps
      .map((appEntry) => {
        const metrics = perAppTotals.get(appEntry.id) || createEmptyPerAppMetrics();
        return {
          appId: appEntry.id,
          name: appEntry.name || metrics.title || `App ${appEntry.id}`,
          downloads: roundMetric(metrics.downloads),
          purchases: roundMetric(metrics.purchases),
        };
      })
      .sort(
        (a, b) =>
          b.downloads + b.purchases - (a.downloads + a.purchases) || a.name.localeCompare(b.name)
      );

    const grossSales = buildMoneySummary(totalGrossSalesByCurrency);
    const proceeds = buildMoneySummary(totalProceedsByCurrency);
    const [grossSalesConverted, proceedsConverted] = await Promise.all([
      fxService.convertSummaryToDisplayCurrency(grossSales),
      fxService.convertSummaryToDisplayCurrency(proceeds),
    ]);

    res.json({
      data: {
        source: "salesReports",
        frequency,
        granularity,
        selectedAppId: selectedAppId || null,
        selectedAppName: selectedAppId ? appNameById.get(selectedAppId) || null : null,
        startDate,
        endDate,
        days,
        totals: {
          downloads: roundMetric(totalDownloads),
          purchases: roundMetric(totalPurchases),
          grossSales,
          proceeds,
          grossSalesConverted,
          proceedsConverted,
        },
        series,
        appBreakdown,
        definitions: {
          downloads:
            `Positive units from App Store first-time install product types (1, 1F, 1T, 1E, 1EP, 1EU, F1) in the ${frequency.toLowerCase()} SALES summary report. Updates and re-downloads are excluded.`,
          purchases:
            "Positive units with positive customer price or developer proceeds, excluding update/redownload product types.",
          grossSales:
            "Sum of customer price × units for purchase rows, grouped by currency from the report.",
          proceeds:
            "Sum of developer proceeds × units for purchase rows, grouped by currency from the report.",
          convertedTotals:
            `Single-number money totals converted to ${fxService.displayCurrency} using cached FX rates.`,
        },
      },
    });
  } catch (error) {
    handleRouteError(res, error);
  }
});

app.listen(PORT, () => {
  console.log(`Dashboard server running on http://localhost:${PORT}`);
});

async function getApps() {
  const now = Date.now();

  if (appListCache.apps.length && now < appListCache.expiresAt) {
    return appListCache.apps;
  }

  const apps = await ascClient.listApps();
  appListCache.apps = apps;
  appListCache.expiresAt = now + APP_LIST_TTL_MS;

  return apps;
}

async function getMetricsForReportDate(reportDate, frequency, aggregationContext, options = {}) {
  const forceRefresh = options.forceRefresh === true;
  const cached = cacheStore.getSalesMetrics(reportDate, frequency, DAILY_METRICS_CACHE_VERSION);
  if (
    cached?.payload &&
    !shouldRefreshCachedSalesMetrics(reportDate, frequency, cached, {
      forceRefresh,
      refreshTtlMs: REPORT_REFRESH_TTL_MS,
      recheckWindowDays: REPORT_RECHECK_WINDOW_DAYS,
      yearlyRefreshTtlMs: YEARLY_REPORT_REFRESH_TTL_MS,
    })
  ) {
    return deserializeDailyMetrics(cached.payload);
  }

  try {
    const reportBuffer = await ascClient.downloadSalesSummary(reportDate, frequency);
    const rows = decodeSalesReport(reportBuffer);
    const aggregated = aggregateDailyMetrics(rows, aggregationContext);

    cacheStore.saveSalesMetrics(
      reportDate,
      frequency,
      DAILY_METRICS_CACHE_VERSION,
      serializeDailyMetrics(aggregated),
      Date.now()
    );

    return aggregated;
  } catch (error) {
    // Some vendors return 410 rather than 404 for unavailable historical annual reports.
    if (error.status === 404 || (frequency === "YEARLY" && error.status === 410)) {
      const empty = createEmptyDailyMetrics();
      cacheStore.saveSalesMetrics(
        reportDate,
        frequency,
        DAILY_METRICS_CACHE_VERSION,
        serializeDailyMetrics(empty),
        Date.now()
      );
      return empty;
    }

    throw error;
  }
}

async function getIapToAppIdMap(apps, knownAppIds) {
  const now = Date.now();

  if (iapIndexCache.map.size && now < iapIndexCache.expiresAt) {
    return iapIndexCache.map;
  }

  const uniqueMap = new Map();
  const ambiguous = new Set();

  await mapWithConcurrency(apps, 4, async (appEntry) => {
    let purchases = [];
    try {
      purchases = await ascClient.listInAppPurchasesV2ForApp(appEntry.id);
    } catch (error) {
      try {
        purchases = await ascClient.listInAppPurchasesLegacyForApp(appEntry.id);
      } catch {
        // Some keys/roles may not allow IAP endpoints. Keep dashboard working without this enrichment.
        return;
      }
    }

    for (const item of purchases) {
      if (!knownAppIds.has(item.appId)) {
        continue;
      }

      registerIapKey(uniqueMap, ambiguous, item.id, item.appId);
      registerIapKey(uniqueMap, ambiguous, item.productId, item.appId);
      registerIapKey(uniqueMap, ambiguous, item.name, item.appId);
    }
  });

  iapIndexCache.map = uniqueMap;
  iapIndexCache.expiresAt = now + IAP_INDEX_TTL_MS;
  return uniqueMap;
}

function registerIapKey(targetMap, ambiguousSet, rawKey, appId) {
  const key = normalizeLookupKey(rawKey);
  if (!key) {
    return;
  }

  if (ambiguousSet.has(key)) {
    return;
  }

  const existing = targetMap.get(key);
  if (!existing) {
    targetMap.set(key, appId);
    return;
  }

  if (existing !== appId) {
    targetMap.delete(key);
    ambiguousSet.add(key);
  }
}

function buildUniqueAppSkuMap(apps) {
  const map = new Map();
  const ambiguous = new Set();

  for (const appEntry of apps) {
    const skuKey = normalizeLookupKey(appEntry.sku);
    if (!skuKey) {
      continue;
    }

    if (ambiguous.has(skuKey)) {
      continue;
    }

    const existing = map.get(skuKey);
    if (!existing) {
      map.set(skuKey, appEntry.id);
      continue;
    }

    if (existing !== appEntry.id) {
      map.delete(skuKey);
      ambiguous.add(skuKey);
    }
  }

  return map;
}

function buildBundleIdMatchers(apps) {
  return apps
    .map((entry) => ({
      appId: entry.id,
      bundleId: normalizeLookupKey(entry.bundleId),
    }))
    .filter((entry) => entry.bundleId.includes("."))
    .sort((a, b) => b.bundleId.length - a.bundleId.length);
}

function buildAppNameMatchers(apps) {
  return apps
    .map((entry) => ({
      appId: entry.id,
      name: String(entry.name || "").trim().toLowerCase(),
    }))
    .filter((entry) => entry.name.length >= 3)
    .sort((a, b) => b.name.length - a.name.length);
}

function handleRouteError(res, error) {
  const status = Number.isInteger(error.status) ? error.status : 500;
  res.status(status).json({
    error: error.message || "Unexpected server error.",
  });
}

function parseReportRequest(query) {
  const period = String(query.period || "daily").trim().toLowerCase();

  if (period === "yearly") {
    return buildYearlyReportRequest(query.year);
  }

  if (period !== "daily") {
    throw createBadRequestError("period must be either 'daily' or 'yearly'.");
  }

  const days = clampNumber(query.days, 30, 1, 365);
  const endDate = formatDateUtc(addDaysUtc(startOfTodayUtc(), -1));
  const startDate = formatDateUtc(addDaysUtc(startOfTodayUtc(), -days));

  return {
    frequency: "DAILY",
    granularity: "day",
    days,
    startDate,
    endDate,
    reportDates: buildDateRange(startDate, endDate),
  };
}

function buildYearlyReportRequest(rawYear) {
  const firstAvailableYear = 2008;
  const latestCompletedYear = startOfTodayUtc().getUTCFullYear() - 1;
  const requestedYear = String(rawYear || "").trim().toLowerCase();

  let startYear;
  let endYear;
  if (requestedYear === "all") {
    startYear = firstAvailableYear;
    endYear = latestCompletedYear;
  } else if (/^\d{4}$/.test(requestedYear)) {
    startYear = Number.parseInt(requestedYear, 10);
    endYear = startYear;
  } else {
    throw createBadRequestError("year must be a completed four-digit calendar year or 'all'.");
  }

  if (startYear < firstAvailableYear || endYear > latestCompletedYear) {
    throw createBadRequestError(
      `year must be between ${firstAvailableYear} and ${latestCompletedYear}, or 'all'.`
    );
  }

  return {
    frequency: "YEARLY",
    granularity: "year",
    days: null,
    startDate: String(startYear),
    endDate: String(endYear),
    reportDates: buildYearRange(startYear, endYear),
  };
}

function createBadRequestError(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

function buildDateRange(startDate, endDate) {
  const values = [];
  let cursor = new Date(`${startDate}T00:00:00.000Z`);
  const final = new Date(`${endDate}T00:00:00.000Z`);

  while (cursor <= final) {
    values.push(formatDateUtc(cursor));
    cursor = addDaysUtc(cursor, 1);
  }

  return values;
}

function buildYearRange(startYear, endYear) {
  const years = [];
  for (let year = startYear; year <= endYear; year += 1) {
    years.push(String(year));
  }
  return years;
}

function startOfTodayUtc() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function addDaysUtc(date, deltaDays) {
  const value = new Date(date.getTime());
  value.setUTCDate(value.getUTCDate() + deltaDays);
  return value;
}

function formatDateUtc(date) {
  return date.toISOString().slice(0, 10);
}

function clampNumber(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value ?? ""), 10);

  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, parsed));
}

function positiveIntegerEnv(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function roundMetric(value) {
  return Math.round(value * 100) / 100;
}

function mergeCurrencyTotals(targetMap, sourceMap) {
  for (const [currency, amount] of sourceMap.entries()) {
    const current = targetMap.get(currency) || 0;
    targetMap.set(currency, current + amount);
  }
}

function serializeDailyMetrics(aggregated) {
  const byAppEntries = aggregated?.byApp instanceof Map ? Array.from(aggregated.byApp.entries()) : [];

  return {
    cachePolicyVersion: DAILY_METRICS_CACHE_POLICY_VERSION,
    downloads: toFiniteNumber(aggregated?.downloads),
    purchases: toFiniteNumber(aggregated?.purchases),
    grossSalesByCurrency: serializeCurrencyMap(aggregated?.grossSalesByCurrency),
    proceedsByCurrency: serializeCurrencyMap(aggregated?.proceedsByCurrency),
    byApp: byAppEntries.map(([appId, metrics]) => [
      String(appId),
      {
        downloads: toFiniteNumber(metrics?.downloads),
        purchases: toFiniteNumber(metrics?.purchases),
        title: String(metrics?.title || ""),
        grossSalesByCurrency: serializeCurrencyMap(metrics?.grossSalesByCurrency),
        proceedsByCurrency: serializeCurrencyMap(metrics?.proceedsByCurrency),
      },
    ]),
    rowCount: Math.max(0, Math.round(toFiniteNumber(aggregated?.rowCount))),
  };
}

function deserializeDailyMetrics(payload) {
  if (!payload || typeof payload !== "object") {
    return createEmptyDailyMetrics();
  }

  const byApp = new Map();
  for (const entry of asArray(payload.byApp)) {
    if (!Array.isArray(entry) || entry.length !== 2) {
      continue;
    }

    const appId = String(entry[0] || "").trim();
    if (!appId) {
      continue;
    }

    const metrics = entry[1] || {};
    byApp.set(appId, {
      downloads: toFiniteNumber(metrics.downloads),
      purchases: toFiniteNumber(metrics.purchases),
      title: String(metrics.title || ""),
      grossSalesByCurrency: deserializeCurrencyMap(metrics.grossSalesByCurrency),
      proceedsByCurrency: deserializeCurrencyMap(metrics.proceedsByCurrency),
    });
  }

  return {
    downloads: toFiniteNumber(payload.downloads),
    purchases: toFiniteNumber(payload.purchases),
    grossSalesByCurrency: deserializeCurrencyMap(payload.grossSalesByCurrency),
    proceedsByCurrency: deserializeCurrencyMap(payload.proceedsByCurrency),
    byApp,
    rowCount: Math.max(0, Math.round(toFiniteNumber(payload.rowCount))),
  };
}

function serializeCurrencyMap(map) {
  if (!(map instanceof Map)) {
    return [];
  }

  const entries = [];
  for (const [currency, amount] of map.entries()) {
    const numericAmount = toFiniteNumber(amount);
    if (numericAmount === 0) {
      continue;
    }

    entries.push([String(currency || "UNKNOWN"), roundMoney(numericAmount)]);
  }

  return entries;
}

function deserializeCurrencyMap(payload) {
  const map = new Map();
  const entries = Array.isArray(payload)
    ? payload
    : payload && typeof payload === "object"
      ? Object.entries(payload)
      : [];

  for (const entry of entries) {
    if (!Array.isArray(entry) || entry.length !== 2) {
      continue;
    }

    const currency = String(entry[0] || "UNKNOWN");
    const amount = toFiniteNumber(entry[1]);
    if (amount === 0) {
      continue;
    }

    map.set(currency, amount);
  }

  return map;
}

function createEmptyPerAppMetrics() {
  return {
    downloads: 0,
    purchases: 0,
    title: "",
    grossSalesByCurrency: new Map(),
    proceedsByCurrency: new Map(),
  };
}

function createEmptyDailyMetrics() {
  return {
    downloads: 0,
    purchases: 0,
    grossSalesByCurrency: new Map(),
    proceedsByCurrency: new Map(),
    byApp: new Map(),
    rowCount: 0,
  };
}

function buildMoneySummary(currencyMap) {
  const byCurrency = Array.from(currencyMap.entries())
    .map(([currency, amount]) => ({
      currency,
      amount: roundMoney(amount),
    }))
    .filter((entry) => entry.amount !== 0)
    .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));

  return {
    mixedCurrencies: byCurrency.length > 1,
    byCurrency,
  };
}

function roundMoney(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function normalizeLookupKey(value) {
  return String(value || "").trim().toLowerCase();
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function toFiniteNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let index = 0;

  const workers = Array.from({ length: Math.max(1, concurrency) }, async () => {
    while (true) {
      const currentIndex = index;
      if (currentIndex >= items.length) {
        return;
      }

      index += 1;
      results[currentIndex] = await mapper(items[currentIndex], currentIndex);
    }
  });

  await Promise.all(workers);
  return results;
}
