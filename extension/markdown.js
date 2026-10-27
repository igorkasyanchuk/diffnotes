// Tiny Markdown → HTML for annotation bodies, shared by the extension (content script global) and the web app (import).
// Everything is escaped first; only http(s), relative and /files/ URLs survive, plus #note: links between notes. resolve(url) turns /files/… into a usable src.
// Images and videos load only from the note's own server: a remote one is a link, so opening a note never tells a third party who read it.
;(() => {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
  // `/\\host` is no relative path: browsers read it as //host
  // and never one holding a \u0000n\u0000 placeholder: restore() would put that tag's attributes inside href="…"
  const safeUrl = (u) => (!u.includes('\u0000') && /^(https?:\/\/|\/(?![\/\\]))/i.test(u) ? u : '')

  function inline(text, resolve) {
    // code spans and tags with attributes are swapped for \u0000n\u0000 so later passes never rewrite inside them
    const held = [], hold = (html) => `\u0000${held.push(html) - 1}\u0000`
    let s = esc(text.replace(/\u0000/g, '')).replace(/`([^`]+)`/g, (_, c) => hold(`<code>${c}</code>`))
    s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (m, text, url) => {
      const alt = text.replace(/\u0000\d+\u0000/g, '') // it lands inside an attribute: no held tags in it
      const u = safeUrl(url.replace(/&amp;/g, '&'))
      if (/^https?:/i.test(u)) return `${hold(`<a href="${esc(u)}" target="_blank" rel="noopener noreferrer">`)}${alt || 'image'} ↗</a>`
      // a screen recording (.mp4 / .webm) plays inline; the alt text is its caption
      if (u && /\.(mp4|webm)$/i.test(u.split(/[?#]/)[0])) {
        return hold(`<video controls muted playsinline preload="metadata" title="${alt}" aria-label="${alt || 'video'}" src="${esc(resolve(u))}" data-dn-src="${esc(u)}"></video>`)
      }
      return u ? hold(`<img alt="${alt}" src="${esc(resolve(u))}" data-dn-src="${esc(u)}">`) : m
    })
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, label, url) => {
      // a link to another note of the same PR: [the migration](#note:db/schema.sql:12); the page jumps to it (dnNoteRef)
      if (/^#note:[^\u0000]+$/.test(url)) return `${hold(`<a href="${url}" class="dn-note-link" data-dn-note="${url.slice(6)}">`)}${label}</a>`
      const u = safeUrl(url.replace(/&amp;/g, '&'))
      return u ? `${hold(`<a href="${esc(resolve(u))}" target="_blank" rel="noopener noreferrer">`)}${label}</a>` : m
    })
    s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>').replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
    const restore = (x) => x.replace(/\u0000(\d+)\u0000/g, (_, i) => restore(held[i]))
    return restore(s)
  }

  const cells = (row) => row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim())
  // per cell, not one regex over the row: adjacent \s* in a whole-row pattern backtracks quadratically on long lines
  const isRule = (row) => cells(row).every((c) => /^:?-{3,}:?$/.test(c))

  // Block Markdown: headings, paragraphs, lists (with [ ] / [x] tasks), quotes, fenced code, tables, rules.
  // depth: quote nesting; past 8 levels the rest is plain text, so `>>>>…` can't overflow the stack
  function markdown(src, resolve = (u) => u, depth = 0) {
    const out = [], lines = String(src ?? '').replace(/\r\n?/g, '\n').split('\n')
    let list = null, para = [], quote = []
    const flushPara = () => { if (para.length) out.push(`<p>${inline(para.join(' '), resolve)}</p>`); para = [] }
    const flushList = () => { if (list) out.push(`</${list}>`); list = null }
    const flushQuote = () => {
      if (quote.length) out.push(`<blockquote>${depth < 8 ? markdown(quote.join('\n'), resolve, depth + 1) : `<p>${inline(quote.join(' '), resolve)}</p>`}</blockquote>`)
      quote = []
    }
    const flush = () => { flushPara(); flushList(); flushQuote() }
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (/^\s*```/.test(line)) {
        flush()
        const code = []
        const lang = line.trim().slice(3).trim().toLowerCase()
        while (++i < lines.length && !/^\s*```/.test(lines[i])) code.push(lines[i])
        out.push((lang === 'mermaid' && diagram(code.join('\n'))) || `<pre><code>${esc(code.join('\n'))}</code></pre>`)
        continue
      }
      if (/^>\s?/.test(line)) { flushPara(); flushList(); quote.push(line.replace(/^>\s?/, '')); continue }
      flushQuote()
      // a table: a row with pipes followed by a rule with pipes and as many cells (a bare `---` is a rule, even under `a |`)
      if (line.includes('|') && lines[i + 1]?.includes('|') && isRule(lines[i + 1]) && cells(lines[i + 1]).length === cells(line).length) {
        flush()
        const head = cells(line), rows = []
        for (i += 2; i < lines.length && lines[i].includes('|') && lines[i].trim(); i++) rows.push(cells(lines[i]))
        i--
        out.push(`<div class="dn-table"><table><thead><tr>${head.map((c) => `<th>${inline(c, resolve)}</th>`).join('')}</tr></thead><tbody>${
          rows.map((r) => `<tr>${head.map((_, k) => `<td>${inline(r[k] ?? '', resolve)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`)
        continue
      }
      const h = line.match(/^(#{1,6})\s+(.*)/), li = line.match(/^\s*([-*+]|\d+\.)\s+(.*)/)
      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { flush(); out.push('<hr>') }
      else if (h) { flush(); const n = Math.min(h[1].length + 2, 6); out.push(`<h${n}>${inline(h[2], resolve)}</h${n}>`) }
      else if (li) {
        flushPara()
        const tag = /\d/.test(li[1]) ? 'ol' : 'ul'
        if (list !== tag) { flushList(); out.push(`<${tag}>`); list = tag }
        const task = li[2].match(/^\[([ xX])\]\s+(.*)/)
        out.push(task ? `<li class="task"><input type="checkbox" disabled${task[1] === ' ' ? '' : ' checked'}> ${inline(task[2], resolve)}</li>`
          : `<li>${inline(li[2], resolve)}</li>`)
      } else if (!line.trim()) { flushPara(); flushList() }
      else { flushList(); para.push(line.trim()) }
    }
    flush()
    return out.join('')
  }

  // ```mermaid flowcharts drawn as SVG here, no library: `flowchart`/`graph` LR|RL|TD|TB|BT, nodes A[box] A(round)
  // A([pill]) A((circle)) A{decision}, edges --> --- -.-> ==> with -->|label| or -- label -->, chains A --> B --> C.
  // Anything else (sequence diagrams, subgraph styling…) stays a code block. Labels are escaped like all Markdown.
  // ponytail: layered layout (rank = longest path), straight edges, no crossing reduction; vendor mermaid into the
  // demo sandbox if notes ever need more
  function diagram(src) {
    const lines = src.split(/\n|;/).map((l) => l.trim()).filter((l) => l && !l.startsWith('%%'))
    const head = lines.shift()?.match(/^(?:graph|flowchart)\s+(LR|RL|TD|TB|BT)\s*$/i)
    if (!head) return ''
    const dir = head[1].toUpperCase(), nodes = new Map(), edges = []
    const NODE = /^([A-Za-z0-9_]+)\s*(?:\(\((.*?)\)\)|\(\[(.*?)\]\)|\[(.*?)\]|\((.*?)\)|\{(.*?)\})?/
    // the `-- label -->` label starts and ends with a non-space: `(.+?)\s+-->` backtracks quadratically on long lines
    const EDGE = /^(-->|---|-\.->|==>|--\s+(\S(?:.*?\S)?)\s+-->)\s*(?:\|([^|]*)\|)?\s*/
    const node = (t) => {
      const m = t.match(NODE)
      if (!m) return null
      const n = nodes.get(m[1]) ?? { id: m[1], label: m[1], shape: 'box' }, label = m[2] ?? m[3] ?? m[4] ?? m[5] ?? m[6]
      if (label != null) {
        n.label = label.replace(/^"(.*)"$/, '$1').slice(0, 40)
        n.shape = m[2] != null ? 'circle' : m[3] != null || m[5] != null ? 'round' : m[6] != null ? 'diamond' : 'box'
      }
      nodes.set(n.id, n)
      return { id: n.id, rest: t.slice(m[0].length).trim() }
    }
    for (const l of lines) {
      if (/^(style|classDef|class|linkStyle|click|subgraph|end|direction)\b/.test(l)) continue
      let a = node(l)
      if (!a) return ''
      while (a.rest) {
        const e = a.rest.match(EDGE), b = e && node(a.rest.slice(e[0].length))
        if (!b) return ''
        edges.push({ from: a.id, to: b.id, label: (e[3] ?? e[2] ?? '').slice(0, 30), kind: e[1].startsWith('-.') ? 'dashed' : e[1] === '==>' ? 'bold' : '', arrow: e[1] !== '---' })
        a = b
      }
      if (nodes.size > 60 || edges.length > 120) return ''
    }
    if (!nodes.size) return ''
    // rank: longest path from the sources; a cycle stops growing once a rank reaches the node count
    const rank = new Map([...nodes.keys()].map((k) => [k, 0]))
    for (let pass = 0; pass < nodes.size; pass++)
      for (const e of edges) if (e.from !== e.to && rank.get(e.from) + 1 > rank.get(e.to) && rank.get(e.from) + 1 < nodes.size) rank.set(e.to, rank.get(e.from) + 1)
    const ranks = []
    for (const n of nodes.values()) {
      n.w = Math.max(64, n.label.length * 7.2 + 26) + (n.shape === 'diamond' ? 24 : 0)
      n.h = n.shape === 'diamond' ? 46 : n.shape === 'circle' ? Math.max(40, n.w * 0.5) : 34
      ;(ranks[rank.get(n.id)] ??= []).push(n)
    }
    const across = dir === 'LR' || dir === 'RL', GAP = across ? 64 : 48, STEP = across ? 22 : 28
    let along = 0, span = 0
    const sizes = ranks.map((r) => {
      const thick = Math.max(...r.map((n) => (across ? n.w : n.h)))
      const len = r.reduce((t, n) => t + (across ? n.h : n.w) + STEP, -STEP)
      span = Math.max(span, len)
      return { thick, len }
    })
    ranks.forEach((r, i) => {
      let at = (span - sizes[i].len) / 2
      for (const n of r) {
        const mid = along + sizes[i].thick / 2, size = across ? n.h : n.w
        if (across) { n.x = mid; n.y = at + size / 2 } else { n.x = at + size / 2; n.y = mid }
        at += size + STEP
      }
      along += sizes[i].thick + GAP
    })
    along -= GAP
    const P = 12, W = Math.ceil((across ? along : span) + P * 2), H = Math.ceil((across ? span : along) + P * 2)
    for (const n of nodes.values()) {
      n.x += P; n.y += P
      if (dir === 'RL') n.x = W - n.x
      if (dir === 'BT') n.y = H - n.y
    }
    // an edge runs between the two centres, cut where it leaves each node's box
    const cut = (n, dx, dy) => { const t = Math.min(n.w / 2 / (Math.abs(dx) || 1e-9), n.h / 2 / (Math.abs(dy) || 1e-9)); return [n.x + dx * t, n.y + dy * t] }
    const f = (v) => Math.round(v * 10) / 10
    const lines2 = edges.map((e) => {
      const a = nodes.get(e.from), b = nodes.get(e.to), dx = b.x - a.x, dy = b.y - a.y
      if (a === b) return ''
      const [x1, y1] = cut(a, dx, dy), [x2, y2] = cut(b, -dx, -dy)
      const label = e.label ? `<text class="dn-dg-elabel" x="${f((x1 + x2) / 2)}" y="${f((y1 + y2) / 2 - 6)}" text-anchor="middle">${esc(e.label)}</text>` : ''
      // the arrowhead is a triangle of its own, not a <marker>: a marker's id would repeat in a copied note (the
      // extension's summary pop) and point at the original, which draws nothing while its box is collapsed
      const d = Math.hypot(dx, dy) || 1, ux = dx / d, uy = dy / d, bx = x2 - ux * 8, by = y2 - uy * 8
      const head = e.arrow ? `<polygon class="dn-dg-arrow" points="${f(x2)},${f(y2)} ${f(bx - uy * 4)},${f(by + ux * 4)} ${f(bx + uy * 4)},${f(by - ux * 4)}"/>` : ''
      return `<line class="dn-dg-edge ${e.kind}" x1="${f(x1)}" y1="${f(y1)}" x2="${f(x2)}" y2="${f(y2)}"/>${head}${label}`
    }).join('')
    const shapes = [...nodes.values()].map((n) => {
      const { x, y, w, h } = n
      const shape = n.shape === 'diamond' ? `<polygon points="${f(x)},${f(y - h / 2)} ${f(x + w / 2)},${f(y)} ${f(x)},${f(y + h / 2)} ${f(x - w / 2)},${f(y)}"/>`
        : n.shape === 'circle' ? `<ellipse cx="${f(x)}" cy="${f(y)}" rx="${f(w / 2)}" ry="${f(h / 2)}"/>`
        : `<rect x="${f(x - w / 2)}" y="${f(y - h / 2)}" width="${f(w)}" height="${f(h)}" rx="${n.shape === 'round' ? 17 : 5}"/>`
      return `<g class="dn-dg-node">${shape}<text x="${f(x)}" y="${f(y)}" text-anchor="middle" dominant-baseline="central">${esc(n.label)}</text></g>`
    }).join('')
    return `<div class="dn-diagram"><svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="diagram">${lines2}${shapes}</svg></div>`
  }

  // Two images side by side named or captioned before / after become one image with a drag handle. Runs on rendered
  // nodes (the web app's notes, the extension's parsed notes) since the handle needs a listener.
  // alt text starting with the word, or a file named …-before.png / …_after.jpg
  const named = (img, word) => new RegExp(`^${word}\\b`, 'i').test(img.alt) || new RegExp(`(^|[-_./])${word}\\.\\w+$`, 'i').test(img.dataset.dnSrc ?? '')
  // delegated, so a copied compare (the extension's summary pop is a clone, without listeners) still moves
  globalThis.document?.addEventListener('input', (e) => {
    if (e.target.classList?.contains('dn-cmp-range')) e.target.parentElement.style.setProperty('--x', `${e.target.value}%`)
  })
  // ⤢ opens the pair large, as a copy (the slider is delegated); a click beside it or Esc closes it
  globalThis.document?.addEventListener('click', (e) => {
    const open = e.target.closest?.('.dn-cmp-open')
    if (open) {
      e.preventDefault(); e.stopPropagation()
      const doc = open.ownerDocument, big = doc.createElement('div'), copy = open.parentElement.cloneNode(true)
      const after = open.parentElement.querySelector('.dn-cmp-after')
      copy.querySelector('.dn-cmp-open').remove()
      // no wider than the picture is at 90vh: a tall (phone) pair fills the box, so the handle stays on the image
      if (after?.naturalHeight) copy.style.width = `min(94vw, 1600px, ${(90 * after.naturalWidth / after.naturalHeight).toFixed(2)}vh)`
      big.className = 'dn-cmp-big'
      big.append(copy)
      doc.body.append(big)
      copy.querySelector('input').focus() // off the ⤢ underneath (Enter would open another copy); ← → move the handle
    } else if (e.target.classList?.contains('dn-cmp-big')) e.target.remove()
  }, true)
  // capture: a host page (GitHub's diff) may stop Escape before it bubbles up here. Registered before content.js's
  // handler, so Esc closes only the large copy, not the summary or file preview it was opened from
  globalThis.document?.addEventListener('keydown', (e) => {
    const big = e.key === 'Escape' ? document.querySelectorAll('.dn-cmp-big') : []
    if (big.length) { big.forEach((n) => n.remove()); e.stopImmediatePropagation() }
  }, true)
  globalThis.dnCompare = (root) => {
    for (const before of root.querySelectorAll('img')) {
      let after = before.nextSibling
      while (after && ((after.nodeType === 3 && !after.textContent.trim()) || after.nodeName === 'BR')) after = after.nextSibling
      if (after?.nodeName !== 'IMG' || !named(before, 'before') || !named(after, 'after') || before.closest('.dn-compare')) continue
      const doc = before.ownerDocument, box = doc.createElement('span'), range = doc.createElement('input')
      box.className = 'dn-compare'
      box.style.setProperty('--x', '50%')
      range.type = 'range'; range.min = '0'; range.max = '100'; range.value = '50'; range.className = 'dn-cmp-range'
      range.setAttribute('aria-label', 'Drag to compare before and after')
      const tag = (cls, text) => { const t = doc.createElement('span'); t.className = cls; t.textContent = text; return t }
      const open = doc.createElement('button')
      open.type = 'button'; open.className = 'dn-cmp-open'; open.textContent = '⤢'; open.title = 'Open large'
      open.setAttribute('aria-label', 'Open before and after large')
      before.before(box)
      before.classList.add('dn-cmp-before'); after.classList.add('dn-cmp-after')
      // before first, so galleries and screen readers keep the pair's order; positioned, it still paints over after
      box.append(before, after, range, tag('dn-cmp-l', 'before'), tag('dn-cmp-r', 'after'), open)
    }
  }

  // CSV (RFC 4180 quotes) → an escaped table; for previews of attached .csv files
  function csv(text) {
    const rows = [], s = String(text ?? '')
    let row = [], cell = '', q = false
    for (let i = 0; i < s.length; i++) {
      const ch = s[i]
      if (q) { if (ch === '"' && s[i + 1] === '"') { cell += '"'; i++ } else if (ch === '"') q = false; else cell += ch }
      else if (ch === '"') q = true
      else if (ch === ',') { row.push(cell); cell = '' }
      else if (ch === '\n' || ch === '\r') { if (ch === '\r' && s[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = '' }
      else cell += ch
    }
    if (cell || row.length) { row.push(cell); rows.push(row) }
    if (!rows.length) return ''
    const [head, ...body] = rows.slice(0, 501)
    return `<div class="dn-table"><table><thead><tr>${head.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>${
      body.map((r) => `<tr>${head.map((_, k) => `<td>${esc(r[k] ?? '')}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`
      + (rows.length > 501 ? `<p>… ${rows.length - 501} more rows</p>` : '')
  }
  // an attached text file as HTML, by its name: .md rendered, .csv as a table, anything else as plain text
  globalThis.dnPreview = (name, text, resolve) =>
    /\.md$/i.test(name) ? markdown(text, resolve) : /\.csv$/i.test(name) ? csv(text) : `<pre>${esc(String(text ?? ''))}</pre>`
  globalThis.dnMarkdown = markdown
  // #note:path, #note:path:line → the index of the note it names in notes ({path, line, end_line, side}), or -1.
  // A line picks the note whose range holds it (the new side first), else the nearest one in that file; no line, the
  // file's note, else its first. The ref may be URL-encoded (a path with spaces).
  globalThis.dnNoteRef = (ref, notes) => {
    let r = String(ref ?? '')
    try { r = decodeURIComponent(r) } catch { /* as written */ }
    const [, path, n] = r.match(/^([\s\S]*?)(?::L?(\d+))?$/), line = Number(n) // [\s\S]: a decoded %0A must not fail the match
    const all = notes.map((a, i) => [a, i]).filter(([a]) => a.path === path)
    if (!all.length) return -1
    if (!line) return (all.find(([a]) => !a.line) ?? all[0])[1]
    const holds = all.filter(([a]) => a.line && a.line <= line && line <= (a.end_line || a.line))
    if (holds.length) return (holds.find(([a]) => a.side !== 'LEFT') ?? holds[0])[1]
    const dist = (a) => (a.line ? Math.abs(a.line - line) : Infinity)
    return all.reduce((best, x) => (dist(x[0]) < dist(best[0]) ? x : best))[1]
  }
})()
