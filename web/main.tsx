import { StrictMode, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import '../extension/markdown.js'
import './styles.css'
import { AGENT_PROMPT, AddToChrome, BadgePage, Code, DemoPage, Landing } from './landing.tsx'
import { version } from '../package.json'

declare global {
  var dnMarkdown: (md: string) => string
  var dnDeploy: (md: string) => string
  var dnPreviewUrl: (preview: string, path: string) => string
  var dnPreview: (name: string, text: string) => string
  var dnCompare: (root: ParentNode) => void
  var dnNoteRef: (ref: string, notes: { path: string; line: number | null; end_line: number | null; side: string }[]) => number
}

type User = { id: string; email: string; name: string; admin: number }
type Annotation = { id: number; path: string; line: number | null; end_line: number | null; side: string; title: string; body: string; risk: 'low' | 'medium' | 'high' | null; try?: string | null }
type Pull = { id: string; repository: string; number: number; title: string; head_sha?: string; can_delete?: boolean; can_delete_all?: boolean; summary: string; deploy?: string; preview?: string; stack?: { number: number; title: string; notes: boolean }[]; updated_at: string; expires_at: string; annotations: Annotation[]; authors?: { name: string; avatar: string | null }[]
  files?: { name: string; type: string; size: number; url: string }[] }

async function api<T = any>(url: string, body?: unknown, method = body === undefined ? 'GET' : 'POST'): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`)
  if (method !== 'GET') dispatchEvent(new Event('dn:change')) // App reloads /api/me: sidebar and token bar stay current
  return data
}
// the landing page may carry the analytics script (app.ts page()): leave it with a full load, so it never runs in the app
const tracked = !!document.querySelector('script[data-website-id]')
const go = (to: string) => {
  if (tracked) return location.assign(to)
  history.pushState(null, '', to)
  dispatchEvent(new PopStateEvent('popstate'))
}
const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '—')
// owner/name is GitHub; host/path is Bitbucket on bitbucket.org, GitLab anywhere else (gitlab.com or self-hosted)
const host = (repo: string) => repo.split('/')[0].includes('.') ? repo.split('/')[0] : 'github.com'
const forge = (repo: string) => ({ 'github.com': 'github', 'bitbucket.org': 'bitbucket' })[host(repo)] ?? 'gitlab'
const repoUrl = (repo: string) => `https://${host(repo) === 'github.com' ? `github.com/${repo}` : repo}`
const prUrl = (repo: string, n: number) => `${repoUrl(repo)}${{ github: `/pull/${n}/changes`, bitbucket: `/pull-requests/${n}/diff`, gitlab: `/-/merge_requests/${n}/diffs` }[forge(repo)]}`

const bytes = (n: number) => {
  const u = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++ }
  return `${i ? n.toFixed(1) : n} ${u[i]}`
}
const Link = ({ to, children, className }: { to: string; children: ReactNode; className?: string }) =>
  <a href={to} className={className} onClick={(e) => { if (!e.metaKey && !e.ctrlKey) { e.preventDefault(); go(to) } }}>{children}</a>
// Markdown, cut to a few lines when long with a show more / less toggle (re-measured when images load)
function Md({ text, deploy }: { text: string; deploy?: boolean }) {
  const ref = useRef<HTMLDivElement>(null), [long, setLong] = useState(false), [open, setOpen] = useState(false)
  // once per text, not on every show more / less: the same string keeps React off the HTML, so what dnCompare added stays
  const html = useMemo(() => (deploy ? dnDeploy : dnMarkdown)(text), [text, deploy])
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    dnCompare(el) // before / after image pairs get a drag handle
    const measure = () => setLong(el.scrollHeight > 280)
    const ro = new ResizeObserver(measure)
    ro.observe(el.firstElementChild ?? el)
    measure()
    return () => ro.disconnect()
  }, [text])
  return <>
    <div ref={ref} className={`md${long && !open ? ' clamped' : ''}`}><div dangerouslySetInnerHTML={{ __html: html }} /></div>
    {long && <button type="button" className="link more" onClick={() => setOpen(!open)}>{open ? 'show less ↑' : 'show more ↓'}</button>}
  </>
}

// Gallery for every image in a note, the summary or the attachments: click one, ← → to move, Esc to close
function Gallery() {
  const [g, setG] = useState<{ imgs: { src: string; alt: string }[]; i: number } | null>(null)
  useEffect(() => {
    const click = (e: MouseEvent) => {
      const img = (e.target as HTMLElement).closest?.('.md img, .file-card img') as HTMLImageElement | null
      if (!img || img.closest('.gallery')) return
      e.preventDefault()
      const group = [...(img.closest('.note, .card, .files') ?? document).querySelectorAll<HTMLImageElement>('.md img, .file-card img')]
      setG({ imgs: group.map((x) => ({ src: x.src, alt: x.alt })), i: Math.max(0, group.indexOf(img)) })
    }
    document.addEventListener('click', click)
    return () => document.removeEventListener('click', click)
  }, [])
  useEffect(() => {
    if (!g) return
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setG(null)
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') setG({ ...g, i: (g.i + (e.key === 'ArrowRight' ? 1 : -1) + g.imgs.length) % g.imgs.length })
    }
    addEventListener('keydown', key)
    return () => removeEventListener('keydown', key)
  }, [g])
  if (!g) return null
  const move = (d: number) => (e: React.MouseEvent) => { e.stopPropagation(); setG({ ...g, i: (g.i + d + g.imgs.length) % g.imgs.length }) }
  const cur = g.imgs[g.i]
  return <div className="gallery" role="dialog" aria-label="Image gallery" onClick={() => setG(null)}>
    <img src={cur.src} alt={cur.alt} onClick={g.imgs.length > 1 ? move(1) : undefined} />
    <div className="cap">{cur.alt || 'image'}{g.imgs.length > 1 && ` · ${g.i + 1} / ${g.imgs.length}`}</div>
    {g.imgs.length > 1 && <>
      <button type="button" className="nav prev" aria-label="Previous image" onClick={move(-1)}>‹</button>
      <button type="button" className="nav next" aria-label="Next image" onClick={move(1)}>›</button>
    </>}
  </div>
}

// An uploaded HTML demo: the server sends it with a CSP that sandboxes it (opaque origin, no cookies, no network);
// the iframe's own sandbox repeats that. Expand opens it large, at phone, tablet or desktop width.
function Demo({ f }: { f: { name: string; url: string } }) {
  const [big, setBig] = useState(false), [w, setW] = useState('100%')
  const frame = (cls: string) => <iframe className={cls} src={f.url} title={f.name} sandbox="allow-scripts" referrerPolicy="no-referrer" style={{ width: cls === 'demo-big' ? w : undefined }} />
  useEffect(() => {
    if (!big) return
    const key = (e: KeyboardEvent) => e.key === 'Escape' && setBig(false)
    addEventListener('keydown', key)
    return () => removeEventListener('keydown', key)
  }, [big])
  return <>
    <div className="demo-bar"><span>live demo · sandboxed</span><button type="button" className="btn small" onClick={() => setBig(true)}>expand ⤢</button></div>
    {frame('demo-frame')}
    {big && <div className="demo-modal" role="dialog" aria-label={f.name} onClick={() => setBig(false)}>
      <div className="demo-box" onClick={(e) => e.stopPropagation()}>
        <div className="demo-head"><b>{f.name}</b>{[['mobile', '390px'], ['tablet', '768px'], ['desktop', '100%']].map(([l, x]) =>
          <button key={l} type="button" className={`btn small${w === x ? ' primary' : ''}`} onClick={() => setW(x)}>{l}</button>)}
          <button type="button" className="btn small" onClick={() => setBig(false)} aria-label="Close">✕</button></div>
        <div className="demo-stage">{frame('demo-big')}</div>
      </div>
    </div>}
  </>
}

// an attached md, csv or txt file, fetched and rendered like the extension does
function Attachment({ f }: { f: { name: string; type: string; size: number; url: string } }) {
  const [html, setHtml] = useState<string>()
  useEffect(() => {
    // only text: files uploaded before the allow-list (svg) are listed as application/octet-stream
    if (f.type.startsWith('text/') && f.type !== 'text/html') fetch(f.url).then((r) => (r.ok ? r.text() : Promise.reject())).then((t) => setHtml(dnPreview(f.name, t)), () => setHtml('<p>could not load</p>'))
  }, [f.url])
  return <div className="file-card">
    <div className="where"><a href={f.url} target="_blank" rel="noreferrer">{f.name}</a> · {bytes(f.size)}</div>
    {f.type.startsWith('image/') ? <img src={f.url} alt={f.name} />
      : f.type.startsWith('video/') ? <video src={f.url} controls muted playsInline preload="metadata" />
      : f.type === 'text/html' ? <Demo f={f} />
      : html !== undefined && <div className="md preview" dangerouslySetInnerHTML={{ __html: html }} />}
  </div>
}
// who wrote it: their GitHub photo (src: served by this server, app.ts AVATAR), else initials on a colour of their own
const Avatar = ({ name, src }: { name: string; src?: string | null }) => {
  const [broken, setBroken] = useState(false)
  if (src && !broken) return <img className="avatar" src={src} alt="" title={name} loading="lazy" onError={() => setBroken(true)} />
  const initials = name.replace(/@.*/, '').split(/[\s._-]+/).filter(Boolean).slice(0, 2).map((w) => [...w][0]).join('').toUpperCase() || '?'
  let h = 0
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) % 360
  return <span className="avatar" style={{ '--h': h } as React.CSSProperties} title={name} aria-hidden="true">{initials}</span>
}
const Author = ({ name, avatar }: { name: string | null | undefined; avatar?: string | null }) =>
  name ? <span className="author"><Avatar name={name} src={avatar} /><span className="author-name">{name}</span></span> : <span className="hint">—</span>
const Stat = ({ label, value }: { label: string; value: ReactNode }) => <div className="stat"><b>{value}</b><span>{label}</span></div>

function useLoad<T>(url: string) {
  const [data, setData] = useState<T>(), [error, setError] = useState(''), [n, setN] = useState(0)
  // live: a slower answer for an older url (the dashboard's pages) never replaces a newer one
  useEffect(() => {
    let live = true
    api<T>(url).then((d) => { if (live) setData(d) }, (e) => { if (live) setError(e.message) })
    return () => { live = false }
  }, [url, n])
  return { data, error, reload: () => setN((x) => x + 1) }
}

// what just happened (saved, copied, removed, or why not), for a few seconds at the bottom of the screen
const toast = (text: string, bad = false) => dispatchEvent(new CustomEvent('dn:toast', { detail: { text, bad } }))
function Toaster() {
  const [t, setT] = useState<{ text: string; bad: boolean } | null>(null)
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const on = (e: Event) => { setT((e as CustomEvent).detail); clearTimeout(timer); timer = setTimeout(() => setT(null), 3000) }
    addEventListener('dn:toast', on)
    return () => { removeEventListener('dn:toast', on); clearTimeout(timer) }
  }, [])
  return <div className={`toast${t ? ' on' : ''}${t?.bad ? ' bad' : ''}`} role="status" aria-live="polite">{t?.text}</div>
}
// navigator.clipboard is undefined on plain-http origins (a self-hosted server on a LAN address) and Safari refuses it
// after an await: the link isn't on the page, so it shows in a prompt to copy by hand
const copy = async (text: string, what: string) => {
  try { await navigator.clipboard.writeText(text); toast(`${what} ✓`) } catch { prompt('Copy the link:', text) }
}

// a form whose submit calls fn and shows its error; `done` is said once it worked
function useSubmit(fn: () => Promise<unknown>, done?: string) {
  const [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const submit = async (e?: FormEvent) => {
    e?.preventDefault(); setBusy(true); setError('')
    try { await fn(); if (done) toast(done) } catch (err) { setError((err as Error).message) } finally { setBusy(false) }
  }
  return { submit, error, busy }
}

type SignIn = { github: boolean; signup: boolean; demo: { repository: string; number: number } | null } // what /api/me says this server offers besides a password
type Setup = { agent: boolean; extension: boolean; notes: boolean }
type Me = SignIn & { user: User; accounts: { id: string; name: string; role: string }[]; has_password: boolean; setup: Setup }

const Brand = () => <Link to="/" className="brand"><img src="/icon.svg" alt="" />diffnotes<span className="cursor">_</span></Link>
const SOURCE = 'https://github.com/igorkasyanchuk/diffnotes'
const GitHubMark = ({ size = 16 }: { size?: number }) => <svg viewBox="0 0 16 16" width={size} height={size} aria-hidden="true"><path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" /></svg>
const Footer = () => <footer className="foot">
  <span>diffnotes {version} · self-hosted PR annotations · MIT</span>
  <a href="/skill/SKILL.md">agent skill</a>
  <Link to="/demo">demo</Link>
  <Link to="/badge">badge</Link>
  <Link to="/privacy">privacy</Link>
  <a href={SOURCE} target="_blank" rel="noreferrer">source</a>
</footer>

// public pages: landing, sign in, invitations
function PublicLayout({ signedIn, signup, demo, children }: { signedIn: boolean; signup: boolean; demo: boolean; children: ReactNode }) {
  return <>
    <header className="top">
      <Brand />
      <nav>
        {demo && <Link to="/demo" className="btn demo-link"><span className="pulse" aria-hidden="true" />live demo</Link>}
        <a href={SOURCE} target="_blank" rel="noreferrer" className="btn gh" aria-label="DiffNotes on GitHub">
          <GitHubMark />
          <span>GitHub</span>
        </a>
        {signedIn ? <Link to="/dashboard" className="btn primary">dashboard →</Link> : <Link to="/login" className="btn primary">sign in{signup && <span className="wide"> / sign up</span>}</Link>}
      </nav>
    </header>
    <main>{children}</main>
    <Footer />
  </>
}

// signed-in pages: a sidebar with the dashboard, your accounts, settings and (super admins) the server page
function AppLayout({ me, path, children }: { me: Me; path: string; children: ReactNode }) {
  const logout = async () => { await api('/api/logout', {}); location.href = '/' }
  const on = (p: string) => (path === p || path.startsWith(`${p}/`) ? 'on' : undefined)
  const setupN = setupDone(me).length
  return <div className="app">
    <aside className="side">
      <Brand />
      <nav>
        <Link to="/dashboard" className={on('/dashboard')}>dashboard</Link>
        <span className="side-h">accounts</span>
        {me.accounts.map((a) => <Link key={a.id} to={`/accounts/${a.id}`} className={on(`/accounts/${a.id}`)}>{a.name}</Link>)}
        <span className="side-h">you</span>
        {setupN < 3 && <Link to="/welcome" className={on('/welcome')}>setup <span className="chip hot">{setupN}/3</span></Link>}
        <Link to="/settings" className={on('/settings')}>settings</Link>
        {!!me.user.admin && <Link to="/admin" className={on('/admin')}>server admin</Link>}
        <button className="link" onClick={logout}>logout</button>
      </nav>
      <div className="side-me hint">{me.user.email}</div>
    </aside>
    <div className="app-main">
      {setupN < 3 && path !== '/welcome' && <div className="nag">
        <span><b>finish setting up:</b> {setupN} of 3 steps done (agent, browser extension, first notes).</span>
        <span><Link to="/welcome" className="btn primary">continue setup →</Link>{' '}
          <button type="button" className="link" onClick={() => { markSetup(me, STEPS); toast('setup hidden: the steps stay linked from settings') }}>I'm set up, hide this</button></span>
      </div>}
      <main>{children}</main>
      <Footer />
    </div>
  </div>
}

const GitHubButton = ({ next, children }: { next?: string; children: ReactNode }) =>
  <a className="btn gh-signin" href={`/auth/github${next ? `?next=${encodeURIComponent(next)}` : ''}`}><GitHubMark size={18} />{children}</a>

function Login({ sign }: { sign: SignIn }) {
  const [email, setEmail] = useState(''), [password, setPassword] = useState('')
  const back = new URLSearchParams(location.search).get('error') // GitHub sign-in sends its refusals here
  // api() fires dn:change, so App reloads /api/me and shows the app page in place (a deep link opened signed out);
  // only /login needs to move on, to the dashboard
  const { submit, error, busy } = useSubmit(async () => {
    const r = await api<{ next?: string }>('/api/login', { email, password })
    if (location.pathname === '/login') go(r.next ?? '/dashboard') // next: a GitHub sign-in's (an invitation) the password just linked
  })
  return <div className="narrow">
    <h1>{sign.signup ? 'sign in or create an account' : 'sign in'}</h1>
    {sign.github && <div className="stack">
      <GitHubButton next={location.pathname === '/login' ? undefined : location.pathname + location.search}>continue with GitHub</GitHubButton>
      {sign.signup && <p className="hint"><b>No account yet?</b> This button creates one for free: your user and a team account, in one step.</p>}
      {back && <div className="error">{back}</div>}
      <div className="or">or with email</div>
    </div>}
    <form className="stack" onSubmit={submit}>
      <label>email<input autoFocus autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} /></label>
      <label>password<input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} /></label>
      {error && <div className="error">{error}</div>}
      <button className="primary" disabled={busy}>{busy ? 'signing in…' : 'sign in'}</button>
      <p className="hint">{!sign.signup && <>No account? Ask a teammate for an invitation link.<br /></>}
        Forgot your password? Your server admin runs <code>npm run reset-password</code>.</p>
    </form>
  </div>
}

function Invite({ token, sign }: { token: string; sign: SignIn }) {
  const { data, error: loadError } = useLoad<{ email: string; github: string | null; open: boolean; expires_at: string; account: string
    by: string | null; role: string; exists: boolean; signed_in: boolean }>(`/api/invites/${token}`)
  const [name, setName] = useState(''), [password, setPassword] = useState(''), [email, setEmail] = useState('')
  // joined: the setup steps next (they show what is done already, so existing users see they're set)
  const { submit, error, busy } = useSubmit(async () => {
    await api(`/api/invites/${token}/accept`, { name, password, email }); location.href = `/welcome?joined=${encodeURIComponent(data?.account ?? '')}`
  })
  if (loadError) return <div className="narrow"><h1>invitation</h1><p className="error">{loadError}</p>
    <p className="hint">Invitations work once (open links until they expire). Ask whoever invited you for a new one.</p></div>
  if (!data) return null
  const intro = <div className="invite-intro">
    <p><b>{data.by ?? 'A teammate'}</b> invited you to <b>{data.account}</b>{data.role === 'admin' && ' as an admin'}.</p>
    <p className="hint">DiffNotes puts your coding agent's notes next to the changed lines of your pull requests, where your team reads them.
      After joining, a short setup (about 5 minutes) connects your agent and your browser.</p>
  </div>
  // an open link: anyone joins, signed in already or with an email (a new user, or an existing one with its password)
  if (data.open) return <div className="narrow">
    <h1>join {data.account}</h1>
    {intro}
    <p className="hint">Anyone with this link can join as a member until {new Date(data.expires_at).toLocaleString()}.</p>
    {/* with GitHub on, new people join with GitHub (it proves their email); the form is for existing users */}
    {!data.signed_in && sign.github && <><p><GitHubButton next={`/invite/${token}`}>continue with GitHub</GitHubButton></p>
      <div className="or">or with your DiffNotes email and password</div></>}
    <form className="stack" onSubmit={submit}>
      {!data.signed_in && <>
        <label>email<input type="email" autoComplete="email" autoFocus value={email} onChange={(e) => setEmail(e.target.value)} /></label>
        {!sign.github && <label>your name <span className="hint">(new users)</span><input value={name} onChange={(e) => setName(e.target.value)} /></label>}
        <label>password <span className="hint">{sign.github ? '' : '(yours, or a new one with 8+ characters)'}</span>
          <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} /></label>
      </>}
      {error && <div className="error">{error}</div>}
      <button className="primary" disabled={busy}>{busy ? 'joining…' : 'join'}</button>
    </form>
  </div>
  // an invite by GitHub login: only a GitHub sign-in as that login joins
  if (data.github) return <div className="narrow">
    <h1>join {data.account}</h1>
    {intro}
    <p className="hint">Invitation for GitHub user @{data.github}.{data.signed_in && ' You are signed in as this user.'}</p>
    {data.signed_in
      ? <form className="stack" onSubmit={submit}>{error && <div className="error">{error}</div>}<button className="primary" disabled={busy}>{busy ? 'joining…' : 'join'}</button></form>
      : sign.github ? <p><GitHubButton next={`/invite/${token}`}>continue with GitHub</GitHubButton></p>
        : <p className="error">GitHub sign-in is off on this server: ask for an invitation by email.</p>}
  </div>
  return <div className="narrow">
    <h1>join {data.account}</h1>
    {intro}
    <p className="hint">Invitation for {data.email}.{data.signed_in ? ' You are signed in as this user.'
      : data.exists && ' You already have an account: enter your password to join.'}</p>
    {sign.github && !data.signed_in && <p><GitHubButton next={`/invite/${token}`}>continue with GitHub</GitHubButton>
      <span className="hint"> if {data.email} is an email of your GitHub account</span></p>}
    <form className="stack" onSubmit={submit}>
      {!data.exists && <label>your name<input autoFocus value={name} onChange={(e) => setName(e.target.value)} /></label>}
      {!data.signed_in && <label>{data.exists ? 'password' : 'choose a password (8+ characters)'}
        <input type="password" autoComplete={data.exists ? 'current-password' : 'new-password'} value={password} onChange={(e) => setPassword(e.target.value)} /></label>}
      {error && <div className="error">{error}</div>}
      <button className="primary" disabled={busy}>{busy ? 'joining…' : 'join'}</button>
    </form>
  </div>
}

// the privacy policy (also the Chrome Web Store listing's): what the extension and a DiffNotes server keep, and who sees it
function Privacy() {
  return <div style={{ maxWidth: 680 }}>
    <h1>privacy</h1>
    <p className="hint">DiffNotes browser extension and DiffNotes servers. Last updated October 2026.</p>
    <h2>The browser extension</h2>
    <ul>
      <li>It stores, in your browser only (<code>chrome.storage.local</code>), the addresses of the DiffNotes servers you connect and the
        access token you paste for each, plus which notes you folded, whether notes are switched off, how notes look, and, for pull requests with notes you
        opened in the last 60 days, their repository and number with hashes of the notes it showed, to mark the ones changed since. Removing a server in its popup deletes its token.</li>
      <li>It talks only to the servers you connect. On a GitHub, GitLab or Bitbucket pull request page it sends that server the
        repository and pull request number, with your token, to fetch the notes your team uploaded, and it downloads their attached files.
        When you remove a note (only offered to its author and account admins), it asks that server to delete it.</li>
      <li>It reads the pull request page only to place notes next to the changed lines. It does not send page contents, code, your
        browsing history or anything else anywhere.</li>
      <li>It has no analytics, no tracking, no ads and no third-party code, and it sells or shares nothing.</li>
    </ul>
    <h2>A DiffNotes server</h2>
    <ul>
      <li>Each server is run by whoever installed it (your company, your team, you). It keeps user accounts (email, name, password hash, and the GitHub user id when you sign in with GitHub; the server then fetches your GitHub photo itself, to show to your teammates),
        sessions, token hashes, and the notes and files your agents upload, which are deleted after the retention period (365 days by default).
        Its operator decides where it runs and who can access it.</li>
      <li>Notes and files are visible only to members of the account that owns the repository, except a live-demo pull request
        the server's operator may set (<code>DEMO_PR</code>), readable by everyone signed in to that server.</li>
      <li>The app's pages load nothing from third parties. The operator may enable Umami analytics on the landing page (<code>/</code>) only:
        one anonymous page view, never on the app's pages. Errors may be reported to the operator's own error tracker with the route pattern only.</li>
    </ul>
    <h2>Contact</h2>
    <p>Questions or requests: open an issue at <a href={`${SOURCE}/issues`} target="_blank" rel="noreferrer">{SOURCE.replace('https://', '')}/issues</a>,
      or contact the operator of your DiffNotes server about the data it holds.</p>
  </div>
}

// one grid for every row (.pulls in styles.css): repository, title, uploader, notes, date and link line up as columns
const PullList = ({ pulls }: { pulls: (Pull & { annotations: number; uploader?: string | null; uploader_avatar?: string | null })[] }) =>
  <div className="list pulls">
    {pulls.length ? pulls.map((p) => <div key={p.id}>
      <span className="mono hint">{p.repository}#{p.number}</span>
      <span className="grow"><Link to={`/pulls/${p.id}`}>{p.title || 'untitled'}</Link></span>
      <Author name={p.uploader} avatar={p.uploader_avatar} />
      <span className="chip hot">{p.annotations} notes</span>
      <span className="hint">{fmt(p.updated_at)}</span>
      <a href={prUrl(p.repository, p.number)} target="_blank" rel="noreferrer">{forge(p.repository)} ↗</a>
    </div>) : <div className="empty">nothing yet. the <Link to="/welcome">setup steps</Link> get your agent annotating pull requests in about 5 minutes.</div>}
  </div>

type Dash = { accounts: { id: string; name: string; role: string }[]; pulls: (Pull & { annotations: number; uploader: string | null; uploader_avatar: string | null })[]; retention_days: number
  total: number; page: number; per_page: number; invites: { token: string; account: string; role: string }[] }
function Dashboard() {
  const urlPage = () => Math.max(1, Number(new URLSearchParams(location.search).get('page')) || 1)
  const [page, setPage] = useState(urlPage)
  // the sidebar's dashboard link and back / forward keep this page mounted: follow the address
  useEffect(() => { const on = () => setPage(urlPage()); addEventListener('popstate', on); return () => removeEventListener('popstate', on) }, [])
  const { data, reload } = useLoad<Dash>(`/api/dashboard?page=${page}`)
  // ?page=N in the address, so back and a reload stay on it
  const turn = (n: number) => { setPage(n); history.replaceState(null, '', n > 1 ? `?page=${n}` : location.pathname); scrollTo(0, 0) }
  const [name, setName] = useState('')
  const { submit, error, busy } = useSubmit(async () => { await api('/api/accounts', { name }); setName(''); reload() }, 'account created')
  if (!data) return null
  return <>
    <h1>dashboard</h1>
    {!!data.invites.length && <>
      <h2>invitations for you</h2>
      <div className="list">
        {data.invites.map((i) => <div key={i.token}>
          <span className="grow">{i.account}</span><span className="chip">{i.role}</span>
          <Link to={`/invite/${i.token}`}>join →</Link>
        </div>)}
      </div>
    </>}
    <h2>annotated pull requests{data.total > 0 && <span className="count"> · {data.total}</span>}</h2>
    <PullList pulls={data.pulls} />
    {data.total > data.per_page && <div className="pager">
      <button type="button" disabled={data.page <= 1} onClick={() => turn(data.page - 1)}>← newer</button>
      <span className="hint">page {data.page} of {Math.ceil(data.total / data.per_page)}</span>
      <button type="button" disabled={data.page * data.per_page >= data.total} onClick={() => turn(data.page + 1)}>older →</button>
    </div>}
    <p className="hint">notes are kept for {data.retention_days} days after the last upload.</p>
    <h2>accounts</h2>
    <div className="list">
      {data.accounts.map((a) => <div key={a.id}>
        <span className="grow"><Link to={`/accounts/${a.id}`}>{a.name}</Link></span><span className={`chip${a.role === 'member' ? '' : ' hot'}`}>{a.role}</span>
      </div>)}
    </div>
    <form className="row" onSubmit={submit}>
      <input placeholder="new account (team) name" value={name} onChange={(e) => setName(e.target.value)} />
      <button disabled={busy}>{busy ? 'creating…' : 'create'}</button>
    </form>
    {error && <div className="error">{error}</div>}
  </>
}

type Acc = {
  account: { id: string; name: string }; role: string
  members: { id: string; email: string; name: string; role: string; avatar: string | null }[]
  repositories: { id: string; full_name: string; pulls: number; rules: Rules }[]
  invites: { token: string; email: string; github: string | null; open: number; role: string; expires_at: string }[]
}
type Overview = {
  totals: Record<'members' | 'admins' | 'invites' | 'repositories' | 'pulls' | 'annotations' | 'files' | 'bytes' | 'expiring_soon', number>
  retention_days: number
  repositories: { repository: string; pulls: number; annotations: number; files: number; bytes: number }[]
  recent: (Pull & { annotations: number; uploader: string | null; uploader_avatar: string | null; files: number; bytes: number })[]
}
const TABS = ['overview', 'members', 'repositories', 'settings'] as const
function Account({ id, user }: { id: string; user: User }) {
  const { data, error: loadError, reload } = useLoad<Acc>(`/api/accounts/${id}`)
  const [tab, setTab] = useState<(typeof TABS)[number]>(() => (TABS as readonly string[]).includes(location.hash.slice(1)) ? location.hash.slice(1) as 'overview' : 'overview')
  const pick = (t: (typeof TABS)[number]) => { setTab(t); history.replaceState(null, '', `#${t}`) }
  if (loadError) return <p className="error">{loadError}</p>
  if (!data) return null
  const admin = data.role === 'owner' || data.role === 'admin'
  const shown = tab === 'settings' && !admin ? 'overview' : tab // #settings from an admin's link, opened by a member
  return <>
    <div className="head"><h1>{data.account.name}</h1><span className="chip hot">{data.role}</span></div>
    <div className="tabs">
      {TABS.filter((t) => t !== 'settings' || admin).map((t) => <button key={t} className={shown === t ? 'on' : ''} onClick={() => pick(t)}>{t}</button>)}
    </div>
    {shown === 'overview' && <AccountOverview id={id} />}
    {shown === 'members' && <Members id={id} data={data} admin={admin} user={user} reload={reload} />}
    {shown === 'repositories' && <Repositories id={id} data={data} admin={admin} reload={reload} />}
    {shown === 'settings' && <AccountSettings id={id} data={data} user={user} reload={reload} />}
  </>
}

function AccountOverview({ id }: { id: string }) {
  const { data } = useLoad<Overview>(`/api/accounts/${id}/overview`)
  if (!data) return null
  const t = data.totals, max = Math.max(1, ...data.repositories.map((r) => r.bytes))
  return <>
    <div className="stats">
      <Stat label="members" value={t.members} />
      <Stat label="admins" value={t.admins} />
      <Stat label="repositories" value={t.repositories} />
      <Stat label="annotated PRs" value={t.pulls} />
      <Stat label="notes" value={t.annotations} />
      <Stat label="files" value={t.files} />
      <Stat label="storage" value={bytes(t.bytes)} />
      <Stat label="expire in 7 days" value={t.expiring_soon} />
    </div>
    <p className="hint">uploads are kept {data.retention_days} days after the last one, then deleted with their files.</p>
    <h2>storage by repository</h2>
    {data.repositories.length ? <div className="scroll"><table className="grid">
      <thead><tr><th>repository</th><th className="num">PRs</th><th className="num">notes</th><th className="num">files</th><th className="num">size</th><th style={{ width: '30%' }} /></tr></thead>
      <tbody>{data.repositories.map((r) => <tr key={r.repository}>
        <td>{r.repository}</td><td className="num">{r.pulls}</td><td className="num">{r.annotations}</td><td className="num">{r.files}</td>
        <td className="num">{bytes(r.bytes)}</td><td><div className="meter"><i style={{ width: `${(r.bytes / max) * 100}%` }} /></div></td>
      </tr>)}</tbody>
    </table></div> : <div className="list"><div className="empty">no repositories yet</div></div>}
    <h2>latest uploads</h2>
    {data.recent.length ? <div className="scroll"><table className="grid fit">
      <thead><tr><th>pull request</th><th>by</th><th className="num">notes</th><th className="num">files</th><th className="num">size</th><th>updated</th><th>expires</th></tr></thead>
      <tbody>{data.recent.map((p) => <tr key={p.id}>
        <td className="wrap"><Link to={`/pulls/${p.id}`}>{p.repository}#{p.number}</Link><div className="hint">{p.title}</div></td>
        <td className="wrap"><Author name={p.uploader} avatar={p.uploader_avatar} /></td><td className="num">{p.annotations}</td><td className="num">{p.files}</td><td className="num">{bytes(p.bytes)}</td>
        <td>{fmt(p.updated_at)}</td><td>{fmt(p.expires_at)}</td>
      </tr>)}</tbody>
    </table></div> : <div className="list"><div className="empty">{t.pulls ? 'shown to the account\'s members only' : 'no uploads yet'}</div></div>}
  </>
}

type TabProps = { id: string; data: Acc; admin: boolean; reload: () => void }
// a refusal (403 once a role changed, 404 already gone) is said, not dropped as an unhandled rejection
const del = async (url: string, reload: () => void, what = 'Are you sure?', done = 'removed') => {
  if (!confirm(what)) return
  try { await api(url, undefined, 'DELETE'); toast(done); reload() } catch (e) { toast((e as Error).message, true) }
}

// a search box and a role picker over a list of people: name and email match any case, every word of the query
const matches = (q: string, ...fields: string[]) => q.toLowerCase().split(/\s+/).filter(Boolean).every((w) => fields.some((f) => f.toLowerCase().includes(w)))
function Filter({ q, setQ, roles, role, setRole, found, of }: { q: string; setQ: (q: string) => void; roles: string[]; role: string; setRole: (r: string) => void; found: number; of: number }) {
  return <div className="filter">
    <input type="search" placeholder="filter by name or email" value={q} onChange={(e) => setQ(e.target.value)} aria-label="filter by name or email" />
    <select value={role} onChange={(e) => setRole(e.target.value)} aria-label="role"><option value="">every role</option>{roles.map((r) => <option key={r}>{r}</option>)}</select>
    {(q || role) && <span className="hint">{found} of {of}</span>}
  </div>
}

function Members({ id, data, admin, user, reload }: TabProps & { user: User }) {
  const [email, setEmail] = useState(''), [role, setRole] = useState('member'), [err, setErr] = useState(''), [minutes, setMinutes] = useState('60')
  const link = (token: string) => `${location.origin}/invite/${token}`
  // an address, or a GitHub login (with or without @)
  const invite = useSubmit(async () => {
    const who = email.trim(), byLogin = !who.includes('@') || who.startsWith('@')
    const { token } = await api(`/api/accounts/${id}/invites`, { ...(byLogin ? { github: who } : { email: who }), role }); setEmail(''); reload()
    if (byLogin) toast(`invited @${who.replace(/^@/, '')}: they join after signing in with GitHub`)
    else await copy(link(token), `invitation for ${who} created, link copied`)
  })
  // an open link: anyone who has it joins as a member until it expires
  const open = useSubmit(async () => {
    const { token } = await api(`/api/accounts/${id}/invites`, { open: true, minutes: Number(minutes) }); reload()
    await copy(link(token), 'open link created and copied')
  })
  const change = async (m: string, next: string) => {
    setErr('')
    try { await api(`/api/accounts/${id}/members/${m}`, { role: next }, 'PUT'); toast(`role changed to ${next}`); reload() } catch (e) { setErr((e as Error).message) }
  }
  const [q, setQ] = useState(''), [only, setOnly] = useState('')
  // the filter shows from two members up; below that it doesn't apply (a filter left set can't hide the last one)
  const shown = data.members.length > 1 ? data.members.filter((m) => (!only || m.role === only) && matches(q, m.name, m.email)) : data.members
  return <>
    {data.members.length > 1 && <Filter q={q} setQ={setQ} roles={['owner', 'admin', 'member']} role={only} setRole={setOnly} found={shown.length} of={data.members.length} />}
    <div className="list">
      {!shown.length && <div className="empty">no member matches</div>}
      {shown.map((m) => <div key={m.id}>
        <span className="grow author"><Avatar name={m.name || m.email} src={m.avatar} />{m.name || m.email} <span className="hint">{m.name && m.email}</span></span>
        {admin && m.role !== 'owner' && m.id !== user.id
          ? <select className="inline" value={m.role} onChange={(e) => change(m.id, e.target.value)}><option>admin</option><option>member</option></select>
          : <span className={`chip${m.role === 'member' ? '' : ' hot'}`}>{m.role}</span>}
        {admin && m.role !== 'owner' && m.id !== user.id && <button className="link danger" onClick={() => del(`/api/accounts/${id}/members/${m.id}`, reload, `Remove ${m.email}?`)}>remove</button>}
      </div>)}
    </div>
    {err && <div className="error">{err}</div>}
    <p className="hint">owner: made the account · admin: invites people, manages members and repositories · member: reads, uploads and removes their own notes</p>
    {/* a super admin outside the account manages it but can't invite (the server refuses) */}
    {admin && data.members.some((m) => m.id === user.id) && <>
      <h2>invitations</h2>
      {!!data.invites.length && <div className="list">
        {data.invites.map((i) => <div key={i.token}>
          <span className="grow">{i.open ? 'anyone with the link' : i.github ? `@${i.github}` : i.email} <span className="hint">
            {i.github && 'pending GitHub sign-in · '}until {i.open ? new Date(i.expires_at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : fmt(i.expires_at)}</span></span>
          <span className={`chip${i.open ? ' hot' : ''}`}>{i.open ? 'open link' : i.role}</span>
          <button className="link" onClick={() => copy(link(i.token), 'invitation link copied')}>copy link</button>
          <button className="link danger" onClick={() => del(`/api/accounts/${id}/invites/${i.token}`, reload, 'Revoke this invitation? Its link stops working.', 'invitation revoked')}>revoke</button>
        </div>)}
      </div>}
      <p className="notice"><b>DiffNotes sends no emails.</b> Inviting someone makes a link (copied for you): send it to them yourself, in chat
        or email. Invited by GitHub login: the invitation also waits on their dashboard once they sign in with GitHub.</p>
      <div className="invite-cards">
        <form className="card invite-card" onSubmit={invite.submit}>
          <h3>invite a person</h3>
          <p className="hint">by email or GitHub login; the link works once, for 7 days.</p>
          <div className="controls">
            <input placeholder="email or GitHub login" value={email} onChange={(e) => setEmail(e.target.value)} />
            <select value={role} onChange={(e) => setRole(e.target.value)} aria-label="role"><option>member</option><option>admin</option></select>
            <button className="primary" disabled={invite.busy}>{invite.busy ? 'inviting…' : 'invite'}</button>
          </div>
          {invite.error && <div className="error">{invite.error}</div>}
        </form>
        <form className="card invite-card" onSubmit={open.submit}>
          <h3>open link</h3>
          <p className="hint">anyone who has it joins as a member, until it expires.</p>
          <div className="controls">
            <select value={minutes} onChange={(e) => setMinutes(e.target.value)} aria-label="link works for">
              {[['5', 'for 5 minutes'], ['10', 'for 10 minutes'], ['30', 'for 30 minutes'], ['60', 'for 1 hour'], ['1440', 'for 1 day']].map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
            <button disabled={open.busy}>{open.busy ? 'creating…' : 'create link'}</button>
          </div>
          {open.error && <div className="error">{open.error}</div>}
        </form>
      </div>
    </>}
  </>
}

type Rules = { risk?: boolean; deploy?: boolean; screenshots?: string }
const ruleChips = (r: Rules) => [r.risk && 'risk on every note', r.deploy && 'deploy card', r.screenshots && `screenshots for ${r.screenshots}`].filter(Boolean) as string[]
// what every upload to a repository must carry; the server answers 422 with what is missing and the agent adds it
function RulesForm({ id, rules, done }: { id: string; rules: Rules; done: () => void }) {
  const [r, setR] = useState(rules)
  const save = useSubmit(async () => { await api(`/api/repositories/${id}/rules`, r, 'PUT'); done() }, 'rules saved')
  return <form className="rules" onSubmit={save.submit}>
    <label><input type="checkbox" checked={!!r.risk} onChange={(e) => setR({ ...r, risk: e.target.checked })} /> every note rates its risk</label>
    <label><input type="checkbox" checked={!!r.deploy} onChange={(e) => setR({ ...r, deploy: e.target.checked })} /> a deploy card (migrations, env vars, flags, rollback)</label>
    <label>screenshots or a recording when a note touches <input placeholder="web/**, **/*.css" value={r.screenshots ?? ''} onChange={(e) => setR({ ...r, screenshots: e.target.value })} /></label>
    <div><button disabled={save.busy}>{save.busy ? 'saving…' : 'save rules'}</button></div>
    {save.error && <div className="error">{save.error}</div>}
  </form>
}

function Repositories({ id, data, admin, reload }: TabProps) {
  const [repo, setRepo] = useState(''), [editing, setEditing] = useState('')
  const add = useSubmit(async () => { await api(`/api/accounts/${id}/repositories`, { full_name: repo }); setRepo(''); reload() }, 'repository added')
  return <>
    <div className="list">
      {data.repositories.length ? data.repositories.map((r) => <div key={r.id}>
        <a className="grow" href={repoUrl(r.full_name)} target="_blank" rel="noreferrer">{r.full_name}</a>
        {ruleChips(r.rules).map((c) => <span key={c} className="chip hot" title="every upload must have it">{c}</span>)}
        <span className="chip">{r.pulls} PRs</span>
        {admin && <button className="link" onClick={() => setEditing(editing === r.id ? '' : r.id)}>rules</button>}
        {admin && <button className="link danger" onClick={() => del(`/api/repositories/${r.id}`, reload, `Delete ${r.full_name}? Its pull requests, notes and uploaded files are deleted too. There is no undo.`, `${r.full_name} deleted`)}>delete</button>}
        {editing === r.id && <RulesForm id={r.id} rules={r.rules} done={() => { setEditing(''); reload() }} />}
      </div>) : <div className="empty">no repositories yet. they are added on the first upload{admin && ', or here'}.</div>}
    </div>
    {admin && <>
      <form className="row" onSubmit={add.submit}>
        <input placeholder="owner/name, gitlab.com/group/project or a repository URL" value={repo} onChange={(e) => setRepo(e.target.value)} /><button disabled={add.busy}>{add.busy ? 'adding…' : 'add'}</button>
      </form>
      {add.error && <div className="error">{add.error}</div>}
    </>}
  </>
}

function AccountSettings({ id, data, user, reload }: Omit<TabProps, 'admin'> & { user: User }) {
  const [name, setName] = useState(data.account.name)
  const rename = useSubmit(async () => { await api(`/api/accounts/${id}`, { name }, 'PUT'); reload() }, 'account renamed')
  const remove = useSubmit(async () => {
    if (prompt(`Type the account name to delete it with all its repositories, notes and files: ${data.account.name}`) !== data.account.name) return
    await api(`/api/accounts/${id}`, undefined, 'DELETE'); toast('account deleted'); go('/dashboard')
  })
  return <>
    <h2>name</h2>
    <form className="row narrow" onSubmit={rename.submit}>
      <input value={name} onChange={(e) => setName(e.target.value)} /><button disabled={rename.busy}>{rename.busy ? 'saving…' : 'save'}</button>
    </form>
    {rename.error && <div className="error">{rename.error}</div>}
    {(data.role === 'owner' || !!user.admin) && <>
      <h2>danger zone</h2>
      <p className="hint">Deleting the account removes its repositories, every annotation and every uploaded file. There is no undo.</p>
      <button className="danger" disabled={remove.busy} onClick={() => remove.submit()}>{remove.busy ? 'deleting…' : 'delete account'}</button>
      {remove.error && <div className="error">{remove.error}</div>}
    </>}
  </>
}

function PullPage({ id }: { id: string }) {
  const { data, error } = useLoad<Pull>(`/api/pulls/${id}`)
  // a note's link to another note (#note:path:line, markdown.js): scroll to it and flash it
  useEffect(() => {
    if (!data) return
    const click = (e: MouseEvent) => {
      const a = (e.target as HTMLElement).closest?.('a[data-dn-note]') as HTMLElement | null
      if (!a) return
      e.preventDefault()
      const n = data.annotations[dnNoteRef(a.dataset.dnNote ?? '', data.annotations)]
      const to = n && document.getElementById(`note-${n.id}`)
      if (!to) return toast('that note is not on this pull request', true)
      to.scrollIntoView({ behavior: 'smooth', block: 'center' })
      to.classList.add('flash')
      setTimeout(() => to.classList.remove('flash'), 1200)
    }
    document.addEventListener('click', click)
    return () => document.removeEventListener('click', click)
  }, [data])
  if (error) return <p className="error">{error}</p>
  if (!data) return null
  const byFile = Map.groupBy(data.annotations, (a) => a.path)
  const order = ['high', 'medium', 'low']
  const risky = data.annotations.filter((a) => a.risk).sort((a, b) => order.indexOf(a.risk!) - order.indexOf(b.risk!))
  return <>
    <p className="hint">{data.repository}#{data.number}{data.head_sha && <> · written for commit <code>{data.head_sha.slice(0, 7)}</code></>} · updated {fmt(data.updated_at)} · expires {fmt(data.expires_at)}</p>
    <h1>{data.title || 'untitled pull request'}</h1>
    {!!data.authors?.length && <p className="authors">notes by {data.authors.map((a, i) => <Author key={i} name={a.name} avatar={a.avatar} />)}</p>}
    <p><a className="btn primary" href={prUrl(data.repository, data.number)} target="_blank" rel="noreferrer">open on {forge(data.repository)} ↗</a>{' '}
      {data.can_delete && <button className="danger" onClick={() => del(`/api/pulls/${id}`, () => go('/dashboard'),
        data.can_delete_all ? 'Delete all notes and files of this pull request? Reviewers stop seeing them in the diff.'
          : 'Delete your notes and files on this pull request? Teammates\' notes stay.')}>{data.can_delete_all ? 'delete notes' : 'delete my notes'}</button>}
      {data.preview && <>{' '}<a className="btn" href={data.preview} target="_blank" rel="noopener noreferrer">preview deploy ↗</a></>}</p>
    {!!data.stack?.length && <nav className="pr-stack" aria-label="Stacked pull requests">{data.stack.map((s, i) => <span key={s.number}>
      {i > 0 && <span className="hint">→</span>}
      {s.number === data.number ? <b aria-current="page">#{s.number} {s.title}</b>
        : <a href={prUrl(data.repository, s.number)} target="_blank" rel="noreferrer" title={s.notes ? 'has DiffNotes notes' : undefined}>#{s.number} {s.title}{s.notes && ' · DN'}</a>}
    </span>)}</nav>}
    {data.deploy && <div className="card deploy"><h3>deploy</h3><Md text={data.deploy} deploy /></div>}
    {data.summary && <div className="card"><Md text={data.summary} /></div>}
    {risky.length > 0 && <div className="card risks">
      <h3>where to look hardest</h3>
      {risky.map((n) => <a key={n.id} className="risk-row" href={`#note-${n.id}`}>
        <span className={`risk risk-${n.risk}`}>{n.risk}</span><code>{n.path}{n.line ? `:${n.line}` : ''}</code><span className="hint">{n.title}</span>
      </a>)}
    </div>}
    {[...byFile].map(([file, notes]) => <div className="file" key={file}>
      <h3>{file}</h3>
      {notes.map((n, i) => <div className="note" key={i} id={`note-${n.id}`}>
        <div className="where">{n.line ? `${n.side === 'LEFT' ? 'old ' : ''}line ${n.line}${n.end_line && n.end_line !== n.line ? `–${n.end_line}` : ''}` : 'whole file'}
          {n.risk && <span className={`risk risk-${n.risk}`}>{n.risk} risk</span>}</div>
        {n.title && <div className="title">{n.title}</div>}
        <Md text={n.body} />
        {data.preview && n.try && <a className="btn try" href={dnPreviewUrl(data.preview, n.try)} target="_blank" rel="noopener noreferrer">try it on the preview ↗</a>}
      </div>)}
    </div>)}
    {!!data.files?.length && <>
      <h2>attachments</h2>
      <div className="files">{data.files.map((f) => <Attachment key={f.name} f={f} />)}</div>
    </>}
  </>
}

// The setup flow after joining or signing up: three steps that tick themselves as they happen (the server sees the
// extension's first request, the agent's first upload or MCP call and the first notes), polled while the page is open.
// Each step can be marked done by hand, in this browser: an extension from before 1.2 doesn't say it's the extension.
const STEPS = ['agent', 'extension', 'notes'] as const
type Step = typeof STEPS[number]
const skipKey = (me: Me) => `dn:setup-done:${me.user.id}` // per user: a shared browser has more than one
const skipped = (me: Me): Step[] => { try { return JSON.parse(localStorage.getItem(skipKey(me)) ?? '[]') } catch { return [] } }
const setupDone = (me: Me) => STEPS.filter((s) => me.setup[s] || skipped(me).includes(s))
// dn:change: App re-renders, so the sidebar's count and the bar on top follow
const markSetup = (me: Me, steps: readonly Step[]) => {
  const next = [...new Set([...skipped(me), ...steps])]
  try { localStorage.setItem(skipKey(me), JSON.stringify(next)) } catch { /* private mode: for this visit only */ }
  dispatchEvent(new Event('dn:change'))
  return next
}
function Welcome({ me }: { me: Me }) {
  // the account just joined (the invitation page sends its name): one of this user's, never any text a link carries
  const joined = me.accounts.find((a) => a.name === new URLSearchParams(location.search).get('joined'))?.name
  const [marked, setMarked] = useState(() => skipped(me))
  const done = (s: Step) => me.setup[s] || marked.includes(s)
  const current = STEPS.find((s) => !done(s))
  const [open, setOpen] = useState<Step | undefined>(current)
  useEffect(() => { setOpen(current) }, [current]) // a step ticked (here or elsewhere): on to the next
  // ponytail: polls /api/me (via dn:change) every 4 s while steps are left and the tab is shown, so ticks show up without a reload
  useEffect(() => {
    if (!current) return
    const t = setInterval(() => { if (!document.hidden) dispatchEvent(new Event('dn:change')) }, 4000)
    return () => clearInterval(t)
  }, [current])
  const mark = (s: Step) => { setMarked(markSetup(me, [s])); toast('marked as done') }
  // one token per place it goes, made right here and shown once; one per click, not two for a double click
  const [tokens, setTokens] = useState<Partial<Record<Step, string>>>({}), [making, setMaking] = useState(false)
  const make = (s: Step, name: string) => async () => {
    setMaking(true)
    try { const { token } = await api('/api/tokens', { name }); setTokens((t) => ({ ...t, [s]: token })); toast('token created: copy it now, it is shown only once') }
    catch (e) { toast((e as Error).message, true) } finally { setMaking(false) }
  }
  const n = STEPS.filter(done).length
  const item = (s: Step, title: string, why: string, body: ReactNode) => <li key={s} className={`setup-step${done(s) ? ' done' : ''}${current === s ? ' current' : ''}`}>
    <button type="button" className="setup-head" onClick={() => setOpen(open === s ? undefined : s)} aria-expanded={open === s}>
      <span className="setup-check" aria-hidden="true">{done(s) ? '✓' : STEPS.indexOf(s) + 1}</span>
      <b>{title}</b>
      {current === s && <span className="tip">start here</span>}
      {done(s) && <span className="hint">done</span>}
    </button>
    {open === s && <div className="setup-body">
      <p className="hint">{why}</p>
      {body}
      {!done(s) && <p className="hint setup-wait"><span className="pulse" aria-hidden="true" /> this ticks itself once it happens ·{' '}
        <button type="button" className="link" onClick={() => mark(s)}>I've done this</button></p>}
    </div>}
  </li>
  return <div className="setup">
    <h1>{joined ? `welcome to ${joined}` : 'welcome'}</h1>
    <p className="lp-lead">{joined ? "You're in. " : ''}Three short steps and your pull requests carry notes your team reads right in the diff.</p>
    <div className="setup-progress" role="progressbar" aria-valuemin={0} aria-valuemax={3} aria-valuenow={n}><span style={{ width: `${(n / 3) * 100}%` }} /></div>
    <p className="hint">{n} of 3 done{n === 3 ? '' : ', about a minute each'}</p>
    <ol className="setup-list">
      {item('agent', 'give your coding agent the skill', 'Claude Code, Codex, Cursor or any Agent Skills tool learns to write notes and upload them here.', <>
        <p>1. install the skill (run it in a terminal):</p>
        <Code prompt text={`curl -fsSL ${location.origin}/install.sh | sh`} />
        <p>2. give it a token: {!tokens.agent && <button type="button" className="primary" disabled={making} onClick={make('agent', 'agent')}>make a token for my agent</button>}</p>
        {tokens.agent && <><p className="hint">add these two lines to your shell profile (~/.zshrc or ~/.bashrc), then open a new terminal:</p>
          <Code text={`export DIFFNOTES_URL=${location.origin}\nexport DIFFNOTES_TOKEN=${tokens.agent}`} /></>}
        <p className="hint">It ticks at your agent's first upload (or its first MCP call).</p>
      </>)}
      {item('extension', 'add the browser extension', 'It shows the notes next to the changed lines on GitHub, GitLab and Bitbucket. Nothing is posted to the PR.', <>
        <p>1. <AddToChrome primary /> <span className="hint">Edge, Brave and Arc too; Firefox: <a href="https://github.com/igorkasyanchuk/diffnotes/blob/main/docs/extension.md#firefox" target="_blank" rel="noreferrer">load it from the repo</a></span></p>
        <p>2. pin it (the puzzle icon in the toolbar), then: {!tokens.extension && <button type="button" className="primary" disabled={making} onClick={make('extension', 'browser extension')}>make a token for the extension</button>}</p>
        {tokens.extension && <><p className="hint">open the extension's popup, paste this one line into its Server field and press Connect:</p>
          <Code text={JSON.stringify({ server: location.origin, token: tokens.extension })} /></>}
      </>)}
      {item('notes', 'annotate your first pull request', "On a branch with an open pull request, ask your agent this. Then open the PR's “Files changed”: the notes are there.", <>
        <Code wrap text={AGENT_PROMPT} />
        {me.demo && <p className="hint">No PR at hand? <Link to="/demo">See the live demo</Link> first.</p>}
      </>)}
    </ol>
    {n === 3 ? <div className="card setup-all"><b>✓ all set.</b> Your team sees your notes on every PR you annotate.{' '}
      <Link to="/dashboard">go to the dashboard →</Link></div>
      : <p className="hint">You can leave and come back: <Link to="/welcome">setup</Link> stays in the sidebar until it's done.</p>}
  </div>
}

function Settings({ me }: { me: Me }) {
  const { data, reload } = useLoad<{ id: string; name: string; created_at: string; last_used_at: string | null }[]>('/api/tokens')
  const [name, setName] = useState(''), [fresh, setFresh] = useState('')
  const make = useSubmit(async () => { setFresh((await api('/api/tokens', { name })).token); setName(''); reload() }, 'token created: copy it now, it is shown only once')
  useEffect(() => { if (location.hash === '#tokens') document.getElementById('tokens')?.scrollIntoView() }, [])
  const [cur, setCur] = useState(''), [next, setNext] = useState('')
  const pass = useSubmit(async () => { await api('/api/password', { current: cur, password: next }, 'PUT'); setCur(''); setNext('') }, 'password changed, other sessions signed out')
  const owned = me.accounts.filter((a) => a.role === 'owner')
  const [delPass, setDelPass] = useState('')
  const remove = useSubmit(async () => {
    const what = owned.length ? `\n\nThese accounts you own are deleted too, with all their repositories, notes and files:\n${owned.map((a) => `- ${a.name}`).join('\n')}` : ''
    const typed = prompt(`Type your email to delete your user, your tokens and your sign-ins. There is no undo.${what}`)
    if (typed === null) return // cancelled
    if (typed.trim().toLowerCase() !== me.user.email.toLowerCase()) throw new Error(`That isn't ${me.user.email}: nothing was deleted`)
    await api('/api/me', { password: delPass }, 'DELETE'); location.href = '/'
  })
  return <>
    <h1>settings</h1>
    <p className="hint">New here? The <Link to="/welcome">setup steps</Link> walk you through all of this.</p>
    <h2>connect your agent</h2>
    <p>1. install the skill for Claude Code, Codex, Cursor and other Agent Skills tools:</p>
    <Code prompt text={`curl -fsSL ${location.origin}/install.sh | sh`} />
    <p>2. make a token below and add it to your shell profile (~/.zshrc or ~/.bashrc):</p>
    {/* the placeholder must stay valid shell: `<token>` pasted into ~/.zshrc is a redirection and a parse error */}
    <Code text={`export DIFFNOTES_URL=${location.origin}\nexport DIFFNOTES_TOKEN=${fresh || 'paste-your-token-here'}`} />
    <p>3. in the browser extension's popup, paste this one line into the Server field (it fills both fields), then press Connect:</p>
    <Code text={JSON.stringify({ server: location.origin, token: fresh || 'make-a-token-below' })} />
    <p>4. on a branch with a pull request, ask your agent:</p>
    <Code wrap text={AGENT_PROMPT} />
    <h2 id="tokens">tokens</h2>
    {fresh && <div className="token"><Code text={fresh} /><span className="hint">copy it now: it is shown only once.</span></div>}
    <div className="list">
      {data?.length ? data.map((t) => <div key={t.id}>
        <span className="grow">{t.name}</span>
        <span className="hint">{t.last_used_at ? `used ${fmt(t.last_used_at)}` : 'never used'}</span>
        <button className="link danger" onClick={() => del(`/api/tokens/${t.id}`, reload, 'Delete this token? Agents and extensions using it stop working.', 'token deleted')}>delete</button>
      </div>) : <div className="empty">no tokens yet</div>}
    </div>
    <form className="row" onSubmit={make.submit}>
      <input placeholder="name, e.g. work laptop" value={name} onChange={(e) => setName(e.target.value)} /><button disabled={make.busy}>{make.busy ? 'creating…' : 'new token'}</button>
    </form>
    <h2>password</h2>
    {!me.has_password && <p className="hint">You sign in with GitHub. A password is optional: set one to sign in with your email too.</p>}
    <form className="stack narrow" onSubmit={pass.submit}>
      {me.has_password && <label>current password<input type="password" autoComplete="current-password" value={cur} onChange={(e) => setCur(e.target.value)} /></label>}
      <label>new password<input type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} /></label>
      {pass.error && <div className="error">{pass.error}</div>}
      <button disabled={pass.busy}>{me.has_password ? 'change password' : 'set password'}</button>
    </form>
    <h2>danger zone</h2>
    <p className="hint">Deleting your user removes your tokens and sign-ins and takes you out of every account.
      {owned.length ? <> The accounts you own go too, with all their repositories, notes and files: <b>{owned.map((a) => a.name).join(', ')}</b>.</> : ''}
      {' '}Notes you uploaded to other accounts stay. There is no undo.</p>
    <form className="stack narrow" onSubmit={remove.submit}>
      {me.has_password && <label>password<input type="password" autoComplete="current-password" value={delPass} onChange={(e) => setDelPass(e.target.value)} /></label>}
      {remove.error && <div className="error">{remove.error}</div>}
      <button className="danger" disabled={remove.busy || (me.has_password && !delPass)}>delete my user</button>
    </form>
  </>
}

type AdminStats = {
  totals: Record<'users' | 'accounts' | 'repositories' | 'pulls' | 'annotations' | 'tokens' | 'sessions' | 'invites' | 'uploads_24h' | 'uploads_7d'
    | 'files' | 'upload_bytes' | 'db_bytes' | 'disk_free_bytes' | 'disk_total_bytes', number>
  retention_days: number
  max_account_bytes: number
  prices: { as_of: string; storage: string; providers: Record<string, { name: string; gb_month: number; free_gb: number }> }
  version: string
  accounts: { id: string; name: string; owner: string | null; members: number; repositories: number; pulls: number; files: number; bytes: number; created_at: string }[]
  users: { id: string; email: string; name: string; admin: number; accounts: number; created_at: string; token_used_at: string | null; signed_in_at: string | null }[]
}
// a month's storage at a list price (GB = 10^9 bytes, as providers bill); free: the bucket's free GB, for the total only
const monthly = (b: number, p: { gb_month: number; free_gb: number }, free = false) => Math.max(0, b / 1e9 - (free ? p.free_gb : 0)) * p.gb_month
const usd = (n: number) => (n === 0 ? '$0' : n < 0.01 ? '< $0.01' : `$${n.toFixed(2)}`)
function Admin({ user }: { user: User }) {
  const { data, error, reload } = useLoad<AdminStats>('/api/admin/stats')
  const [err, setErr] = useState(''), [q, setQ] = useState(''), [only, setOnly] = useState('')
  const flag = async (id: string, admin: boolean) => {
    setErr('')
    try { await api(`/api/admin/users/${id}`, { admin }, 'PUT'); toast(admin ? 'made super admin' : 'super admin removed'); reload() } catch (e) { setErr((e as Error).message) }
  }
  if (error) return <p className="error">{error}</p>
  if (!data) return null
  const t = data.totals, used = t.disk_total_bytes - t.disk_free_bytes
  const price = data.prices.providers[data.prices.storage] // none on disk or MinIO: no bucket bill
  const users = data.users.filter((u) => (!only || (only === 'super admin') === !!u.admin) && matches(q, u.name, u.email))
  return <>
    <div className="head"><h1>server</h1><span className="chip hot">super admin</span></div>
    <div className="stats">
      <Stat label="users" value={t.users} />
      <Stat label="accounts" value={t.accounts} />
      <Stat label="repositories" value={t.repositories} />
      <Stat label="annotated PRs" value={t.pulls} />
      <Stat label="notes" value={t.annotations} />
      <Stat label="uploads 24h / 7d" value={`${t.uploads_24h} / ${t.uploads_7d}`} />
      <Stat label="files" value={t.files} />
      <Stat label="uploads size" value={bytes(t.upload_bytes)} />
      <Stat label="database" value={bytes(t.db_bytes)} />
      <Stat label="tokens / sessions" value={`${t.tokens} / ${t.sessions}`} />
      <Stat label="open invites" value={t.invites} />
      <div className="stat"><b>{bytes(t.disk_free_bytes)}</b><span>disk free of {bytes(t.disk_total_bytes)}</span>
        <div className="meter"><i style={{ width: `${(used / Math.max(1, t.disk_total_bytes)) * 100}%` }} /></div></div>
    </div>
    <p className="hint">retention: {data.retention_days} days after the last upload. diffnotes {data.version}.</p>
    <h2>accounts</h2>
    <div className="scroll"><table className="grid">
      <thead><tr><th>account</th><th>owner</th><th className="num">members</th><th className="num">repos</th><th className="num">PRs</th><th className="num">files</th><th className="num">size</th><th>of quota</th>{price && <th className="num">≈ / month</th>}<th>created</th></tr></thead>
      {/* the biggest first; of quota: MAX_ACCOUNT_MB, past which uploads to the account are refused */}
      <tbody>{data.accounts.map((a) => <tr key={a.id}>
        <td><Link to={`/accounts/${a.id}`}>{a.name}</Link></td><td>{a.owner ?? '—'}</td><td className="num">{a.members}</td>
        <td className="num">{a.repositories}</td><td className="num">{a.pulls}</td><td className="num">{a.files}</td><td className="num">{bytes(a.bytes)}</td>
        <td title={`${bytes(a.bytes)} of ${bytes(data.max_account_bytes)}`}><div className="meter"><i style={{ width: `${Math.min(100, (a.bytes / Math.max(1, data.max_account_bytes)) * 100)}%` }} /></div></td>
        {price && <td className="num">{usd(monthly(a.bytes, price))}</td>}<td>{fmt(a.created_at)}</td>
      </tr>)}</tbody>
      <tfoot><tr><th colSpan={5}>all accounts</th><th className="num">{t.files}</th><th className="num">{bytes(t.upload_bytes)}</th><th />
        {price && <th className="num">{usd(monthly(t.upload_bytes, price, true))}</th>}<th /></tr></tfoot>
    </table></div>
    <p className="hint">{price && `≈ / month: storage at ${price.name}'s price, the total after the bucket's free ${price.free_gb} GB. `}Uploads and
      downloads of files this small cost nothing extra on B2 and R2. All of today's files ({bytes(t.upload_bytes)}) a month at list prices
      as of {fmt(`${data.prices.as_of}T00:00`)}: {Object.values(data.prices.providers).map((p) => `${p.name} $${(p.gb_month * 1000).toFixed(2)}/TB ${usd(monthly(t.upload_bytes, p, true))}`).join(' · ')}
      {!price && (data.prices.storage === 'disk' ? ' (files are on this server\'s disk now: no bucket bill)' : ' (your own MinIO: no list price)')}.</p>
    <h2>users</h2>
    <Filter q={q} setQ={setQ} roles={['super admin', 'user']} role={only} setRole={setOnly} found={users.length} of={data.users.length} />
    <div className="scroll"><table className="grid">
      <thead><tr><th>user</th><th className="num">accounts</th><th>joined</th><th>last sign-in</th><th>token used</th><th>super admin</th><th></th></tr></thead>
      <tbody>{users.map((u) => <tr key={u.id}>
        <td>{u.email} <span className="hint">{u.name}</span></td><td className="num">{u.accounts}</td><td>{fmt(u.created_at)}</td>
        <td>{fmt(u.signed_in_at)}</td><td>{fmt(u.token_used_at)}</td>
        <td>{u.id === user.id ? <span className="chip hot">you</span>
          : <input type="checkbox" style={{ width: 'auto' }} checked={!!u.admin} onChange={(e) => flag(u.id, e.target.checked)} aria-label={`super admin: ${u.email}`} />}</td>
        <td>{u.id !== user.id && !u.admin && <button className="link danger" onClick={() => del(`/api/admin/users/${u.id}`, reload,
          `Delete ${u.email} with the accounts they own and everything in them? Their notes in other accounts stay.`)}>delete</button>}</td>
      </tr>)}</tbody>
    </table></div>
    {err && <div className="error">{err}</div>}
    <StorageSettings />
  </>
}

type StorageCfg = { kind: 'disk' | 's3'; type: string; source?: 'env' | 'settings'; endpoint?: string; region?: string; bucket?: string; prefix?: string; key_id?: string }
// read only: STORAGE_TYPE and its provider's variables in the server's environment (docs/storage.md)
function StorageSettings() {
  const { data } = useLoad<{ storage: StorageCfg; counts: { backend: string; files: number; bytes: number }[]; retention_days: number }>('/api/admin/storage')
  if (!data) return null
  const st = data.storage
  return <>
    <h2>file storage</h2>
    <p className="hint">Where uploaded screenshots and files go, set by <code>STORAGE_TYPE</code> (disk, b2, r2, s3, minio) and that provider's
      variables in the server's environment, never here. Existing files stay where they were written.
      {data.counts.map((c) => ` ${c.backend}: ${c.files} files, ${bytes(c.bytes)}.`)}</p>
    <div className="card">
      <p>new uploads: <strong>{st.kind === 's3' ? `${st.type} bucket` : 'disk (DATA_DIR/uploads)'}</strong></p>
      {st.bucket && <p className="hint">{st.source === 'settings' && 'Saved on this page by an older version; its files still read and delete. New uploads go to disk until STORAGE_TYPE is set. '}
        endpoint <code>{st.endpoint}</code> · region <code>{st.region}</code> · bucket <code>{st.bucket}</code>
        {st.prefix && <> · prefix <code>{st.prefix}</code></>} · key <code>{st.key_id}</code></p>}
    </div>
    {st.bucket && <p className="hint" style={{ marginTop: 12 }}>Files are deleted from the bucket with their PR ({data.retention_days} days after
      its last upload), by the server every hour. Don't add a bucket rule that expires files by age: a PR outlives its oldest files.</p>}
  </>
}

const APP_PATHS = /^\/(dashboard|welcome|settings|admin|accounts\/[\w-]+|pulls\/[\w-]+)$/

function App() {
  const [path, setPath] = useState(location.pathname), [me, setMe] = useState<Me | null>(), [n, setN] = useState(0)
  const [sign, setSign] = useState<SignIn>({ github: false, signup: false, demo: null })
  useEffect(() => {
    const on = () => setPath(location.pathname), change = () => setN((x) => x + 1)
    addEventListener('popstate', on)
    addEventListener('dn:change', change)
    return () => { removeEventListener('popstate', on); removeEventListener('dn:change', change) }
  }, [])
  // ponytail: refetched on every navigation and after every change (one small request), so the sidebar and token bar
  // also pick up what other people changed; `live` drops a response that a newer request already superseded
  useEffect(() => {
    let live = true
    // a failed request keeps who we knew; on the very first load it falls back to signed out instead of a blank page
    api<Me | (SignIn & { user: null })>('/api/me').then((r) => { if (live) { setSign({ github: r.github, signup: r.signup, demo: r.demo }); setMe(r.user ? r as Me : null) } },
      () => { if (live) setMe((x) => x ?? null) })
    return () => { live = false }
  }, [path, n])
  // the tab's title; the server writes the public pages' own into the HTML too (app.ts PUBLIC_PAGES), for crawlers
  useEffect(() => {
    const t = ({ '/dashboard': 'dashboard', '/welcome': 'setup', '/settings': 'settings', '/admin': 'server admin', '/login': 'sign in',
      '/demo': 'Live demo', '/badge': 'Badge', '/privacy': 'Privacy' } as Record<string, string>)[path] // the public ones as app.ts writes them
      ?? (path.startsWith('/accounts/') ? 'account' : path.startsWith('/pulls/') ? 'pull request' : path.startsWith('/invite/') ? 'invitation' : '')
    document.title = t ? `${t} · DiffNotes` : 'DiffNotes · AI pull request notes, right in the diff'
  }, [path])
  if (me === undefined) return null
  const m = (re: RegExp) => path.match(re)?.[1]
  if (!me || !APP_PATHS.test(path)) {
    const invite = m(/^\/invite\/([\w-]+)$/)
    // signed out on an app page: sign in right there, so links from the skill, the extension and install.sh survive
    const login = !me && (path === '/login' || APP_PATHS.test(path))
    return <PublicLayout signedIn={!!me} signup={sign.signup} demo={!!sign.demo}>{invite ? <Invite token={invite} sign={sign} /> : login ? <Login sign={sign} />
      : path === '/privacy' ? <Privacy /> : path === '/badge' ? <BadgePage />
      : path === '/demo' ? <DemoPage signedIn={!!me} github={sign.github} demo={sign.demo && { url: prUrl(sign.demo.repository, sign.demo.number), label: `${sign.demo.repository} #${sign.demo.number}` }} />
      : <Landing signedIn={!!me} signup={sign.signup} demo={!!sign.demo} />}<Toaster /></PublicLayout>
  }
  let page: ReactNode
  if (m(/^\/accounts\/([\w-]+)$/)) page = <Account key={path} id={m(/^\/accounts\/([\w-]+)$/)!} user={me.user} />
  else if (m(/^\/pulls\/([\w-]+)$/)) page = <PullPage id={m(/^\/pulls\/([\w-]+)$/)!} />
  else if (path === '/settings') page = <Settings me={me} />
  else if (path === '/welcome') page = <Welcome me={me} />
  else if (path === '/admin' && me.user.admin) page = <Admin user={me.user} />
  else page = <Dashboard />
  return <AppLayout me={me} path={path}>{page}<Gallery /><Toaster /></AppLayout>
}

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>)
