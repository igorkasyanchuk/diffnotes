import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
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
export const Code = ({ text, prompt, wrap }: { text: string; prompt?: boolean; wrap?: boolean }) =>
  <div className={wrap ? 'code wrap' : 'code'}><pre>{prompt && <span className="prompt">$ </span>}{text}</pre><Copy text={text} /></div>

const BENEFITS: [string, string][] = [
  ['review faster', 'Reviewers read why each block changed before reading how. Less back-and-forth, fewer “what does this do?” comments.'],
  ['context from the author', 'The agent that wrote the code explains it while it still remembers why: decisions, trade-offs, what was left out.'],
  ['screenshots, recordings, demos', 'Images next to the lines that caused them, a before / after slider for UI changes, short screen recordings of a flow, and small HTML demos you can click, locked in a sandbox.'],
  ['where to look hardest', 'The agent flags the risky parts (money, auth, migrations) and the boring ones. Reviewers get a short list at the top and jump straight there.'],
  ['diagrams in the diff', 'A flow or a state change drawn right above the code that implements it, from a Mermaid flowchart the agent writes. No library, no network.'],
  ['notes that stay true', 'Before every upload the agent checks each note against the current diff; after new commits it fixes or drops stale ones, and reviewers see what changed since their last visit.'],
  ['zero noise in the PR', 'Nothing is posted to the PR. No bot comments, no notification spam; the notes live beside the diff, only for your team.'],
  ['your server, your data', 'Use the free server at diffnotes.dev, or run your own and code context never leaves your infrastructure. Notes expire on their own (after a year by default).'],
  ['any agent, any team', 'Claude Code, Codex, Cursor and other Agent Skills tools, or any MCP client. Chrome, Edge, Brave and Arc; connect several servers in one browser for different teams or clients.'],
]

// what to ask a coding agent once the skill is installed (landing and settings, with a copy button)
export const AGENT_PROMPT = 'Use the diffnotes skill to annotate this pull request for its reviewers: explain each changed file and the non-obvious lines in plain language, flag the risky parts (auth, money, migrations), add before / after screenshots of UI changes, then upload the notes to DiffNotes.'

export const STORE = 'https://chromewebstore.google.com/detail/fmnbgmeahjhfakpcmhimjjjplimdiibd'
const MAIN = 'https://diffnotes.dev' // where the README badge links, from every server
const ChromeLogo = () => <svg viewBox="0 0 48 48" width="18" height="18" aria-hidden="true">
  <path fill="#ea4335" d="M24 24 6.68 14A20 20 0 0 1 41.32 14z" /><path fill="#fbbc04" d="M24 24 41.32 14A20 20 0 0 1 24 44z" />
  <path fill="#34a853" d="M24 24 24 44A20 20 0 0 1 6.68 14z" /><circle cx="24" cy="24" r="9.5" fill="#fff" /><circle cx="24" cy="24" r="7.5" fill="#4285f4" /></svg>
export const AddToChrome = ({ primary }: { primary?: boolean }) =>
  <a href={STORE} className={`btn chrome${primary ? ' primary' : ''}`}><ChromeLogo />add to Chrome</a>

// what /api/me says about this server: how long notes live and the per-account limits (the hosted server's box)
export type ServerInfo = { retention_days: number; limits: { account_mb: number; pulls: number; file_mb: number; video_mb: number } }

export function Landing({ signedIn, signup, demo, info }: { signedIn: boolean; signup: boolean; demo: boolean; info?: ServerInfo }) {
  const origin = location.origin
  // the server adds Umami to this page only when it is configured (UMAMI_SCRIPT); one page view, nothing after.
  // The script is deferred and from another host: it can still be loading when this runs, so wait for it then.
  useEffect(() => {
    const w = window as { umami?: { track: () => void } }
    if (w.umami) w.umami.track()
    else document.querySelector('script[data-website-id]')?.addEventListener('load', () => w.umami?.track(), { once: true })
  }, [])
  const cta = signedIn ? <a href="/dashboard" className="btn primary">open dashboard →</a> : <a href="/login" className="btn primary">{signup ? 'create a free account →' : 'sign in →'}</a>
  return <>
    <section className="lp-hero">
      <div className="lp-tags"><span>free</span><span>hosted or self-hosted</span><span>open source · MIT</span><span>GitHub · GitLab · Bitbucket</span></div>
      <h1 className="lp-h1">Your agent explains the pull request. <em>Your team reads it in the diff.</em></h1>
      <div className="lp-quick">{cta}<AddToChrome /></div>
      <p className="hint">{signup && !signedIn ? 'A free account with GitHub, then' : 'Then'} one command sets up Claude Code, Codex, Cursor or any Agent Skills tool, and the extension connects in one click.</p>
      <p className="lp-soon">extension for Chrome, Edge, Brave and Arc · <b>Firefox and Safari: developer install for now</b></p>
      {demo && <p><a href="/demo" className="lp-demo"><span className="pulse" aria-hidden="true" />read a real annotated pull request, no sign-up →</a></p>}
    </section>
    <Demo />
    <section className="lp-after">
      <p className="lp-lead">A coding agent attaches plain-language notes, screenshots and live demos to the lines it changed. Reviewers see them
        right inside the diff on GitHub, GitLab or Bitbucket, through a small browser extension. Nothing is posted to the PR.</p>
      <p>{cta} <a href="#install" className="btn">start in 5 minutes</a></p>
    </section>

    <section className="lp-notbot">
      <h2>not another review bot</h2>
      <p>Review bots read your diff from the outside and post their opinions as PR comments. DiffNotes is the other side: the agent
        that <b>wrote</b> the code explains what it changed and why, while it still knows the intent, the trade-offs and what to test.
        Nothing is posted to the pull request, and it works next to any review bot you already use.</p>
    </section>

    <h2>why developers like it</h2>
    <div className="lp-benefits">
      {BENEFITS.map(([t, d]) => <div key={t} className="card"><h3>{t}</h3><p>{d}</p></div>)}
    </div>

    {/* two separate ways in, each its own panel: this server (most people), or your own (then the same steps) */}
    <section className="lp-path" id="install">
      <div className="lp-path-head"><span className="lp-path-tag">option 1 · on {location.host}</span>
        <h2>start in 5 minutes</h2>
        <p className="hint">Use this server: nothing to install on your side but the skill and the extension.</p>
        {origin === MAIN && info && <p className="hint lp-hosted">diffnotes.dev is run by Igor Kasyanchuk, who wrote DiffNotes. It is free, with
          no paid plan. Notes and files are deleted {info.retention_days} days after a pull request's last upload; each account holds up to{' '}
          {info.limits.pulls.toLocaleString('en-US')} pull requests and {info.limits.account_mb >= 1024 ? `${info.limits.account_mb / 1024} GB` : `${info.limits.account_mb} MB`} of files.
          For code that must not leave your company, self-host it (option 2). <a href="/privacy">Privacy</a>.</p>}</div>
    <ol className="lp-install">
      <li>
        <div className="lp-step"><span className="lp-time">~30 s</span><b>{signedIn ? 'you are signed in' : signup ? 'create a free account' : 'sign in'}</b></div>
        <p className="hint">{signedIn ? 'Good, nothing to do here.' : signup ? 'One click with GitHub: your user and a team account to invite people into.'
          : 'This server is invite-only: ask its admin for an invitation, then sign in.'}</p>
        {!signedIn && <p>{cta}</p>}
      </li>
      <li>
        <div className="lp-step"><span className="lp-time">~1 min</span><b>add the browser extension</b></div>
        <p className="hint">From the Chrome Web Store (Edge, Brave and Arc too). It opens a tab by itself: press <b>Sign in and connect</b>
          {origin !== 'https://diffnotes.dev' && <> with <code>{origin}</code> as the server</>}, then <b>allow</b>. Nothing to copy.</p>
        <p><AddToChrome /></p>
      </li>
      <li>
        <div className="lp-step"><span className="lp-time">~1 min</span><b>set up your agent with one command</b></div>
        <p className="hint">Claude Code, Codex, Cursor and other Agent Skills tools. The <a href="/welcome">setup page</a> gives you the command with your token in it: run it once, no shell profile to edit.</p>
      </li>
      <li>
        <div className="lp-step"><span className="lp-time">~1 min</span><b>ask your agent to explain a PR</b></div>
        <p className="hint">On a pushed branch with an open pull request (GitHub, GitLab or Bitbucket). The agent finds it with <code>gh</code> or
          <code> glab</code>, or asks you for its address. Then open the PR's “Files changed”.</p>
        <Code wrap text={AGENT_PROMPT} />
      </li>
    </ol>
    </section>

    <div className="lp-or"><span>or</span></div>

    <section className="lp-path lp-self" id="self-host">
      <div className="lp-path-head"><span className="lp-path-tag">option 2 · your own server</span>
        <h2>self-host it</h2>
        <p className="hint">Keep code context on your own infrastructure. One container with a volume, free and open source (MIT), also for commercial use.</p></div>
    <Code prompt text={'docker run -d -p 3000:3000 -v diffnotes:/data -e ADMIN_EMAIL=you@company.com \\\n  -e PUBLIC_URL=https://reviews.example.com ghcr.io/igorkasyanchuk/diffnotes'} />
    <p className="hint">Put it behind HTTPS (Caddy, Coolify, Cloudflare…): the extension connects only to https servers (and localhost). Or <code>docker compose up</code>, Coolify, Render, Fly.io, Railway or any Docker host: see the <a href="https://github.com/igorkasyanchuk/diffnotes/blob/main/docs/deploy.md">deploy guides</a>. The first admin password is printed in the logs. Then follow the steps of option 1 with your server's address.</p>
    </section>
    {/* the closing call to action: centred, on its own, after both ways in */}
    <div className="lp-end">
      <p className="lp-lead">{signedIn ? 'Your dashboard has your annotated pull requests and the setup steps.' : 'Free on this server, or on yours. Your agent’s next pull request can carry its notes.'}</p>
      <p>{cta}{demo && <> <a href="/demo" className="btn">see the live demo</a></>}</p>
    </div>
  </>
}

// the live demo (DEMO_PR on the server): what a visitor does to see real notes on a real pull request
export function DemoPage({ signedIn, github, demo, children }: { signedIn: boolean; github: boolean; demo: { url: string; label: string } | null; children?: ReactNode }) {
  if (!demo) return <div className="narrow"><h1>live demo</h1><p className="hint">This server has no live demo.</p></div>
  return <div className="lp-page">
    <h1>live demo</h1>
    <p className="lp-lead">A real pull request in DiffNotes' own repository, explained by Claude Code with the DiffNotes skill: a summary,
      where to look hardest, the deploy steps, a note on each changed block, before / after screenshots and a demo you can click.
      Below is what its reviewers read; with the extension it sits right next to the changed lines on GitHub.</p>
    <p><a href={demo.url} className="btn" target="_blank" rel="noreferrer">{demo.label} on GitHub ↗</a></p>
    {children}
    <h2>see it inside GitHub's diff</h2>
    <ol className="lp-install">
      <li><div className="lp-step"><b>{signedIn ? 'you are signed in' : 'make a free account'}</b></div>
        {signedIn ? <p className="hint">Good, nothing to do here.</p>
          : github ? <p><a href="/auth/github?next=/welcome" className="btn primary">continue with GitHub</a> <span className="hint">one click, no password</span></p>
          : <p className="hint">Ask this server's admin for an invitation, then <a href="/login">sign in</a>.</p>}</li>
      <li><div className="lp-step"><b>add the browser extension</b></div>
        <p><AddToChrome primary={signedIn} /> <span className="hint">Edge, Brave and Arc too. It opens a tab by itself: press <b>Sign in and connect</b>, then <b>allow</b>.</span></p></li>
      <li><div className="lp-step"><b>open the pull request</b></div>
        <p><a href={demo.url} className="btn" target="_blank" rel="noreferrer">{demo.label} →</a></p>
        <p className="hint">The summary box sits above the files and the notes next to the changed lines. Press <kbd>?</kbd> for the keys:
          <kbd>j</kbd> / <kbd>k</kbd> jump between notes, <kbd>n</kbd> hides them.</p></li>
    </ol>
    <p className="hint">This demo is public. Your own pull requests' notes are visible only to your team.</p>
  </div>
}

// "Reviewed with DiffNotes": a badge for READMEs and PR templates, linking to the main site
export function BadgePage() {
  const img = `${MAIN}/badge.svg`, alt = 'Reviewed with DiffNotes'
  return <div className="lp-page">
    <h1>badge</h1>
    <p className="lp-lead">Tell contributors your pull requests come with notes: put the badge in your README or your pull request template.</p>
    <p><a href={MAIN}><img src="/badge.svg" alt={alt} width="150" height="20" /></a></p>
    <h2>Markdown (README, PR template)</h2>
    <Code wrap text={`[![${alt}](${img})](${MAIN})`} />
    <h2>HTML</h2>
    <Code wrap text={`<a href="${MAIN}"><img src="${img}" alt="${alt}"></a>`} />
    <h2>pull request template</h2>
    <p className="hint">In <code>.github/pull_request_template.md</code>, so every PR tells reviewers where the notes are:</p>
    <Code wrap text={`[![${alt}](${img})](${MAIN}) Notes for reviewers are in the diff: open **Files changed** with the DiffNotes extension.`} />
  </div>
}
