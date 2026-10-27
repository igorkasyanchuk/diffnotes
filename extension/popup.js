const $ = (id) => document.getElementById(id)
const servers = async () => (await chrome.storage.local.get('servers')).servers ?? []

async function show() {
  const list = await servers()
  $('list').replaceChildren(...list.map((s) => {
    const row = document.createElement('div'), info = document.createElement('div'), btn = document.createElement('button')
    row.className = 'row'
    info.innerHTML = '<b></b><br><span class="hint"></span>'
    info.querySelector('b').textContent = new URL(s.server).host
    info.querySelector('span').textContent = s.user
    btn.className = 'plain'
    btn.textContent = 'Remove'
    btn.addEventListener('click', async () => {
      await chrome.storage.local.set({ servers: (await servers()).filter((x) => x.server !== s.server) })
      chrome.permissions.remove({ origins: [`${s.server}/*`] }).catch(() => {})
      show()
    })
    row.append(info, btn)
    return row
  }))
  $('add-title').textContent = list.length ? 'Add another server' : 'Connect a server'
}
const settingsLink = () => { $('settings').href = `${$('server').value.trim().replace(/\/+$/, '')}/settings` }
// what was typed survives the popup closing (switching windows to copy the token closes it): storage.session, gone with the browser
const saveDraft = () => chrome.storage.session.set({ draft: { server: $('server').value.trim(), token: $('token').value.trim() } })
$('server').addEventListener('input', () => {
  // the one line Settings shows next to a new token: {"server":"…","token":"…"} fills both fields
  const v = $('server').value.trim()
  if (v.startsWith('{')) try {
    const { server, token } = JSON.parse(v)
    if (typeof server === 'string' && typeof token === 'string') {
      $('server').value = server; $('token').value = token; $('submit').focus()
      $('status').textContent = 'Server and token filled in: press Connect'
    }
  } catch { /* still typing */ }
  settingsLink()
  saveDraft()
})
$('token').addEventListener('input', saveDraft)
chrome.storage.session.get('draft').then(({ draft }) => {
  if (!draft) return
  $('server').value = draft.server ?? ''
  $('token').value = draft.token ?? ''
  $('error').textContent = draft.error ?? ''
  settingsLink()
})
show()
// how the notes look on the diff (content.js applies it to open pages right away)
chrome.storage.local.get('noteTheme').then(({ noteTheme }) => { $('theme').value = noteTheme ?? 'standard' })
$('theme').addEventListener('change', async () => {
  await chrome.storage.local.set({ noteTheme: $('theme').value })
  $('status').textContent = `Notes look ${$('theme').value} now, on open pages too`
})
// a connect the background finished after the permission prompt closed this popup shows up as soon as it lands
chrome.storage.onChanged.addListener((changes) => { if (changes.servers) show() })

$('connect').addEventListener('submit', async (e) => {
  e.preventDefault()
  $('error').textContent = ''
  // say what is happening: the permission prompt and the token check each take a moment
  const say = (text) => { $('status').textContent = text }
  $('submit').disabled = true
  try {
    const url = new URL($('server').value.trim()), server = url.origin, token = $('token').value.trim()
    // the token goes with every request: plain http only to this computer
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)))
      throw new Error('Use the https:// address of your server (http only works for localhost)')
    // saved before the prompt: if it closes this popup, background.js connects once the permission is granted
    await chrome.storage.session.set({ draft: { server, token } })
    // servers are self-hosted, so each origin is asked for when it is connected
    say(`Asking for access to ${url.host}…`)
    if (!(await chrome.permissions.request({ origins: [`${server}/*`] }))) throw new Error('Permission to reach the server was denied')
    say('Checking the token…')
    const { error } = await chrome.runtime.sendMessage({ type: 'connect' })
    if (error) throw new Error(error)
    $('connect').reset()
    say(`Connected to ${url.host} ✓`)
    show()
  } catch (err) { say(''); $('error').textContent = err.message } finally { $('submit').disabled = false }
})
