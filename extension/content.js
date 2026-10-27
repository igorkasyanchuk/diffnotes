// Draws DiffNotes annotations on a pull request's diff: GitHub, GitLab (merge requests) and Bitbucket. Idempotent:
// apply() runs again whenever the page renders more of the diff (they all render lazily) and only adds what is missing.
;(() => {
  let current = '', pull = null, error = null, observer = null, timer = 0, seen = null
  // Notes folded by hand stay folded after a reload while their content is the same: keyed by a hash of the PR and the
  // note (a.fold, set in check()), not its id (a re-upload makes new ids), so a note that changed opens again. Kept
  // FOLD_DAYS from the fold (shorter than the default 365 days retention: a fold this old is let go). Every tab keeps its copy current through onChanged.
  // ponytail: 32-bit FNV-1a, a collision only starts some other note folded
  const FOLD_DAYS = 60
  let folded = {} // note key → when it was folded
  const fresh = (all) => { const cut = Date.now() - FOLD_DAYS * 86400_000; for (const [k, t] of Object.entries(all)) if (t < cut) delete all[k]; return all }
  // Changed since your last visit: per PR, the note hashes (and anchors: server, path, side, line) shown last time. A note
  // whose hash wasn't among them is "new", or "updated" when its anchor was. The first visit of a PR marks nothing.
  // prior keeps the state this tab found, so badges stay through a redraw (remove note, navigating back) until a reload.
  let visits = {} // PR key → {t, h: [note hashes], a: [anchor hashes]}
  const prior = new Map()
  const foldsLoaded = chrome.storage.local.get(['folded', 'visits']).then((s) => { folded = fresh(s.folded ?? {}); visits = s.visits ?? {} }, () => {})
  chrome.storage.onChanged.addListener((ch) => { if (ch.folded) folded = ch.folded.newValue ?? {}; if (ch.visits) visits = ch.visits.newValue ?? {} })
  const hash = (s) => { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193); return (h >>> 0).toString(36) }
  // complete: every server answered. Else what was stored stays too, so the notes of a server that didn't answer this
  // time don't count as new on the next visit; skipping the save instead would lose every visit while one connected
  // server is down or rejects its token.
  const visit = (key, notes, complete) => {
    // a first visit is its own baseline: notes uploaded while this tab stays open are marked when it comes back to the PR
    if (!prior.has(key)) prior.set(key, visits[key] ?? { h: notes.map((a) => a.fold), a: notes.map((a) => a.anchor) })
    const before = prior.get(key), was = visits[key]
    for (const a of notes) a.changed = before && !before.h.includes(a.fold) ? (before.a.includes(a.anchor) ? 'updated' : 'new') : ''
    const keep = (now, old) => (complete || !old ? now : [...new Set([...now, ...old])])
    visits[key] = { t: Date.now(), h: keep(notes.map((a) => a.fold), was?.h), a: keep(notes.map((a) => a.anchor), was?.a) }
    // bounded: FOLD_DAYS like folds, and the 500 most recent PRs
    const cut = Date.now() - FOLD_DAYS * 86400_000
    visits = Object.fromEntries(Object.entries(visits).filter(([, v]) => v.t > cut).sort(([, x], [, y]) => y.t - x.t).slice(0, 500))
    Promise.resolve().then(() => chrome.storage.local.set({ visits })).catch(() => {})
  }
  const fold = (notes, c) => {
    for (const a of notes) if (c) folded[a.fold] = Date.now(); else delete folded[a.fold]
    // in a microtask: after an extension update this orphaned script's chrome.* calls throw instead of rejecting
    Promise.resolve().then(() => chrome.storage.local.set({ folded: fresh(folded) })).catch(() => {})
  }
  const fetched = new Map() // server + /files/… → a promise of its data: URL (images, videos and html demos), fetched once
  let fetchedFor = '' // the PR they belong to: another PR's are let go (a 2 MB video is a ~2.7 MB string)
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
    if (a.changed) head.append(el('span', 'dn-changed', a.changed))
    head.append(el('span', 'dn-where', where(a)))
    const body = el('div', 'dn-body dn-md')
    body.append(md(a.body, a.server))
    box.classList.toggle('dn-collapsed', !!folded[a.fold])
    head.addEventListener('click', () => { fold([a], box.classList.toggle('dn-collapsed')); clampAll() })
    box.append(head, body)
    const actions = el('div', 'dn-actions'), go = previewLink(a.preview, a.try)
    if (go) actions.append(go)
    if (a.canDelete && a.id) {
      const remove = el('button', 'dn-link dn-remove', 'remove note')
      remove.type = 'button'
      remove.addEventListener('click', confirming('Remove this note for everyone?', () => removeNotes(a.server, `/api/v1/annotations/${a.id}`)))
      actions.append(remove)
    }
    if (actions.childElementCount) box.append(actions)
    return box
  }

  // the PR's preview deploy (https only), at a path on it (a note's try: /checkout, the server keeps it a path; the box: '',
  // the preview itself, so one deployed under a path (…/pr-42/) isn't cut to its host's root)
  const previewLink = (preview, path, text = 'try it on the preview ↗') => {
    // another connected server's reply is checked too: a non-string or bad value draws no link instead of breaking the box
    if (typeof preview !== 'string' || !/^https:\/\//i.test(preview) || !URL.canParse(preview) || typeof path !== 'string') return null
    const a = el('a', 'dn-link dn-try', text)
    a.href = dnPreviewUrl(preview, path)
    a.target = '_blank'
    a.rel = 'noopener noreferrer'
    return a
  }

  // Removing notes: a note's author and account admins see "remove" (the server says so with can_delete and checks again).
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
    root.querySelectorAll('video[data-dn-src]').forEach((v) => {
      if (!v.dataset.dnSrc.startsWith('/files/')) return v.remove()
      v.replaceWith(videoFrame(server, v.dataset.dnSrc, v.title))
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
          // as wide as the file's visible box, not the grid: a long code line widens the grid past the file and would cut the note off
          // ponytail: measured when drawn; a window resize keeps the old width until the page re-renders the diff
          if (f.box.clientWidth) div.style.maxWidth = `${f.box.clientWidth}px`
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

  // How the notes look (popup: standard, loud, sticky, quiet, compact, ghost and more): a class on <html>, content.css styles it
  const theme = (t) => {
    const cl = document.documentElement.classList
    cl.remove(...[...cl].filter((c) => c.startsWith('dn-theme-')))
    if (t && t !== 'standard') cl.add(`dn-theme-${t}`)
    // notes change height with the theme: measure them again for show more
    document.querySelectorAll('[data-dn-measured]').forEach((b) => delete b.dataset.dnMeasured)
    clampAll()
  }
  chrome.storage.local.get('noteTheme').then((s) => theme(s.noteTheme), () => {})
  chrome.storage.onChanged.addListener((ch) => { if (ch.noteTheme) theme(ch.noteTheme.newValue) })

  // Notes in the diff on/off, and the box's summary (deploy card, risk map, summary) on/off: each remembered across PRs,
  // a class on <html>. Every switch on the page shows the same state. save false: as stored (the first read).
  let hidden = false, noSummary = false
  chrome.storage.local.get(['hideNotes', 'hideSummary']).then((s) => { setHidden(!!s.hideNotes, false); setNoSummary(!!s.hideSummary, false) }, () => {})
  const flip = (what, cls, key, v, save) => {
    document.documentElement.classList.toggle(cls, v)
    document.querySelectorAll(`.dn-switch[data-dn-what=${what}]`).forEach((b) => b.setAttribute('aria-checked', String(!v)))
    // in a microtask, like fold(): an orphaned script's chrome.* throws, which would skip clampAll() below
    if (save) Promise.resolve().then(() => chrome.storage.local.set({ [key]: v })).catch(() => {})
    clampAll() // what was hidden gets measured now that it shows
  }
  function setHidden(v, save = true) { hidden = v; flip('notes', 'dn-hide-notes', 'hideNotes', v, save) }
  function setNoSummary(v, save = true) { noSummary = v; flip('summary', 'dn-hide-summary', 'hideSummary', v, save) }
  function toggle(what) {
    const b = el('button', 'dn-switch'), notes = what === 'notes'
    b.type = 'button'
    b.dataset.dnWhat = what
    b.setAttribute('role', 'switch')
    b.setAttribute('aria-checked', String(!(notes ? hidden : noSummary)))
    b.title = notes ? 'Show or hide DiffNotes notes in the diff' : 'Show or hide the summary in this box'
    b.append(el('i'), el('span', '', what))
    b.addEventListener('click', () => (notes ? setHidden(!hidden) : setNoSummary(!noSummary)))
    return b
  }
  const notesSwitch = () => toggle('notes')

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
      // the page may re-render the diff and a new box take this one's place with the same key: always the live one
      const live = () => document.getElementById('dn-box') ?? box
      const summary = el('button', 'dn-pill-btn', 'summary'), top = el('button', 'dn-pill-btn', '↑')
      top.title = 'Back to the DiffNotes box'
      summary.addEventListener('click', () => {
        const open = document.getElementById('dn-pop')
        if (open) return open.remove()
        const pop = el('div', 'dn-float dn-pop')
        pop.id = 'dn-pop'
        const body = live().querySelector('.dn-box-body'), copy = body ? body.cloneNode(true) : el('div', 'dn-hint', 'No summary for this pull request.')
        // a cloned demo frame never gets its HTML posted in; the file link (delegated) still opens the demo.
        // remove note needs its listener: that stays in the box (a note's try link works in the copy)
        copy.querySelectorAll('.dn-demo, .dn-remove, .dn-confirm, .dn-actions:not(:has(.dn-try))').forEach((d) => d.remove())
        copy.querySelectorAll('iframe.dn-video').forEach(playIn) // a recording is posted in again
        pop.append(copy)
        // a clone has no listeners: note headers toggle (and are remembered) through the pop
        pop.addEventListener('click', (e) => {
          const n = e.target.closest('.dn-head')?.parentElement
          if (n) fold([pull.annotations[n.dataset.dn]], n.classList.toggle('dn-collapsed'))
        })
        document.body.append(pop)
      })
      top.addEventListener('click', () => { document.getElementById('dn-pop')?.remove(); live().scrollIntoView({ behavior: 'smooth', block: 'start' }) })
      d.replaceChildren(el('span', 'dn-badge', 'DN'), el('b', '', `${pull.annotations.length} notes`), ...changedLink(), notesSwitch(), summary, top)
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

  // "N changed since your last visit": jumps to the first (the click is delegated, so it works from the dock too)
  const changedLink = () => {
    const i = pull.annotations.findIndex((a) => a.changed), n = pull.annotations.filter((a) => a.changed).length
    if (i < 0) return []
    const b = el('button', 'dn-link dn-changed-link', `${n} changed since your last visit`)
    b.type = 'button'
    b.dataset.dnJump = i
    return [b]
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
    const all = (c) => () => { fold(pull.annotations, c); document.querySelectorAll('.dn-note').forEach((n) => n.classList.toggle('dn-collapsed', c)); clampAll() }
    const expand = el('button', 'dn-link', 'expand all'), collapse = el('button', 'dn-link', 'collapse all')
    expand.addEventListener('click', all(false))
    collapse.addEventListener('click', all(true))
    const many = pull.pulls.length > 1
    const opens = pull.pulls.map((p) => {
      const open = el('a', 'dn-link', many ? `open on ${new URL(p.server).host}` : 'open in DiffNotes')
      open.href = `${p.server}/pulls/${p.id}`
      open.target = '_blank'
      open.rel = 'noopener noreferrer'
      return open
    })
    const removes = pull.pulls.filter((p) => p.can_delete).map((p) => {
      // an admin removes everything; an author only their own notes and files (older servers: no can_delete_all, all of it)
      const everything = p.can_delete_all ?? true, mine = p.annotations.filter((a) => a.can_delete).length
      const b = el('button', 'dn-link dn-remove', `${everything ? 'remove all notes' : 'remove my notes'}${many ? ` on ${new URL(p.server).host}` : ''}`)
      b.type = 'button'
      // an author may have only files here (no notes of theirs): no count then
      b.addEventListener('click', confirming(everything ? `Remove all ${p.annotations.length} notes and files of this PR for everyone?`
        : `Remove your ${mine ? `${mine} ` : ''}notes and files of this PR?`,
        () => removeNotes(p.server, `/api/v1/pulls/${p.repo}/${p.number}?id=${p.id}`)))
      return b
    })
    // the summary (and deploy card) as Markdown for the PR's description: /files/… links point at their server (readers
    // sign in there), images become links (the site can't load them without a session), links to notes (#note:) their text
    // (no such anchor on the PR). Nothing is posted anywhere.
    const summaries = pull.pulls.filter((p) => p.summary || p.deploy), copy = el('button', 'dn-link', 'copy summary')
    copy.type = 'button'
    copy.title = 'Copy the summary as Markdown, e.g. for the PR description'
    copy.addEventListener('click', () => {
      const text = summaries.map((p) => (many ? `### ${new URL(p.server).host}\n\n` : '') +
        [p.summary, p.deploy && `### Deploy\n\n${p.deploy}`].filter(Boolean).join('\n\n').replace(/\[([^\]]+)\]\(#note:[^)\s]+\)/g, '$1').replace(/!?\[([^\]]*)\]\((\/files\/[^)\s]+)\)/g, (m, label, u) => `[${label || 'image'}](${p.server}${u})`)).join('\n\n')
      navigator.clipboard.writeText(text).then(() => 'copied ✓', () => 'copy failed').then((t) => {
        copy.textContent = t
        setTimeout(() => { copy.textContent = 'copy summary' }, 1500)
      })
    })
    // the first server's valid one: a bad value from one doesn't hide another's
    const preview = pull.pulls.map((p) => previewLink(p.preview, '', 'preview ↗')).find(Boolean)
    bar.append(title, ...changedLink(), notesSwitch(), expand, collapse, ...(summaries.length ? [copy] : []), ...(preview ? [preview] : []), ...opens, ...removes)
    // sum: what the summary switch hides (stack, deploy card, risk map, summary); a server's error and notes not placed in the diff always show
    const body = el('div', 'dn-box-body'), sum = el('div', 'dn-box-sum')
    // a stacked PR: the stack, bottom first, this one marked; the others link to their own diff (where their notes show)
    // (a list of PR numbers, else none: another server's string or null entry would throw and break the box, and a
    // number that isn't one would put any path of this site in the link)
    const stack = pull.pulls.map((p) => p.stack).find((s) => Array.isArray(s) && s.length && s.every((x) => Number.isSafeInteger(x?.number)))
    if (stack) {
      const row = el('div', 'dn-stack')
      row.append(el('span', 'dn-risks-title', 'Stack'))
      stack.forEach((s, i) => {
        if (i) row.append(el('span', 'dn-hint', '→'))
        const label = `#${s.number}${s.title ? ` ${s.title}` : ''}`
        if (String(s.number) === String(pull.pulls[0].number)) { const b = el('b', 'dn-stack-pr dn-stack-current', label); b.setAttribute('aria-current', 'page'); return row.append(b) }
        const a = el('a', 'dn-stack-pr', s.notes ? `${label} · DN` : label)
        // the same tab (files, diffs…), not what follows it: a commit range there is this PR's. The last /pull/<n>:
        // an owner named pull with a numeric repository (/pull/123/pull/42) has one before it
        a.href = location.pathname.replace(/^(.*\/(?:pull|merge_requests|pull-requests)\/)\d+(\/[^/]*)?.*/, (_, at, tab = '') => `${at}${s.number}${tab}`)
        if (s.notes) a.title = 'Has DiffNotes notes'
        row.append(a)
      })
      sum.append(row)
    }
    // the deploy card, pinned first: what shipping this PR takes (migrations, env vars, flags, rollback), for whoever deploys it
    for (const p of pull.pulls.filter((x) => x.deploy)) {
      const d = el('div', 'dn-md dn-summary dn-deploy')
      d.append(el('div', 'dn-risks-title', many ? `Deploy · ${new URL(p.server).host}` : 'Deploy'), nodes(dnDeploy(p.deploy), p.server))
      sum.append(d)
    }
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
      sum.append(map)
    }
    for (const p of pull.pulls.filter((x) => x.summary)) {
      const s = el('div', 'dn-md dn-summary')
      if (many) s.append(el('h6', '', new URL(p.server).host))
      s.append(md(p.summary, p.server))
      sum.append(s)
    }
    // the summary switch, and a click on the title flips it too. A box without a summary has neither (no arrow either):
    // a click there would hide the next PR's summary unseen
    if (sum.childElementCount) {
      body.append(sum)
      bar.insertBefore(toggle('summary'), bar.querySelector('.dn-switch').nextSibling)
      title.addEventListener('click', () => setNoSummary(!noSummary))
    } else title.classList.add('dn-no-sum')
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
  // jump to the note in the diff (or in the box when it isn't placed), turning notes on if they were off
  function jump(i) {
    if (hidden) setHidden(false)
    document.getElementById('dn-pop')?.remove()
    reveal(document.querySelector(`.dn-row [data-dn="${i}"], .dn-file[data-dn="${i}"], #dn-box [data-dn="${i}"]`), true)
  }
  // risk map and "changed" link; a note's link to another note ([text](#note:path:line), markdown.js), resolved among this PR's notes
  document.addEventListener('click', (e) => {
    const i = e.target.closest?.('[data-dn-jump]')?.dataset.dnJump
    if (i != null) return jump(i)
    const ref = e.target.closest?.('a[data-dn-note]')?.dataset.dnNote
    if (ref == null || !pull) return
    e.preventDefault()
    const n = dnNoteRef(ref, pull.annotations)
    if (n >= 0) jump(n)
  })
  // open: a folded note unfolds (a jump is to read it); j / k only scroll to it
  function reveal(n, open) {
    if (!n) return
    if (open && n.classList.contains('dn-collapsed')) { n.classList.remove('dn-collapsed'); fold([pull.annotations[n.dataset.dn]], false); clampAll() }
    n.scrollIntoView({ behavior: 'smooth', block: 'center' })
    n.classList.add('dn-flash')
    setTimeout(() => n.classList.remove('dn-flash'), 1200)
  }

  // Keyboard, while the PR has notes and nothing editable has focus: j / k next / previous note in page order, n notes
  // on / off, o opens the current note's attachment, ? lists the keys (a second ? leaves them to the site's own help).
  // j / k take over the site's own (GitLab, Bitbucket: next file) only while notes show.
  let cursor = null // the note j / k went to last
  const KEYS = [['j', 'next note'], ['k', 'previous note'], ['n', 'notes on / off'], ['o', 'open the note’s attachment'],
    ['?', 'these keys (press again for the site’s own)'], ['Esc', 'close']]
  function step(d) {
    const list = [...document.querySelectorAll('.dn-note')].filter((n) => n.offsetParent && !n.closest('#dn-pop'))
    if (!list.length) return false // no note in sight: the site's own j / k
    let i = list.indexOf(cursor)
    if (i < 0) { // from where the page is: the first note below the top third is next, the one before it previous
      const below = list.findIndex((n) => n.getBoundingClientRect().top > innerHeight / 3)
      i = (below < 0 ? list.length : below) - (d > 0 ? 1 : 0)
    }
    // past either end: stay (clamping would make k go down to the first note, j up to the last)
    if (!list[i + d]) return
    cursor = list[i + d]
    reveal(cursor, false)
  }
  // false: nothing to open (no current note, or one without a file or a loaded image): the site's own o goes through
  function openAt() {
    const link = cursor?.querySelector('.dn-file-link'), img = cursor?.querySelector('.dn-md img[src]')
    if (link) preview(link)
    else if (img) img.click() // the gallery (delegated click)
    else return false
  }
  function keys() {
    const box = el('div', 'dn-lightbox dn-keys'), doc = el('div', 'dn-doc'), head = el('div', 'dn-bar'), body = el('div', 'dn-doc-body')
    head.append(el('span', 'dn-badge', 'DN'), el('b', '', 'Keyboard'))
    for (const [k, what] of KEYS) { const r = el('div', 'dn-key'); r.append(el('kbd', '', k), el('span', '', what)); body.append(r) }
    doc.append(head, body)
    doc.addEventListener('click', (e) => e.stopPropagation())
    box.addEventListener('click', () => box.remove())
    document.body.append(box)
  }
  document.addEventListener('keydown', (e) => {
    if (!pull || e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return
    // composedPath: an input in a shadow root reaches the document as its host. A checkbox (the "Viewed" box) takes no typing
    const t = e.composedPath()[0]
    if (t instanceof Element && t.closest('input:not([type=checkbox], [type=radio]), textarea, select, [contenteditable]:not([contenteditable="false"])')) return
    const help = document.querySelector('.dn-keys')
    if (help) return void (e.key === '?' && help.remove()) // the site's own ? help goes through
    if (document.querySelector('.dn-lightbox')) return // a gallery or preview has its own keys
    const act = { j: () => step(1), k: () => step(-1), n: () => setHidden(!hidden), o: openAt, '?': keys }[e.key]
    if (!act || (hidden && e.key !== 'n' && e.key !== '?')) return
    if (act() === false) return // did nothing: the key stays the site's
    e.preventDefault()
    e.stopImmediatePropagation()
  }, true)
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
  // Safari has no manifest sandbox pages (Chromium has, Firefox since 154): there demo.html would be a privileged
  // extension page whose CSP blocks inline scripts, so a demo stays a link to try on the DiffNotes server instead.
  const sandboxed = !chrome.runtime.getURL('').startsWith('safari')
  function demoFrame(html) {
    if (!sandboxed) return el('div', 'dn-hint', 'Live demos don’t run in Safari: use “open in DiffNotes” to try it.')
    const f = el('iframe', 'dn-demo-frame')
    f.setAttribute('sandbox', 'allow-scripts')
    f.setAttribute('referrerpolicy', 'no-referrer')
    // every load: moving an iframe in the DOM reloads it
    f.addEventListener('load', () => f.contentWindow.postMessage({ dnDemo: html }, '*'))
    f.src = chrome.runtime.getURL('demo.html')
    return f
  }
  // A screen recording: github.com's CSP (media-src) refuses data: and blob: videos from the page, so it plays in the
  // sandboxed demo.html instead (its CSP allows media from data:), fetched by the background with the token like images.
  // demo.html answers with the video's size, so the frame takes its shape. Safari: no sandboxed demo.html, so a hint.
  function videoFrame(server, src, title) {
    if (!sandboxed) return el('div', 'dn-hint', 'Videos don’t play in Safari: use “open in DiffNotes” to watch it.')
    const f = el('iframe', 'dn-video')
    f.title = title || 'video'
    f.setAttribute('sandbox', 'allow-scripts')
    f.setAttribute('referrerpolicy', 'no-referrer')
    f.allow = 'fullscreen'
    f.dataset.dnSrc = src
    f.dataset.dnServer = server
    playIn(f)
    return f
  }
  function playIn(f) {
    file(f.dataset.dnServer, f.dataset.dnSrc).then((u) => {
      if (!u) return
      // every load: moving an iframe in the DOM reloads it
      f.addEventListener('load', () => f.contentWindow.postMessage({ dnVideo: u }, '*'))
      f.src = chrome.runtime.getURL('demo.html')
    })
  }
  addEventListener('message', (e) => {
    const [w, h] = Array.isArray(e.data?.dnVideoSize) ? e.data.dnVideoSize : []
    if (!(w > 0 && h > 0)) return // the page's own messages: no DOM walk for them
    const f = [...document.querySelectorAll('iframe.dn-video')].find((x) => x.contentWindow === e.source)
    if (!f) return
    f.style.aspectRatio = `${w} / ${h}`
    clamp(f.closest('.dn-note > .dn-body, .dn-summary'))
  })
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
    // through the cache: a video's frame asks for the same file again (fetched once, not twice per open)
    const u = await file(link.dataset.dnServer, url)
    if (!u) return
    const box = el('div', 'dn-lightbox')
    if (/^data:image\//.test(u)) { const big = el('img'); big.src = u; box.append(big) }
    else if (/^data:video\//.test(u)) box.append(videoFrame(link.dataset.dnServer, url, name)) // not text: never decoded as such
    else {
      const text = decode(u)
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
    pull = error = seen = cursor = null
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
    if (key && key !== fetchedFor) { fetched.clear(); fetchedFor = key }
    if (!m) return void chrome.runtime.sendMessage({ type: 'clear' }).catch(() => {})
    const res = await chrome.runtime.sendMessage({ type: 'pull', repo: m.repo, number: m.number }).catch(() => null)
    if (current !== key) return
    if (res?.pulls?.length) {
      // another connected server's notes are checked too: one that isn't an object with a path is left out, a body is
      // text (a null note or body would throw below and break every server's box)
      const pulls = res.pulls.map((p) => ({ ...p, repo: m.repo, number: m.number,
        annotations: p.annotations.filter((a) => typeof a?.path === 'string').map((a) => ({ ...a, body: String(a.body ?? '') })) }))
      pull = { pulls, errors: res.errors, annotations: pulls.flatMap((p) => p.annotations.map((a) => ({ ...a, server: p.server, preview: p.preview, canDelete: a.can_delete ?? p.can_delete,
        fold: hash([key, p.server, a.path, a.side, a.line, a.end_line, a.risk, a.title, a.body].join('\n')),
        anchor: hash([key, p.server, a.path, a.side, a.line].join('\n')) }))) }
    } else if (res?.errors?.length) error = res.errors.join(' · ')
    else return
    await foldsLoaded
    if (current !== key) return
    if (pull) visit(key, pull.annotations, !pull.errors?.length)
    apply()
    observer = new MutationObserver(() => { clearTimeout(timer); timer = setTimeout(apply, 200) })
    observer.observe(document.body, { childList: true, subtree: true })
  }

  // all three navigate without page loads
  check()
  setInterval(check, 1000)
})()
