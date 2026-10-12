/**
 * Runs API requests from the content script instead of the background.
 *
 * Bilibili rejects requests whose `Origin` is not one of its own pages with `412`
 * / `403`, while every `*.bilibili.com` page origin is accepted. Chromium and
 * Firefox rewrite that header — `assets/rules.json` through
 * `declarativeNetRequest`, `webRequest.onBeforeSendHeaders` for Firefox — so this
 * fallback only runs on browsers without either, such as Orion on iOS / iPadOS.
 *
 * Issued from here, the browser fills in the page's own `Origin` / `Referer` and
 * attaches the session cookies, which is what the header rewrite achieves
 * elsewhere. The trade-off is that a page-context request is subject to CORS
 * while a background one is exempt through the extension's host permissions, so
 * this only works for endpoints that send `access-control-allow-origin` — which
 * varies per endpoint, not per host.
 *
 * `app.bilibili.com/x/v2/feed/index` sends none, so for it the request is moved
 * one step further, into a hidden iframe loaded from that very origin. A request
 * from `app.bilibili.com` to itself is same-origin: CORS does not apply, and no
 * `Origin` header is attached either, so the `412` never happens.
 *
 * `src/background/pageRelay.ts` holds the other half of this handshake and
 * decides when to fall back here.
 */

import browser from 'webextension-polyfill'

import { FRAME_FETCH_REQUEST, FRAME_FETCH_RESPONSE, PAGE_FETCH_REQUEST } from '../constants/pageRelay'

/** Relay frames are cheap but not instant, and a hung one must not leak. */
const RELAY_TIMEOUT = 15_000

interface FetchOptions {
  method: string
  headers?: Record<string, string>
  body?: string
}

interface PageFetchRequest {
  __bewlyPageFetch: true
  url: string
  fetchOpt: FetchOptions
}

interface PageFetchSuccess {
  status: number
  statusText: string
  body: string
}

interface PageFetchFailure {
  error: string
}

interface FrameFetchRequest {
  [FRAME_FETCH_REQUEST]: string
  url: string
  fetchOpt: FetchOptions
}

interface FrameFetchResponse {
  [FRAME_FETCH_RESPONSE]: string
  result?: PageFetchSuccess
  error?: string
}

/** Only `*.bilibili.com` pages may borrow the relay frame as a proxy. */
function isBilibiliOrigin(origin: string): boolean {
  try {
    const { hostname } = new URL(origin)
    return hostname === 'bilibili.com' || hostname.endsWith('.bilibili.com')
  }
  catch {
    return false
  }
}

async function fetchFromThisDocument(url: string, fetchOpt: FetchOptions): Promise<PageFetchSuccess> {
  const response = await fetch(url, {
    method: fetchOpt.method,
    headers: fetchOpt.headers,
    body: fetchOpt.body,
    // Bilibili's API is same-site with every page this script runs on, and
    // `include` is what makes the browser attach the session cookies.
    credentials: 'include',
  })
  const body = await response.text()
  return { status: response.status, statusText: response.statusText, body }
}

/**
 * Answers relay requests. Registered in every frame, but a frame can only serve
 * a URL on its own origin, so in practice only the relay frame ever answers.
 */
export function setupFrameFetchResponder() {
  window.addEventListener('message', async (event: MessageEvent) => {
    const request = event.data as FrameFetchRequest | undefined
    const nonce = request?.[FRAME_FETCH_REQUEST]
    if (!request || typeof nonce !== 'string')
      return
    // Refuse anything that is not one of our pages, or that would not be
    // same-origin anyway, so a hostile page cannot borrow the session cookies.
    if (!isBilibiliOrigin(event.origin) || !request.url.startsWith(`${location.origin}/`))
      return

    const source = event.source as WindowProxy | null
    if (!source)
      return

    try {
      const result = await fetchFromThisDocument(request.url, request.fetchOpt)
      source.postMessage({ [FRAME_FETCH_RESPONSE]: nonce, result } satisfies FrameFetchResponse, event.origin)
    }
    catch (error) {
      source.postMessage({
        [FRAME_FETCH_RESPONSE]: nonce,
        error: error instanceof Error ? error.message : String(error),
      } satisfies FrameFetchResponse, event.origin)
    }
  })
}

let relayFrame: HTMLIFrameElement | undefined
let relayFrameOrigin: string | undefined
let relayFrameReady: Promise<HTMLIFrameElement> | undefined

function getRelayFrame(origin: string): Promise<HTMLIFrameElement> {
  if (relayFrameOrigin === origin && relayFrameReady && relayFrame?.isConnected)
    return relayFrameReady

  relayFrame?.remove()
  relayFrameOrigin = origin

  const frame = document.createElement('iframe')
  frame.setAttribute('aria-hidden', 'true')
  frame.tabIndex = -1
  // It has to stay in the document for the content script to run inside it, but
  // it must never be visible or reachable by the keyboard.
  frame.style.cssText = 'position:fixed;top:-9999px;left:-9999px;width:1px;height:1px;border:0;opacity:0;pointer-events:none'
  // Any document on the origin works; the download landing page is the smallest
  // one that reliably returns HTML.
  frame.src = `${origin}/`

  relayFrameReady = new Promise<HTMLIFrameElement>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Relay frame did not load in time')), RELAY_TIMEOUT)
    frame.addEventListener('load', () => {
      clearTimeout(timer)
      resolve(frame)
    }, { once: true })
  })
  relayFrame = frame
  document.documentElement.appendChild(frame)

  return relayFrameReady
}

async function fetchViaSameOriginFrame(url: string, fetchOpt: FetchOptions): Promise<PageFetchSuccess> {
  const { origin } = new URL(url)
  const frame = await getRelayFrame(origin)
  const nonce = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`

  return new Promise<PageFetchSuccess>((resolve, reject) => {
    const timer = setTimeout(() => {
      window.removeEventListener('message', onMessage)
      reject(new Error('Relay frame request timed out'))
    }, RELAY_TIMEOUT)

    function onMessage(event: MessageEvent) {
      const response = event.data as FrameFetchResponse | undefined
      if (response?.[FRAME_FETCH_RESPONSE] !== nonce)
        return

      clearTimeout(timer)
      window.removeEventListener('message', onMessage)

      if (response.error !== undefined)
        reject(new Error(response.error))
      else if (response.result)
        resolve(response.result)
      else
        reject(new Error('Relay frame returned no result'))
    }

    window.addEventListener('message', onMessage)
    frame.contentWindow?.postMessage(
      { [FRAME_FETCH_REQUEST]: nonce, url, fetchOpt } satisfies FrameFetchRequest,
      origin,
    )
  })
}

async function handlePageFetch(request: PageFetchRequest): Promise<PageFetchSuccess | PageFetchFailure> {
  try {
    return await fetchFromThisDocument(request.url, request.fetchOpt)
  }
  catch (directError) {
    // The page context could not read the response, which means the endpoint
    // sends no `access-control-allow-origin`. Retry from a document that shares
    // the endpoint's own origin, where CORS does not apply at all.
    try {
      return await fetchViaSameOriginFrame(request.url, request.fetchOpt)
    }
    catch {
      return { error: directError instanceof Error ? directError.message : String(directError) }
    }
  }
}

export function setupPageFetchListener() {
  browser.runtime.onMessage.addListener((
    message: unknown,
  ): Promise<PageFetchSuccess | PageFetchFailure> | undefined => {
    const request = message as PageFetchRequest | undefined
    if (!request || request[PAGE_FETCH_REQUEST] !== true)
      return undefined

    return handlePageFetch(request)
  })
}
