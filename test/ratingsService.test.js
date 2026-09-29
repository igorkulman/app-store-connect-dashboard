const test = require("node:test");
const assert = require("node:assert/strict");

const {
  RatingsService,
  parseLookupRatings,
  summarizeStorefrontRatings,
  computeRatingDelta,
  selectStorefronts,
} = require("../lib/ratingsService");

test("parses lookup ratings and zeroes apps missing from the storefront", () => {
  const entries = parseLookupRatings(
    { results: [{ trackId: 111, averageUserRating: 4.5, userRatingCount: 12 }] },
    ["111", "222"]
  );

  assert.deepEqual(entries, [
    { appId: "111", average: 4.5, count: 12 },
    { appId: "222", average: 0, count: 0 },
  ]);
});

test("combines storefronts into a count-weighted average", () => {
  const summaries = summarizeStorefrontRatings([
    { appId: "111", storefront: "US", average: 5, count: 3 },
    { appId: "111", storefront: "DE", average: 3, count: 1 },
    { appId: "111", storefront: "SK", average: 0, count: 0 },
  ]);

  const summary = summaries.get("111");
  assert.equal(summary.count, 4);
  assert.equal(summary.average, 4.5);
  assert.deepEqual(
    summary.storefronts.map((entry) => entry.country),
    ["US", "DE"]
  );
});

test("compares ratings against the newest snapshot at least a week old", () => {
  const history = [
    { snapshotDate: "2026-09-10", count: 5 },
    { snapshotDate: "2026-09-21", count: 8 },
    { snapshotDate: "2026-09-25", count: 9 },
    { snapshotDate: "2026-09-29", count: 10 },
  ];

  assert.deepEqual(computeRatingDelta(history, 10, "2026-09-29"), { count: 2, since: "2026-09-21" });
});

test("falls back to the oldest snapshot while history is shorter than a week", () => {
  const history = [
    { snapshotDate: "2026-09-26", count: 3 },
    { snapshotDate: "2026-09-28", count: 4 },
  ];

  assert.deepEqual(computeRatingDelta(history, 5, "2026-09-29"), { count: 2, since: "2026-09-26" });
  assert.equal(computeRatingDelta([{ snapshotDate: "2026-09-29", count: 5 }], 5, "2026-09-29"), null);
});

test("queries download countries plus storefronts with known ratings, rated ones first", () => {
  const storefronts = selectStorefronts(
    ["US", "DE", "IN", "SK"],
    [
      { storefront: "SK", count: 2 },
      { storefront: "CZ", count: 7 },
      { storefront: "FR", count: 0 },
    ]
  );

  // CZ has no recent downloads but keeps being refreshed; FR never had ratings or downloads.
  assert.deepEqual(storefronts, ["CZ", "SK", "US", "DE", "IN"]);
});

test("checks each storefront at most once per day and picks up new download countries", () => {
  const today = Date.now();
  const cacheStore = {
    getStorefrontRatings: () => [
      { appId: "111", storefront: "US", average: 5, count: 1, fetchedAt: today },
      { appId: "111", storefront: "CZ", average: 4, count: 2, fetchedAt: today - 2 * 24 * 60 * 60 * 1000 },
    ],
  };
  let countries = ["US", "DE"];
  const service = new RatingsService(cacheStore, { getRatingCountries: () => countries });
  const runs = [];
  service.runRefresh = async (appIds, storefronts) => {
    runs.push(storefronts);
  };

  service.ensureFresh(["111"]);
  service.refresh = null;
  service.ensureFresh(["111"]);
  service.refresh = null;
  countries = ["US", "DE", "JP"];
  service.ensureFresh(["111"]);

  // US was fetched today; CZ is stale; DE isn't retried after being attempted; JP is new.
  assert.deepEqual(runs, [["CZ", "DE"], ["JP"]]);
});

test("keeps previous values for storefronts that fail and snapshots the result", async () => {
  const saved = new Map([["DE", [{ appId: "111", average: 4, count: 2 }]]]);
  const snapshots = [];
  const cacheStore = {
    getLatestRatingSnapshotDate: () => null,
    getStorefrontRatings: () =>
      Array.from(saved.entries()).flatMap(([storefront, entries]) =>
        entries.map((entry) => ({ ...entry, storefront }))
      ),
    saveStorefrontRatings: (storefront, entries) => saved.set(storefront, entries),
    getRatingHistory: () => [],
    saveRatingSnapshot: (date, entries) => snapshots.push({ date, entries }),
  };

  const fetchImpl = async (url) => {
    if (url.includes("country=de")) {
      throw new Error("network down");
    }
    return {
      ok: true,
      json: async () => ({ results: [{ trackId: 111, averageUserRating: 5, userRatingCount: 2 }] }),
    };
  };

  const service = new RatingsService(cacheStore, { requestIntervalMs: 0, fetchImpl });

  await service.runRefresh(["111"], ["DE", "US"], { done: 0, total: 2 });

  assert.deepEqual(saved.get("DE"), [{ appId: "111", average: 4, count: 2 }]);
  assert.equal(snapshots.length, 1);
  assert.deepEqual(snapshots[0].entries, [{ appId: "111", average: 4.5, count: 4 }]);
});
