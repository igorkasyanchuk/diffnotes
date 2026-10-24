// Tiny Markdown → HTML for annotation bodies, shared by the extension (content script global) and the web app (import).
// Everything is escaped first; only http(s), relative and /files/ URLs survive. resolve(url) turns /files/… into a usable src.
;(() => {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
  const safeUrl = (u) => (/^(https?:\/\/|\/(?!\/))/i.test(u) ? u : '')

  function inline(text, resolve) {
    // code spans and tags with attributes are swapped for \u0000n\u0000 so later passes never rewrite inside them
    const held = [], hold = (html) => `\u0000${held.push(html) - 1}\u0000`
    let s = esc(text.replace(/\u0000/g, '')).replace(/`([^`]+)`/g, (_, c) => hold(`<code>${c}</code>`))
    s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (m, alt, url) => {
      const u = safeUrl(url.replace(/&amp;/g, '&'))
      return u ? hold(`<img alt="${alt}" src="${esc(resolve(u))}" data-r42-src="${esc(u)}">`) : m
    })
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, label, url) => {
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
        while (++i < lines.length && !/^\s*```/.test(lines[i])) code.push(lines[i])
        out.push(`<pre><code>${esc(code.join('\n'))}</code></pre>`)
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
        out.push(`<div class="r42-table"><table><thead><tr>${head.map((c) => `<th>${inline(c, resolve)}</th>`).join('')}</tr></thead><tbody>${
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
    return `<div class="r42-table"><table><thead><tr>${head.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>${
      body.map((r) => `<tr>${head.map((_, k) => `<td>${esc(r[k] ?? '')}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`
      + (rows.length > 501 ? `<p>… ${rows.length - 501} more rows</p>` : '')
  }
  // an attached text file as HTML, by its name: .md rendered, .csv as a table, anything else as plain text
  globalThis.r42Preview = (name, text, resolve) =>
    /\.md$/i.test(name) ? markdown(text, resolve) : /\.csv$/i.test(name) ? csv(text) : `<pre>${esc(String(text ?? ''))}</pre>`
  globalThis.r42Markdown = markdown
})()
