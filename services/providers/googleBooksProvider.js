// Wraps Google Books' Volumes API as a *fallback* ISBN lookup, behind
// openLibraryProvider. Exists specifically for the `979-8` range (Amazon KDP /
// independently published), where Open Library's coverage is close to nil --
// confirmed 2026-08-21 against a real valid ISBN-13 (checksum verified) that
// Open Library returned nothing for across four separate endpoint variants.
//
// Requires GOOGLE_BOOKS_API_KEY. Unlike finnhubProvider's requireApiKey(),
// an absent key here **returns null instead of throwing** -- this is a
// fallback, the primary already answered, and a missing optional key must not
// turn a clean "no match" into an error. Same reasoning as Finnhub being
// optional overall, applied one level down.
//
// Keyless requests are not an option: the anonymous quota is charged against
// Google's own shared project (project_number:624717413613) and is permanently
// exhausted -- verified 2026-08-21, HTTP 429 on every attempt, for ISBNs that
// definitely exist. Free tier with a key is 1,000 requests/day.
import { withUsageLog } from "../usageLog.js";
import { normalizeIsbn } from "./openLibraryProvider.js";
import { fetchWithTimeout } from "../../lib/timeout.js";

const BASE_URL = "https://www.googleapis.com/books/v1/volumes";

/**
 * Pure: shapes a Volumes API response into `{title, author}` or null. Split
 * from the fetch for the same reason openLibraryProvider does it -- the
 * parsing can be tested against a sample payload without a live call.
 * @param {object} data raw JSON from the API
 */
export function parseGoogleBooksResponse(data) {
  const info = data?.items?.[0]?.volumeInfo;
  if (!info || !info.title) return null;
  // Google splits subtitles out; Open Library folds them into `title`, so join
  // them here to keep one consistent shape across both providers.
  const title = info.subtitle ? `${info.title}: ${info.subtitle}` : info.title;
  const author = Array.isArray(info.authors) && info.authors.length > 0 ? info.authors.join(", ") : null;
  return { title, author };
}

/**
 * @param {string} rawIsbn
 * @returns {Promise<{title: string, author: string|null}|null>} null if the
 *   input isn't ISBN-shaped, no key is configured, or no match was found
 */
export async function lookupBookByIsbn(rawIsbn) {
  const isbn = normalizeIsbn(rawIsbn);
  if (!isbn) return null;

  const key = process.env.GOOGLE_BOOKS_API_KEY;
  if (!key) return null; // deliberately silent -- see header

  return withUsageLog("googlebooks", `volumes:${isbn}`, async () => {
    const url = new URL(BASE_URL);
    url.searchParams.set("q", `isbn:${isbn}`);
    url.searchParams.set("key", key);

    const res = await fetchWithTimeout(url, { label: "google books" });
    if (!res.ok) {
      // 400 here almost always means a bad/restricted key rather than a bad
      // ISBN -- worth saying so, since the ISBN was already validated above.
      const hint = res.status === 400 ? " (check GOOGLE_BOOKS_API_KEY is valid and the Books API is enabled)" : "";
      const err = new Error(`Google Books lookup failed: ${res.status} ${res.statusText}${hint}`);
      err.statusCode = res.status;
      throw err;
    }
    return parseGoogleBooksResponse(await res.json());
  });
}
