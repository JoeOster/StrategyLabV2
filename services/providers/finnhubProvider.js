// Thin wrapper around the Finnhub REST API (official, free tier = 60
// calls/min, needs FINNHUB_API_KEY). Used as a secondary/real-time source --
// Yahoo covers historical data and routine polling for free, Finnhub is
// there for when you want a true real-time top-up on something you're
// actively watching. Historical candles are deliberately NOT wired up here:
// Finnhub's free tier has repeatedly restricted /stock/candle for US
// equities, so that job stays on Yahoo instead of building on a foundation
// that can disappear.
// Env vars (FINNHUB_API_KEY) are loaded once, centrally, by lib/db.js via
// process.loadEnvFile() -- every module that needs process.env just reads
// it directly rather than each re-importing a .env loader.
import { withUsageLog } from "../usageLog.js";
import { fetchWithTimeout } from "../../lib/timeout.js";

const BASE_URL = "https://finnhub.io/api/v1";

function requireApiKey() {
  const key = process.env.FINNHUB_API_KEY;
  if (!key) {
    throw new Error(
      "FINNHUB_API_KEY is not set. Copy .env.example to .env and add a free key from finnhub.io/register, or skip Finnhub and rely on Yahoo only.",
    );
  }
  return key;
}

async function finnhubGet(endpointPath, params) {
  const key = requireApiKey();
  const url = new URL(`${BASE_URL}${endpointPath}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set("token", key);

  const res = await fetchWithTimeout(url, { label: "finnhub" });
  if (!res.ok) {
    const err = new Error(`Finnhub ${endpointPath} failed: ${res.status} ${res.statusText}`);
    err.statusCode = res.status;
    throw err;
  }
  return res.json();
}

/**
 * @param {string} symbol
 */
export async function getQuote(symbol) {
  return withUsageLog("finnhub", `quote:${symbol}`, async () => {
    const q = await finnhubGet("/quote", { symbol });
    if (q.c == null || q.c === 0) {
      throw new Error(`No quote returned for ${symbol} (symbol may be unsupported on Finnhub free tier)`);
    }
    return {
      price: q.c,
      prevClose: q.pc ?? null,
      open: q.o ?? null,
      dayHigh: q.h ?? null,
      dayLow: q.l ?? null,
      volume: null, // not included in Finnhub's /quote response
      asOf: q.t ? new Date(q.t * 1000).toISOString() : null,
      currency: null,
      exchange: null,
      name: null,
    };
  });
}

/**
 * @param {string} symbol
 */
export async function getProfile(symbol) {
  return withUsageLog("finnhub", `profile2:${symbol}`, async () => {
    const p = await finnhubGet("/stock/profile2", { symbol });
    if (!p || !p.name) return null;
    return {
      name: p.name ?? null,
      currency: p.currency ?? null,
      exchange: p.exchange ?? null,
      sector: p.finnhubIndustry ?? null,
      industry: p.finnhubIndustry ?? null,
      description: null,
      logoUrl: p.logo ?? null,
    };
  });
}

/**
 * Recent company news headlines.
 *
 * The one thing the browser can genuinely do on its own for research: real,
 * dated headlines with sources, no model in the loop. It is not the synthesis
 * a Claude session produces -- nothing here cross-references a headline
 * against your cost basis -- but "what has been said about this lately" is
 * half the question and it needs no reasoning to answer.
 *
 * @param {string} symbol
 * @param {{days?: number, limit?: number}} [opts]
 * @returns {Promise<Array<{datetime: string, headline: string, source: string,
 *   url: string, summary: string|null}>>}
 */
export async function getCompanyNews(symbol, { days = 14, limit = 12 } = {}) {
  return withUsageLog("finnhub", `news:${symbol}`, async () => {
    const to = new Date();
    const from = new Date(to.getTime() - days * 86400000);
    const rows = await finnhubGet("/company-news", {
      symbol,
      from: from.toISOString().slice(0, 10),
      to: to.toISOString().slice(0, 10),
    });

    // Finnhub returns an object rather than an array on error cases the HTTP
    // status does not cover -- an unsupported symbol on the free tier, for
    // one. Treated as "no news" rather than allowed to throw on .map.
    if (!Array.isArray(rows)) return [];

    return rows
      .filter((n) => n?.headline && n?.url)
      .sort((a, b) => (b.datetime ?? 0) - (a.datetime ?? 0))
      .slice(0, limit)
      .map((n) => ({
        // Seconds, not milliseconds. Multiplying is the difference between
        // 2026 and 1970, and a date of 1970 in the panel would look like a
        // data problem in this app rather than a unit mistake.
        datetime: new Date((n.datetime ?? 0) * 1000).toISOString(),
        headline: String(n.headline),
        source: String(n.source ?? "unknown"),
        url: String(n.url),
        summary: n.summary ? String(n.summary) : null,
      }));
  });
}
