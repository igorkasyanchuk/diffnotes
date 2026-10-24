import { useState } from 'react'
import { Demo } from './demo.tsx'
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

const BENEFITS: [string, string][] = [
  ['review faster', 'Reviewers read why each block changed before reading how. Less back-and-forth, fewer “what does this do?” comments.'],
  ['context from the author', 'The agent that wrote the code explains it while it still remembers why: decisions, trade-offs, what was left out.'],
  ['screenshots and live demos', 'Images next to the lines that caused them, a before / after slider for UI changes, and small HTML demos you can click, locked in a sandbox.'],
  ['where to look hardest', 'The agent flags the risky parts (money, auth, migrations) and the boring ones. Reviewers get a short list at the top and jump straight there.'],
  ['diagrams in the diff', 'A flow or a state change drawn right above the code that implements it, from a Mermaid flowchart the agent writes. No library, no network.'],
  ['notes that stay true', 'Before every upload the agent checks each note against the current diff; after new commits it fixes or drops stale ones. The author removes any note in place.'],
  ['zero noise in the PR', 'Nothing is posted to the PR. No bot comments, no notification spam; the notes live beside the diff, only for your team.'],
  ['your server, your data', 'Self-hosted: code context never leaves your infrastructure. Notes expire on their own (after 30 days by default).'],
  ['any agent, any team', 'Claude Code, Codex, Cursor and other Agent Skills tools. Connect several servers in one browser for different teams or clients.'],
]

export function Landing({ signedIn }: { signedIn: boolean }) {
  const origin = location.origin
  const cta = signedIn ? <a href="/dashboard" className="btn primary">open dashboard →</a> : <a href="/login" className="btn primary">sign in →</a>
  return <>
    <section className="lp-hero">
      <div className="lp-tags"><span>free</span><span>self-hosted</span><span>open source · MIT</span><span>GitHub · GitLab · Bitbucket</span></div>
      <h1 className="lp-h1">Your agent writes the review notes. <em>Your team reads them right in the diff.</em></h1>
    </section>
    <Demo />
    <section className="lp-after">
      <p className="lp-lead">A coding agent attaches plain-language notes, screenshots and live demos to the lines it changed. Reviewers see them
        right inside the diff on GitHub, GitLab or Bitbucket, through a small browser extension. Nothing is posted to the PR.</p>
      <p>{cta} <a href="#install" className="btn">install in 3 minutes</a></p>
    </section>

    <h2>why developers like it</h2>
    <div className="lp-benefits">
      {BENEFITS.map(([t, d]) => <div key={t} className="card"><h3>{t}</h3><p>{d}</p></div>)}
    </div>

    <h2 id="install">install in 3 minutes</h2>
    <ol className="lp-install">
      <li>
        <div className="lp-step"><span className="lp-time">~1 min</span><b>run the server</b></div>
        <p className="hint">One container with a volume. Free and open source (MIT), also for commercial use.</p>
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
