// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import '../extension/markdown.js'

const g = globalThis as unknown as {
  dnMarkdown: (src: unknown, resolve?: (u: string) => string) => string
  dnPreview: (name: string, text: unknown, resolve?: (u: string) => string) => string
  dnCompare: (root: Element) => void
}
const md = (s: unknown) => g.dnMarkdown(s)

describe('deploy card', () => {
  const dep = (s: string) => (globalThis as unknown as { dnDeploy: (s: string) => string }).dnDeploy(s)
  it('tags list items that start with a kind, and only in a deploy card', () => {
    expect(dep('- Migration: `add_fee`, reversible\n- envs: EXPRESS_FEE=499\n- other: x')).toBe('<ul><li class="dn-dep"><span class="dn-dep-tag dn-dep-migration">migration</span> <code>add_fee</code>, reversible</li>' +
      '<li class="dn-dep"><span class="dn-dep-tag dn-dep-env">env</span> EXPRESS_FEE=499</li><li>other: x</li></ul>')
    expect(dep('- rollback: <b>x</b>')).toContain('&lt;b&gt;x&lt;/b&gt;')
    expect(dep('> - env: X')).toContain('<li class="dn-dep">') // in a quote too
    expect(md('- migration: x')).toBe('<ul><li>migration: x</li></ul>')
  })
})

describe('preview links', () => {
  const url = (p: string, t: string) => (globalThis as unknown as { dnPreviewUrl: (p: string, t: string) => string }).dnPreviewUrl(p, t)
  it('puts a note\'s path under the preview\'s own path', () => {
    expect(url('https://pr-42.x.vercel.app/', '/checkout?step=2')).toBe('https://pr-42.x.vercel.app/checkout?step=2')
    expect(url('https://o.github.io/repo/pr-42/', '/checkout')).toBe('https://o.github.io/repo/pr-42/checkout')
    expect(url('https://o.github.io/repo/pr-42?x=1#y', '/a#b')).toBe('https://o.github.io/repo/pr-42/a#b')
    expect(url('https://x.dev/app/', '')).toBe('https://x.dev/app/')
    // never another host or scheme, whatever follows the slash
    expect(url('https://x.dev/', '/https://evil.example/a')).toBe('https://x.dev/https://evil.example/a')
    expect(url('https://x.dev/', '/javascript:alert(1)')).toBe('https://x.dev/javascript:alert(1)')
    // nor above the preview's own path
    expect(url('https://o.github.io/repo/pr-42/', '/../../other/')).toBe('https://o.github.io/repo/pr-42/')
    expect(url('https://o.github.io/repo/pr-42/', '/%2e%2e/a')).toBe('https://o.github.io/repo/pr-42/')
    expect(url('https://o.github.io/repo/pr-42/', '/..%2f..%2fother/')).toBe('https://o.github.io/repo/pr-42/')
    expect(url('https://x.dev/', '/\\\\evil.example/a')).toBe('https://x.dev/evil.example/a')
    expect(url('https://x.dev/', '/.//evil.example/a')).toBe('https://x.dev/')
    expect(url('https://o.github.io/repo/pr-42?x=1', '/a/..//evil.example')).toBe('https://o.github.io/repo/pr-42?x=1')
  })
})

describe('links between notes', () => {
  const ref = (r: string, notes: object[]) => (globalThis as unknown as { dnNoteRef: (r: string, n: object[]) => number }).dnNoteRef(r, notes)
  it('renders #note: links without a target, escaped', () => {
    expect(md('see [the column](#note:db/schema.sql:12)')).toBe('<p>see <a href="#note:db/schema.sql:12" class="dn-note-link" data-dn-note="db/schema.sql:12">the column</a></p>')
    expect(md('[x](#note:a"b.ts)')).toBe('<p><a href="#note:a&quot;b.ts" class="dn-note-link" data-dn-note="a&quot;b.ts">x</a></p>')
    expect(md('[x](#other)')).toBe('<p>[x](#other)</p>') // other fragments stay text
  })
  it('finds the note a ref names', () => {
    const notes = [{ path: 'a.ts', line: 10, end_line: 14, side: 'RIGHT' }, { path: 'a.ts', line: 30, side: 'LEFT' }, { path: 'a.ts', line: 30, side: 'RIGHT' },
      { path: 'b c.ts', line: null }, { path: 'b c.ts', line: 5 }]
    expect(ref('a.ts:12', notes)).toBe(0) // inside 10–14
    expect(ref('a.ts:L30', notes)).toBe(2) // the new side first
    expect(ref('a.ts:28', notes)).toBe(1) // nearest
    expect(ref('a.ts', notes)).toBe(0) // no file note: the first
    expect(ref('b%20c.ts', notes)).toBe(3) // the file note, URL-encoded path
    expect(ref('b c.ts:2', [{ path: 'b c.ts', line: null }])).toBe(0)
    expect(ref('%E0', notes)).toBe(-1) // bad encoding: as written, no such file
    expect(ref('a%0Ab.ts:1', notes)).toBe(-1) // a decoded line break: no such file, not a throw
    expect(ref('nope.ts:1', notes)).toBe(-1)
    expect(ref('a.ts:30', [{ path: 'a.ts', line: 30, side: 'LEFT' }])).toBe(0)
  })
})

describe('dnMarkdown', () => {
  it('renders blocks', () => {
    expect(md('# Title\n###### six')).toBe('<h3>Title</h3><h6>six</h6>')
    expect(md('a\nb\n\nc')).toBe('<p>a b</p><p>c</p>')
    expect(md('- a\n- [x] done\n- [ ] todo\n1. one')).toBe('<ul><li>a</li><li class="task"><input type="checkbox" disabled checked> done</li>'
      + '<li class="task"><input type="checkbox" disabled> todo</li></ul><ol><li>one</li></ol>')
    expect(md('- a\n\ntext\n- b\nafter')).toBe('<ul><li>a</li></ul><p>text</p><ul><li>b</li></ul><p>after</p>')
    expect(md('---\n* * *')).toBe('<hr><hr>')
    expect(md('> quote\n>> deep\nafter')).toBe('<blockquote><p>quote</p><blockquote><p>deep</p></blockquote></blockquote><p>after</p>')
    expect(md('>'.repeat(12) + ' x')).toContain('<p>&gt;&gt;&gt; x</p>')
    expect(md('```js\n<b>\n```')).toBe('<pre><code>&lt;b&gt;</code></pre>')
    expect(md('```\nunclosed')).toBe('<pre><code>unclosed</code></pre>')
    expect(md(null)).toBe('')
    expect(md('a\r\nb')).toBe('<p>a b</p>')
  })

  it('plays screen recordings from the note\'s own server only, captioned and escaped', () => {
    expect(g.dnMarkdown('![Drag "a" <b>](/files/p1/drag.webm)', (u) => `https://dn.example${u}`)).toBe('<p><video controls muted playsinline preload="metadata" '
      + 'title="Drag &quot;a&quot; &lt;b&gt;" aria-label="Drag &quot;a&quot; &lt;b&gt;" src="https://dn.example/files/p1/drag.webm" data-dn-src="/files/p1/drag.webm"></video></p>')
    expect(md('![](/files/p1/a.MP4?v=2)')).toContain('aria-label="video" src="/files/p1/a.MP4?v=2"')
    expect(md('![x](https://evil.example/a.webm)')).toBe('<p><a href="https://evil.example/a.webm" target="_blank" rel="noopener noreferrer">x ↗</a></p>')
    expect(md('![x](javascript:a.mp4)')).toBe('<p>![x](javascript:a.mp4)</p>')
    expect(md('![x](/files/p1/a.webm.png)')).toContain('<img')
  })

  it('renders tables, short rows and a pipe that is no table', () => {
    expect(md('a | b\n--- | :---:\n1 | 2\n3 |\n\nx')).toBe('<div class="dn-table"><table><thead><tr><th>a</th><th>b</th></tr></thead><tbody>'
      + '<tr><td>1</td><td>2</td></tr><tr><td>3</td><td></td></tr></tbody></table></div><p>x</p>')
    expect(md('a | b\n---')).toBe('<p>a | b</p><hr>')
    expect(md('a | b\n--- | --- | ---')).toContain('<p>')
  })

  it('escapes and keeps only safe URLs', () => {
    expect(md('<script>"\'&')).toBe('<p>&lt;script&gt;&quot;&#39;&amp;</p>')
    expect(md('`<i>` **b** *i* ~~s~~')).toBe('<p><code>&lt;i&gt;</code> <strong>b</strong> <em>i</em> <del>s</del></p>')
    expect(md('[x](javascript:alert(1)) [y](//evil) [z](/\\evil)')).not.toContain('<a')
    expect(md('[ok](https://a.example/?a=1&b=2)')).toBe('<p><a href="https://a.example/?a=1&amp;b=2" target="_blank" rel="noopener noreferrer">ok</a></p>')
    expect(md('`**not bold**`')).toBe('<p><code>**not bold**</code></p>')
    expect(md('a\u0000b')).toBe('<p>ab</p>')
    // a URL holding an image that's already rendered would put that tag's alt words inside href="…" as attributes
    expect(md('[x](/![a onmouseover=alert(1) b](/y.png))')).toBe('<p>[x](/<img alt="a onmouseover=alert(1) b" src="/y.png" data-dn-src="/y.png">)</p>')
    expect(md('![a `b`](/y.png)')).toBe('<p><img alt="a " src="/y.png" data-dn-src="/y.png"></p>')
  })

  it('loads images only from the note server and resolves /files/ paths', () => {
    const r = g.dnMarkdown('![shot](/files/p/a.png) ![](https://cdn.example/x.png) ![bad](data:x)', (u) => `https://srv${u}`)
    expect(r).toContain('<img alt="shot" src="https://srv/files/p/a.png" data-dn-src="/files/p/a.png">')
    expect(r).toContain('<a href="https://cdn.example/x.png" target="_blank" rel="noopener noreferrer">image ↗</a>')
    expect(r).toContain('![bad](data:x)')
  })
})

describe('diagrams', () => {
  const dg = (src: string) => md('```mermaid\n' + src + '\n```')

  it('draws every node shape and edge kind', () => {
    const r = dg('flowchart LR\n%% comment\nA[Box] --> B(Round) --- C([Pill]) -.-> D((Circle)) ==> E{"Choice"}\nE -->|yes| A\nE -- no --> F\nstyle A fill:red\nA --> A')
    expect(r).toMatch(/^<div class="dn-diagram"><svg/)
    for (const s of ['<rect', 'rx="17"', '<ellipse', '<polygon', '>Choice<', '>yes<', '>no<', 'dn-dg-edge dashed', 'dn-dg-edge bold', 'dn-dg-arrow'])
      expect(r).toContain(s)
    expect(r).not.toContain('fill:red')
  })

  it('lays out in every direction', () => {
    const at = (d: string) => dg(`graph ${d}\nA --> B`).match(/<text x="([\d.]+)" y="([\d.]+)"[^>]*>A</)!.slice(1).map(Number)
    const [lr, rl, td, bt] = ['LR', 'RL', 'TD', 'BT'].map(at)
    expect(lr[0]).toBeLessThan(rl[0])
    expect(td[1]).toBeLessThan(bt[1])
    expect(dg('graph TB\nA;B')).toContain('dn-diagram')
  })

  it('falls back to a code block for what it does not draw', () => {
    for (const src of ['sequenceDiagram\nA->>B: hi', 'graph LR\n--> B', 'graph LR\nA ~~> B', 'graph LR\n%% only a comment',
      'graph LR\n' + Array.from({ length: 61 }, (_, i) => `N${i}`).join('\n')])
      expect(dg(src)).toMatch(/^<pre><code>/)
  })

  it('stops ranking a cycle', () => {
    expect(dg('graph TD\nA --> B --> C --> A')).toContain('dn-diagram')
  })
})

describe('dnPreview', () => {
  it('renders by file name', () => {
    expect(g.dnPreview('a.MD', '# t')).toBe('<h3>t</h3>')
    expect(g.dnPreview('a.txt', '<b>')).toBe('<pre>&lt;b&gt;</pre>')
    expect(g.dnPreview('a.txt', null)).toBe('<pre></pre>')
    expect(g.dnPreview('a.csv', '')).toBe('')
    expect(g.dnPreview('a.csv', 'a,"b ""q"""\r\n1,"x,y"\n2')).toBe('<div class="dn-table"><table><thead><tr><th>a</th><th>b &quot;q&quot;</th></tr></thead>'
      + '<tbody><tr><td>1</td><td>x,y</td></tr><tr><td>2</td><td></td></tr></tbody></table></div>')
    expect(g.dnPreview('a.csv', Array.from({ length: 503 }, (_, i) => i).join('\n'))).toContain('<p>… 2 more rows</p>')
  })
})

describe('dnCompare', () => {
  it('joins a before / after pair into one slider that moves', () => {
    const root = document.body.appendChild(document.createElement('div'))
    root.innerHTML = '<p><img alt="Before: old" data-dn-src="/files/p/x.png"> <br><img alt="" data-dn-src="/files/p/shot-after.png"></p>'
      + '<p><img alt="solo"><img alt="before"> text <img alt="after"></p>'
    g.dnCompare(root)
    g.dnCompare(root) // twice is harmless
    const boxes = root.querySelectorAll('.dn-compare')
    expect(boxes).toHaveLength(1)
    expect([...boxes[0].querySelectorAll('img')].map((i) => i.alt)).toEqual(['Before: old', ''])
    const range = boxes[0].querySelector('input')!
    range.value = '20'
    range.dispatchEvent(new Event('input', { bubbles: true }))
    expect((boxes[0] as HTMLElement).style.getPropertyValue('--x')).toBe('20%')
    document.body.dispatchEvent(new Event('input', { bubbles: true })) // other inputs are ignored

    // ⤢ opens a large copy; a click on it keeps it, a click beside it or Esc closes it
    const open = () => { boxes[0].querySelector<HTMLElement>('.dn-cmp-open')!.click(); return document.querySelector<HTMLElement>('.dn-cmp-big')! }
    let big = open()
    expect(big.querySelectorAll('img')).toHaveLength(2)
    expect(big.querySelector('.dn-cmp-open')).toBeNull()
    big.querySelector('img')!.click()
    expect(document.querySelector('.dn-cmp-big')).not.toBeNull()
    big.click()
    expect(document.querySelector('.dn-cmp-big')).toBeNull()
    big = open()
    expect(document.activeElement).toBe(big.querySelector('input')) // off the ⤢ underneath, which Enter would press again
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect(document.querySelector('.dn-cmp-big')).not.toBeNull()
    // Esc closes only the large copy: later handlers (content.js closing the preview under it) don't see it
    const later: string[] = [], log = (e: KeyboardEvent) => later.push(e.key)
    document.addEventListener('keydown', log, true)
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(document.querySelector('.dn-cmp-big')).toBeNull()
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    document.removeEventListener('keydown', log, true)
    expect(later).toEqual(['Escape']) // the second one, with nothing large open
  })
})
