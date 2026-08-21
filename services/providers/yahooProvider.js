// Thin wrapper around yahoo-finance2 (unofficial, free, no API key). This is
// the default/primary data source: bulk quote polling and all historical
// price / dividend / split data comes from here so nothing depends on a
// paid tier.
// The default export is the YahooFinance *class*, not a ready-to-use
// instance -- it has to be constructed. Pinned to ^3.15.3 specifically:
// the 2.x line (what an unpinned/loose range resolved to before) only
// wires up `quote` + `autoc` by default and doesn't have chart/quoteSummary
// at all -- 3.x's default export registers every module.
import YahooFinance from "yahoo-finance2";
import { withUsageLog } from "../usageLog.js";
import { withTimeout } from "../../lib/timeout.js";

// suppressNotices silences the library's one-time "please fill out our
// survey" console message. (Tried this once before and it appeared to do
// nothing -- but that was while 2.x was installed, which didn't support the
// option. Worth retrying now that 3.x is pinned.)
const yahooFinance = new YahooFinance({ suppressNotices: ["yahooSurvey"] });

/**
 * @param {string} symbol
 * @returns {Promise<{price:number, prevClose:number, open:number, dayHigh:number, dayLow:number, volume:number, asOf:string, currency:string, exchange:string, name:string}>}
 */
export async function getQuote(symbol) {
  return withUsageLog("yahoo", `quote:${symbol}`, async () => {
    const q = await withTimeout(yahooFinance.quote(symbol), { label: `yahoo quote ${symbol}` });
    if (!q || q.regularMarketPrice == null) {
      throw new Error(`No quote returned for ${symbol}`);
    }
    return {
      price: q.regularMarketPrice,
      prevClose: q.regularMarketPreviousClose ?? null,
      open: q.regularMarketOpen ?? null,
      dayHigh: q.regularMarketDayHigh ?? null,
      dayLow: q.regularMarketDayLow ?? null,
      volume: q.regularMarketVolume ?? null,
      asOf: q.regularMarketTime ? new Date(q.regularMarketTime).toISOString() : null,
      currency: q.currency ?? null,
      exchange: q.fullExchangeName ?? q.exchange ?? null,
      name: q.longName ?? q.shortName ?? null,
    };
  });
}

/**
 * Daily OHLCV history, used for charting and (later) backtesting.
 * @param {string} symbol
 * @param {{period1?: string|Date, period2?: string|Date}} range defaults to trailing 1 year
 */
export async function getHistorical(symbol, range = {}) {
  const period1 = range.period1 ?? new Date(Date.now() - 365 * 24 * 60 * 60 * 1000);
  const period2 = range.period2 ?? new Date();
  return withUsageLog("yahoo", `chart:${symbol}`, async () => {
    const result = await withTimeout(
      yahooFinance.chart(symbol, { period1, period2, interval: "1d" }),
      { label: `yahoo history ${symbol}` },
    );
    return (result.quotes || [])
      .filter((row) => row.close != null)
      .map((row) => ({
        date: row.date.toISOString().slice(0, 10),
        open: row.open ?? null,
        high: row.high ?? null,
        low: row.low ?? null,
        close: row.close,
        adjClose: row.adjclose ?? row.close,
        volume: row.volume ?? null,
      }));
  });
}

/**
 * Company profile fields for the securities table -- sector/industry/logo
 * aren't in the plain quote response, they live in quoteSummary.
 * @param {string} symbol
 */
export async function getProfile(symbol) {
  return withUsageLog("yahoo", `quoteSummary:${symbol}`, async () => {
    const result = await withTimeout(
      yahooFinance.quoteSummary(symbol, { modules: ["assetProfile", "price"] }),
      { label: `yahoo profile ${symbol}` },
    );
    const profile = result.assetProfile ?? {};
    const price = result.price ?? {};
    return {
      name: price.longName ?? price.shortName ?? null,
      currency: price.currency ?? null,
      exchange: price.fullExchangeName ?? price.exchangeName ?? null,
      sector: profile.sector ?? null,
      industry: profile.industry ?? null,
      description: profile.longBusinessSummary ?? null,
      logoUrl: profile.website ? `https://logo.clearbit.com/${new URL(profile.website).hostname}` : null,
    };
  });
}

/**
 * Dividends and splits, pulled from the chart endpoint's events.
 * @param {string} symbol
 */
export async function getDividendsAndSplits(symbol, range = {}) {
  const period1 = range.period1 ?? new Date(Date.now() - 5 * 365 * 24 * 60 * 60 * 1000);
  const period2 = range.period2 ?? new Date();
  return withUsageLog("yahoo", `chart-events:${symbol}`, async () => {
    const result = await withTimeout(
      yahooFinance.chart(symbol, { period1, period2, interval: "1d", events: "div,split" }),
      { label: `yahoo events ${symbol}` },
    );
    const dividends = (result.events?.dividends || []).map((d) => ({
      exDate: d.date.toISOString().slice(0, 10),
      amount: d.amount,
    }));
    const splits = (result.events?.splits || []).map((s) => ({
      splitDate: s.date.toISOString().slice(0, 10),
      ratio: `${s.numerator}:${s.denominator}`,
    }));
    return { dividends, splits };
  });
}
