const appSelect = document.getElementById("appSelect");
const daysSelect = document.getElementById("daysSelect");
const refreshBtn = document.getElementById("refreshBtn");
const downloadsTotalEl = document.getElementById("downloadsTotal");
const purchasesTotalEl = document.getElementById("purchasesTotal");
const grossSalesTotalEl = document.getElementById("grossSalesTotal");
const grossSalesMetaEl = document.getElementById("grossSalesMeta");
const proceedsTotalEl = document.getElementById("proceedsTotal");
const proceedsMetaEl = document.getElementById("proceedsMeta");
const dateRangeEl = document.getElementById("dateRange");
const topAppsPanel = document.getElementById("topAppsPanel");
const topAppsBody = document.getElementById("topAppsBody");
const statusEl = document.getElementById("status");
const chartCanvas = document.getElementById("chart");
const loadingOverlayEl = document.getElementById("loadingOverlay");
const loadingTextEl = document.getElementById("loadingText");
const feedbackSubtitleEl = document.getElementById("feedbackSubtitle");
const reviewsNewBadgeEl = document.getElementById("reviewsNewBadge");
const ratingSummaryEl = document.getElementById("ratingSummary");
const markReviewsReadBtn = document.getElementById("markReviewsReadBtn");
const reviewsNoteEl = document.getElementById("reviewsNote");
const reviewsListEl = document.getElementById("reviewsList");
const showAllReviewsBtn = document.getElementById("showAllReviewsBtn");

const REVIEWS_PREVIEW_COUNT = 10;
const FEW_RATINGS_THRESHOLD = 5;
const RATINGS_POLL_MS = 15000;
const SEEN_REVIEWS_STORAGE_KEY = "appStoreDashboard.seenReviews";
const MAX_SEEN_REVIEW_IDS = 5000;

const numberFormatter = new Intl.NumberFormat();
const moneyFallbackFormatter = new Intl.NumberFormat(undefined, {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const ratingFormatter = new Intl.NumberFormat(undefined, {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});
const reviewDateFormatter = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });
const reviewDateTimeFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});
const snapshotDateFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeZone: "UTC",
});
const relativeTimeFormatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
const regionNames = createRegionNames();
let appIconMap = new Map();
let loadingCounter = 0;
let lastMetricsData = null;
let ratingsState = { loaded: false, error: "", updatedAt: null, refreshing: null, byAppId: new Map() };
let ratingsPollTimer = null;
let reviewsState = { status: "idle", scope: null, access: "ok", reviews: [], error: "" };
let reviewsRequestId = 0;
let showAllReviews = false;
const seenReviews = readSeenReviews();

populateYearlyRangeOptions();

refreshBtn.addEventListener("click", async () => {
  await loadApps().catch(() => {});
  loadReviews({ force: true });
  await loadMetrics({ force: true });
  loadRatings();
});
appSelect.addEventListener("change", () => {
  loadMetrics();
  showAllReviews = false;
  renderRatingSummary();
  loadReviews();
});
// Ratings are looked up in the countries found in the loaded sales reports, so a longer range can add some.
daysSelect.addEventListener("change", async () => {
  await loadMetrics();
  loadRatings();
});
markReviewsReadBtn.addEventListener("click", markReviewsAsRead);
showAllReviewsBtn.addEventListener("click", () => {
  showAllReviews = !showAllReviews;
  renderReviews();
});

initialize().catch((error) => showStatus(error.message, true));

async function initialize() {
  setLoading(true, "Loading apps...");
  try {
    showStatus("Loading apps...");
    const apps = await loadApps();

    appSelect.innerHTML = "";
    appSelect.append(new Option("All apps", ""));

    for (const app of apps) {
      appSelect.append(new Option(`${app.name} (${app.bundleId})`, app.id));
    }

    loadReviews();
    await loadMetrics();
    loadRatings();
  } finally {
    setLoading(false);
  }
}

async function loadApps() {
  const response = await fetch("/api/apps");
  const payload = await response.json();

  if (!response.ok) {
    throw new Error(payload.error || "Failed to load apps.");
  }

  const apps = payload.data || [];
  appIconMap = new Map(apps.map((a) => [a.id, a.iconUrl || ""]));
  return apps;
}

async function loadMetrics(options = {}) {
  const appId = appSelect.value;
  const [period, rangeValue] = (daysSelect.value || "daily:30").split(":");

  const params = new URLSearchParams();
  if (period === "yearly") {
    params.set("period", "yearly");
    params.set("year", rangeValue);
  } else {
    params.set("days", rangeValue);
  }
  if (options.force) {
    params.set("refresh", "1");
  }
  if (appId) {
    params.set("appId", appId);
  }

  showStatus("Loading metrics...");
  setLoading(true, "Loading metrics...");
  refreshBtn.disabled = true;

  try {
    const response = await fetch(`/api/metrics?${params.toString()}`);
    const payload = await response.json();

    if (!response.ok) {
      throw new Error(payload.error || "Failed to load metrics.");
    }

    render(payload.data);
    const selectedName = payload.data.selectedAppName || "all apps";
    showStatus(`Updated ${selectedName} (${payload.data.startDate} to ${payload.data.endDate}).`);
  } catch (error) {
    showStatus(error.message, true);
    drawEmptyChart(chartCanvas, "No data");
  } finally {
    refreshBtn.disabled = false;
    setLoading(false);
  }
}

function render(data) {
  lastMetricsData = data;
  downloadsTotalEl.textContent = formatMetric(data.totals.downloads);
  purchasesTotalEl.textContent = formatMetric(data.totals.purchases);
  renderConvertedMoneySummary(
    data?.totals?.grossSalesConverted,
    data?.totals?.grossSales,
    grossSalesTotalEl,
    grossSalesMetaEl
  );
  renderConvertedMoneySummary(
    data?.totals?.proceedsConverted,
    data?.totals?.proceeds,
    proceedsTotalEl,
    proceedsMetaEl
  );
  dateRangeEl.textContent = `${data.startDate} to ${data.endDate}`;

  drawSeriesChart(chartCanvas, data.series || [], data.granularity);
  renderTopApps(data);
}

function renderTopApps(data) {
  const hasSelection = Boolean(data.selectedAppId);
  topAppsPanel.style.display = hasSelection ? "none" : "block";

  if (hasSelection) {
    topAppsBody.innerHTML = "";
    return;
  }

  const rows = data.appBreakdown || [];
  if (!rows.length) {
    topAppsBody.innerHTML = '<tr><td colspan="4">No data</td></tr>';
    return;
  }

  topAppsBody.innerHTML = rows
    .map(
      (row) =>
        `<tr><td>${renderAppNameCell(row.name, row.appId)}</td><td>${formatMetric(row.downloads)}</td><td>${formatMetric(
          row.purchases
        )}</td><td>${renderRatingCell(row.appId)}</td></tr>`
    )
    .join("");
}

function renderAppNameCell(name, appId) {
  const safeName = escapeHtml(name);
  const safeIconUrl = escapeHtml(appId ? (appIconMap.get(appId) || "") : "");
  const fallbackLetter = safeName.slice(0, 1).toUpperCase() || "?";

  if (!safeIconUrl) {
    return `<span class="app-name-cell"><span class="app-icon app-icon-fallback">${fallbackLetter}</span><span>${safeName}</span></span>`;
  }

  return `<span class="app-name-cell"><img class="app-icon" src="${safeIconUrl}" alt="" loading="lazy" decoding="async" /><span>${safeName}</span></span>`;
}

async function loadRatings() {
  try {
    const response = await fetch("/api/ratings");
    const payload = await response.json();

    if (!response.ok) {
      throw new Error(payload.error || "Failed to load ratings.");
    }

    const data = payload.data || {};
    ratingsState = {
      loaded: true,
      error: "",
      updatedAt: data.updatedAt || null,
      refreshing: data.refreshing || null,
      byAppId: new Map((data.apps || []).map((entry) => [entry.appId, entry])),
    };
  } catch (error) {
    ratingsState = { ...ratingsState, loaded: true, error: error.message };
  }

  // Ratings are collected in the background storefront by storefront; poll until that finishes.
  clearTimeout(ratingsPollTimer);
  ratingsPollTimer = ratingsState.refreshing ? setTimeout(loadRatings, RATINGS_POLL_MS) : null;

  if (lastMetricsData) {
    renderTopApps(lastMetricsData);
  }
  renderRatingSummary();
  renderFeedbackSubtitle();
}

function isCollectingRatings() {
  return !ratingsState.loaded || Boolean(ratingsState.refreshing && !ratingsState.updatedAt);
}

function renderRatingCell(appId) {
  const rating = ratingsState.byAppId.get(appId);
  if (rating?.count) {
    return renderRatingValue(rating);
  }

  if (ratingsState.error && !ratingsState.byAppId.size) {
    return `<span class="muted" title="${escapeHtml(ratingsState.error)}">–</span>`;
  }

  if (isCollectingRatings()) {
    return '<span class="muted" title="Collecting ratings">…</span>';
  }

  return '<span class="muted">No ratings</span>';
}

function renderRatingValue(rating, countLabel = "") {
  const isFew = rating.count < FEW_RATINGS_THRESHOLD;
  const title = buildRatingTooltip(rating);

  return `<span class="rating${isFew ? " rating-few" : ""}" title="${escapeHtml(title)}"><span class="rating-star" aria-hidden="true">★</span> ${ratingFormatter.format(
    rating.average
  )}<span class="rating-count"> · ${formatMetric(rating.count)}${countLabel}</span></span>${renderRatingDelta(
    rating.delta
  )}`;
}

function renderRatingDelta(delta) {
  if (!delta?.count) {
    return "";
  }

  const sign = delta.count > 0 ? "+" : "−";
  const amount = formatMetric(Math.abs(delta.count));
  const title = `${sign}${amount} ${pluralize(Math.abs(delta.count), "rating")} since ${formatSnapshotDate(delta.since)}`;
  const className = delta.count > 0 ? "rating-delta-up" : "rating-delta-down";

  return ` <span class="rating-delta ${className}" title="${escapeHtml(title)}">${sign}${amount}</span>`;
}

function buildRatingTooltip(rating) {
  const lines = [`Average ${rating.average} from ${formatMetric(rating.count)} ${pluralize(rating.count, "rating")}`];
  if (rating.count < FEW_RATINGS_THRESHOLD) {
    lines.push("Too few ratings for a reliable average");
  }

  const storefronts = formatStorefrontBreakdown(rating.storefronts, 8);
  if (storefronts) {
    lines.push(storefronts);
  }

  return lines.join("\n");
}

function formatStorefrontBreakdown(storefronts, limit) {
  const entries = Array.isArray(storefronts) ? storefronts : [];
  const shown = entries
    .slice(0, limit)
    .map((entry) => `${countryName(entry.country)} ${formatMetric(entry.count)}`);
  if (entries.length > limit) {
    shown.push(`${entries.length - limit} more`);
  }
  return shown.join(" · ");
}

function renderRatingSummary() {
  const appId = appSelect.value;
  if (!appId || !ratingsState.loaded) {
    ratingSummaryEl.hidden = true;
    ratingSummaryEl.innerHTML = "";
    return;
  }

  const rating = ratingsState.byAppId.get(appId);
  if (rating?.count) {
    const storefronts = formatStorefrontBreakdown(rating.storefronts, 5);
    ratingSummaryEl.innerHTML = `<div>${renderRatingValue(rating, ` ${pluralize(rating.count, "rating")}`)}</div>${
      storefronts ? `<div class="rating-summary-storefronts">${escapeHtml(storefronts)}</div>` : ""
    }`;
  } else {
    ratingSummaryEl.innerHTML = `<span class="muted">${isCollectingRatings() ? "Collecting ratings…" : "No ratings yet"}</span>`;
  }

  ratingSummaryEl.hidden = false;
}

function renderFeedbackSubtitle() {
  let text = "All time, not affected by the date range.";
  const refreshing = ratingsState.refreshing;
  if (refreshing) {
    text += ` Updating ratings (${refreshing.done}/${refreshing.total} countries)…`;
  } else if (ratingsState.updatedAt) {
    text += ` Ratings updated ${formatSnapshotDate(ratingsState.updatedAt)}.`;
  }
  feedbackSubtitleEl.textContent = text;
}

async function loadReviews(options = {}) {
  const requestId = ++reviewsRequestId;
  const scope = appSelect.value;
  const params = new URLSearchParams();
  if (scope) {
    params.set("appId", scope);
  }
  if (options.force) {
    params.set("refresh", "1");
  }

  // Keep the current list visible while refreshing the same scope; clear it when switching apps.
  const keepReviews = reviewsState.scope === scope;
  reviewsState = {
    ...reviewsState,
    status: "loading",
    scope,
    reviews: keepReviews ? reviewsState.reviews : [],
  };
  renderReviews();

  try {
    const response = await fetch(`/api/reviews?${params.toString()}`);
    const payload = await response.json();

    if (!response.ok) {
      throw new Error(payload.error || "Failed to load reviews.");
    }

    if (requestId !== reviewsRequestId) {
      return;
    }

    const access = payload.data?.access || "ok";
    const reviews = payload.data?.reviews || [];
    reviewsState = { status: "ready", scope, access, reviews, error: "" };
    if (access === "ok") {
      seedSeenReviews(scope ? [scope] : Array.from(appIconMap.keys()), reviews);
    }
  } catch (error) {
    if (requestId !== reviewsRequestId) {
      return;
    }

    reviewsState = { status: "error", scope, access: "ok", reviews: [], error: error.message };
  }

  renderReviews();
}

function renderReviews() {
  const { status, access, reviews, error } = reviewsState;

  const newCount = reviews.filter(isNewReview).length;
  reviewsNewBadgeEl.hidden = newCount === 0;
  reviewsNewBadgeEl.textContent = `${formatMetric(newCount)} new`;
  markReviewsReadBtn.hidden = newCount === 0;

  let note = "";
  if (status === "error") {
    note = `Couldn't load reviews: ${error}`;
  } else if (status === "loading" && !reviews.length) {
    note = "Loading reviews…";
  } else if (access === "forbidden") {
    note =
      "This API key can't read customer reviews. Written reviews need a key with the Customer Support or Admin role; ratings come from the public App Store and still work.";
  } else if (status === "ready" && !reviews.length) {
    note = "No written reviews yet.";
  }
  reviewsNoteEl.textContent = note;
  reviewsNoteEl.hidden = !note;
  reviewsNoteEl.classList.toggle("reviews-note-error", status === "error");

  const visible = showAllReviews ? reviews : reviews.slice(0, REVIEWS_PREVIEW_COUNT);
  reviewsListEl.innerHTML = visible.map(renderReviewItem).join("");

  showAllReviewsBtn.hidden = reviews.length <= REVIEWS_PREVIEW_COUNT;
  showAllReviewsBtn.textContent = showAllReviews
    ? "Show fewer"
    : `Show all ${formatMetric(reviews.length)} reviews`;
}

function renderReviewItem(review) {
  const isNew = isNewReview(review);
  const meta = [];

  if (!reviewsState.scope) {
    meta.push(renderAppNameCell(review.appName || "Unknown app", review.appId));
  }
  if (review.country) {
    meta.push(`<span>${escapeHtml(countryName(review.country))}</span>`);
  }
  if (review.reviewerNickname) {
    meta.push(`<span>${escapeHtml(review.reviewerNickname)}</span>`);
  }
  const createdAt = Date.parse(review.createdDate);
  if (Number.isFinite(createdAt)) {
    meta.push(
      `<time datetime="${escapeHtml(review.createdDate)}" title="${escapeHtml(
        reviewDateTimeFormatter.format(new Date(createdAt))
      )}">${escapeHtml(formatReviewDate(createdAt))}</time>`
    );
  }

  return `<li class="review${isNew ? " review-new" : ""}">
    <div class="review-head">
      ${renderStars(review.rating)}
      <strong class="review-title">${escapeHtml(review.title || "Untitled")}</strong>
      ${isNew ? '<span class="new-pill">New</span>' : ""}
    </div>
    ${review.body ? `<p class="review-body">${escapeHtml(review.body)}</p>` : ""}
    <div class="review-meta">${meta.join('<span class="meta-sep" aria-hidden="true">·</span>')}</div>
    ${renderReviewResponse(review.response)}
  </li>`;
}

function renderStars(rating) {
  const value = Math.max(0, Math.min(5, Math.round(Number(rating) || 0)));
  return `<span class="stars" role="img" aria-label="${value} out of 5 stars"><span class="stars-on">${"★".repeat(
    value
  )}</span><span class="stars-off">${"★".repeat(5 - value)}</span></span>`;
}

function renderReviewResponse(response) {
  if (!response?.body) {
    return "";
  }

  const isPending = response.state && response.state !== "PUBLISHED";
  return `<div class="review-response"><span class="review-response-label">Your response${
    isPending ? " (pending)" : ""
  }</span><p>${escapeHtml(response.body)}</p></div>`;
}

function formatReviewDate(timestamp) {
  const days = Math.floor((Date.now() - timestamp) / (24 * 60 * 60 * 1000));
  if (days >= 0 && days < 30) {
    return relativeTimeFormatter.format(-days, "day");
  }
  return reviewDateFormatter.format(new Date(timestamp));
}

function formatSnapshotDate(value) {
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(timestamp) ? snapshotDateFormatter.format(new Date(timestamp)) : String(value);
}

// "New" means not seen in this browser. Reviews that already existed the first time an app's
// reviews were loaded are treated as seen, so the first visit doesn't flag the whole history.
function readSeenReviews() {
  try {
    const parsed = JSON.parse(localStorage.getItem(SEEN_REVIEWS_STORAGE_KEY) || "null");
    return {
      appIds: new Set(Array.isArray(parsed?.appIds) ? parsed.appIds.map(String) : []),
      reviewIds: new Set(Array.isArray(parsed?.reviewIds) ? parsed.reviewIds.map(String) : []),
    };
  } catch {
    // Without storage there is no way to tell what's new, so nothing gets flagged.
    return null;
  }
}

function writeSeenReviews() {
  try {
    localStorage.setItem(
      SEEN_REVIEWS_STORAGE_KEY,
      JSON.stringify({
        appIds: Array.from(seenReviews.appIds),
        reviewIds: Array.from(seenReviews.reviewIds).slice(-MAX_SEEN_REVIEW_IDS),
      })
    );
  } catch {
    // Storage full or blocked; the in-memory state still works for this session.
  }
}

function seedSeenReviews(appIds, reviews) {
  if (!seenReviews) {
    return;
  }

  const unseededAppIds = new Set(appIds.filter((appId) => !seenReviews.appIds.has(appId)));
  if (!unseededAppIds.size) {
    return;
  }

  for (const review of reviews) {
    if (unseededAppIds.has(review.appId)) {
      seenReviews.reviewIds.add(review.id);
    }
  }
  for (const appId of unseededAppIds) {
    seenReviews.appIds.add(appId);
  }
  writeSeenReviews();
}

function isNewReview(review) {
  return Boolean(seenReviews) && !seenReviews.reviewIds.has(review.id);
}

function markReviewsAsRead() {
  if (!seenReviews) {
    return;
  }

  for (const review of reviewsState.reviews) {
    seenReviews.reviewIds.add(review.id);
  }
  writeSeenReviews();
  renderReviews();
}

function createRegionNames() {
  try {
    return new Intl.DisplayNames(undefined, { type: "region" });
  } catch {
    return null;
  }
}

function countryName(code) {
  try {
    return regionNames?.of(code) || code;
  } catch {
    return code;
  }
}

function pluralize(count, word) {
  return count === 1 ? word : `${word}s`;
}

function drawSeriesChart(canvas, series, granularity = "day") {
  if (!Array.isArray(series) || !series.length) {
    drawEmptyChart(canvas, "No data");
    return;
  }

  const labels = series.map((point) =>
    granularity === "year" ? point.date : point.date.slice(5)
  );
  const downloads = series.map((point) => Number(point.downloads) || 0);
  const purchases = series.map((point) => Number(point.purchases) || 0);

  const dpr = window.devicePixelRatio || 1;
  const cssWidth = canvas.clientWidth || 900;
  const cssHeight = getCanvasCssHeight(canvas);

  canvas.width = Math.floor(cssWidth * dpr);
  canvas.height = Math.floor(cssHeight * dpr);

  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);

  ctx.clearRect(0, 0, cssWidth, cssHeight);

  const margin = { top: 20, right: 20, bottom: 40, left: 56 };
  const chartWidth = cssWidth - margin.left - margin.right;
  const chartHeight = cssHeight - margin.top - margin.bottom;
  const yMax = Math.max(1, ...downloads, ...purchases) * 1.1;

  ctx.font = "12px IBM Plex Sans, Segoe UI, sans-serif";
  ctx.fillStyle = "#6b7280";
  ctx.strokeStyle = "#dbe2ea";
  ctx.lineWidth = 1;

  const tickCount = 4;
  for (let i = 0; i <= tickCount; i += 1) {
    const ratio = i / tickCount;
    const y = margin.top + chartHeight - ratio * chartHeight;
    const value = Math.round((ratio * yMax + Number.EPSILON) * 100) / 100;

    ctx.beginPath();
    ctx.moveTo(margin.left, y);
    ctx.lineTo(margin.left + chartWidth, y);
    ctx.stroke();

    ctx.fillText(numberFormatter.format(value), 10, y + 4);
  }

  drawLine(ctx, downloads, "#0066ff", margin, chartWidth, chartHeight, yMax);
  drawLine(ctx, purchases, "#0f766e", margin, chartWidth, chartHeight, yMax);

  ctx.strokeStyle = "#94a3b8";
  ctx.beginPath();
  ctx.moveTo(margin.left, margin.top + chartHeight);
  ctx.lineTo(margin.left + chartWidth, margin.top + chartHeight);
  ctx.stroke();

  const step = Math.max(1, Math.floor(labels.length / 6));
  for (let i = 0; i < labels.length; i += step) {
    const x =
      labels.length > 1
        ? margin.left + (i / (labels.length - 1)) * chartWidth
        : margin.left + chartWidth / 2;

    ctx.fillText(labels[i], x - 14, margin.top + chartHeight + 18);
  }

  drawLegend(ctx, margin.left + 4, 12);
}

function drawLine(ctx, values, color, margin, chartWidth, chartHeight, yMax) {
  if (!values.length) {
    return;
  }

  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.beginPath();

  for (let i = 0; i < values.length; i += 1) {
    const x =
      values.length > 1
        ? margin.left + (i / (values.length - 1)) * chartWidth
        : margin.left + chartWidth / 2;
    const y = margin.top + chartHeight - (values[i] / yMax) * chartHeight;

    if (i === 0) {
      ctx.moveTo(x, y);
    } else {
      ctx.lineTo(x, y);
    }
  }

  ctx.stroke();
}

function drawLegend(ctx, x, y) {
  ctx.font = "12px IBM Plex Sans, Segoe UI, sans-serif";

  ctx.fillStyle = "#0066ff";
  ctx.fillRect(x, y - 8, 10, 10);
  ctx.fillStyle = "#1f2937";
  ctx.fillText("Downloads", x + 14, y);

  const x2 = x + 90;
  ctx.fillStyle = "#0f766e";
  ctx.fillRect(x2, y - 8, 10, 10);
  ctx.fillStyle = "#1f2937";
  ctx.fillText("Purchases", x2 + 14, y);
}

function drawEmptyChart(canvas, label) {
  const dpr = window.devicePixelRatio || 1;
  const cssWidth = canvas.clientWidth || 900;
  const cssHeight = getCanvasCssHeight(canvas);

  canvas.width = Math.floor(cssWidth * dpr);
  canvas.height = Math.floor(cssHeight * dpr);

  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);

  ctx.clearRect(0, 0, cssWidth, cssHeight);
  ctx.fillStyle = "#6b7280";
  ctx.font = "14px IBM Plex Sans, Segoe UI, sans-serif";
  ctx.fillText(label, 20, 30);
}

function formatMetric(value) {
  return numberFormatter.format(Math.round(Number(value) || 0));
}

function renderConvertedMoneySummary(converted, rawSummary, valueEl, metaEl) {
  const currency = String(converted?.currency || "").toUpperCase();
  const amount = Number(converted?.amount);
  if (currency && Number.isFinite(amount)) {
    valueEl.textContent = formatCurrencyAmount(currency, amount);
    const missing = Array.isArray(converted?.missingCurrencies)
      ? converted.missingCurrencies.filter(Boolean)
      : [];
    if (missing.length) {
      metaEl.textContent = `Converted to ${currency} (missing rates: ${missing.join(", ")})`;
    } else {
      metaEl.textContent = `Converted to ${currency}`;
    }
    return;
  }

  renderMoneySummary(rawSummary, valueEl, metaEl);
}

function renderMoneySummary(summary, valueEl, metaEl) {
  const byCurrency = Array.isArray(summary?.byCurrency) ? summary.byCurrency : [];
  if (!byCurrency.length) {
    valueEl.textContent = "$0.00";
    metaEl.textContent = "";
    return;
  }

  if (!summary.mixedCurrencies && byCurrency.length === 1) {
    const single = byCurrency[0];
    valueEl.textContent = formatCurrencyAmount(single.currency, single.amount);
    metaEl.textContent = single.currency === "UNKNOWN" ? "Unknown currency" : single.currency;
    return;
  }

  const primary = byCurrency[0];
  valueEl.textContent = formatCurrencyAmount(primary.currency, primary.amount);
  metaEl.textContent = `Mixed currencies (${byCurrency.length})`;
}

function formatCurrencyAmount(currency, amount) {
  const numericAmount = Number(amount) || 0;

  if (!currency || currency === "UNKNOWN") {
    return moneyFallbackFormatter.format(numericAmount);
  }

  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(numericAmount);
  } catch {
    return `${currency} ${moneyFallbackFormatter.format(numericAmount)}`;
  }
}

function showStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.style.color = isError ? "#b91c1c" : "#6b7280";
  statusEl.classList.toggle("status-error", isError);
}

function setLoading(isLoading, message) {
  if (!loadingOverlayEl) {
    return;
  }

  if (isLoading) {
    loadingCounter += 1;
    if (message && loadingTextEl) {
      loadingTextEl.textContent = message;
    }
  } else {
    loadingCounter = Math.max(0, loadingCounter - 1);
  }

  const visible = loadingCounter > 0;
  loadingOverlayEl.hidden = !visible;
  loadingOverlayEl.style.display = visible ? "grid" : "none";
  document.body.classList.toggle("is-loading", visible);
}

function populateYearlyRangeOptions() {
  const group = document.getElementById("yearlyRangeOptions");
  if (!group) {
    return;
  }

  const latestCompletedYear = new Date().getUTCFullYear() - 1;
  for (let year = latestCompletedYear; year >= 2008; year -= 1) {
    group.append(new Option(String(year), `yearly:${year}`));
  }
  group.append(new Option("All completed years", "yearly:all"));
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function getCanvasCssHeight(canvas) {
  const fallback = Math.floor(window.innerHeight * 0.35);
  const height = canvas.clientHeight || fallback || 240;
  return Math.max(160, Math.min(300, height));
}
