import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import './demo.css'

// A full-width, auto-playing tour of Reviews42 on a GitHub pull request. The page is annotated from the first frame;
// an arrow with a label moves from feature to feature (summary, note, screenshots, live demo, notes switch, the agent),
// measured from the real elements so it lands right at any width. Scene actions are CSS animations keyed on `.dm-sN`.

type Target = 'box' | 'noteA' | 'thumbs' | 'live' | 'switch' | 'term'
// opens on what words can't show: screenshots and a live demo, then the notes themselves
const SCENES: { name: string; ms: number; at?: Target; click?: Target | 'thumb' | 'express'; label?: string; caption: ReactNode }[] = [
  { name: 'shots', ms: 5400, at: 'thumbs', click: 'thumb', label: 'Screenshots open in a gallery', caption: <>Mobile and desktop shots right in the diff; <b>← →</b> to flip.</> },
  { name: 'live', ms: 5000, at: 'live', click: 'express', label: 'A live demo you can click', caption: <>Small <b>HTML demos</b> run in a locked sandbox: no network, no access to GitHub.</> },
  { name: 'summary', ms: 4200, at: 'box', label: 'The whole PR in two lines', caption: <>Your agent's <b>summary</b> sits above the diff, with links to its reports.</> },
  { name: 'note', ms: 4200, at: 'noteA', label: 'The why, next to the change', caption: <>Every changed block gets <b>a plain-language note</b> on its own lines.</> },
  { name: 'off', ms: 4400, at: 'switch', click: 'switch', label: 'One switch hides every note', caption: <>Want the bare diff? <b>Notes off</b>, and back on whenever you like.</> },
  { name: 'agent', ms: 4800, at: 'term', label: 'All of it from one prompt', caption: <>You ask your agent: <b>“annotate this PR with reviews42”</b>. That's it.</> },
  { name: 'end', ms: 5200, caption: <>Free, self-hosted, <b>3 minutes</b> to install.</> },
]

type Row = [kind: ' ' | '+' | '-', old: number | '', now: number | '', code: string]
const FILE_A: Row[] = [
  [' ', 41, 41, 'export async function checkout(cart: Cart) {'],
  [' ', 42, 42, '  const total = sum(cart.items)'],
  ['-', 43, '', '  if (total > 0) await charge(cart.card, total)'],
  ['+', '', 43, '  if (total <= 0) return { status: "empty" }'],
  ['+', '', 44, '  const fee = cart.express ? EXPRESS_FEE : 0'],
  ['+', '', 45, '  await charge(cart.card, total + fee)'],
  [' ', 44, 46, '  return { status: "paid" }'],
]
const FILE_B: Row[] = [
  [' ', 12, 12, '<CartSummary items={items} />'],
  ['+', '', 13, '<ShippingPicker'],
  ['+', '', 14, '  options={["standard", "express"]}'],
  ['+', '', 15, '  onChange={setShipping} />'],
  [' ', 13, 16, '<PayButton total={total} />'],
]

const Badge = () => <span className="dm-badge">R42</span>

function Diff({ rows, notes }: { rows: Row[]; notes: Record<number, ReactNode> }) {
  return <table><tbody>{rows.map(([k, a, b, code], i) => <Rows key={i} before={notes[i]}>
    <tr className={k === '+' ? 'add' : k === '-' ? 'del' : ''}>
      <td className="n">{a}</td><td className="n">{b}</td><td className="c"><span className="sign">{k}</span>{code}</td>
    </tr>
  </Rows>)}</tbody></table>
}
const Rows = ({ before, children }: { before?: ReactNode; children: ReactNode }) => <>{before}{children}</>
const Note = ({ title, where, children, refEl }: { title: string; where: string; children: ReactNode; refEl?: (e: HTMLDivElement | null) => void }) =>
  <tr className="dm-note-row"><td colSpan={3}><div className="dm-note" ref={refEl}>
    <div className="dm-nh"><Badge /><b>{title}</b><span className="dm-where">{where}</span></div>
    <div className="dm-nb">{children}</div>
  </div></td></tr>

// the two "screenshots" a note carries: the shipping picker at phone and desktop width
const Shot = ({ mobile }: { mobile?: boolean }) => <div className={`dm-shot${mobile ? ' mobile' : ''}`}>
  <div className="dm-shot-bar" /><div className="dm-shot-line w60" /><div className="dm-shot-line w40" />
  <div className="dm-shot-opts"><span>standard</span><span className="on">express</span></div>
  <div className="dm-shot-pay">pay $42</div>
</div>

export function Demo() {
  const reduce = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
  // reduced motion: hold the summary scene, not a gallery mid-animation
  const [scene, setScene] = useState(reduce ? 2 : 0), [playing, setPlaying] = useState(!reduce), [round, setRound] = useState(0), [moving, setMoving] = useState(false)
  const [view, setView] = useState({ scroll: 0, hl: null as null | { x: number; y: number; w: number; h: number }, cursor: null as null | { x: number; y: number }, below: true })
  const els = useRef<Record<string, HTMLElement | null>>({}), screen = useRef<HTMLDivElement>(null), content = useRef<HTMLDivElement>(null)
  const ref = (k: string) => (e: HTMLElement | null) => { els.current[k] = e }

  useEffect(() => {
    if (!playing) return
    const t = setTimeout(() => {
      if (scene === SCENES.length - 1) setRound((r) => r + 1)
      setScene((scene + 1) % SCENES.length)
    }, SCENES[scene].ms)
    return () => clearTimeout(t)
  }, [scene, playing])

  // where the arrow, the highlight and the cursor go: layout boxes (offsets ignore the running transitions)
  useLayoutEffect(() => {
    const measure = () => {
      const s = SCENES[scene], scr = screen.current!, body = content.current!
      const box = (el: HTMLElement | null | undefined, scroll: number) => {
        if (!el) return null
        if (!body.contains(el)) return { x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight }
        const r = el.getBoundingClientRect(), b = body.getBoundingClientRect(), sr = scr.getBoundingClientRect()
        return { x: r.left - sr.left, y: body.offsetTop + r.top - b.top - scroll, w: r.width, h: r.height }
      }
      const el = s.at && els.current[s.at]
      let scroll = 0
      if (el && body.contains(el)) {
        const top = box(el, 0)!.y
        scroll = Math.max(0, Math.min(top - scr.clientHeight * 0.3, body.offsetTop + body.offsetHeight - scr.clientHeight))
      }
      const hl = box(el, scroll), c = s.click && box(els.current[s.click], scroll)
      setView({ scroll, hl, cursor: c ? { x: c.x + c.w * 0.55, y: c.y + c.h * 0.6 } : null, below: !hl || hl.y + hl.h + 110 < scr.clientHeight })
    }
    measure()
    // the first frame lands in place; after that the page, arrow and cursor glide between scenes
    requestAnimationFrame(() => setMoving(true))
    addEventListener('resize', measure)
    return () => removeEventListener('resize', measure)
  }, [scene, round])

  const s = scene, end = s === SCENES.length - 1, hl = view.hl
  const callX = hl ? Math.max(12, Math.min(hl.x + Math.min(hl.w / 2, 140) - 24, (screen.current?.clientWidth ?? 800) - 300)) : 0
  return <section className={`dm dm-x-${SCENES[s].name}${reduce ? ' dm-still' : ''}${moving ? ' dm-moving' : ''}`} aria-label="How Reviews42 looks on a GitHub pull request">
    <div className="dm-screen" ref={screen} key={round}>
      <div className="dm-page">
        <div className="dm-gh-top"><span className="dm-cat">◉</span><span>acme / <b>shop</b></span><span className="dm-gh-pr">Pull requests</span></div>
        <div className="dm-content" ref={content} style={{ transform: `translateY(${-view.scroll}px)` }}>
          <div className="dm-head">
            <h3>Express shipping at checkout <span>#42</span></h3>
            <div className="dm-meta"><span className="dm-open">Open</span> ana wants to merge 3 commits into <code>main</code></div>
            <div className="dm-tabs"><span>Conversation <i>2</i></span><span>Commits <i>3</i></span><span className="on">Files changed <i>3</i></span>
              <em className="dm-ext"><Badge />5</em></div>
          </div>
          <div className="dm-scroll">
            <div className="dm-box" ref={ref('box')}>
              <div className="dm-bar"><Badge /><b>Reviews42 · 5 notes</b>
                <span className="dm-sw" ref={ref('switch')}><i />notes</span><span className="dm-link">expand all</span><span className="dm-link">open in Reviews42</span></div>
              <div className="dm-sum">Adds an <b>express</b> shipping option. Empty carts now stop before the payment call. Tested on mobile and desktop.
                {' '}<span className="dm-a">test report</span> · <span className="dm-a">timings.csv</span></div>
            </div>
            <div className="dm-file">
              <div className="dm-fh">⌄ app/checkout.ts <span className="add">+3</span> <span className="del">−1</span></div>
              <Diff rows={FILE_A} notes={{
                2: <Note refEl={ref('noteA')} title="Charge the express fee, stop on empty carts" where="line 43–45">
                  An empty cart used to reach the payment provider with $0. It now returns early; express orders pay the fee.
                </Note>,
              }} />
            </div>
            <div className="dm-file">
              <div className="dm-fh">⌄ app/ShippingPicker.tsx <span className="add">+3</span></div>
              <Diff rows={FILE_B} notes={{
                1: <Note title="Shipping picker on checkout" where="line 13–15">
                  Customers choose standard or express before paying.
                  <div className="dm-thumbs" ref={ref('thumbs')}><span className="dm-thumb hit" ref={ref('thumb')}><Shot mobile /></span><span className="dm-thumb"><Shot /></span></div>
                  <div className="dm-live" ref={ref('live')}>
                    <div className="dm-live-bar"><span>live demo · sandboxed</span><span className="dm-pill">expand ⤢</span></div>
                    <div className="dm-live-app">
                      <span className="dm-opt s">Standard <small>3–5 days</small></span>
                      <span className="dm-opt e" ref={ref('express')}>Express <small>tomorrow</small></span>
                      <span className="dm-total">Total <b className="t1">$40.00</b><b className="t2">$47.00</b></span>
                    </div>
                  </div>
                </Note>,
              }} />
            </div>
          </div>
        </div>
      </div>

      {hl && !end && <>
        <div className="dm-hl" style={{ left: hl.x - 6, top: hl.y - 6, width: hl.w + 12, height: hl.h + 12 }} />
        <div className={`dm-call${view.below ? '' : ' up'}`} style={{ left: callX, top: view.below ? hl.y + hl.h + 10 : hl.y - 10 }}>
          <svg className="dm-arrow" viewBox="0 0 40 46" aria-hidden="true"><path d="M20 44V8M6 20 20 4l14 16" /></svg>
          <span className="dm-label" key={s}>{SCENES[s].label}</span>
        </div>
      </>}

      <div className="dm-term" ref={ref('term')}>
        <div className="dm-term-bar"><i /><i /><i /><span>~/acme/shop</span></div>
        <div className="dm-term-body">
          <div className="l p">$ claude "annotate this PR with reviews42"</div>
          <div className="l o" style={{ animationDelay: '1.1s' }}>· reading the diff: 3 files, 5 changed blocks</div>
          <div className="l o" style={{ animationDelay: '1.9s' }}>· screenshots + demo: picker-mobile.png, picker-desktop.png, picker.html</div>
          <div className="l a" style={{ animationDelay: '2.8s' }}>✓ uploaded 5 notes + 3 files → reviews.acme.dev</div>
        </div>
      </div>

      <div className="dm-gallery">
        <div className="dm-gallery-track"><Shot mobile /><Shot /></div>
        <div className="dm-cap"><span className="dm-cap-a">Picker on mobile · 1 / 2</span><span className="dm-cap-b">Picker on desktop · 2 / 2</span></div>
        <span className="dm-key">←</span><span className="dm-key r">→</span>
      </div>

      <div className="dm-end">
        <div className="dm-end-tags"><span>free</span><span>self-hosted</span><span>any agent</span><span>nothing posted to GitHub</span></div>
        <h3>Set it up in 3 minutes</h3>
        <ol>
          <li><b>docker run</b> the server</li>
          <li><b>curl …/install.sh | sh</b> for your agent</li>
          <li><b>load the extension</b>, paste a token</li>
        </ol>
        <a href="#install" className="btn primary">how to install ↓</a>
      </div>

      <div className="dm-cursor" aria-hidden="true" style={view.cursor ? { left: view.cursor.x, top: view.cursor.y } : undefined}><i key={s} /></div>
    </div>

    <div className="dm-controls">
      <button type="button" className="dm-play" onClick={() => setPlaying(!playing)} aria-label={playing ? 'Pause' : 'Play'}>{playing ? '❚❚' : '▶'}</button>
      <div className="dm-caption" key={s}>{SCENES[s].caption}</div>
      <div className="dm-dots">{SCENES.map((x, i) => <button key={i} type="button" aria-label={`Scene ${i + 1}`} className={i === s ? 'on' : i < s ? 'done' : ''}
        onClick={() => { setScene(i); setPlaying(false) }}>{i === s && playing && <i style={{ animationDuration: `${x.ms}ms` }} />}</button>)}</div>
    </div>
  </section>
}
