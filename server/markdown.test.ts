// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import '../extension/markdown.js'

const g = globalThis as unknown as {
  r42Markdown: (src: unknown, resolve?: (u: string) => string) => string
  r42Preview: (name: string, text: unknown, resolve?: (u: string) => string) => string
  r42Compare: (root: Element) => void
}
const md = (s: unknown) => g.r42Markdown(s)

describe('r42Markdown', () => {
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

  it('renders tables, short rows and a pipe that is no table', () => {
    expect(md('a | b\n--- | :---:\n1 | 2\n3 |\n\nx')).toBe('<div class="r42-table"><table><thead><tr><th>a</th><th>b</th></tr></thead><tbody>'
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
  })

  it('loads images only from the note server and resolves /files/ paths', () => {
    const r = g.r42Markdown('![shot](/files/p/a.png) ![](https://cdn.example/x.png) ![bad](data:x)', (u) => `https://srv${u}`)
    expect(r).toContain('<img alt="shot" src="https://srv/files/p/a.png" data-r42-src="/files/p/a.png">')
    expect(r).toContain('<a href="https://cdn.example/x.png" target="_blank" rel="noopener noreferrer">image ↗</a>')
    expect(r).toContain('![bad](data:x)')
  })
})

describe('diagrams', () => {
  const dg = (src: string) => md('```mermaid\n' + src + '\n```')

  it('draws every node shape and edge kind', () => {
    const r = dg('flowchart LR\n%% comment\nA[Box] --> B(Round) --- C([Pill]) -.-> D((Circle)) ==> E{"Choice"}\nE -->|yes| A\nE -- no --> F\nstyle A fill:red\nA --> A')
    expect(r).toMatch(/^<div class="r42-diagram"><svg/)
    for (const s of ['<rect', 'rx="17"', '<ellipse', '<polygon', '>Choice<', '>yes<', '>no<', 'r42-dg-edge dashed', 'r42-dg-edge bold', 'r42-dg-arrow'])
      expect(r).toContain(s)
    expect(r).not.toContain('fill:red')
  })

  it('lays out in every direction', () => {
    const at = (d: string) => dg(`graph ${d}\nA --> B`).match(/<text x="([\d.]+)" y="([\d.]+)"[^>]*>A</)!.slice(1).map(Number)
    const [lr, rl, td, bt] = ['LR', 'RL', 'TD', 'BT'].map(at)
    expect(lr[0]).toBeLessThan(rl[0])
    expect(td[1]).toBeLessThan(bt[1])
    expect(dg('graph TB\nA;B')).toContain('r42-diagram')
  })

  it('falls back to a code block for what it does not draw', () => {
    for (const src of ['sequenceDiagram\nA->>B: hi', 'graph LR\n--> B', 'graph LR\nA ~~> B', 'graph LR\n%% only a comment',
      'graph LR\n' + Array.from({ length: 61 }, (_, i) => `N${i}`).join('\n')])
      expect(dg(src)).toMatch(/^<pre><code>/)
  })

  it('stops ranking a cycle', () => {
    expect(dg('graph TD\nA --> B --> C --> A')).toContain('r42-diagram')
  })
})

describe('r42Preview', () => {
  it('renders by file name', () => {
    expect(g.r42Preview('a.MD', '# t')).toBe('<h3>t</h3>')
    expect(g.r42Preview('a.txt', '<b>')).toBe('<pre>&lt;b&gt;</pre>')
    expect(g.r42Preview('a.txt', null)).toBe('<pre></pre>')
    expect(g.r42Preview('a.csv', '')).toBe('')
    expect(g.r42Preview('a.csv', 'a,"b ""q"""\r\n1,"x,y"\n2')).toBe('<div class="r42-table"><table><thead><tr><th>a</th><th>b &quot;q&quot;</th></tr></thead>'
      + '<tbody><tr><td>1</td><td>x,y</td></tr><tr><td>2</td><td></td></tr></tbody></table></div>')
    expect(g.r42Preview('a.csv', Array.from({ length: 503 }, (_, i) => i).join('\n'))).toContain('<p>… 2 more rows</p>')
  })
})

describe('r42Compare', () => {
  it('joins a before / after pair into one slider that moves', () => {
    const root = document.body.appendChild(document.createElement('div'))
    root.innerHTML = '<p><img alt="Before: old" data-r42-src="/files/p/x.png"> <br><img alt="" data-r42-src="/files/p/shot-after.png"></p>'
      + '<p><img alt="solo"><img alt="before"> text <img alt="after"></p>'
    g.r42Compare(root)
    g.r42Compare(root) // twice is harmless
    const boxes = root.querySelectorAll('.r42-compare')
    expect(boxes).toHaveLength(1)
    expect([...boxes[0].querySelectorAll('img')].map((i) => i.alt)).toEqual(['Before: old', ''])
    const range = boxes[0].querySelector('input')!
    range.value = '20'
    range.dispatchEvent(new Event('input', { bubbles: true }))
    expect((boxes[0] as HTMLElement).style.getPropertyValue('--x')).toBe('20%')
    document.body.dispatchEvent(new Event('input', { bubbles: true })) // other inputs are ignored
  })
})
