const $ = (id) => document.getElementById(id)
const show = (s) => {
  $('connect').hidden = !!s.user
  $('connected').hidden = !s.user
  if (s.user) { $('host').textContent = new URL(s.server).host; $('who').textContent = s.user }
}
const settingsLink = () => { $('settings').href = `${$('server').value.replace(/\/+$/, '')}/settings` }
chrome.storage.local.get(['server', 'user']).then((s) => { if (s.server) $('server').value = s.server; settingsLink(); show(s) })
$('server').addEventListener('input', settingsLink)

$('connect').addEventListener('submit', async (e) => {
  e.preventDefault()
  $('error').textContent = ''
  try {
    const server = new URL($('server').value.trim()).origin, token = $('token').value.trim()
    // the server is self-hosted, so its origin is asked for at connect time
    if (!(await chrome.permissions.request({ origins: [`${server}/*`] }))) throw new Error('Permission to reach the server was denied')
    const res = await fetch(`${server}/api/v1/me`, { headers: { authorization: `Bearer ${token}` } })
    if (!res.ok) throw new Error(res.status === 401 ? 'That token is not valid on this server' : `Server answered ${res.status}`)
    const { user } = await res.json()
    const s = { server, token, user: user.email }
    await chrome.storage.local.set(s)
    show(s)
  } catch (err) { $('error').textContent = err.message }
})
$('disconnect').addEventListener('click', async () => {
  await chrome.storage.local.remove(['token', 'user'])
  show({})
})
