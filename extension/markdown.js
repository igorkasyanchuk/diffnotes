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
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
    const restore = (x) => x.replace(/\u0000(\d+)\u0000/g, (_, i) => restore(held[i]))
    return restore(s)
  }

  function markdown(src, resolve = (u) => u) {
    const out = [], lines = String(src ?? '').replace(/\r\n?/g, '\n').split('\n')
    let list = null, para = []
    const flushPara = () => { if (para.length) out.push(`<p>${inline(para.join(' '), resolve)}</p>`); para = [] }
    const flushList = () => { if (list) out.push(`</${list}>`); list = null }
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      const fence = line.match(/^```/)
      if (fence) {
        flushPara(); flushList()
        const code = []
        while (++i < lines.length && !/^```/.test(lines[i])) code.push(lines[i])
        out.push(`<pre><code>${esc(code.join('\n'))}</code></pre>`)
        continue
      }
      const h = line.match(/^(#{1,4})\s+(.*)/), li = line.match(/^\s*([-*]|\d+\.)\s+(.*)/)
      if (h) { flushPara(); flushList(); out.push(`<h${h[1].length + 2}>${inline(h[2], resolve)}</h${h[1].length + 2}>`) }
      else if (li) {
        flushPara()
        const tag = /\d/.test(li[1]) ? 'ol' : 'ul'
        if (list !== tag) { flushList(); out.push(`<${tag}>`); list = tag }
        out.push(`<li>${inline(li[2], resolve)}</li>`)
      } else if (/^>\s?/.test(line)) { flushPara(); flushList(); out.push(`<blockquote>${inline(line.replace(/^>\s?/, ''), resolve)}</blockquote>`) }
      else if (!line.trim()) { flushPara(); flushList() }
      else { flushList(); para.push(line.trim()) }
    }
    flushPara(); flushList()
    return out.join('')
  }
  globalThis.r42Markdown = markdown
})()
