const test = require("node:test");
const assert = require("node:assert/strict");

const { aggregateDailyMetrics } = require("../lib/salesMetrics");

test("counts first-time downloads per country for each app", () => {
  const appId = "6809385431";
  const row = (productType, units, country) => ({
    "Apple Identifier": appId,
    "Product Type Identifier": productType,
    Units: String(units),
    "Customer Price": "0",
    "Developer Proceeds": "0",
    "Country Code": country,
  });

  const metrics = aggregateDailyMetrics(
    [row("1F", 2, "DE"), row("1F", 1, "cz"), row("1F", 3, "DE"), row("7F", 5, "JP")],
    { knownAppIds: new Set([appId]) }
  );

  // Updates (7F) are not downloads, so JP is not counted.
  assert.deepEqual(
    Array.from(metrics.byApp.get(appId).downloadsByCountry.entries()),
    [
      ["DE", 5],
      ["CZ", 1],
    ]
  );
});
