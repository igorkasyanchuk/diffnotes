// Draws Reviews42 annotations on a GitHub pull request's changes view. Idempotent: apply() runs again whenever
// GitHub renders more of the diff (it renders lazily) and only adds what is missing.
;(() => {
  const PR = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)\/(changes|files)/
  let current = '', pull = null, error = null, observer = null, timer = 0
  const collapsed = new Map() // annotation index → collapsed; survives re-renders
  const images = new Map() // /files/… → data: URL (or a promise of it)

  const norm = (t) => t.replace(/[‎‏]/g, '').trim()
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text) n.textContent = text; return n }
  const where = (a) => a.line ? `${a.side === 'LEFT' ? 'old ' : ''}line ${a.line}${a.end_line && a.end_line !== a.line ? `–${a.end_line}` : ''}` : 'file'

  function note(a, i) {
    const box = el('div', 'r42-note')
    box.dataset.r42 = i
    const head = el('button', 'r42-head')
    head.type = 'button'
    head.append(el('span', 'r42-badge', 'R42'), el('span', 'r42-title', a.title || a.body.split('\n')[0].replace(/[`*_#>]/g, '').slice(0, 120)), el('span', 'r42-where', where(a)))
    const body = el('div', 'r42-body r42-md')
    body.innerHTML = r42Markdown(a.body) // escaped by r42Markdown; only http(s) and relative URLs survive
    loadImages(body, a.server)
    const set = (c) => { collapsed.set(i, c); box.classList.toggle('r42-collapsed', c) }
    set(collapsed.get(i) ?? false)
    head.addEventListener('click', () => set(!box.classList.contains('r42-collapsed')))
    box.append(head, body)
    return box
  }

  // server: the Reviews42 server the Markdown came from; its /files/… are fetched by the background with its token
  function loadImages(root, server) {
    root.querySelectorAll('img[data-r42-src]').forEach((img) => {
      const src = img.dataset.r42Src
      img.removeAttribute('src')
      if (!src.startsWith('/files/')) { img.src = src; return }
      const k = server + src
      if (!images.has(k)) images.set(k, chrome.runtime.sendMessage({ type: 'file', server, url: src }).then((r) => r.url))
      images.get(k).then((u) => { if (u) img.src = u })
    })
    root.querySelectorAll('a[href^="/files/"]').forEach((a) => a.removeAttribute('href'))
  }

  // Two GitHub diff UIs: the React "changes" view (h3 file-name__*, cells with data-diff-side) and the classic one
  // (still served to signed-out visitors: .file-header[data-path], td.blob-num). Each gives {path, box, table, top}.
  function files() {
    const react = [...document.querySelectorAll('h3[class*="file-name"]')].map((h3) => {
      let box = h3.parentElement
      while (box && !box.querySelector('table')) box = box.parentElement
      // a file whose diff isn't rendered yet walks up past its own container: skip it rather than borrow a neighbour's table
      if (!box || box.querySelectorAll('h3[class*="file-name"]').length > 1) return null
      const table = box.querySelector('table')
      return table && { path: norm(h3.textContent), box, table, top: table.parentElement }
    })
    const classic = [...document.querySelectorAll('.file-header[data-path]')].map((h) => {
      const box = h.closest('.file'), table = box?.querySelector('table')
      return table && { path: h.dataset.path, box, table, top: box.querySelector('.js-file-content') ?? table }
    })
    return [...react, ...classic].filter(Boolean)
  }

  function rowFor(table, a) {
    const side = a.side === 'LEFT' ? 'left' : 'right'
    for (const cell of table.querySelectorAll(`td[data-line-number="${a.line}"]`)) {
      const row = cell.closest('tr')
      const s = cell.dataset.diffSide ?? (row.querySelector('td.blob-num') === cell ? 'left' : 'right')
      if (s === side) return row
    }
  }

  function apply() {
    if (error) return renderBox()
    if (!pull) return
    const placed = new Set()
    for (const f of files()) {
      pull.annotations.forEach((a, i) => {
        if (a.path !== f.path) return
        if (f.box.querySelector(`[data-r42="${i}"]`)) return placed.add(i)
        if (!a.line) {
          const card = note(a, i)
          card.classList.add('r42-file')
          f.top.before(card)
          return placed.add(i)
        }
        const row = rowFor(f.table, a)
        if (!row) return
        const tr = el('tr', 'r42-row'), td = el('td')
        td.colSpan = [...row.children].reduce((n, c) => n + (c.colSpan || 1), 0)
        td.append(note(a, i))
        tr.append(td)
        row.before(tr)
        placed.add(i)
      })
    }
    renderBox(placed)
  }

  // The Reviews42 box sits above the first file of the diff (never over the code), re-attached when GitHub re-renders.
  function place(box) {
    const first = files()[0]?.box
    if (first && box.nextElementSibling !== first) first.before(box)
  }

  function renderBox(placed) {
    let box = document.getElementById('r42-box')
    if (!box) { box = el('div'); box.id = 'r42-box' }
    const missing = error ? [] : pull.annotations.map((a, i) => [a, i]).filter(([, i]) => !placed.has(i))
    const key = error ?? `${pull.pulls.map((p) => p.id)}:${pull.annotations.length}:${missing.map(([, i]) => i).join(',')}`
    if (box.dataset.key !== key) {
      box.dataset.key = key
      box.replaceChildren(...(error ? [errorBar()] : boxContent(box, missing)))
    }
    place(box)
  }

  const errorBar = () => {
    const bar = el('div', 'r42-bar')
    bar.append(el('span', 'r42-badge', 'R42'), el('span', 'r42-hint', error))
    return bar
  }

  function boxContent(box, missing) {
    const bar = el('div', 'r42-bar')
    const title = el('button', 'r42-head r42-box-title')
    title.type = 'button'
    title.append(el('span', 'r42-badge', 'R42'), el('b', '', `Reviews42 · ${pull.annotations.length} notes`))
    title.addEventListener('click', () => box.classList.toggle('r42-collapsed'))
    const all = (c) => () => { pull.annotations.forEach((_, i) => collapsed.set(i, c)); document.querySelectorAll('.r42-note').forEach((n) => n.classList.toggle('r42-collapsed', c)) }
    const expand = el('button', 'r42-link', 'expand all'), collapse = el('button', 'r42-link', 'collapse all')
    expand.addEventListener('click', all(false))
    collapse.addEventListener('click', all(true))
    const many = pull.pulls.length > 1
    const opens = pull.pulls.map((p) => {
      const open = el('a', 'r42-link', many ? `open on ${new URL(p.server).host}` : 'open in Reviews42')
      open.href = `${p.server}/pulls/${p.id}`
      open.target = '_blank'
      return open
    })
    bar.append(title, expand, collapse, ...opens)
    const body = el('div', 'r42-box-body')
    for (const p of pull.pulls.filter((x) => x.summary)) {
      const s = el('div', 'r42-md r42-summary')
      s.innerHTML = (many ? `<h6>${new URL(p.server).host}</h6>` : '') + r42Markdown(p.summary)
      loadImages(s, p.server)
      body.append(s)
    }
    for (const e of pull.errors) body.append(el('div', 'r42-hint', e))
    if (missing.length) {
      body.append(el('div', 'r42-hint', `${missing.length} not shown in the diff yet (file collapsed, not loaded, or the line changed since):`))
      for (const [a, i] of missing) {
        const n = note(a, i)
        n.querySelector('.r42-where').textContent = `${a.path} · ${where(a)}`
        body.append(n)
      }
    }
    return body.childElementCount ? [bar, body] : [bar]
  }

  // click an image to preview it full size
  document.addEventListener('click', (e) => {
    const img = e.target.closest?.('.r42-md img')
    if (!img?.src) return
    const box = el('div', 'r42-lightbox'), big = el('img')
    big.src = img.src
    box.append(big)
    box.addEventListener('click', () => box.remove())
    document.body.append(box)
  })
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') document.querySelector('.r42-lightbox')?.remove() })

  function clear() {
    observer?.disconnect()
    observer = null
    pull = error = null
    document.querySelectorAll('.r42-row, .r42-file, #r42-box').forEach((n) => n.remove())
  }

  async function check() {
    const m = location.pathname.match(PR), key = m ? `${m[1]}/${m[2]}#${m[3]}` : ''
    if (key === current) return
    current = key
    clear()
    if (!m) return void chrome.runtime.sendMessage({ type: 'clear' }).catch(() => {})
    const res = await chrome.runtime.sendMessage({ type: 'pull', repo: `${m[1]}/${m[2]}`, number: m[3] }).catch(() => null)
    if (current !== key) return
    if (res?.pulls?.length) {
      pull = { pulls: res.pulls, errors: res.errors, annotations: res.pulls.flatMap((p) => p.annotations.map((a) => ({ ...a, server: p.server }))) }
    } else if (res?.errors?.length) error = res.errors.join(' · ')
    else return
    collapsed.clear()
    apply()
    observer = new MutationObserver(() => { clearTimeout(timer); timer = setTimeout(apply, 200) })
    observer.observe(document.body, { childList: true, subtree: true })
  }

  // GitHub navigates without page loads
  check()
  setInterval(check, 1000)
})()
