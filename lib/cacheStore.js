const path = require("node:path");
const Database = require("better-sqlite3");

const DAILY_METRICS_CACHE_VERSION = 4;

class CacheStore {
  constructor(options = {}) {
    const dbPath = options.dbPath || path.join(process.cwd(), "cache.sqlite");
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.initSchema();

    this.selectDailyStmt = this.db.prepare(
      "SELECT fetched_at, payload_json FROM daily_metrics_cache WHERE report_date = ? AND version = ?"
    );
    this.selectAllDailyPayloadsStmt = this.db.prepare(
      "SELECT payload_json FROM daily_metrics_cache WHERE version = ?"
    );
    this.upsertDailyStmt = this.db.prepare(
      `INSERT INTO daily_metrics_cache (report_date, version, fetched_at, payload_json)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(report_date)
       DO UPDATE SET
         version = excluded.version,
         fetched_at = excluded.fetched_at,
         payload_json = excluded.payload_json`
    );

    this.selectFxStmt = this.db.prepare(
      "SELECT fetched_at, rates_json FROM fx_rates_cache WHERE base_currency = ?"
    );
    this.upsertFxStmt = this.db.prepare(
      `INSERT INTO fx_rates_cache (base_currency, fetched_at, rates_json)
       VALUES (?, ?, ?)
       ON CONFLICT(base_currency)
       DO UPDATE SET
         fetched_at = excluded.fetched_at,
         rates_json = excluded.rates_json`
    );

    this.selectIconStmt = this.db.prepare(
      "SELECT fetched_at, icon_url FROM app_icons_cache WHERE app_id = ?"
    );
    this.upsertIconStmt = this.db.prepare(
      `INSERT INTO app_icons_cache (app_id, fetched_at, icon_url)
       VALUES (?, ?, ?)
       ON CONFLICT(app_id)
       DO UPDATE SET
         fetched_at = excluded.fetched_at,
         icon_url = excluded.icon_url`
    );

    this.selectStorefrontRatingsStmt = this.db.prepare(
      "SELECT app_id, storefront, average_rating, rating_count, fetched_at FROM app_ratings_by_storefront"
    );
    this.upsertStorefrontRatingStmt = this.db.prepare(
      `INSERT INTO app_ratings_by_storefront (app_id, storefront, average_rating, rating_count, fetched_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(app_id, storefront)
       DO UPDATE SET
         average_rating = excluded.average_rating,
         rating_count = excluded.rating_count,
         fetched_at = excluded.fetched_at`
    );

    this.selectRatingHistoryStmt = this.db.prepare(
      "SELECT app_id, snapshot_date, average_rating, rating_count FROM app_ratings_history ORDER BY snapshot_date"
    );
    this.selectLatestRatingSnapshotStmt = this.db.prepare(
      "SELECT MAX(snapshot_date) AS snapshot_date FROM app_ratings_history"
    );
    this.upsertRatingHistoryStmt = this.db.prepare(
      `INSERT INTO app_ratings_history (app_id, snapshot_date, average_rating, rating_count)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(app_id, snapshot_date)
       DO UPDATE SET
         average_rating = excluded.average_rating,
         rating_count = excluded.rating_count`
    );

    this.selectReviewsStmt = this.db.prepare(
      "SELECT fetched_at, payload_json FROM customer_reviews_cache WHERE app_id = ?"
    );
    this.selectAllReviewsStmt = this.db.prepare("SELECT payload_json FROM customer_reviews_cache");
    this.upsertReviewsStmt = this.db.prepare(
      `INSERT INTO customer_reviews_cache (app_id, fetched_at, payload_json)
       VALUES (?, ?, ?)
       ON CONFLICT(app_id)
       DO UPDATE SET
         fetched_at = excluded.fetched_at,
         payload_json = excluded.payload_json`
    );
  }

  initSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS daily_metrics_cache (
        report_date TEXT PRIMARY KEY,
        version INTEGER NOT NULL,
        fetched_at INTEGER NOT NULL,
        payload_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS fx_rates_cache (
        base_currency TEXT PRIMARY KEY,
        fetched_at INTEGER NOT NULL,
        rates_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS app_icons_cache (
        app_id TEXT PRIMARY KEY,
        fetched_at INTEGER NOT NULL,
        icon_url TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS app_ratings_by_storefront (
        app_id TEXT NOT NULL,
        storefront TEXT NOT NULL,
        average_rating REAL NOT NULL,
        rating_count INTEGER NOT NULL,
        fetched_at INTEGER NOT NULL,
        PRIMARY KEY (app_id, storefront)
      );

      CREATE TABLE IF NOT EXISTS app_ratings_history (
        app_id TEXT NOT NULL,
        snapshot_date TEXT NOT NULL,
        average_rating REAL NOT NULL,
        rating_count INTEGER NOT NULL,
        PRIMARY KEY (app_id, snapshot_date)
      );

      CREATE TABLE IF NOT EXISTS customer_reviews_cache (
        app_id TEXT PRIMARY KEY,
        fetched_at INTEGER NOT NULL,
        payload_json TEXT NOT NULL
      );
    `);
  }

  getDailyMetrics(reportDate, version) {
    const row = this.selectDailyStmt.get(reportDate, version);
    if (!row) {
      return null;
    }

    return {
      fetchedAt: Number(row.fetched_at),
      payload: safeParseJson(row.payload_json, null),
    };
  }

  saveDailyMetrics(reportDate, version, payload, fetchedAt = Date.now()) {
    this.upsertDailyStmt.run(reportDate, version, fetchedAt, JSON.stringify(payload));
  }

  getAllSalesMetricsPayloads(version) {
    return this.selectAllDailyPayloadsStmt
      .all(version)
      .map((row) => safeParseJson(row.payload_json, null))
      .filter(Boolean);
  }

  getSalesMetrics(reportDate, frequency, version) {
    return this.getDailyMetrics(buildSalesMetricsCacheKey(reportDate, frequency), version);
  }

  saveSalesMetrics(reportDate, frequency, version, payload, fetchedAt = Date.now()) {
    this.saveDailyMetrics(buildSalesMetricsCacheKey(reportDate, frequency), version, payload, fetchedAt);
  }

  getFxRates(baseCurrency) {
    const row = this.selectFxStmt.get(baseCurrency);
    if (!row) {
      return null;
    }

    return {
      fetchedAt: Number(row.fetched_at),
      rates: safeParseJson(row.rates_json, null),
    };
  }

  saveFxRates(baseCurrency, rates, fetchedAt = Date.now()) {
    this.upsertFxStmt.run(baseCurrency, fetchedAt, JSON.stringify(rates));
  }

  getAppIcon(appId) {
    const row = this.selectIconStmt.get(String(appId));
    if (!row) {
      return null;
    }

    return { fetchedAt: Number(row.fetched_at), iconUrl: row.icon_url };
  }

  saveAppIcon(appId, iconUrl, fetchedAt = Date.now()) {
    this.upsertIconStmt.run(String(appId), fetchedAt, iconUrl || "");
  }

  getStorefrontRatings() {
    return this.selectStorefrontRatingsStmt.all().map((row) => ({
      appId: row.app_id,
      storefront: row.storefront,
      average: Number(row.average_rating),
      count: Number(row.rating_count),
      fetchedAt: Number(row.fetched_at),
    }));
  }

  saveStorefrontRatings(storefront, entries, fetchedAt = Date.now()) {
    this.db.transaction(() => {
      for (const entry of entries) {
        this.upsertStorefrontRatingStmt.run(
          String(entry.appId),
          storefront,
          entry.average,
          entry.count,
          fetchedAt
        );
      }
    })();
  }

  getRatingHistory() {
    return this.selectRatingHistoryStmt.all().map((row) => ({
      appId: row.app_id,
      snapshotDate: row.snapshot_date,
      average: Number(row.average_rating),
      count: Number(row.rating_count),
    }));
  }

  getLatestRatingSnapshotDate() {
    return this.selectLatestRatingSnapshotStmt.get()?.snapshot_date || null;
  }

  saveRatingSnapshot(snapshotDate, entries) {
    this.db.transaction(() => {
      for (const entry of entries) {
        this.upsertRatingHistoryStmt.run(String(entry.appId), snapshotDate, entry.average, entry.count);
      }
    })();
  }

  getCustomerReviews(appId) {
    const row = this.selectReviewsStmt.get(String(appId));
    if (!row) {
      return null;
    }

    return {
      fetchedAt: Number(row.fetched_at),
      reviews: safeParseJson(row.payload_json, null),
    };
  }

  getAllCachedCustomerReviews() {
    return this.selectAllReviewsStmt
      .all()
      .flatMap((row) => safeParseJson(row.payload_json, null) || []);
  }

  saveCustomerReviews(appId, reviews, fetchedAt = Date.now()) {
    this.upsertReviewsStmt.run(String(appId), fetchedAt, JSON.stringify(reviews));
  }
}

function buildSalesMetricsCacheKey(reportDate, frequency) {
  const normalizedFrequency = String(frequency || "DAILY").trim().toUpperCase();
  const normalizedDate = String(reportDate || "").trim();

  // Preserve the existing daily-cache keys while avoiding collisions with annual reports.
  return normalizedFrequency === "DAILY" ? normalizedDate : `${normalizedFrequency}:${normalizedDate}`;
}

function safeParseJson(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

module.exports = {
  CacheStore,
  DAILY_METRICS_CACHE_VERSION,
  buildSalesMetricsCacheKey,
};
