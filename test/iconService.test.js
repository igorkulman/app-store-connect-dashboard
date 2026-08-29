const test = require("node:test");
const assert = require("node:assert/strict");

const { shouldUseCachedIcon } = require("../lib/iconService");

const now = Date.parse("2026-08-29T12:00:00.000Z");

test("keeps found icons cached for seven days", () => {
  assert.equal(
    shouldUseCachedIcon(
      { fetchedAt: now - 6 * 24 * 60 * 60 * 1000, iconUrl: "https://example.com/icon.png" },
      now
    ),
    true
  );
});

test("retries a missing icon after one hour", () => {
  assert.equal(
    shouldUseCachedIcon({ fetchedAt: now - 59 * 60 * 1000, iconUrl: "" }, now),
    true
  );
  assert.equal(
    shouldUseCachedIcon({ fetchedAt: now - 61 * 60 * 1000, iconUrl: "" }, now),
    false
  );
});
