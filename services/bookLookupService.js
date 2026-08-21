// Orchestrates ISBN lookup across providers so server.js doesn't have to know
// there is more than one. Order matters and is deliberate:
//
//   1. Open Library  -- no key, good coverage of mainstream/traditionally
//                       published ISBNs, and the only provider that worked
//                       before Google Books was added.
//   2. Google Books  -- needs GOOGLE_BOOKS_API_KEY, silently skipped without
//                       one. Exists for the 979-8 (Amazon KDP) range that
//                       Open Library essentially does not carry.
//
// Open Library goes first on purpose: it needs no key, so the common case
// costs nothing and burns none of Google's 1,000/day quota.
import * as openLibrary from "./providers/openLibraryProvider.js";
import * as googleBooks from "./providers/googleBooksProvider.js";
import { normalizeIsbn } from "./providers/openLibraryProvider.js";

/**
 * Distinguishes "that isn't an ISBN" from "that's an ISBN nobody has", which
 * the single-provider version couldn't -- both used to surface as the same
 * "No book found" message. They want different UI: one is a typo, the other
 * means fill the form in by hand.
 *
 * @param {string} rawIsbn
 * @returns {Promise<{ok: true, book: {title: string, author: string|null}, provider: string}
 *   | {ok: false, reason: "invalid-isbn" | "not-found"}>}
 */
export async function lookupBook(rawIsbn) {
  if (!normalizeIsbn(rawIsbn)) return { ok: false, reason: "invalid-isbn" };

  const providers = [
    ["openlibrary", openLibrary],
    ["googlebooks", googleBooks],
  ];

  let lastError = null;
  for (const [name, provider] of providers) {
    try {
      const book = await provider.lookupBookByIsbn(rawIsbn);
      if (book) return { ok: true, book, provider: name };
    } catch (err) {
      // One provider being down must not block the next one. Open Library is
      // intermittently slow/flaky (observed 2026-08-21), and that shouldn't
      // stop Google Books from answering. Remembered, not swallowed: if every
      // provider fails, the caller should hear about it rather than being told
      // the book doesn't exist.
      console.error(`[bookLookup] ${name} failed:`, err.message);
      lastError = err;
    }
  }

  if (lastError) throw lastError;
  return { ok: false, reason: "not-found" };
}
