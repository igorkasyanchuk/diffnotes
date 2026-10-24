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
$('server').addEventListener('input', settingsLink)
show()

$('connect').addEventListener('submit', async (e) => {
  e.preventDefault()
  $('error').textContent = ''
  try {
    const url = new URL($('server').value.trim()), server = url.origin, token = $('token').value.trim()
    // the token goes with every request: plain http only to this computer
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)))
      throw new Error('Use the https:// address of your server (http only works for localhost)')
    // servers are self-hosted, so each origin is asked for when it is connected
    if (!(await chrome.permissions.request({ origins: [`${server}/*`] }))) throw new Error('Permission to reach the server was denied')
    const res = await fetch(`${server}/api/v1/me`, { headers: { authorization: `Bearer ${token}` } })
    if (!res.ok) throw new Error(res.status === 401 ? 'That token is not valid on this server' : `Server answered ${res.status}`)
    const { user } = await res.json()
    await chrome.storage.local.set({ servers: [...(await servers()).filter((x) => x.server !== server), { server, token, user: user.email }] })
    $('connect').reset()
    show()
  } catch (err) { $('error').textContent = err.message }
})
