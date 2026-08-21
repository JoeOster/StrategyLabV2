// Wraps Open Library's free "Books API" (no key required, no documented
// hard rate limit for this kind of light personal use) to look up a book's
// title/author from an ISBN when adding a book Advice Source in Settings.
//
// Deliberately server-side rather than a fetch() embedded in the frontend --
// every other external call in this app goes through a services/providers/*
// wrapper (see yahooProvider.js, finnhubProvider.js), which keeps rate
// logging, error shaping, and any future API-key handling in one place
// instead of scattered across UI code.
import { withUsageLog } from "../usageLog.js";
import { fetchWithTimeout } from "../../lib/timeout.js";

const BASE_URL = "https://openlibrary.org/api/books";

/**
 * Strips whitespace/hyphens and checks it's ISBN-shaped (10 digits, the last
 * optionally 'X' for ISBN-10, or 13 digits for ISBN-13). Returns null for
 * anything else, so the caller can skip the network call entirely while the
 * user is still mid-keystroke rather than firing a request per character.
 * @param {string} raw
 * @returns {string|null}
 */
export function normalizeIsbn(raw) {
  const stripped = String(raw || "")
    .replace(/[\s-]/g, "")
    .toUpperCase();
  if (/^\d{9}[\dX]$/.test(stripped) || /^\d{13}$/.test(stripped)) return stripped;
  return null;
}

/**
 * Pure: shapes Open Library's `jscmd=data` response into `{title, author}`
 * or null. Kept separate from the fetch so the parsing logic can be tested
 * against a sample payload without a live network call -- the actual HTTP
 * round trip is the one part of this that genuinely needs live verification
 * (see STATUS.md).
 * @param {string} isbn normalized (see normalizeIsbn)
 * @param {object} data raw JSON from the API
 */
export function parseBookLookupResponse(isbn, data) {
  const entry = data?.[`ISBN:${isbn}`];
  if (!entry || !entry.title) return null;
  const author =
    Array.isArray(entry.authors) && entry.authors.length > 0
      ? entry.authors
          .map((a) => a?.name)
          .filter(Boolean)
          .join(", ")
      : null;
  return { title: entry.title, author: author || null };
}

/**
 * @param {string} rawIsbn
 * @returns {Promise<{title: string, author: string|null}|null>} null if the
 *   input isn't ISBN-shaped, or no match was found
 */
export async function lookupBookByIsbn(rawIsbn) {
  const isbn = normalizeIsbn(rawIsbn);
  if (!isbn) return null;

  return withUsageLog("openlibrary", `books:${isbn}`, async () => {
    const url = new URL(BASE_URL);
    url.searchParams.set("bibkeys", `ISBN:${isbn}`);
    url.searchParams.set("jscmd", "data");
    url.searchParams.set("format", "json");

    const res = await fetchWithTimeout(url, { label: "open library" });
    if (!res.ok) {
      const err = new Error(`Open Library lookup failed: ${res.status} ${res.statusText}`);
      err.statusCode = res.status;
      throw err;
    }
    return parseBookLookupResponse(isbn, await res.json());
  });
}
