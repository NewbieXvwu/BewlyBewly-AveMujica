/**
 * Message keys for the page-context API relay.
 *
 * Chromium and Firefox rewrite the `Origin` / `Referer` headers through
 * `declarativeNetRequest` and `webRequest` respectively, which is what lets the
 * background talk to bilibili at all. Orion on iOS / iPadOS has neither, so the
 * request is re-issued from a page context instead — see
 * `src/background/pageRelay.ts` and `src/contentScripts/pageFetch.ts`.
 *
 * The keys live here rather than in either endpoint so the two halves cannot
 * drift apart.
 */

/** Background → content script: re-issue this request from the page context. */
export const PAGE_FETCH_REQUEST = '__bewlyPageFetch'

/** Host page → relay frame: re-issue this request from the frame's own origin. */
export const FRAME_FETCH_REQUEST = '__bewlyFrameFetchRequest'

/** Relay frame → host page: the result of that request. */
export const FRAME_FETCH_RESPONSE = '__bewlyFrameFetchResponse'
