// Talks to the DiffNotes servers for the content script (it holds the tokens; pages never see them).
// storage.local.servers: [{server, token, user}], one per connected server.
async function servers() {
  const s = await chrome.storage.local.get(['servers', 'server', 'token', 'user'])
  if (s.servers) return s.servers
  // single-server settings of the first release
  if (!s.server || !s.token) return []
  const list = [{ server: s.server, token: s.token, user: s.user }]
  await chrome.storage.local.set({ servers: list })
  await chrome.storage.local.remove(['server', 'token', 'user'])
  return list
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
    if (msg.type === 'connect') return connect()
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
  await chrome.storage.local.set({ servers: [...(await servers()).filter((x) => x.server !== server), { server, token, user: user.email }] })
  await chrome.storage.session.remove('draft')
  return { ok: true }
}
chrome.permissions.onAdded.addListener(async ({ origins = [] }) => {
  const { draft } = await chrome.storage.session.get('draft')
  if (draft?.server && !draft.error && origins.includes(`${draft.server}/*`)) connect()
})

// move first-release settings over as soon as the extension updates
chrome.runtime.onInstalled.addListener(() => { servers() })
