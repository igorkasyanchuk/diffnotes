import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import './demo.css'

// A full-width, auto-playing film of Reviews42 on a GitHub pull request: a plain PR, the agent uploads, notes appear,
// screenshots open in a gallery, focus mode hides everything, then how to get it. Pure CSS animation driven by `scene`.

const SCENES: { ms: number; caption: ReactNode }[] = [
  { ms: 3200, caption: <>A pull request on GitHub. <b>342 changed lines</b>, no context.</> },
  { ms: 4600, caption: <>You ask your agent: <b>“annotate this PR with reviews42”</b>.</> },
  { ms: 4800, caption: <>Reviewers open the PR. <b>The why</b> appears right next to each change.</> },
  { ms: 4800, caption: <>Screenshots open in a <b>gallery</b>: mobile, desktop, ← → to flip.</> },
  { ms: 4400, caption: <>Scroll on: a <b>dock</b> keeps the summary close. One switch hides every note.</> },
  { ms: 5200, caption: <>Free, self-hosted, <b>3 minutes</b> to install.</> },
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
  [' ', 45, 47, '}'],
]
const FILE_B: Row[] = [
  [' ', 12, 12, '<CartSummary items={items} />'],
  ['+', '', 13, '<ShippingPicker'],
  ['+', '', 14, '  options={["standard", "express"]}'],
  ['+', '', 15, '  onChange={setShipping} />'],
  [' ', 13, 16, '<PayButton total={total} />'],
]

const Badge = () => <span className="dm-badge">R42</span>

function Note({ show, delay, title, children, where }: { show: boolean; delay: number; title: string; where: string; children: ReactNode }) {
  return <tr className={`dm-note-row${show ? ' on' : ''}`} style={{ transitionDelay: show ? `${delay}ms` : '0ms' }}>
    <td colSpan={3}><div className="dm-note">
      <div className="dm-nh"><Badge /><b>{title}</b><span className="dm-where">{where}</span></div>
      <div className="dm-nb">{children}</div>
    </div></td>
  </tr>
}

function Diff({ rows, notes }: { rows: Row[]; notes: Record<number, ReactNode> }) {
  return <table><tbody>{rows.map(([k, a, b, code], i) => <FragmentRows key={i} before={notes[i]}>
    <tr className={k === '+' ? 'add' : k === '-' ? 'del' : ''}>
      <td className="n">{a}</td><td className="n">{b}</td><td className="c"><span className="sign">{k}</span>{code}</td>
    </tr>
  </FragmentRows>)}</tbody></table>
}
const FragmentRows = ({ before, children }: { before?: ReactNode; children: ReactNode }) => <>{before}{children}</>

// the two "screenshots" a note carries: the shipping picker at phone and desktop width
const Shot = ({ mobile }: { mobile?: boolean }) => <div className={`dm-shot${mobile ? ' mobile' : ''}`}>
  <div className="dm-shot-bar" /><div className="dm-shot-line w60" /><div className="dm-shot-line w40" />
  <div className="dm-shot-opts"><span>standard</span><span className="on">express</span></div>
  <div className="dm-shot-pay">pay $42</div>
</div>

export function Demo() {
  const reduce = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
  const [scene, setScene] = useState(reduce ? 2 : 0), [playing, setPlaying] = useState(!reduce), [round, setRound] = useState(0)
  useEffect(() => {
    if (!playing) return
    const t = setTimeout(() => {
      if (scene === SCENES.length - 1) setRound((r) => r + 1)
      setScene((scene + 1) % SCENES.length)
    }, SCENES[scene].ms)
    return () => clearTimeout(t)
  }, [scene, playing])
  const s = scene, notes = s >= 2 && s <= 4, hidden = s === 4
  return <section className={`dm dm-s${s}`} aria-label="How Reviews42 looks on a GitHub pull request" key={round}>
    <div className="dm-screen">
      <div className={`dm-page${hidden ? ' notes-off' : ''}`}>
        <div className="dm-gh-top"><span className="dm-cat">◉</span><span>acme / <b>shop</b></span><span className="dm-gh-pr">Pull requests</span></div>
        <div className="dm-head">
          <h3>Express shipping at checkout <span>#42</span></h3>
          <div className="dm-meta"><span className="dm-open">Open</span> ana wants to merge 3 commits into <code>main</code></div>
          <div className="dm-tabs"><span>Conversation <i>2</i></span><span>Commits <i>3</i></span><span className="on">Files changed <i>3</i></span>
            <em className={`dm-ext${notes || s === 5 ? ' on' : ''}`}><Badge />{notes ? '5' : ''}</em></div>
        </div>
        <div className="dm-scroll">
          <div className={`dm-box${notes ? ' on' : ''}`}>
            <div className="dm-bar"><Badge /><b>Reviews42 · 5 notes</b>
              <span className={`dm-sw${hidden ? '' : ' on'}`}><i />notes</span><span className="dm-link">expand all</span><span className="dm-link">open in Reviews42</span></div>
            <div className="dm-sum">Adds an <b>express</b> shipping option. Empty carts now stop before the payment call. Tested on mobile and desktop.</div>
          </div>
          <div className="dm-file">
            <div className="dm-fh">⌄ app/checkout.ts <span className="add">+3</span> <span className="del">−1</span></div>
            <Diff rows={FILE_A} notes={{
              2: <Note show={notes} delay={300} title="Charge the express fee, stop on empty carts" where="line 43–45">
                An empty cart used to reach the payment provider with $0. It now returns early; express orders pay the fee.
              </Note>,
            }} />
          </div>
          <div className="dm-file">
            <div className="dm-fh">⌄ app/ShippingPicker.tsx <span className="add">+3</span></div>
            <Diff rows={FILE_B} notes={{
              1: <Note show={notes} delay={900} title="Shipping picker on checkout" where="line 13–15">
                Customers choose standard or express before paying.
                <div className="dm-thumbs"><span className={`dm-thumb${s === 3 ? ' hit' : ''}`}><Shot mobile /></span><span className="dm-thumb"><Shot /></span></div>
              </Note>,
            }} />
          </div>
        </div>
        <div className={`dm-dock${s === 4 ? ' on' : ''}`}><Badge /><b>5 notes</b><span className={`dm-sw${hidden ? '' : ' on'}`}><i />notes</span><span className="dm-pill">summary</span><span className="dm-pill">↑</span></div>
      </div>

      <div className={`dm-term${s === 1 ? ' on' : ''}`}>
        <div className="dm-term-bar"><i /><i /><i /><span>~/acme/shop</span></div>
        <div className="dm-term-body">
          <div className="l p">$ claude "annotate this PR with reviews42"</div>
          <div className="l o" style={{ animationDelay: '1.1s' }}>· reading the diff: 3 files, 5 changed blocks</div>
          <div className="l o" style={{ animationDelay: '1.9s' }}>· screenshots: picker-mobile.png, picker-desktop.png</div>
          <div className="l a" style={{ animationDelay: '2.8s' }}>✓ uploaded 5 notes + 2 images → reviews.acme.dev</div>
        </div>
      </div>

      <div className={`dm-gallery${s === 3 ? ' on' : ''}`}>
        <div className="dm-gallery-track"><Shot mobile /><Shot /></div>
        <div className="dm-cap"><span className="dm-cap-a">Picker on mobile · 1 / 2</span><span className="dm-cap-b">Picker on desktop · 2 / 2</span></div>
        <span className="dm-key">←</span><span className="dm-key r">→</span>
      </div>

      <div className={`dm-end${s === 5 ? ' on' : ''}`}>
        <div className="dm-end-tags"><span>free</span><span>self-hosted</span><span>any agent</span><span>nothing posted to GitHub</span></div>
        <h3>Set it up in 3 minutes</h3>
        <ol>
          <li><b>docker run</b> the server</li>
          <li><b>curl …/install.sh | sh</b> for your agent</li>
          <li><b>load the extension</b>, paste a token</li>
        </ol>
        <a href="#install" className="btn primary">how to install ↓</a>
      </div>

      <div className="dm-cursor" aria-hidden="true" />
    </div>

    <div className="dm-controls">
      <button type="button" className="dm-play" onClick={() => setPlaying(!playing)} aria-label={playing ? 'Pause' : 'Play'}>{playing ? '❚❚' : '▶'}</button>
      <div className="dm-caption" key={s}>{SCENES[s].caption}</div>
      <div className="dm-dots">{SCENES.map((x, i) => <button key={i} type="button" aria-label={`Scene ${i + 1}`} className={i === s ? 'on' : i < s ? 'done' : ''}
        onClick={() => { setScene(i); setPlaying(false) }}>{i === s && playing && <i style={{ animationDuration: `${x.ms}ms` }} />}</button>)}</div>
    </div>
  </section>
}
