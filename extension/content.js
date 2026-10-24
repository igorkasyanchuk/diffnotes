// Draws Reviews42 annotations on a pull request's diff: GitHub, GitLab (merge requests) and Bitbucket. Idempotent:
// apply() runs again whenever the page renders more of the diff (they all render lazily) and only adds what is missing.
;(() => {
  let current = '', pull = null, error = null, observer = null, timer = 0, seen = null
  const collapsed = new Map() // annotation index → collapsed; survives re-renders
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
    const box = el('div', 'r42-note')
    box.dataset.r42 = i
    const head = el('button', 'r42-head')
    head.type = 'button'
    head.append(el('span', 'r42-badge', 'R42'), el('span', 'r42-title', a.title || a.body.split('\n')[0].replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[`*_#>]/g, '').slice(0, 120)), el('span', 'r42-where', where(a)))
    const body = el('div', 'r42-body r42-md')
    body.append(md(a.body, a.server))
    const set = (c) => { collapsed.set(i, c); box.classList.toggle('r42-collapsed', c) }
    set(collapsed.get(i) ?? false)
    head.addEventListener('click', () => { set(!box.classList.contains('r42-collapsed')); clampAll() })
    box.append(head, body)
    return box
  }

  // Markdown as nodes, escaped by r42Markdown (only http(s) and relative URLs survive). Parsed in an inert <template>, so
  // no image starts loading before loadImages() points /files/… at the right server (else github.com would get them)
  function md(text, server) { return nodes(r42Markdown(text), server) }
  function nodes(html, server) {
    const t = document.createElement('template')
    t.innerHTML = html
    loadImages(t.content, server)
    return t.content
  }
  // server: the Reviews42 server the Markdown came from; its /files/… are fetched by the background with its token
  function loadImages(root, server) {
    root.querySelectorAll('img[data-r42-src]').forEach((img) => {
      const src = img.dataset.r42Src
      img.removeAttribute('src')
      if (!src.startsWith('/files/')) return // only the note's server's files load: another path would hit this site
      file(server, src).then((u) => { if (u) img.src = u })
    })
    // links to attached files open a preview here instead of navigating the page to /files/…
    root.querySelectorAll('a[href^="/files/"]').forEach((a) => {
      a.dataset.r42File = a.getAttribute('href')
      a.dataset.r42Server = server
      a.removeAttribute('href')
      a.removeAttribute('target')
      a.classList.add('r42-file-link')
      if (/\.html$/i.test(a.dataset.r42File)) inlineDemo(a, server)
    })
    root.querySelectorAll('img').forEach((img) => img.addEventListener('load', () => clamp(img.closest('.r42-note > .r42-body, .r42-summary')), { once: true }))
  }

  // One adapter per host. pr(): the repository (as Reviews42 names it) and number when this is a diff page.
  // files(): every rendered file as {path, box, top, rowFor(a)}: box is the file's container (the Reviews42 box goes
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
        if (f.box.querySelector(`[data-r42="${i}"]`)) return placed.add(i)
        if (!a.line) {
          const card = note(a, i)
          card.classList.add('r42-file')
          f.top.before(card)
          return placed.add(i)
        }
        const row = f.rowFor(a)
        if (!row) return
        if (row.tagName === 'TR') {
          const tr = el('tr', 'r42-row'), td = el('td')
          td.colSpan = [...row.children].reduce((n, c) => n + (c.colSpan || 1), 0)
          td.append(note(a, i))
          tr.append(td)
          // GitLab styles its rows as grids inside a block tbody: a table-row there would shrink to its content
          if (getComputedStyle(row).display !== 'table-row') tr.style.display = td.style.display = 'block'
          row.before(tr)
        } else {
          const div = el('div', 'r42-row r42-grid-row') // a div grid (Bitbucket): stays in view when the code scrolls sideways
          div.append(note(a, i))
          row.before(div)
        }
        placed.add(i)
      })
    }
    renderBox(placed, list)
    clampAll() // after renderBox, so the summary and the not-placed notes it builds are measured too
  }

  // The Reviews42 box sits above the first file of the diff (never over the code), re-attached when the page re-renders.
  function place(box, first) {
    if (first && box.nextElementSibling !== first) first.before(box)
  }

  function renderBox(placed, list) {
    let box = document.getElementById('r42-box')
    if (!box) { box = el('div'); box.id = 'r42-box' }
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
    document.documentElement.classList.toggle('r42-hide-notes', v)
    document.querySelectorAll('.r42-switch').forEach((b) => b.setAttribute('aria-checked', String(!v)))
    if (save) chrome.storage.local.set({ hideNotes: v })
    clampAll() // notes that were hidden get measured now that they show
  }
  function notesSwitch() {
    const b = el('button', 'r42-switch')
    b.type = 'button'
    b.setAttribute('role', 'switch')
    b.setAttribute('aria-checked', String(!hidden))
    b.title = 'Show or hide Reviews42 notes in the diff'
    b.append(el('i'), el('span', '', 'notes'))
    b.addEventListener('click', () => setHidden(!hidden))
    return b
  }

  // Once the box scrolls away, a floating dock at the bottom keeps the count, the notes switch and the summary at hand.
  function dock(box) {
    let d = document.getElementById('r42-dock')
    if (!d) {
      d = el('div', 'r42-float')
      d.id = 'r42-dock'
      document.body.append(d)
    }
    if (d.dataset.key !== box.dataset.key) {
      d.dataset.key = box.dataset.key
      const summary = el('button', 'r42-pill-btn', 'summary'), top = el('button', 'r42-pill-btn', '↑')
      top.title = 'Back to the Reviews42 box'
      summary.addEventListener('click', () => {
        const open = document.getElementById('r42-pop')
        if (open) return open.remove()
        const pop = el('div', 'r42-float r42-pop')
        pop.id = 'r42-pop'
        const body = box.querySelector('.r42-box-body'), copy = body ? body.cloneNode(true) : el('div', 'r42-hint', 'No summary for this pull request.')
        // a cloned demo frame never gets its HTML posted in; the file link (delegated) still opens the demo
        copy.querySelectorAll('.r42-demo').forEach((d) => d.remove())
        pop.append(copy)
        // a clone has no listeners: note headers toggle through the pop
        pop.addEventListener('click', (e) => e.target.closest('.r42-head')?.parentElement.classList.toggle('r42-collapsed'))
        document.body.append(pop)
      })
      top.addEventListener('click', () => { document.getElementById('r42-pop')?.remove(); box.scrollIntoView({ behavior: 'smooth', block: 'start' }) })
      d.replaceChildren(el('span', 'r42-badge', 'R42'), el('b', '', `${pull.annotations.length} notes`), notesSwitch(), summary, top)
    }
    // watch the box's header bar: once it is above the viewport the dock takes over, even if the tall summary still shows
    const bar = box.firstElementChild
    if (!bar || seen?.target === bar) return
    seen?.disconnect()
    seen = new IntersectionObserver(([e]) => {
      const away = !e.isIntersecting && e.boundingClientRect.top < 0
      d.classList.toggle('r42-show', away)
      if (!away) document.getElementById('r42-pop')?.remove()
    })
    seen.target = bar
    seen.observe(bar)
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
    title.addEventListener('click', () => { box.classList.toggle('r42-collapsed'); clampAll() })
    const all = (c) => () => { pull.annotations.forEach((_, i) => collapsed.set(i, c)); document.querySelectorAll('.r42-note').forEach((n) => n.classList.toggle('r42-collapsed', c)); clampAll() }
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
    bar.append(title, notesSwitch(), expand, collapse, ...opens)
    const body = el('div', 'r42-box-body')
    for (const p of pull.pulls.filter((x) => x.summary)) {
      const s = el('div', 'r42-md r42-summary')
      if (many) s.append(el('h6', '', new URL(p.server).host))
      s.append(md(p.summary, p.server))
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

  // Long notes are cut to a few lines with a show more / less toggle. Each is measured once it shows (hidden ones,
  // collapsed or notes switched off, measure 0 high and wait for clampAll() after they open) and again when one of its
  // images loads; apply() runs on every re-render of the diff, so already measured notes cost no layout.
  function clampAll() {
    document.querySelectorAll('.r42-note > .r42-body:not([data-r42-measured]), .r42-summary:not([data-r42-measured])').forEach(clamp)
  }
  function clamp(b) {
    if (!b || b.classList.contains('r42-open')) return
    if (!b.offsetParent) return void delete b.dataset.r42Measured
    b.dataset.r42Measured = ''
    let more = b.nextElementSibling?.classList.contains('r42-more') ? b.nextElementSibling : null
    // live demos sit right under their text (and its toggle), outside the clamp, so "show more" never cuts one in half
    ;(more ?? b).after(...b.querySelectorAll('.r42-demo'))
    const long = b.scrollHeight > 240
    b.classList.toggle('r42-clamped', long)
    if (long && !more) {
      more = el('button', 'r42-link r42-more', 'show more ↓')
      more.type = 'button'
      b.after(more)
    }
    if (!long && more) more.remove()
  }
  // delegated, so the toggle also works in the dock's summary pop (a clone, which has no listeners)
  document.addEventListener('click', (e) => {
    const more = e.target.closest?.('.r42-more'), b = more?.previousElementSibling
    if (!b) return
    const open = b.classList.toggle('r42-open')
    b.classList.toggle('r42-clamped', !open)
    more.textContent = open ? 'show less ↑' : 'show more ↓'
  })

  const fetchText = (server, url) => file(server, url).then((u) => u && decode(u))

  // An uploaded HTML demo runs in the extension's sandboxed demo.html: an opaque origin with no access to github.com,
  // its cookies or the extension, and a CSP (manifest.json) that blocks every network request. The HTML is posted in once.
  function demoFrame(html) {
    const f = el('iframe', 'r42-demo-frame')
    f.setAttribute('sandbox', 'allow-scripts')
    f.setAttribute('referrerpolicy', 'no-referrer')
    // every load: moving an iframe in the DOM reloads it
    f.addEventListener('load', () => f.contentWindow.postMessage({ r42Demo: html }, '*'))
    f.src = chrome.runtime.getURL('demo.html')
    return f
  }
  // a link to an .html attachment in a note gets a live preview under it; "expand" opens it large
  function inlineDemo(link, server) {
    const wrap = el('div', 'r42-demo'), bar = el('div', 'r42-demo-bar'), open = el('button', 'r42-demo-open', 'expand ⤢')
    open.type = 'button'
    open.addEventListener('click', () => preview(link))
    bar.append(el('span', 'r42-demo-tag', 'live demo · sandboxed'), open)
    wrap.append(bar)
    // after the paragraph, and after the demos of earlier links in it, so they keep the text's order
    let at = link.closest('p, li') ?? link
    while (at.nextElementSibling?.classList.contains('r42-demo')) at = at.nextElementSibling
    at.after(wrap)
    fetchText(server, link.dataset.r42File).then((html) => { if (html) wrap.append(demoFrame(html)) })
  }

  // an attached md / csv / txt file in a modal, an html demo in a sandboxed frame; images open in the lightbox
  async function preview(link) {
    const url = link.dataset.r42File, name = decodeURIComponent(url.split('/').pop())
    const r = await chrome.runtime.sendMessage({ type: 'file', server: link.dataset.r42Server, url }).catch(() => null)
    if (!r?.url) return
    const box = el('div', 'r42-lightbox')
    if (/^data:image\//.test(r.url)) { const big = el('img'); big.src = r.url; box.append(big) }
    else {
      const text = decode(r.url)
      const demo = /\.html$/i.test(name)
      const doc = el('div', `r42-doc r42-md${demo ? ' r42-demo-doc' : ''}`), head = el('div', 'r42-bar')
      head.append(el('span', 'r42-badge', 'R42'), el('b', '', name))
      const body = el('div', 'r42-doc-body')
      if (demo) {
        const frame = demoFrame(text)
        for (const [label, w] of [['mobile', '390px'], ['tablet', '768px'], ['desktop', '100%']]) {
          const b = el('button', `r42-demo-w${w === '100%' ? ' on' : ''}`, label)
          b.type = 'button'
          b.addEventListener('click', () => { frame.style.width = w; head.querySelectorAll('.r42-demo-w').forEach((x) => x.classList.toggle('on', x === b)) })
          head.append(b)
        }
        body.append(frame)
      } else {
        body.append(nodes(r42Preview(name, text), link.dataset.r42Server)) // escaped by r42Preview, inert until loadImages
      }
      doc.append(head, body)
      doc.addEventListener('click', (e) => e.stopPropagation())
      box.append(doc)
    }
    box.addEventListener('click', () => box.remove())
    document.body.append(box)
  }
  document.addEventListener('click', (e) => {
    const link = e.target.closest?.('.r42-file-link')
    if (link) { e.preventDefault(); preview(link) }
  })

  // Gallery: a click on an image opens every image of the same note (or summary); ← → move, Esc closes.
  // A note can carry several shots, e.g. one component at mobile and desktop width.
  function gallery(imgs, start) {
    document.querySelector('.r42-lightbox')?.remove()
    let i = start
    const box = el('div', 'r42-lightbox r42-gallery'), big = el('img'), cap = el('div', 'r42-cap')
    const prev = el('button', 'r42-nav r42-prev', '‹'), next = el('button', 'r42-nav r42-next', '›')
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
    box.r42Show = (d) => show(i + d)
    document.body.append(box)
    show(i)
  }
  document.addEventListener('click', (e) => {
    const img = e.target.closest?.('.r42-md img')
    if (!img?.src || img.closest('.r42-lightbox')) return
    const group = [...(img.closest('.r42-note, .r42-summary, .r42-doc-body') ?? img.parentElement).querySelectorAll('.r42-md img, img')].filter((x) => x.src)
    gallery(group, Math.max(0, group.indexOf(img)))
  })
  document.addEventListener('keydown', (e) => {
    const g = document.querySelector('.r42-gallery')
    if (g && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) { e.preventDefault(); e.stopPropagation(); g.r42Show(e.key === 'ArrowRight' ? 1 : -1) }
    if (e.key === 'Escape') document.querySelectorAll('.r42-lightbox, #r42-pop').forEach((n) => n.remove())
  }, true)

  function clear() {
    observer?.disconnect()
    observer = null
    seen?.disconnect()
    pull = error = seen = null
    document.querySelectorAll('.r42-row, .r42-file, #r42-box, #r42-dock, #r42-pop').forEach((n) => n.remove())
  }

  // dark fallbacks when the page itself is dark, whatever the OS says (content.css)
  const darkPage = () => {
    const rgb = (n) => getComputedStyle(n).backgroundColor.match(/[\d.]+/g)?.map(Number) ?? []
    const opaque = (c) => c.length === 3 || c[3] > 0
    const c = [rgb(document.body), rgb(document.documentElement)].find(opaque) ?? [255, 255, 255] // transparent: browser white
    const [r, g, b] = c
    document.documentElement.classList.toggle('r42-dark', 0.299 * r + 0.587 * g + 0.114 * b < 128)
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
      pull = { pulls: res.pulls, errors: res.errors, annotations: res.pulls.flatMap((p) => p.annotations.map((a) => ({ ...a, server: p.server }))) }
    } else if (res?.errors?.length) error = res.errors.join(' · ')
    else return
    collapsed.clear()
    apply()
    observer = new MutationObserver(() => { clearTimeout(timer); timer = setTimeout(apply, 200) })
    observer.observe(document.body, { childList: true, subtree: true })
  }

  // all three navigate without page loads
  check()
  setInterval(check, 1000)
})()
