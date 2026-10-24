// Talks to the Reviews42 servers for the content script (it holds the tokens; pages never see them).
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

async function call({ server, token }, path) {
  // a network or permission failure throws; say so instead of showing nothing
  const res = await fetch(server + path, { headers: { authorization: `Bearer ${token}` } }).catch(() => null)
  const host = new URL(server).host
  if (!res) return { error: `can't reach ${host}: open the Reviews42 popup and connect it again` }
  if (res.status === 404) return { none: true }
  if (res.status === 401) return { error: `${host} rejected the token: connect it again with a new one` }
  if (!res.ok) return { error: `${host} answered HTTP ${res.status}` }
  return res
}

// files come back as data: URLs because <img> on github.com can't send the token
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
        return Array.isArray(pull?.annotations) ? { pull: { ...pull, server: s.server } } : { error: `${new URL(s.server).host} did not answer like a Reviews42 server` }
      }))
      const pulls = results.filter((r) => r.pull).map((r) => r.pull), errors = results.filter((r) => r.error).map((r) => r.error)
      const count = pulls.reduce((n, p) => n + p.annotations.length, 0)
      chrome.action.setBadgeBackgroundColor({ color: '#e8622a' })
      chrome.action.setBadgeText({ tabId: sender.tab.id, text: count ? String(count) : '' })
      return { pulls, errors }
    }
    if (msg.type === 'clear') return chrome.action.setBadgeText({ tabId: sender.tab.id, text: '' })
    // exactly /files/<pull>/<name> on a connected server: a `..` segment would send the token to any other API path
    if (msg.type === 'file' && /^\/files\/[\w-]+\/[\w-][\w.-]*$/.test(msg.url)) {
      const s = (await servers()).find((x) => x.server === msg.server)
      if (!s) return { error: 'not connected' }
      const res = await call(s, msg.url)
      return res instanceof Response ? { url: await dataUrl(await res.blob()) } : res
    }
    return { error: 'unknown message' }
  })().then(reply, (e) => reply({ error: String(e.message ?? e) }))
  return true
})

// move first-release settings over as soon as the extension updates
chrome.runtime.onInstalled.addListener(() => { servers() })
