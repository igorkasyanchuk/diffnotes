// Talks to the Reviews42 server for the content script (it holds the token; pages never see it).
const settings = () => chrome.storage.local.get(['server', 'token'])

async function call(path) {
  const { server, token } = await settings()
  if (!server || !token) return { error: 'not connected' }
  const res = await fetch(server + path, { headers: { authorization: `Bearer ${token}` } })
  if (res.status === 404) return { none: true }
  if (!res.ok) return { error: `HTTP ${res.status}` }
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
      const res = await call(`/api/v1/pulls/${msg.repo}/${msg.number}`)
      if (!(res instanceof Response)) {
        chrome.action.setBadgeText({ tabId: sender.tab.id, text: '' })
        return res
      }
      const pull = await res.json()
      chrome.action.setBadgeBackgroundColor({ color: '#e8622a' })
      chrome.action.setBadgeText({ tabId: sender.tab.id, text: String(pull.annotations.length) })
      return { pull, server: (await settings()).server }
    }
    if (msg.type === 'clear') return chrome.action.setBadgeText({ tabId: sender.tab.id, text: '' })
    // exactly /files/<pull>/<name>: a `..` segment would send the token to any other API path
    if (msg.type === 'file' && /^\/files\/[\w-]+\/[\w-][\w.-]*$/.test(msg.url)) {
      const res = await call(msg.url)
      return res instanceof Response ? { url: await dataUrl(await res.blob()) } : res
    }
    return { error: 'unknown message' }
  })().then(reply, (e) => reply({ error: String(e.message ?? e) }))
  return true
})
