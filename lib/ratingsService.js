const ITUNES_LOOKUP_URL = "https://itunes.apple.com/lookup";
const ITUNES_BATCH_SIZE = 100;
const ITUNES_TIMEOUT_MS = 10000;
// The iTunes Search API allows roughly 20 requests per minute. Stay below that so icon lookups still fit.
const DEFAULT_REQUEST_INTERVAL_MS = 4000;
const RATE_LIMIT_BACKOFF_MS = 60 * 1000;
const DELTA_WINDOW_DAYS = 7;

class RatingsService {
  constructor(cacheStore, options = {}) {
    this.cacheStore = cacheStore;
    this.getRatingCountries = options.getRatingCountries || (() => []);
    this.requestIntervalMs = options.requestIntervalMs ?? DEFAULT_REQUEST_INTERVAL_MS;
    this.fetchImpl = options.fetchImpl || fetch;
    this.refresh = null;
    this.attempted = { date: "", storefronts: new Set() };
  }

  // Ratings are collected storefront by storefront at a slow pace, so the refresh runs in the
  // background and callers get whatever is stored so far. Each storefront is checked at most once
  // per UTC day; countries that appear later in the day (e.g. from a longer sales range or a new
  // review) are picked up on the next call.
  ensureFresh(appIds) {
    if (this.refresh || !appIds.length) {
      return;
    }

    const today = formatDateUtc(new Date());
    if (this.attempted.date !== today) {
      this.attempted = { date: today, storefronts: new Set() };
    }

    const storedRows = this.cacheStore.getStorefrontRatings();
    const fetchedToday = new Set(
      storedRows
        .filter((row) => formatDateUtc(new Date(row.fetchedAt)) === today)
        .map((row) => row.storefront)
    );
    const storefronts = selectStorefronts(this.getRatingCountries(), storedRows).filter(
      (storefront) => !fetchedToday.has(storefront) && !this.attempted.storefronts.has(storefront)
    );
    if (!storefronts.length) {
      return;
    }

    // Failed storefronts (network errors, countries without a storefront) wait until tomorrow.
    for (const storefront of storefronts) {
      this.attempted.storefronts.add(storefront);
    }

    const refresh = { done: 0, total: storefronts.length };
    this.refresh = refresh;
    this.runRefresh(appIds, storefronts, refresh)
      .catch((error) => console.error(`Ratings refresh failed: ${error.message}`))
      .finally(() => {
        this.refresh = null;
      });
  }

  getRatings(appIds) {
    const summaries = summarizeStorefrontRatings(this.cacheStore.getStorefrontRatings());
    const historyByApp = groupBy(this.cacheStore.getRatingHistory(), (row) => row.appId);
    const today = formatDateUtc(new Date());

    return {
      updatedAt: this.cacheStore.getLatestRatingSnapshotDate(),
      refreshing: this.refresh ? { done: this.refresh.done, total: this.refresh.total } : null,
      apps: appIds.map((appId) => {
        const summary = summaries.get(appId) || { average: 0, count: 0, storefronts: [] };
        return {
          appId,
          ...summary,
          delta: computeRatingDelta(historyByApp.get(appId) || [], summary.count, today),
        };
      }),
    };
  }

  async runRefresh(appIds, storefronts, refresh) {
    const chunks = chunkArray(appIds, ITUNES_BATCH_SIZE);
    let succeeded = 0;

    for (const storefront of storefronts) {
      for (const chunk of chunks) {
        let result = await this.fetchStorefrontRatings(chunk, storefront);
        if (result.rateLimited) {
          await delay(RATE_LIMIT_BACKOFF_MS);
          result = await this.fetchStorefrontRatings(chunk, storefront);
        }

        // Failed storefronts keep their previous values rather than dropping to zero.
        if (result.entries) {
          this.cacheStore.saveStorefrontRatings(storefront, result.entries, Date.now());
          succeeded += 1;
        }

        await delay(this.requestIntervalMs);
      }

      refresh.done += 1;
    }

    if (!succeeded) {
      throw new Error("No App Store storefront could be reached.");
    }

    const summaries = summarizeStorefrontRatings(this.cacheStore.getStorefrontRatings());
    this.cacheStore.saveRatingSnapshot(
      formatDateUtc(new Date()),
      appIds.map((appId) => ({
        appId,
        average: summaries.get(appId)?.average || 0,
        count: summaries.get(appId)?.count || 0,
      }))
    );
  }

  async fetchStorefrontRatings(appIds, storefront) {
    try {
      const ids = appIds.map(encodeURIComponent).join(",");
      const response = await this.fetchImpl(
        `${ITUNES_LOOKUP_URL}?id=${ids}&country=${storefront.toLowerCase()}`,
        { signal: AbortSignal.timeout(ITUNES_TIMEOUT_MS) }
      );

      if (!response.ok) {
        return { rateLimited: response.status === 403 || response.status === 429 };
      }

      return { entries: parseLookupRatings(await response.json(), appIds) };
    } catch {
      return {};
    }
  }
}

function parseLookupRatings(payload, appIds) {
  const found = new Map();
  for (const item of Array.isArray(payload?.results) ? payload.results : []) {
    if (item?.trackId) {
      found.set(String(item.trackId), {
        average: toFiniteNumber(item.averageUserRating),
        count: Math.max(0, Math.round(toFiniteNumber(item.userRatingCount))),
      });
    }
  }

  // Apps missing from a storefront are not sold there, so they have no ratings in it.
  return appIds.map((appId) => ({
    appId: String(appId),
    ...(found.get(String(appId)) || { average: 0, count: 0 }),
  }));
}

function summarizeStorefrontRatings(rows) {
  const byApp = new Map();

  for (const row of rows) {
    if (!(row.count > 0)) {
      continue;
    }

    let summary = byApp.get(row.appId);
    if (!summary) {
      summary = { count: 0, weightedSum: 0, storefronts: [] };
      byApp.set(row.appId, summary);
    }

    summary.count += row.count;
    summary.weightedSum += row.average * row.count;
    summary.storefronts.push({
      country: row.storefront,
      average: roundRating(row.average),
      count: row.count,
    });
  }

  const result = new Map();
  for (const [appId, summary] of byApp.entries()) {
    result.set(appId, {
      average: roundRating(summary.weightedSum / summary.count),
      count: summary.count,
      storefronts: summary.storefronts.sort(
        (a, b) => b.count - a.count || a.country.localeCompare(b.country)
      ),
    });
  }

  return result;
}

// Compares against the newest snapshot that is at least a week old, falling back to the oldest
// earlier snapshot while history is still shorter than a week.
function computeRatingDelta(history, currentCount, today, windowDays = DELTA_WINDOW_DAYS) {
  const earlier = history
    .filter((entry) => entry.snapshotDate < today)
    .sort((a, b) => a.snapshotDate.localeCompare(b.snapshotDate));

  if (!earlier.length) {
    return null;
  }

  const cutoff = formatDateUtc(addDaysUtc(new Date(`${today}T00:00:00.000Z`), -windowDays));
  const baseline = earlier.filter((entry) => entry.snapshotDate <= cutoff).pop() || earlier[0];

  return {
    count: currentCount - baseline.count,
    since: baseline.snapshotDate,
  };
}

// Query the countries where ratings can exist plus any storefront that already has ratings.
// Known ratings go first, then the given countries in order.
function selectStorefronts(countries, storedRows) {
  const ratingsByStorefront = new Map();
  for (const row of storedRows) {
    ratingsByStorefront.set(row.storefront, (ratingsByStorefront.get(row.storefront) || 0) + row.count);
  }

  const rated = Array.from(ratingsByStorefront.keys()).filter(
    (storefront) => ratingsByStorefront.get(storefront) > 0
  );

  return Array.from(new Set([...countries, ...rated])).sort(
    (a, b) => (ratingsByStorefront.get(b) || 0) - (ratingsByStorefront.get(a) || 0)
  );
}

function groupBy(items, keyFn) {
  const map = new Map();
  for (const item of items) {
    const key = keyFn(item);
    const group = map.get(key);
    if (group) {
      group.push(item);
    } else {
      map.set(key, [item]);
    }
  }
  return map;
}

function chunkArray(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

function roundRating(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function toFiniteNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function addDaysUtc(date, deltaDays) {
  const value = new Date(date.getTime());
  value.setUTCDate(value.getUTCDate() + deltaDays);
  return value;
}

function formatDateUtc(date) {
  return date.toISOString().slice(0, 10);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  RatingsService,
  parseLookupRatings,
  summarizeStorefrontRatings,
  computeRatingDelta,
  selectStorefronts,
};
