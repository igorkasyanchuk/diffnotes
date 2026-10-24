// Draws DiffNotes annotations on a pull request's diff: GitHub, GitLab (merge requests) and Bitbucket. Idempotent:
// apply() runs again whenever the page renders more of the diff (they all render lazily) and only adds what is missing.
;(() => {
  let current = '', pull = null, error = null, observer = null, timer = 0, seen = null
  // Notes folded by hand stay folded after a reload while their content is the same: keyed by a hash of the PR and the
  // note (a.fold, set in check()), not its id (a re-upload makes new ids), so a note that changed opens again. Kept
  // FOLD_DAYS from the fold, past the default 30 days retention. Every tab keeps its copy current through onChanged.
  // ponytail: 32-bit FNV-1a, a collision only starts some other note folded
  const FOLD_DAYS = 60
  let folded = {} // note key → when it was folded
  const fresh = (all) => { const cut = Date.now() - FOLD_DAYS * 86400_000; for (const [k, t] of Object.entries(all)) if (t < cut) delete all[k]; return all }
  const foldsLoaded = chrome.storage.local.get('folded').then((s) => { folded = fresh(s.folded ?? {}) }, () => {})
  chrome.storage.onChanged.addListener((ch) => { if (ch.folded) folded = ch.folded.newValue ?? {} })
  const hash = (s) => { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193); return (h >>> 0).toString(36) }
  const fold = (notes, c) => {
    for (const a of notes) if (c) folded[a.fold] = Date.now(); else delete folded[a.fold]
    // in a microtask: after an extension update this orphaned script's chrome.* calls throw instead of rejecting
    Promise.resolve().then(() => chrome.storage.local.set({ folded: fresh(folded) })).catch(() => {})
  }
  const fetched = new Map() // server + /files/… → a promise of its data: URL (images and html demos), fetched once
  const file = (server, url) => {
    const k = server + url
    if (!fetched.has(k)) fetched.set(k, chrome.runtime.sendMessage({ type: 'file', server, url }).then((r) => r?.url, () => null))
    return fetched.get(k)
  }
  const decode = (dataUrl) => new TextDecoder().decode(Uint8Array.from(atob(dataUrl.split(',')[1]), (c) => c.charCodeAt(0)))

  const norm = (t) => t.replace(/[‎‏]/g, '').trim()
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text) n.textContent = text; return n }
  const where = (a) => a.line ? `${a.side === 'LEFT' ? 'old ' : ''}line ${a.line}${a.end_line && a.end_line !== a.line ? `–${a.end_line}` : ''}` : 'file'

  function note(a, i) {
    const box = el('div', 'dn-note')
    box.dataset.dn = i
    const head = el('button', 'dn-head')
    head.type = 'button'
    head.append(el('span', 'dn-badge', 'DN'), el('span', 'dn-title', a.title || a.body.split('\n')[0].replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[`*_#>]/g, '').slice(0, 120)))
    if (RISKS.includes(a.risk)) head.append(el('span', `dn-risk dn-risk-${a.risk}`, `${a.risk} risk`))
    head.append(el('span', 'dn-where', where(a)))
    const body = el('div', 'dn-body dn-md')
    body.append(md(a.body, a.server))
    box.classList.toggle('dn-collapsed', !!folded[a.fold])
    head.addEventListener('click', () => { fold([a], box.classList.toggle('dn-collapsed')); clampAll() })
    box.append(head, body)
    if (a.canDelete && a.id) {
      const actions = el('div', 'dn-actions'), remove = el('button', 'dn-link dn-remove', 'remove note')
      remove.type = 'button'
      remove.addEventListener('click', confirming('Remove this note for everyone?', () => removeNotes(a.server, `/api/v1/annotations/${a.id}`)))
      actions.append(remove)
      box.append(actions)
    }
    return box
  }

  // Removing notes: the uploader and account admins see "remove" (the server says so with can_delete and checks again).
  // A click asks inline first; only real clicks count, so a script on the page can't press them.
  const RISKS = ['high', 'medium', 'low']
  const confirming = (question, action) => (e) => {
    if (!e.isTrusted) return
    const button = e.currentTarget, ask = el('span', 'dn-confirm')
    const yes = el('button', 'dn-danger', 'Remove'), no = el('button', 'dn-link', 'Cancel')
    yes.type = no.type = 'button'
    // a failed removal keeps Cancel, which brings the button back for another try
    yes.addEventListener('click', (ev) => { if (!ev.isTrusted) return; yes.disabled = true; yes.textContent = 'Removing…'; action().then((err) => { if (err) ask.replaceChildren(el('span', 'dn-hint', err), no) }) })
    no.addEventListener('click', () => { ask.remove(); button.style.display = ''; button.focus() })
    ask.append(el('span', '', question), yes, no)
    button.style.display = 'none' // .dn-link's all: unset beats the hidden attribute
    button.after(ask)
    yes.focus()
  }
  async function removeNotes(server, url) {
    const r = await chrome.runtime.sendMessage({ type: 'delete', server, url }).catch(() => null)
    if (!r?.ok) return r?.error ?? 'Could not remove: reload the page and try again'
    current = '' // fetch again and redraw what is left
    check()
  }

  // Markdown as nodes, escaped by dnMarkdown (only http(s) and relative URLs survive). Parsed in an inert <template>, so
  // no image starts loading before loadImages() points /files/… at the right server (else github.com would get them)
  function md(text, server) { return nodes(dnMarkdown(text), server) }
  function nodes(html, server) {
    const t = document.createElement('template')
    t.innerHTML = html
    loadImages(t.content, server)
    dnCompare(t.content) // before / after image pairs get a drag handle
    return t.content
  }
  // server: the DiffNotes server the Markdown came from; its /files/… are fetched by the background with its token
  function loadImages(root, server) {
    root.querySelectorAll('img[data-dn-src]').forEach((img) => {
      const src = img.dataset.dnSrc
      img.removeAttribute('src')
      if (!src.startsWith('/files/')) return // only the note's server's files load: another path would hit this site
      file(server, src).then((u) => { if (u) img.src = u })
    })
    // links to attached files open a preview here instead of navigating the page to /files/…
    root.querySelectorAll('a[href^="/files/"]').forEach((a) => {
      a.dataset.dnFile = a.getAttribute('href')
      a.dataset.dnServer = server
      a.removeAttribute('href')
      a.removeAttribute('target')
      a.classList.add('dn-file-link')
      if (/\.html$/i.test(a.dataset.dnFile)) inlineDemo(a, server)
    })
    root.querySelectorAll('img').forEach((img) => img.addEventListener('load', () => clamp(img.closest('.dn-note > .dn-body, .dn-summary')), { once: true }))
  }

  // One adapter per host. pr(): the repository (as DiffNotes names it) and number when this is a diff page.
  // files(): every rendered file as {path, box, top, rowFor(a)}: box is the file's container (the DiffNotes box goes
  // above the first one), file notes go before top, a line note before rowFor(a) (a <tr> or a grid row).
  const lineRow = (cell) => cell?.closest('tr, [role=row]')
  const SITES = {
    // Two GitHub diff UIs: the React "changes" view (h3 file-name__*, cells with data-diff-side) and the classic one
    // (still served to signed-out visitors: .file-header[data-path], td.blob-num).
    'github.com': {
      pr: (p) => { const m = p.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)\/(changes|files)/); return m && { repo: `${m[1]}/${m[2]}`, number: m[3] } },
      files() {
        const rowFor = (table) => (a) => {
          const side = a.side === 'LEFT' ? 'left' : 'right'
          for (const cell of table.querySelectorAll(`td[data-line-number="${Number(a.line)}"]`)) {
            const row = cell.closest('tr')
            const s = cell.dataset.diffSide ?? (row.querySelector('td.blob-num') === cell ? 'left' : 'right')
            if (s === side) return row
          }
        }
        const react = [...document.querySelectorAll('h3[class*="file-name"]')].map((h3) => {
          let box = h3.parentElement
          while (box && !box.querySelector('table')) box = box.parentElement
          // a file whose diff isn't rendered yet walks up past its own container: skip it rather than borrow a neighbour's table
          if (!box || box.querySelectorAll('h3[class*="file-name"]').length > 1) return null
          const table = box.querySelector('table')
          return table && { path: norm(h3.textContent), box, top: table.parentElement, rowFor: rowFor(table) }
        })
        const classic = [...document.querySelectorAll('.file-header[data-path]')].map((h) => {
          const box = h.closest('.file'), table = box?.querySelector('table')
          return table && { path: h.dataset.path, box, top: box.querySelector('.js-file-content') ?? table, rowFor: rowFor(table) }
        })
        return [...react, ...classic].filter(Boolean)
      },
    },
    // GitLab's merge request diffs ("rapid diffs"): <diff-file>, the path in its copy button, line links per side.
    // Repositories are host/path (gitlab.com/group/sub/project), so nested groups and self-hosted GitLab both work.
    'gitlab.com': {
      pr: (p) => { const m = p.match(/^\/(.+?)\/-\/merge_requests\/(\d+)\/diffs/); return m && { repo: `${location.host}/${m[1]}`, number: m[2] } },
      files: () => [...document.querySelectorAll('diff-file')].map((box) => {
        let path = ''
        try { path = JSON.parse(box.querySelector('[data-testid="rd-diff-file-copy-clipboard"]')?.dataset.clipboardText ?? '{}').text ?? '' } catch {}
        const top = box.querySelector('[data-testid="rd-diff-file-body"]')
        return path && top && { path, box, top, rowFor: (a) => lineRow(box.querySelector(`td.rd-line-number[data-position="${a.side === 'LEFT' ? 'old' : 'new'}"] a[data-line-number="${Number(a.line)}"]`)) }
      }).filter(Boolean),
    },
    // Bitbucket Cloud: <article data-qa=branch-diff-file>, a div grid whose gutter cells carry both line numbers
    'bitbucket.org': {
      pr: (p) => { const m = p.match(/^\/([^/]+)\/([^/]+)\/pull-requests\/(\d+)/); return m && { repo: `bitbucket.org/${m[1]}/${m[2]}`, number: m[3] } },
      files: () => [...document.querySelectorAll('[data-qa="branch-diff-file"]')].map((box) => {
        const path = norm(box.querySelector('[data-qa="bk-filepath"]')?.textContent ?? '').replace(/\s*\/\s*/g, '/')
        const top = box.querySelector('[data-qa="bk-file__content"]')
        return path && top && { path, box, top, rowFor: (a) => lineRow(box.querySelector(`[data-${a.side === 'LEFT' ? 'old' : 'new'}-line-number="${Number(a.line)}"]`)) }
      }).filter(Boolean),
    },
  }
  const site = SITES[location.host] ?? SITES['gitlab.com'] // any other host the extension runs on is a self-hosted GitLab
  const files = () => site.files()

  function apply() {
    if (!pull && !error) return
    const list = files()
    if (error) return renderBox(null, list)
    const placed = new Set()
    for (const f of list) {
      pull.annotations.forEach((a, i) => {
        if (a.path !== f.path) return
        if (f.box.querySelector(`[data-dn="${i}"]`)) return placed.add(i)
        if (!a.line) {
          const card = note(a, i)
          card.classList.add('dn-file')
          f.top.before(card)
          return placed.add(i)
        }
        const row = f.rowFor(a)
        if (!row) return
        if (row.tagName === 'TR') {
          const tr = el('tr', 'dn-row'), td = el('td')
          td.colSpan = [...row.children].reduce((n, c) => n + (c.colSpan || 1), 0)
          td.append(note(a, i))
          tr.append(td)
          // GitLab styles its rows as grids inside a block tbody: a table-row there would shrink to its content
          if (getComputedStyle(row).display !== 'table-row') tr.style.display = td.style.display = 'block'
          row.before(tr)
        } else {
          const div = el('div', 'dn-row dn-grid-row') // a div grid (Bitbucket): stays in view when the code scrolls sideways
          div.append(note(a, i))
          row.before(div)
        }
        placed.add(i)
      })
    }
    renderBox(placed, list)
    clampAll() // after renderBox, so the summary and the not-placed notes it builds are measured too
  }

  // The DiffNotes box sits above the first file of the diff (never over the code), re-attached when the page re-renders.
  function place(box, first) {
    if (first && box.nextElementSibling !== first) first.before(box)
  }

  function renderBox(placed, list) {
    let box = document.getElementById('dn-box')
    if (!box) { box = el('div'); box.id = 'dn-box' }
    const missing = error ? [] : pull.annotations.map((a, i) => [a, i]).filter(([, i]) => !placed.has(i))
    const key = error ?? `${pull.pulls.map((p) => p.id)}:${pull.annotations.length}:${missing.map(([, i]) => i).join(',')}`
    if (box.dataset.key !== key) {
      box.dataset.key = key
      box.replaceChildren(...(error ? [errorBar()] : boxContent(box, missing)))
    }
    place(box, list[0]?.box)
    if (!error) dock(box)
  }

  // Notes on/off for the whole diff, remembered across PRs. Every switch on the page shows the same state.
  let hidden = false
  chrome.storage.local.get('hideNotes').then((s) => setHidden(!!s.hideNotes, false))
  function setHidden(v, save = true) {
    hidden = v
    document.documentElement.classList.toggle('dn-hide-notes', v)
    document.querySelectorAll('.dn-switch').forEach((b) => b.setAttribute('aria-checked', String(!v)))
    if (save) chrome.storage.local.set({ hideNotes: v })
    clampAll() // notes that were hidden get measured now that they show
  }
  function notesSwitch() {
    const b = el('button', 'dn-switch')
    b.type = 'button'
    b.setAttribute('role', 'switch')
    b.setAttribute('aria-checked', String(!hidden))
    b.title = 'Show or hide DiffNotes notes in the diff'
    b.append(el('i'), el('span', '', 'notes'))
    b.addEventListener('click', () => setHidden(!hidden))
    return b
  }

  // Once the box scrolls away, a floating dock at the bottom keeps the count, the notes switch and the summary at hand.
  function dock(box) {
    let d = document.getElementById('dn-dock')
    if (!d) {
      d = el('div', 'dn-float')
      d.id = 'dn-dock'
      document.body.append(d)
    }
    if (d.dataset.key !== box.dataset.key) {
      d.dataset.key = box.dataset.key
      const summary = el('button', 'dn-pill-btn', 'summary'), top = el('button', 'dn-pill-btn', '↑')
      top.title = 'Back to the DiffNotes box'
      summary.addEventListener('click', () => {
        const open = document.getElementById('dn-pop')
        if (open) return open.remove()
        const pop = el('div', 'dn-float dn-pop')
        pop.id = 'dn-pop'
        const body = box.querySelector('.dn-box-body'), copy = body ? body.cloneNode(true) : el('div', 'dn-hint', 'No summary for this pull request.')
        // a cloned demo frame never gets its HTML posted in; the file link (delegated) still opens the demo.
        // remove note needs its listener: that stays in the box
        copy.querySelectorAll('.dn-demo, .dn-actions').forEach((d) => d.remove())
        pop.append(copy)
        // a clone has no listeners: note headers toggle (and are remembered) through the pop
        pop.addEventListener('click', (e) => {
          const n = e.target.closest('.dn-head')?.parentElement
          if (n) fold([pull.annotations[n.dataset.dn]], n.classList.toggle('dn-collapsed'))
        })
        document.body.append(pop)
      })
      top.addEventListener('click', () => { document.getElementById('dn-pop')?.remove(); box.scrollIntoView({ behavior: 'smooth', block: 'start' }) })
      d.replaceChildren(el('span', 'dn-badge', 'DN'), el('b', '', `${pull.annotations.length} notes`), notesSwitch(), summary, top)
    }
    // watch the box's header bar: once it is above the viewport the dock takes over, even if the tall summary still shows
    const bar = box.firstElementChild
    if (!bar || seen?.target === bar) return
    seen?.disconnect()
    seen = new IntersectionObserver(([e]) => {
      const away = !e.isIntersecting && e.boundingClientRect.top < 0
      d.classList.toggle('dn-show', away)
      if (!away) document.getElementById('dn-pop')?.remove()
    })
    seen.target = bar
    seen.observe(bar)
  }

  const errorBar = () => {
    const bar = el('div', 'dn-bar')
    bar.append(el('span', 'dn-badge', 'DN'), el('span', 'dn-hint', error))
    return bar
  }

  function boxContent(box, missing) {
    const bar = el('div', 'dn-bar')
    const title = el('button', 'dn-head dn-box-title')
    title.type = 'button'
    title.append(el('span', 'dn-badge', 'DN'), el('b', '', `DiffNotes · ${pull.annotations.length} notes`))
    title.addEventListener('click', () => { box.classList.toggle('dn-collapsed'); clampAll() })
    const all = (c) => () => { fold(pull.annotations, c); document.querySelectorAll('.dn-note').forEach((n) => n.classList.toggle('dn-collapsed', c)); clampAll() }
    const expand = el('button', 'dn-link', 'expand all'), collapse = el('button', 'dn-link', 'collapse all')
    expand.addEventListener('click', all(false))
    collapse.addEventListener('click', all(true))
    const many = pull.pulls.length > 1
    const opens = pull.pulls.map((p) => {
      const open = el('a', 'dn-link', many ? `open on ${new URL(p.server).host}` : 'open in DiffNotes')
      open.href = `${p.server}/pulls/${p.id}`
      open.target = '_blank'
      return open
    })
    const removes = pull.pulls.filter((p) => p.can_delete).map((p) => {
      const b = el('button', 'dn-link dn-remove', many ? `remove notes on ${new URL(p.server).host}` : 'remove all notes')
      b.type = 'button'
      b.addEventListener('click', confirming(`Remove all ${p.annotations.length} notes and files of this PR for everyone?`,
        () => removeNotes(p.server, `/api/v1/pulls/${p.repo}/${p.number}?id=${p.id}`)))
      return b
    })
    bar.append(title, notesSwitch(), expand, collapse, ...opens, ...removes)
    const body = el('div', 'dn-box-body')
    // risk map: the notes the agent marked risky, highest first; a click jumps to the note in the diff
    const risky = pull.annotations.map((a, i) => [a, i]).filter(([a]) => RISKS.includes(a.risk))
      .sort(([a], [b]) => RISKS.indexOf(a.risk) - RISKS.indexOf(b.risk))
    if (risky.length) {
      const map = el('div', 'dn-risks')
      map.append(el('div', 'dn-risks-title', 'Where to look hardest'))
      for (const [a, i] of risky) {
        const row = el('button', 'dn-risk-row')
        row.type = 'button'
        row.dataset.dnJump = i // the click is delegated (below), so it also works in the dock's summary pop
        row.append(el('span', `dn-risk dn-risk-${a.risk}`, a.risk), el('code', '', `${a.path}${a.line ? `:${a.line}` : ''}`), el('span', 'dn-hint', a.title || ''))
        map.append(row)
      }
      body.append(map)
    }
    for (const p of pull.pulls.filter((x) => x.summary)) {
      const s = el('div', 'dn-md dn-summary')
      if (many) s.append(el('h6', '', new URL(p.server).host))
      s.append(md(p.summary, p.server))
      body.append(s)
    }
    for (const e of pull.errors) body.append(el('div', 'dn-hint', e))
    if (missing.length) {
      body.append(el('div', 'dn-hint', `${missing.length} not shown in the diff yet (file collapsed, not loaded, or the line changed since):`))
      for (const [a, i] of missing) {
        const n = note(a, i)
        n.querySelector('.dn-where').textContent = `${a.path} · ${where(a)}`
        body.append(n)
      }
    }
    return body.childElementCount ? [bar, body] : [bar]
  }

  // Long notes are cut to a few lines with a show more / less toggle. Each is measured once it shows (hidden ones,
  // collapsed or notes switched off, measure 0 high and wait for clampAll() after they open) and again when one of its
  // images loads; apply() runs on every re-render of the diff, so already measured notes cost no layout.
  function clampAll() {
    document.querySelectorAll('.dn-note > .dn-body:not([data-dn-measured]), .dn-summary:not([data-dn-measured])').forEach(clamp)
  }
  function clamp(b) {
    if (!b || b.classList.contains('dn-open')) return
    if (!b.offsetParent) return void delete b.dataset.dnMeasured
    b.dataset.dnMeasured = ''
    let more = b.nextElementSibling?.classList.contains('dn-more') ? b.nextElementSibling : null
    // live demos sit right under their text (and its toggle), outside the clamp, so "show more" never cuts one in half
    ;(more ?? b).after(...b.querySelectorAll('.dn-demo'))
    const long = b.scrollHeight > 240
    b.classList.toggle('dn-clamped', long)
    if (long && !more) {
      more = el('button', 'dn-link dn-more', 'show more ↓')
      more.type = 'button'
      b.after(more)
    }
    if (!long && more) more.remove()
  }
  // risk map: jump to the note in the diff (or in the box when it isn't placed), turning notes on if they were off
  document.addEventListener('click', (e) => {
    const i = e.target.closest?.('.dn-risk-row')?.dataset.dnJump
    if (i == null) return
    if (hidden) setHidden(false)
    document.getElementById('dn-pop')?.remove()
    const n = document.querySelector(`.dn-row [data-dn="${i}"], .dn-file[data-dn="${i}"], #dn-box [data-dn="${i}"]`)
    // a note listed in a collapsed box has no box to scroll to: open it (clicked from the dock's summary pop)
    if (n?.closest('#dn-box.dn-collapsed')) { document.getElementById('dn-box').classList.remove('dn-collapsed'); clampAll() }
    // a folded note opens: the jump is to read it
    if (n?.classList.contains('dn-collapsed')) { n.classList.remove('dn-collapsed'); fold([pull.annotations[n.dataset.dn]], false); clampAll() }
    n?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    n?.classList.add('dn-flash')
    setTimeout(() => n?.classList.remove('dn-flash'), 1200)
  })
  // delegated, so the toggle also works in the dock's summary pop (a clone, which has no listeners)
  document.addEventListener('click', (e) => {
    const more = e.target.closest?.('.dn-more'), b = more?.previousElementSibling
    if (!b) return
    const open = b.classList.toggle('dn-open')
    b.classList.toggle('dn-clamped', !open)
    more.textContent = open ? 'show less ↑' : 'show more ↓'
  })

  const fetchText = (server, url) => file(server, url).then((u) => u && decode(u))

  // An uploaded HTML demo runs in the extension's sandboxed demo.html: an opaque origin with no access to github.com,
  // its cookies or the extension, and a CSP (manifest.json) that blocks every network request. The HTML is posted in once.
  function demoFrame(html) {
    const f = el('iframe', 'dn-demo-frame')
    f.setAttribute('sandbox', 'allow-scripts')
    f.setAttribute('referrerpolicy', 'no-referrer')
    // every load: moving an iframe in the DOM reloads it
    f.addEventListener('load', () => f.contentWindow.postMessage({ dnDemo: html }, '*'))
    f.src = chrome.runtime.getURL('demo.html')
    return f
  }
  // a link to an .html attachment in a note gets a live preview under it; "expand" opens it large
  function inlineDemo(link, server) {
    const wrap = el('div', 'dn-demo'), bar = el('div', 'dn-demo-bar'), open = el('button', 'dn-demo-open', 'expand ⤢')
    open.type = 'button'
    open.addEventListener('click', () => preview(link))
    bar.append(el('span', 'dn-demo-tag', 'live demo · sandboxed'), open)
    wrap.append(bar)
    // after the paragraph, and after the demos of earlier links in it, so they keep the text's order
    let at = link.closest('p, li') ?? link
    while (at.nextElementSibling?.classList.contains('dn-demo')) at = at.nextElementSibling
    at.after(wrap)
    fetchText(server, link.dataset.dnFile).then((html) => { if (html) wrap.append(demoFrame(html)) })
  }

  // an attached md / csv / txt file in a modal, an html demo in a sandboxed frame; images open in the lightbox
  async function preview(link) {
    const url = link.dataset.dnFile, name = decodeURIComponent(url.split('/').pop())
    const r = await chrome.runtime.sendMessage({ type: 'file', server: link.dataset.dnServer, url }).catch(() => null)
    if (!r?.url) return
    const box = el('div', 'dn-lightbox')
    if (/^data:image\//.test(r.url)) { const big = el('img'); big.src = r.url; box.append(big) }
    else {
      const text = decode(r.url)
      const demo = /\.html$/i.test(name)
      const doc = el('div', `dn-doc dn-md${demo ? ' dn-demo-doc' : ''}`), head = el('div', 'dn-bar')
      head.append(el('span', 'dn-badge', 'DN'), el('b', '', name))
      const body = el('div', 'dn-doc-body')
      if (demo) {
        const frame = demoFrame(text)
        for (const [label, w] of [['mobile', '390px'], ['tablet', '768px'], ['desktop', '100%']]) {
          const b = el('button', `dn-demo-w${w === '100%' ? ' on' : ''}`, label)
          b.type = 'button'
          b.addEventListener('click', () => { frame.style.width = w; head.querySelectorAll('.dn-demo-w').forEach((x) => x.classList.toggle('on', x === b)) })
          head.append(b)
        }
        body.append(frame)
      } else {
        body.append(nodes(dnPreview(name, text), link.dataset.dnServer)) // escaped by dnPreview, inert until loadImages
      }
      doc.append(head, body)
      doc.addEventListener('click', (e) => e.stopPropagation())
      box.append(doc)
    }
    box.addEventListener('click', () => box.remove())
    document.body.append(box)
  }
  document.addEventListener('click', (e) => {
    const link = e.target.closest?.('.dn-file-link')
    if (link) { e.preventDefault(); preview(link) }
  })

  // Gallery: a click on an image opens every image of the same note (or summary); ← → move, Esc closes.
  // A note can carry several shots, e.g. one component at mobile and desktop width.
  function gallery(imgs, start) {
    document.querySelector('.dn-lightbox')?.remove()
    let i = start
    const box = el('div', 'dn-lightbox dn-gallery'), big = el('img'), cap = el('div', 'dn-cap')
    const prev = el('button', 'dn-nav dn-prev', '‹'), next = el('button', 'dn-nav dn-next', '›')
    prev.setAttribute('aria-label', 'Previous image'); next.setAttribute('aria-label', 'Next image')
    const show = (n) => {
      i = (n + imgs.length) % imgs.length
      big.src = imgs[i].src
      big.alt = imgs[i].alt
      cap.textContent = `${imgs[i].alt || 'image'}${imgs.length > 1 ? ` · ${i + 1} / ${imgs.length}` : ''}`
    }
    prev.addEventListener('click', (e) => { e.stopPropagation(); show(i - 1) })
    next.addEventListener('click', (e) => { e.stopPropagation(); show(i + 1) })
    big.addEventListener('click', (e) => { e.stopPropagation(); if (imgs.length > 1) show(i + 1) })
    box.append(big, cap)
    if (imgs.length > 1) box.append(prev, next)
    box.addEventListener('click', () => box.remove())
    box.dnShow = (d) => show(i + d)
    document.body.append(box)
    show(i)
  }
  document.addEventListener('click', (e) => {
    const img = e.target.closest?.('.dn-md img')
    if (!img?.src || img.closest('.dn-lightbox')) return
    const group = [...(img.closest('.dn-note, .dn-summary, .dn-doc-body') ?? img.parentElement).querySelectorAll('.dn-md img, img')].filter((x) => x.src)
    gallery(group, Math.max(0, group.indexOf(img)))
  })
  document.addEventListener('keydown', (e) => {
    const g = document.querySelector('.dn-gallery')
    if (g && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) { e.preventDefault(); e.stopPropagation(); g.dnShow(e.key === 'ArrowRight' ? 1 : -1) }
    if (e.key === 'Escape') document.querySelectorAll('.dn-lightbox, #dn-pop').forEach((n) => n.remove())
  }, true)

  function clear() {
    observer?.disconnect()
    observer = null
    seen?.disconnect()
    pull = error = seen = null
    document.querySelectorAll('.dn-row, .dn-file, #dn-box, #dn-dock, #dn-pop, .dn-cmp-big').forEach((n) => n.remove())
  }

  // dark fallbacks when the page itself is dark, whatever the OS says (content.css)
  const darkPage = () => {
    const rgb = (n) => getComputedStyle(n).backgroundColor.match(/[\d.]+/g)?.map(Number) ?? []
    const opaque = (c) => c.length === 3 || c[3] > 0
    const c = [rgb(document.body), rgb(document.documentElement)].find(opaque) ?? [255, 255, 255] // transparent: browser white
    const [r, g, b] = c
    document.documentElement.classList.toggle('dn-dark', 0.299 * r + 0.587 * g + 0.114 * b < 128)
  }

  async function check() {
    darkPage()
    const m = site.pr(location.pathname), key = m ? `${m.repo}#${m.number}` : ''
    if (key === current) return
    current = key
    clear()
    if (!m) return void chrome.runtime.sendMessage({ type: 'clear' }).catch(() => {})
    const res = await chrome.runtime.sendMessage({ type: 'pull', repo: m.repo, number: m.number }).catch(() => null)
    if (current !== key) return
    if (res?.pulls?.length) {
      const pulls = res.pulls.map((p) => ({ ...p, repo: m.repo, number: m.number }))
      pull = { pulls, errors: res.errors, annotations: pulls.flatMap((p) => p.annotations.map((a) => ({ ...a, server: p.server, canDelete: p.can_delete,
        fold: hash([key, p.server, a.path, a.side, a.line, a.end_line, a.risk, a.title, a.body].join('\n')) }))) }
    } else if (res?.errors?.length) error = res.errors.join(' · ')
    else return
    await foldsLoaded
    if (current !== key) return
    apply()
    observer = new MutationObserver(() => { clearTimeout(timer); timer = setTimeout(apply, 200) })
    observer.observe(document.body, { childList: true, subtree: true })
  }

  // all three navigate without page loads
  check()
  setInterval(check, 1000)
})()
