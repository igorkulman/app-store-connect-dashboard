const { mapWithConcurrency } = require("./concurrency");
const { territoryToCountryCode } = require("./territories");

const REVIEWS_CACHE_TTL_MS = 60 * 60 * 1000;
const FORBIDDEN_RETRY_MS = 10 * 60 * 1000;

class ReviewsService {
  constructor(ascClient, cacheStore) {
    this.ascClient = ascClient;
    this.cacheStore = cacheStore;
    this.forbiddenUntil = 0;
  }

  async getReviews(apps, options = {}) {
    const forceRefresh = options.forceRefresh === true;
    const now = Date.now();

    // Reading reviews needs a different key role than sales reports, so a 403 is an expected
    // configuration state. Remember it briefly instead of hitting the API on every page load.
    if (!forceRefresh && now < this.forbiddenUntil) {
      return { access: "forbidden", reviews: [] };
    }

    const results = await mapWithConcurrency(apps, 4, (appEntry) =>
      this.getReviewsForApp(appEntry.id, { forceRefresh, now })
    );

    if (results.length && results.every((result) => result.forbidden)) {
      this.forbiddenUntil = now + FORBIDDEN_RETRY_MS;
      return { access: "forbidden", reviews: [] };
    }

    this.forbiddenUntil = 0;
    const nameById = new Map(apps.map((appEntry) => [appEntry.id, appEntry.name]));
    const reviews = results
      .flatMap((result) => result.reviews || [])
      .map((review) => ({
        ...review,
        appName: nameById.get(review.appId) || "",
        country: territoryToCountryCode(review.territory),
      }))
      // createdDate carries a UTC offset, so compare parsed timestamps rather than strings.
      .sort((a, b) => (Date.parse(b.createdDate) || 0) - (Date.parse(a.createdDate) || 0));

    return { access: "ok", reviews };
  }

  async getReviewsForApp(appId, { forceRefresh, now }) {
    const cached = this.cacheStore.getCustomerReviews(appId);
    const cachedReviews = Array.isArray(cached?.reviews) ? cached.reviews : null;
    if (!forceRefresh && cachedReviews && now - cached.fetchedAt < REVIEWS_CACHE_TTL_MS) {
      return { reviews: cachedReviews };
    }

    try {
      const reviews = await this.ascClient.listCustomerReviews(appId);
      this.cacheStore.saveCustomerReviews(appId, reviews, now);
      return { reviews };
    } catch (error) {
      if (error.status === 403) {
        return { forbidden: true };
      }

      // Serve stale reviews through transient API failures.
      if (cachedReviews) {
        return { reviews: cachedReviews };
      }

      throw error;
    }
  }
}

module.exports = {
  ReviewsService,
};
