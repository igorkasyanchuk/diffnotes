import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import './landing.css'

// copy-to-clipboard for commands and tokens
// navigator.clipboard is undefined on plain-http origins (a self-hosted server on a LAN address): say so instead of failing silently
function Copy({ text }: { text: string }) {
  const [label, setLabel] = useState('copy')
  return <button type="button" className="copy" onClick={async () => {
    try { await navigator.clipboard.writeText(text); setLabel('copied ✓') } catch { setLabel('select to copy') }
    setTimeout(() => setLabel('copy'), 1500)
  }}>{label}</button>
}
export const Code = ({ text, prompt }: { text: string; prompt?: boolean }) =>
  <div className="code"><pre>{prompt && <span className="prompt">$ </span>}{text}</pre><Copy text={text} /></div>

// --- the walkthrough: a mock GitHub pull request, one step at a time

type Line = [kind: ' ' | '+' | '-', old: number | '', now: number | '', code: string]
const DIFF: Line[] = [
  [' ', 41, 41, 'export async function checkout(cart: Cart) {'],
  [' ', 42, 42, '  const total = sum(cart.items)'],
  ['-', 43, '', '  if (total > 0) await charge(cart.card, total)'],
  ['+', '', 43, '  if (total <= 0) return { status: "empty" }'],
  ['+', '', 44, '  const fee = cart.express ? EXPRESS_FEE : 0'],
  ['+', '', 45, '  await charge(cart.card, total + fee)'],
  [' ', 44, 46, '  return { status: "paid" }'],
  [' ', 45, 47, '}'],
]

const STEPS: { title: string; text: ReactNode }[] = [
  { title: 'Your agent annotates the PR', text: <>You ask Claude Code, Codex or Cursor to <b>annotate the PR</b>. The skill reads the diff and uploads plain-language notes, plus screenshots, to <b>your</b> Reviews42 server.</> },
  { title: 'A reviewer opens it on GitHub', text: <>The pull request looks the same as always. Nothing was posted to GitHub: <b>no bot comments, no noise</b> in the conversation.</> },
  { title: 'The extension adds the notes', text: <>With the extension connected, a <b>summary box</b> appears above the files and <b>each changed block gets its “why”</b>, right next to the code.</> },
  { title: 'Screenshots and focus mode', text: <>Images open full size with a click. A floating dock keeps the summary at hand, and one switch <b>hides every note</b> when you just want the code.</> },
]

function Terminal() {
  const lines: [string, string][] = [
    ['p', '$ claude "annotate PR #42 with reviews42"'],
    ['o', '· reading the diff: 3 files, 5 changed blocks'],
    ['o', '· tests skipped, screenshot: checkout-after.png'],
    ['a', '✓ uploaded 5 notes + 1 image to reviews42'],
  ]
  return <div className="gh-term">
    {lines.map(([k, t], i) => <div key={i} className={`line ${k}`} style={{ animationDelay: `${0.2 + i * 0.6}s` }}>{t}</div>)}
  </div>
}

function MockPR({ step, hide, setHide }: { step: number; hide: boolean; setHide: (v: boolean) => void }) {
  const notes = step >= 2 && !hide
  return <div className="gh">
    <div className="gh-top">
      <span className="gh-title">Express shipping at checkout <span className="gh-num">#42</span></span>
      <span className="gh-open">Open</span>
    </div>
    <div className="gh-tabs"><span>Conversation</span><span>Commits</span><span className="on">Files changed <i>3</i></span></div>
    {step >= 2 && <div className="r42-box">
      <div className="r42-bar">
        <span className="r42-badge">R42</span><b>Reviews42 · 5 notes</b>
        <button type="button" className={`r42-sw${hide ? '' : ' on'}`} onClick={() => setHide(!hide)} aria-pressed={!hide}><i />notes</button>
      </div>
      {!hide && <div className="r42-sum">
        Adds an <b>express shipping</b> option. Empty carts now stop early instead of charging 0.
        <div className="r42-thumb" title="checkout-after.png"><span>checkout-after.png</span></div>
      </div>}
    </div>}
    <div className="gh-file">
      <div className="gh-fh"><span className="gh-chev">⌄</span> app/checkout.ts <span className="gh-stat">+3 −1</span></div>
      <table>
        <tbody>
          {DIFF.map(([k, a, b, code], i) => <FragmentRow key={i} show={notes && i === 2}>
            <tr className={k === '+' ? 'add' : k === '-' ? 'del' : ''}>
              <td className="n">{a}</td><td className="n">{b}</td><td className="c"><span className="sign">{k}</span>{code}</td>
            </tr>
          </FragmentRow>)}
        </tbody>
      </table>
    </div>
    {step >= 3 && <div className="r42-dock"><span className="r42-badge">R42</span><b>5 notes</b><span className="r42-pill">summary</span><span className="r42-pill">↑</span></div>}
  </div>
}

// the note row sits above the first line of the changed block
function FragmentRow({ show, children }: { show: boolean; children: ReactNode }) {
  return <>
    {show && <tr className="note-row"><td colSpan={3}><div className="r42-note">
      <div className="r42-nh"><span className="r42-badge">R42</span><b>Charge the express fee, stop on empty carts</b><span className="r42-where">line 43–45</span></div>
      <div className="r42-nb">An empty cart used to reach the payment provider with 0. Now it returns early, and express orders pay the extra fee.</div>
    </div></td></tr>}
    {children}
  </>
}

function Walkthrough() {
  const [step, setStep] = useState(0), [paused, setPaused] = useState(false), [hide, setHide] = useState(false)
  useEffect(() => {
    if (paused || matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const t = setTimeout(() => setStep((s) => (s + 1) % STEPS.length), 5200)
    return () => clearTimeout(t)
  }, [step, paused])
  useEffect(() => { if (step !== 3) setHide(false) }, [step])
  return <section className="walk" onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)}>
    <div className="walk-steps" role="tablist">
      {STEPS.map((s, i) => <button key={i} type="button" role="tab" aria-selected={step === i} className={step === i ? 'on' : ''} onClick={() => setStep(i)}>
        <span className="walk-n">0{i + 1}</span>
        <span><b>{s.title}</b><span className="walk-t">{s.text}</span></span>
        {step === i && !paused && <span className="walk-bar" />}
      </button>)}
    </div>
    <div className="walk-stage" aria-live="polite">
      {step === 0 ? <Terminal /> : <MockPR step={step} hide={hide} setHide={setHide} />}
    </div>
  </section>
}

const BENEFITS: [string, string][] = [
  ['review faster', 'Reviewers read why each block changed before reading how. Less back-and-forth, fewer “what does this do?” comments.'],
  ['context from the author', 'The agent that wrote the code explains it while it still remembers why: decisions, trade-offs, what was left out.'],
  ['screenshots in the diff', 'UI changes come with before/after images next to the lines that caused them. No more “can you post a screenshot?”.'],
  ['zero noise on GitHub', 'Nothing is posted to the PR. No bot comments, no notification spam; the notes live beside the diff, only for your team.'],
  ['your server, your data', 'Self-hosted: code context never leaves your infrastructure. Notes expire on their own after 30 days.'],
  ['any agent, any team', 'Claude Code, Codex, Cursor and other Agent Skills tools. Connect several servers in one browser for different teams or clients.'],
]

export function Landing({ signedIn }: { signedIn: boolean }) {
  const origin = location.origin
  const cta = signedIn ? <a href="/dashboard" className="btn primary">open dashboard →</a> : <a href="/login" className="btn primary">sign in →</a>
  return <>
    <section className="lp-hero">
      <div className="lp-tags"><span>free</span><span>self-hosted</span><span>source-available</span><span>no seats, no SaaS</span></div>
      <h1 className="lp-h1">Your agent explains the pull request. <em>Your team reads it on GitHub.</em></h1>
      <p className="lp-lead">Reviews42 lets a coding agent attach plain-language notes and screenshots to the lines it changed. Reviewers see them
        right inside GitHub's diff, through a small browser extension. Nothing is posted to the PR.</p>
      <p>{cta} <a href="#install" className="btn">install in 3 minutes</a></p>
    </section>

    <h2>see it on github</h2>
    <Walkthrough />

    <h2>why developers like it</h2>
    <div className="lp-benefits">
      {BENEFITS.map(([t, d]) => <div key={t} className="card"><h3>{t}</h3><p>{d}</p></div>)}
    </div>

    <h2 id="install">install in 3 minutes</h2>
    <ol className="lp-install">
      <li>
        <div className="lp-step"><span className="lp-time">~1 min</span><b>run the server</b></div>
        <p className="hint">One container with a volume. Free to self-host, also for commercial use (FSL-1.1-ALv2).</p>
        <Code prompt text={'git clone https://github.com/igorkasyanchuk/reviews42 && cd reviews42 && docker build -t reviews42 . \\\n  && docker run -d -p 3000:3000 -v reviews42:/data -e ADMIN_EMAIL=you@company.com reviews42'} />
        <p className="hint">Or any Docker host (Coolify, Dokku, a VPS) from the Dockerfile. The first admin password is printed in the logs.</p>
      </li>
      <li>
        <div className="lp-step"><span className="lp-time">~1 min</span><b>give your agent the skill</b></div>
        <p className="hint">Installs for Claude Code, Codex, Cursor and other Agent Skills tools. Then make a token in settings.</p>
        <Code prompt text={`curl -fsSL ${origin}/install.sh | sh`} />
      </li>
      <li>
        <div className="lp-step"><span className="lp-time">~1 min</span><b>connect the browser extension</b></div>
        <p className="hint">Load it in Chrome, paste your server and token in its popup. Open any annotated PR's “Files changed”.</p>
      </li>
    </ol>
    <p>{cta}</p>
  </>
}
