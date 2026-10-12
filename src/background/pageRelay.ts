/**
 * Re-issues API requests from a page context when the background cannot.
 *
 * Bilibili rejects requests whose `Origin` is not one of its own pages with `412`
 * (verified for `chrome-extension://…`, the scheme the extension background uses)
 * or `403` (verified for unrelated origins), while every `*.bilibili.com` page
 * origin is accepted. Those statuses come from the edge, before the endpoint
 * runs, so retrying them cannot double-apply anything.
 *
 * On Chromium `assets/rules.json` rewrites that header through
 * `declarativeNetRequest`, and on Firefox `webRequest.onBeforeSendHeaders` does,
 * so the first attempt already succeeds there and nothing below ever runs.
 * Orion on iOS / iPadOS has neither, so the request is re-issued from the
 * originating content script, where the browser fills in the page's own `Origin`
 * / `Referer` and attaches the session cookies.
 *
 * That retry is subject to CORS — a background request is exempt through the
 * extension's host permissions, a page-context one is not — so it only works for
 * endpoints that send `access-control-allow-origin`. That varies per endpoint
 * rather than per host: `app.bilibili.com/x/v2/feed/index` sends none even though
 * other paths on that host do. `src/contentScripts/pageFetch.ts` handles those by
 * re-issuing the request from a document that already shares the endpoint's
 * origin, where CORS does not apply at all.
 *
 * Because the fallback is decided at runtime, no host list is maintained here and
 * browsers that can rewrite headers keep their existing behaviour untouched.
 *
 * `src/contentScripts/pageFetch.ts` holds the other half of this handshake.
 */

import type Browser from 'webextension-polyfill'
import browser from 'webextension-polyfill'

import { PAGE_FETCH_REQUEST } from '../constants/pageRelay'
import type { _FETCH } from './utils'

interface PageFetchResult {
  status?: number
  statusText?: string
  body?: string
  error?: string
}

let warnedAboutOriginRejection = false

function warnAboutOriginRejectionOnce(status: number) {
  if (warnedAboutOriginRejection)
    return

  warnedAboutOriginRejection = true
  console.warn(
    `[BewlyBewly] Bilibili rejected a request with ${status} because this browser cannot rewrite the Origin header, so API requests are being relayed through the page context instead.`,
  )
}

async function fetchFromPageContext(url: string, fetchOpt: _FETCH, sender: Browser.Runtime.MessageSender) {
  const tabId = sender.tab?.id
  if (tabId === undefined)
    return undefined

  // `URLSearchParams` bodies are not portable across every messaging
  // implementation, so hand the content script a plain string.
  const body = fetchOpt.body === undefined
    ? undefined
    : typeof fetchOpt.body === 'string' ? fetchOpt.body : String(fetchOpt.body)

  let result: PageFetchResult | undefined
  try {
    result = await browser.tabs.sendMessage(
      tabId,
      { [PAGE_FETCH_REQUEST]: true, url, fetchOpt: { ...fetchOpt, body } },
      sender.frameId !== undefined ? { frameId: sender.frameId } : undefined,
    )
  }
  catch {
    // The content script never ran on that frame, or it is gone by now, so the
    // caller falls back to the original background response.
    return undefined
  }

  // The content script answered but the request itself failed. Surface that
  // instead of silently issuing the same request a second time from the
  // background, which for a `post` endpoint would mean a duplicate action.
  if (result?.error)
    throw new Error(`Page context request failed: ${result.error}`)

  if (!result || typeof result.body !== 'string')
    return undefined

  // `Response` refuses a body for the null-body statuses, and bilibili always
  // answers with a JSON payload, so anything unusual falls back to `200`.
  const status = typeof result.status === 'number' && result.status >= 200 && ![204, 205, 304].includes(result.status)
    ? result.status
    : 200

  return new Response(result.body, { status, statusText: result.statusText ?? '' })
}

export function sendRequest(url: string, fetchOpt: _FETCH, sender?: Browser.Runtime.MessageSender) {
  if (!sender || !sender.tab)
    return fetch(url, { ...fetchOpt })

  // Try the background first: where `declarativeNetRequest` or `webRequest`
  // rewrites the headers this succeeds and nothing else happens. Only a rejected
  // request falls back to the page.
  return fetch(url, { ...fetchOpt }).then(
    async (response) => {
      if (response.status !== 412 && response.status !== 403)
        return response

      warnAboutOriginRejectionOnce(response.status)

      const relayed = await fetchFromPageContext(url, fetchOpt, sender).catch(() => undefined)
      // Endpoints without CORS headers cannot be read from the page either, so the
      // original rejection is the most useful thing left to report.
      return relayed ?? response
    },
    async (error: unknown) => {
      // Some WebKit builds refuse the cross-origin request outright and reject
      // with a `TypeError` instead of answering with a status code. Retrying is
      // only safe for idempotent requests: a `post` that already reached the
      // server must never be sent a second time.
      if (fetchOpt.method.toLowerCase() !== 'get')
        throw error

      const relayed = await fetchFromPageContext(url, fetchOpt, sender).catch(() => undefined)
      if (relayed)
        return relayed

      throw error
    },
  )
}
