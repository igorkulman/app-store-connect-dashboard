const test = require("node:test");
const assert = require("node:assert/strict");

const { ReviewsService } = require("../lib/reviewsService");
const { parseCustomerReviewsPage } = require("../lib/appStoreConnectClient");
const { territoryToCountryCode } = require("../lib/territories");

function createMemoryCache() {
  const store = new Map();
  return {
    getCustomerReviews: (appId) => store.get(appId) || null,
    saveCustomerReviews: (appId, reviews, fetchedAt) => store.set(appId, { reviews, fetchedAt }),
  };
}

function forbiddenError() {
  const error = new Error("forbidden");
  error.status = 403;
  return error;
}

test("parses reviews and attaches included developer responses", () => {
  const reviews = parseCustomerReviewsPage(
    {
      data: [
        {
          id: "r1",
          attributes: {
            rating: 4,
            title: "Nice",
            body: "Works well",
            reviewerNickname: "sam",
            createdDate: "2026-09-20T10:00:00-07:00",
            territory: "DEU",
          },
          relationships: { response: { data: { type: "customerReviewResponses", id: "p1" } } },
        },
        { id: "r2", attributes: { rating: 1, territory: "USA" } },
      ],
      included: [
        {
          type: "customerReviewResponses",
          id: "p1",
          attributes: { responseBody: "Thanks!", state: "PUBLISHED", lastModifiedDate: "2026-09-21T00:00:00Z" },
        },
      ],
    },
    "111"
  );

  assert.equal(reviews.length, 2);
  assert.equal(reviews[0].response.body, "Thanks!");
  assert.equal(reviews[0].appId, "111");
  assert.equal(reviews[1].response, null);
  assert.equal(reviews[1].title, "");
});

test("maps App Store Connect territories to country codes", () => {
  assert.equal(territoryToCountryCode("SVK"), "SK");
  assert.equal(territoryToCountryCode("XKS"), "XK");
  assert.equal(territoryToCountryCode("us"), "US");
  assert.equal(territoryToCountryCode("???"), "");
});

test("merges reviews across apps newest first by actual time", async () => {
  const ascClient = {
    listCustomerReviews: async (appId) =>
      appId === "111"
        ? [{ id: "a", appId: "111", createdDate: "2026-09-20T01:00:00-07:00", territory: "USA" }]
        : [{ id: "b", appId: "222", createdDate: "2026-09-20T09:00:00+02:00", territory: "SVK" }],
  };
  const service = new ReviewsService(ascClient, createMemoryCache());

  const result = await service.getReviews([
    { id: "111", name: "One" },
    { id: "222", name: "Two" },
  ]);

  // 01:00-07:00 is 08:00Z, which is later than 09:00+02:00 (07:00Z).
  assert.equal(result.access, "ok");
  assert.deepEqual(
    result.reviews.map((review) => [review.id, review.appName, review.country]),
    [
      ["a", "One", "US"],
      ["b", "Two", "SK"],
    ]
  );
});

test("reports forbidden access without throwing and skips the API until forced", async () => {
  let calls = 0;
  const ascClient = {
    listCustomerReviews: async () => {
      calls += 1;
      throw forbiddenError();
    },
  };
  const service = new ReviewsService(ascClient, createMemoryCache());
  const apps = [{ id: "111", name: "One" }];

  assert.deepEqual(await service.getReviews(apps), { access: "forbidden", reviews: [] });
  assert.deepEqual(await service.getReviews(apps), { access: "forbidden", reviews: [] });
  assert.equal(calls, 1);

  await service.getReviews(apps, { forceRefresh: true });
  assert.equal(calls, 2);
});

test("serves cached reviews when a refresh fails", async () => {
  const cache = createMemoryCache();
  cache.saveCustomerReviews("111", [{ id: "a", appId: "111", territory: "USA" }], 0);
  const ascClient = {
    listCustomerReviews: async () => {
      throw new Error("timeout");
    },
  };
  const service = new ReviewsService(ascClient, cache);

  const result = await service.getReviews([{ id: "111", name: "One" }]);
  assert.deepEqual(
    result.reviews.map((review) => review.id),
    ["a"]
  );
});
