// Talks to the DiffNotes servers for the content script (it holds the tokens; pages never see them).
// storage.local.servers: [{server, user, minted}], one per connected server (the popup lists them); minted: the token came
// from "Sign in and connect", so Remove deletes it on the server too (a pasted one may be the agent's as well).
// The tokens themselves are in this extension's own IndexedDB ({server: token}): content scripts can read storage.local,
// never the extension's IndexedDB (theirs is the site's).
const vault = (mode, fn) => new Promise((ok, no) => {
  const open = indexedDB.open('diffnotes', 1)
  open.onupgradeneeded = () => open.result.createObjectStore('kv')
  open.onerror = () => no(open.error)
  open.onsuccess = () => {
    try { // a throw in this handler would leave the promise, and every message waiting on it, pending forever
      const t = open.result.transaction('kv', mode), r = fn(t.objectStore('kv'))
      t.oncomplete = () => { open.result.close(); ok(r?.result) }
      t.onerror = t.onabort = () => { open.result.close(); no(t.error) }
    } catch (e) { open.result.close(); no(e) }
  }
})
const tokens = async () => (await vault('readonly', (kv) => kv.get('tokens'))) ?? {}
const keep = (map) => vault('readwrite', (kv) => kv.put(map, 'tokens'))
async function servers() {
  const s = await chrome.storage.local.get(['servers', 'server', 'token', 'user'])
  // single-server settings of the first release
  const list = s.servers ?? (s.server && s.token ? [{ server: s.server, token: s.token, user: s.user }] : [])
  // tokens kept in storage.local before 1.6.1: into the vault first, then out of storage.local
  if (list.some((x) => x.token) || s.token) {
    await keep({ ...(await tokens()), ...Object.fromEntries(list.filter((x) => x.token).map((x) => [x.server, x.token])) })
    await chrome.storage.local.set({ servers: list.map(({ token, ...x }) => x) })
    await chrome.storage.local.remove(['server', 'token', 'user'])
  }
  const map = await tokens()
  return list.map(({ token, ...x }) => ({ ...x, token: map[x.server] ?? token })).filter((x) => x.token)
}
// the list without tokens to storage.local, the tokens of exactly those servers to the vault
async function store(list) {
  await keep(Object.fromEntries(list.map((x) => [x.server, x.token])))
  await chrome.storage.local.set({ servers: list.map(({ token, ...x }) => x) })
}

// every request says it's the extension, so the server's setup checklist can tick "extension connected"
const headers = (token) => ({ authorization: `Bearer ${token}`, 'x-diffnotes-client': 'extension' })

async function call({ server, token }, path) {
  // a network or permission failure throws; say so instead of showing nothing
  const res = await fetch(server + path, { headers: headers(token) }).catch(() => null)
  const host = new URL(server).host
  if (!res) return { error: `can't reach ${host}: open the DiffNotes popup and connect it again` }
  if (res.status === 404) return { none: true }
  if (res.status === 401) return { error: `${host} rejected the token: connect it again with a new one` }
  if (!res.ok) return { error: `${host} answered HTTP ${res.status}` }
  return res
}

// files come back as data: URLs because <img> on github.com, gitlab.com or bitbucket.org can't send the token
async function dataUrl(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return `data:${blob.type || 'application/octet-stream'};base64,${btoa(bin)}`
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  ;(async () => {
    if (msg.type === 'pull') {
      // every connected server is asked; a PR can have notes on more than one
      const list = await servers()
      const results = await Promise.all(list.map(async (s) => {
        const res = await call(s, `/api/v1/pulls/${msg.repo}/${msg.number}`)
        if (!(res instanceof Response)) return res
        // one server answering something else (a proxy's HTML page) must not hide the others' notes
        const pull = await res.json().catch(() => null)
        return Array.isArray(pull?.annotations) ? { pull: { ...pull, server: s.server } } : { error: `${new URL(s.server).host} did not answer like a DiffNotes server` }
      }))
      const pulls = results.filter((r) => r.pull).map((r) => r.pull), errors = results.filter((r) => r.error).map((r) => r.error)
      const count = pulls.reduce((n, p) => n + p.annotations.length, 0)
      chrome.action.setBadgeBackgroundColor({ color: '#e8622a' })
      chrome.action.setBadgeText({ tabId: sender.tab.id, text: count ? String(count) : '' })
      return { pulls, errors }
    }
    // connecting and removing servers: the extension's own pages only (the popup, or popup.html in the tab opened on
    // install), never a content script on a site (its sender.url is the site's)
    if (['connect', 'signin', 'remove'].includes(msg.type) && !sender.url?.startsWith(chrome.runtime.getURL(''))) return { error: 'not from a page' }
    if (msg.type === 'connect') return connect()
    if (msg.type === 'signin') return signin()
    if (msg.type === 'remove') {
      const s = (await servers()).find((x) => x.server === msg.server)
      if (s?.minted) await revoke(s)
      // without s too: an entry whose token is missing from the vault (servers() leaves it out) still leaves the list
      await store((await servers()).filter((x) => x.server !== msg.server))
      chrome.permissions.remove({ origins: [`${msg.server}/*`] }).catch(() => {})
      return { ok: true }
    }
    if (msg.type === 'clear') return chrome.action.setBadgeText({ tabId: sender.tab.id, text: '' })
    // exactly /files/<pull>/<name> on a connected server: a `..` segment would send the token to any other API path
    if (msg.type === 'file' && /^\/files\/[\w-]+\/[\w-][\w.-]*$/.test(msg.url)) {
      const s = (await servers()).find((x) => x.server === msg.server)
      if (!s) return { error: 'not connected' }
      const res = await call(s, msg.url)
      return res instanceof Response ? { url: await dataUrl(await res.blob()) } : res
    }
    // removing notes: a connected server's own token, and only one note or one PR's notes (content.js asks first)
    if (msg.type === 'delete' && !msg.url.includes('..') && /^\/api\/v1\/(annotations\/\d+|pulls\/[\w.:/-]+\/\d+\?id=[0-9a-f-]{36})$/.test(msg.url)) {
      const s = (await servers()).find((x) => x.server === msg.server)
      if (!s) return { error: 'not connected' }
      const res = await fetch(s.server + msg.url, { method: 'DELETE', headers: headers(s.token) }).catch(() => null)
      if (!res) return { error: `can't reach ${new URL(s.server).host}` }
      return res.ok ? { ok: true } : { error: (await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}` }
    }
    return { error: 'unknown message' }
  })().then(reply, (e) => reply({ error: String(e.message ?? e) }))
  return true
})

// Connecting a server: the popup keeps what was typed as storage.session `draft` {server, token} and asks for the origin.
// The permission prompt can close the popup before it hears the answer (then the server was never saved and needed a
// second Connect), so the background finishes it: when asked by the popup, or when the permission lands without it.
async function connect() {
  const { draft } = await chrome.storage.session.get('draft')
  if (!draft?.server) return { error: 'nothing to connect' }
  const { server, token } = draft
  const res = await fetch(`${server}/api/v1/me`, { headers: headers(token) }).catch(() => null)
  const user = res?.ok ? (await res.json().catch(() => null))?.user : null
  const error = !res ? `can't reach ${new URL(server).host}` : res.status === 401 ? 'That token is not valid on this server'
    : !res.ok ? `Server answered ${res.status}` : !user?.email ? `${new URL(server).host} did not answer like a DiffNotes server` : ''
  // a failure stays in the draft, so the popup shows it (and the fields) when it opens again
  if (error) { await chrome.storage.session.set({ draft: { ...draft, error } }); return { error } }
  await save({ server, token, user: user.email })
  return { ok: true }
}
chrome.permissions.onAdded.addListener(async ({ origins = [] }) => {
  const { draft } = await chrome.storage.session.get('draft')
  if (draft?.server && !draft.error && origins.includes(`${draft.server}/*`)) (draft.signin ? signin : connect)()
})
// a server connected again replaces its entry; the token the extension made for it before is deleted on the server
async function save(entry) {
  const old = (await servers()).find((x) => x.server === entry.server)
  if (old?.minted && old.token !== entry.token) await revoke(old)
  // read again after the network call: a server removed or added meanwhile stays so
  await store([...(await servers()).filter((x) => x.server !== entry.server), entry])
  await chrome.storage.session.remove('draft')
}
// a server that doesn't answer doesn't hold up Remove (its token then stays on Settings)
const revoke = (s) => fetch(`${s.server}/api/v1/token`, { method: 'DELETE', headers: headers(s.token), signal: AbortSignal.timeout(5000) }).catch(() => {})

// Sign in and connect: the server's /connect page in the browser's sign-in window, a one-time code back on this
// extension's own redirect address, traded with the PKCE verifier (never in any URL) for a token. Here, not in the
// popup: the sign-in window takes the focus, which closes the popup. Safari has no identity API: tokens are pasted there.
const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const random = () => b64url(crypto.getRandomValues(new Uint8Array(32)))
let signingIn = null // one sign-in window at a time: a second click joins the first
function signin() { return (signingIn ??= signinFlow().finally(() => { signingIn = null })) }
async function signinFlow() {
  const { draft } = await chrome.storage.session.get('draft')
  if (!draft?.server) return { error: 'nothing to connect' }
  const { server } = draft, host = new URL(server).host
  const fail = async (error) => { await chrome.storage.session.set({ draft: { ...draft, error } }); return { error } }
  if (!chrome.identity?.launchWebAuthFlow) return fail('This browser has no sign-in window: use a token instead')
  const verifier = random(), state = random(), redirect = chrome.identity.getRedirectURL()
  const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)))
  const url = `${server}/connect?${new URLSearchParams({ redirect_uri: redirect, state, challenge, name: browserName() })}`
  // the user may take minutes to sign in: an extension call every 20 s keeps the service worker from stopping meanwhile
  const awake = setInterval(() => chrome.runtime.getPlatformInfo(), 20_000)
  let back
  try { back = new URL(await chrome.identity.launchWebAuthFlow({ url, interactive: true })) }
  catch { return fail(`The sign-in window closed before Allow (or ${host} is not a DiffNotes server)`) }
  finally { clearInterval(awake) }
  if (back.searchParams.get('state') !== state) return fail('That answer was not for this sign-in: try again')
  if (back.searchParams.get('error')) return fail('Cancelled on the server')
  // a server whose /connect sends the window on to another server's Allow page must not get that server's code
  const iss = back.searchParams.get('iss')
  if (!iss) return fail(`${host} runs an older DiffNotes: update it, or connect with a token`)
  if (!URL.canParse(iss) || new URL(iss).origin !== new URL(server).origin) return fail(`That sign-in came from another server than ${host}: check the address`)
  const res = await fetch(`${server}/api/v1/connect/token`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: back.searchParams.get('code'), verifier, redirect_uri: redirect }) }).catch(() => null)
  const data = await res?.json().catch(() => null)
  if (!res?.ok || typeof data?.token !== 'string' || typeof data.user?.email !== 'string')
    return fail(data?.error ?? (res ? `${host} answered HTTP ${res.status}` : `can't reach ${host}`))
  await save({ server, token: data.token, user: data.user.email, minted: true })
  return { ok: true }
}
// the token's name on the server's Settings, so the user can tell their browsers apart
function browserName() {
  const ua = navigator.userAgent, brand = navigator.userAgentData?.brands?.map((b) => b.brand).find((b) => !/Not|Chromium/.test(b))
  const name = /Firefox\//.test(ua) ? 'Firefox' : /Edg\//.test(ua) ? 'Edge' : brand?.replace('Google ', '') || 'Chrome'
  const os = /Mac/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows' : /CrOS/.test(ua) ? 'ChromeOS' : /Linux|X11/.test(ua) ? 'Linux' : ''
  return os ? `${name} on ${os}` : name
}

// move first-release settings over as soon as the extension updates
// and, on a first install, the connect page in a tab: nobody has to find the toolbar's puzzle icon to start
chrome.runtime.onInstalled.addListener(({ reason }) => {
  servers()
  if (reason === 'install') chrome.tabs.create({ url: chrome.runtime.getURL('popup.html?welcome') }).catch(() => {})
})
