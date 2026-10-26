import { StrictMode, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import '../extension/markdown.js'
import './styles.css'
import { BadgePage, Code, DemoPage, Landing } from './landing.tsx'
import { version } from '../package.json'

declare global {
  var dnMarkdown: (md: string) => string
  var dnPreview: (name: string, text: string) => string
  var dnCompare: (root: ParentNode) => void
}

type User = { id: string; email: string; name: string; admin: number }
type Annotation = { id: number; path: string; line: number | null; end_line: number | null; side: string; title: string; body: string; risk: 'low' | 'medium' | 'high' | null }
type Pull = { id: string; repository: string; number: number; title: string; head_sha?: string; can_delete?: boolean; summary: string; deploy?: string; updated_at: string; expires_at: string; annotations: Annotation[]
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
function Md({ text }: { text: string }) {
  const ref = useRef<HTMLDivElement>(null), [long, setLong] = useState(false), [open, setOpen] = useState(false)
  // once per text, not on every show more / less: the same string keeps React off the HTML, so what dnCompare added stays
  const html = useMemo(() => dnMarkdown(text), [text])
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
const Stat = ({ label, value }: { label: string; value: ReactNode }) => <div className="stat"><b>{value}</b><span>{label}</span></div>

function useLoad<T>(url: string) {
  const [data, setData] = useState<T>(), [error, setError] = useState(''), [n, setN] = useState(0)
  useEffect(() => { api<T>(url).then(setData, (e) => setError(e.message)) }, [url, n])
  return { data, error, reload: () => setN((x) => x + 1) }
}

// a form whose submit calls fn and shows its error
function useSubmit(fn: () => Promise<unknown>) {
  const [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const submit = async (e?: FormEvent) => {
    e?.preventDefault(); setBusy(true); setError('')
    try { await fn() } catch (err) { setError((err as Error).message) } finally { setBusy(false) }
  }
  return { submit, error, busy }
}

type SignIn = { github: boolean; signup: boolean; demo: { repository: string; number: number } | null } // what /api/me says this server offers besides a password
type Me = SignIn & { user: User; accounts: { id: string; name: string; role: string }[]; tokens: number; has_password: boolean }

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
function PublicLayout({ signedIn, signup, children }: { signedIn: boolean; signup: boolean; children: ReactNode }) {
  return <>
    <header className="top">
      <Brand />
      <nav>
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
  return <div className="app">
    <aside className="side">
      <Brand />
      <nav>
        <Link to="/dashboard" className={on('/dashboard')}>dashboard</Link>
        <span className="side-h">accounts</span>
        {me.accounts.map((a) => <Link key={a.id} to={`/accounts/${a.id}`} className={on(`/accounts/${a.id}`)}>{a.name}</Link>)}
        <span className="side-h">you</span>
        <Link to="/settings" className={on('/settings')}>settings</Link>
        {!!me.user.admin && <Link to="/admin" className={on('/admin')}>server admin</Link>}
        <button className="link" onClick={logout}>logout</button>
      </nav>
      <div className="side-me hint">{me.user.email}</div>
    </aside>
    <div className="app-main">
      {!me.tokens && <div className="nag">
        <span><b>no agent token yet.</b> create one to connect your coding agent and the browser extension.</span>
        {path !== '/settings' && <Link to="/settings#tokens" className="btn primary">create token →</Link>}
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
    await api('/api/login', { email, password })
    if (location.pathname === '/login') go('/dashboard')
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
      <button className="primary" disabled={busy}>sign in</button>
      <p className="hint">{!sign.signup && <>No account? Ask a teammate for an invitation link.<br /></>}
        Forgot your password? Your server admin runs <code>npm run reset-password</code>.</p>
    </form>
  </div>
}

function Invite({ token, sign }: { token: string; sign: SignIn }) {
  const { data, error: loadError } = useLoad<{ email: string; account: string; exists: boolean; signed_in: boolean }>(`/api/invites/${token}`)
  const [name, setName] = useState(''), [password, setPassword] = useState('')
  const { submit, error, busy } = useSubmit(async () => { await api(`/api/invites/${token}/accept`, { name, password }); location.href = '/dashboard' })
  if (loadError) return <p className="error">{loadError}</p>
  if (!data) return null
  return <div className="narrow">
    <h1>join {data.account}</h1>
    <p className="hint">Invitation for {data.email}.{data.signed_in ? ' You are signed in as this user.'
      : data.exists && ' You already have an account: enter your password to join.'}</p>
    {sign.github && !data.signed_in && <p><GitHubButton next={`/invite/${token}`}>continue with GitHub</GitHubButton>
      <span className="hint"> if {data.email} is an email of your GitHub account</span></p>}
    <form className="stack" onSubmit={submit}>
      {!data.exists && <label>your name<input autoFocus value={name} onChange={(e) => setName(e.target.value)} /></label>}
      {!data.signed_in && <label>{data.exists ? 'password' : 'choose a password (8+ characters)'}
        <input type="password" autoComplete={data.exists ? 'current-password' : 'new-password'} value={password} onChange={(e) => setPassword(e.target.value)} /></label>}
      {error && <div className="error">{error}</div>}
      <button className="primary" disabled={busy}>join</button>
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
        access token you paste for each, plus which notes you folded, whether notes are switched off, and, for pull requests with notes you
        opened in the last 60 days, their repository and number with hashes of the notes it showed, to mark the ones changed since. Removing a server in its popup deletes its token.</li>
      <li>It talks only to the servers you connect. On a GitHub, GitLab or Bitbucket pull request page it sends that server the
        repository and pull request number, with your token, to fetch the notes your team uploaded, and it downloads their attached files.</li>
      <li>It reads the pull request page only to place notes next to the changed lines. It does not send page contents, code, your
        browsing history or anything else anywhere.</li>
      <li>It has no analytics, no tracking, no ads and no third-party code, and it sells or shares nothing.</li>
    </ul>
    <h2>A DiffNotes server</h2>
    <ul>
      <li>Each server is run by whoever installed it (your company, your team, you). It keeps user accounts (email, name, password hash, and the GitHub user id when you sign in with GitHub),
        sessions, token hashes, and the notes and files your agents upload, which are deleted after the retention period (30 days by default).
        Its operator decides where it runs and who can access it.</li>
      <li>Notes and files are visible only to members of the account that owns the repository.</li>
      <li>The app's pages load nothing from third parties. The operator may enable Umami analytics on the landing page (<code>/</code>) only:
        one anonymous page view, never on the app's pages. Errors may be reported to the operator's own error tracker with the route pattern only.</li>
    </ul>
    <h2>Contact</h2>
    <p>Questions or requests: open an issue at <a href={`${SOURCE}/issues`} target="_blank" rel="noreferrer">{SOURCE.replace('https://', '')}/issues</a>,
      or contact the operator of your DiffNotes server about the data it holds.</p>
  </div>
}

const PullList = ({ pulls }: { pulls: (Pull & { annotations: number; uploader?: string })[] }) =>
  <div className="list">
    {pulls.length ? pulls.map((p) => <div key={p.id}>
      <span className="mono hint">{p.repository}#{p.number}</span>
      <span className="grow"><Link to={`/pulls/${p.id}`}>{p.title || 'untitled'}</Link></span>
      <span className="chip hot">{p.annotations} notes</span>
      <span className="hint">{fmt(p.updated_at)}</span>
      <a href={prUrl(p.repository, p.number)} target="_blank" rel="noreferrer">{forge(p.repository)} ↗</a>
    </div>) : <div className="empty">nothing yet. install the skill (settings) and ask your agent to annotate a pull request.</div>}
  </div>

type Dash = { accounts: { id: string; name: string; role: string }[]; pulls: (Pull & { annotations: number })[]; retention_days: number }
function Dashboard() {
  const { data, reload } = useLoad<Dash>('/api/dashboard')
  const [name, setName] = useState('')
  const { submit, error } = useSubmit(async () => { await api('/api/accounts', { name }); setName(''); reload() })
  if (!data) return null
  return <>
    <h1>dashboard</h1>
    <h2>annotated pull requests</h2>
    <PullList pulls={data.pulls} />
    <p className="hint">notes are kept for {data.retention_days} days after the last upload.</p>
    <h2>accounts</h2>
    <div className="list">
      {data.accounts.map((a) => <div key={a.id}>
        <span className="grow"><Link to={`/accounts/${a.id}`}>{a.name}</Link></span><span className={`chip${a.role === 'member' ? '' : ' hot'}`}>{a.role}</span>
      </div>)}
    </div>
    <form className="row" onSubmit={submit}>
      <input placeholder="new account (team) name" value={name} onChange={(e) => setName(e.target.value)} />
      <button>create</button>
    </form>
    {error && <div className="error">{error}</div>}
  </>
}

type Acc = {
  account: { id: string; name: string }; role: string
  members: { id: string; email: string; name: string; role: string }[]
  repositories: { id: string; full_name: string; pulls: number; rules: Rules }[]
  invites: { token: string; email: string; role: string; expires_at: string }[]
}
type Overview = {
  totals: Record<'members' | 'admins' | 'invites' | 'repositories' | 'pulls' | 'annotations' | 'files' | 'bytes' | 'expiring_soon', number>
  retention_days: number
  repositories: { repository: string; pulls: number; annotations: number; files: number; bytes: number }[]
  recent: (Pull & { annotations: number; uploader: string | null; files: number; bytes: number })[]
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
    {data.recent.length ? <div className="scroll"><table className="grid">
      <thead><tr><th>pull request</th><th>by</th><th className="num">notes</th><th className="num">files</th><th className="num">size</th><th>updated</th><th>expires</th></tr></thead>
      <tbody>{data.recent.map((p) => <tr key={p.id}>
        <td><Link to={`/pulls/${p.id}`}>{p.repository}#{p.number}</Link> <span className="hint">{p.title}</span></td>
        <td>{p.uploader ?? '—'}</td><td className="num">{p.annotations}</td><td className="num">{p.files}</td><td className="num">{bytes(p.bytes)}</td>
        <td>{fmt(p.updated_at)}</td><td>{fmt(p.expires_at)}</td>
      </tr>)}</tbody>
    </table></div> : <div className="list"><div className="empty">no uploads yet</div></div>}
  </>
}

type TabProps = { id: string; data: Acc; admin: boolean; reload: () => void }
// a refusal (403 once a role changed, 404 already gone) is said, not dropped as an unhandled rejection
const del = async (url: string, reload: () => void, what = 'Are you sure?') => {
  if (!confirm(what)) return
  try { await api(url, undefined, 'DELETE'); reload() } catch (e) { alert((e as Error).message) }
}

function Members({ id, data, admin, user, reload }: TabProps & { user: User }) {
  const [email, setEmail] = useState(''), [role, setRole] = useState('member'), [err, setErr] = useState('')
  const invite = useSubmit(async () => { await api(`/api/accounts/${id}/invites`, { email, role }); setEmail(''); reload() })
  const change = async (m: string, next: string) => {
    setErr('')
    try { await api(`/api/accounts/${id}/members/${m}`, { role: next }, 'PUT'); reload() } catch (e) { setErr((e as Error).message) }
  }
  return <>
    <div className="list">
      {data.members.map((m) => <div key={m.id}>
        <span className="grow">{m.name || m.email} <span className="hint">{m.name && m.email}</span></span>
        {admin && m.role !== 'owner' && m.id !== user.id
          ? <select className="inline" value={m.role} onChange={(e) => change(m.id, e.target.value)}><option>admin</option><option>member</option></select>
          : <span className={`chip${m.role === 'member' ? '' : ' hot'}`}>{m.role}</span>}
        {admin && m.role !== 'owner' && m.id !== user.id && <button className="link danger" onClick={() => del(`/api/accounts/${id}/members/${m.id}`, reload, `Remove ${m.email}?`)}>remove</button>}
      </div>)}
    </div>
    {err && <div className="error">{err}</div>}
    <p className="hint">owner: made the account · admin: invites people, manages members and repositories · member: reads and uploads notes</p>
    {admin && <>
      <h2>invitations</h2>
      {!!data.invites.length && <div className="list">
        {data.invites.map((i) => <div key={i.token}>
          <span className="grow">{i.email} <span className="hint">until {fmt(i.expires_at)}</span></span>
          <span className="chip">{i.role}</span>
          <button className="link" onClick={() => navigator.clipboard.writeText(`${location.origin}/invite/${i.token}`)}>copy link</button>
          <button className="link danger" onClick={() => del(`/api/accounts/${id}/invites/${i.token}`, reload)}>revoke</button>
        </div>)}
      </div>}
      <form className="row" onSubmit={invite.submit}>
        <input type="email" placeholder="teammate@company.com" value={email} onChange={(e) => setEmail(e.target.value)} />
        <select value={role} onChange={(e) => setRole(e.target.value)}><option>member</option><option>admin</option></select>
        <button>invite</button>
      </form>
      {invite.error && <div className="error">{invite.error}</div>}
      <p className="hint">send them the link (copy link); it works for 7 days.</p>
    </>}
  </>
}

type Rules = { risk?: boolean; deploy?: boolean; screenshots?: string }
const ruleChips = (r: Rules) => [r.risk && 'risk on every note', r.deploy && 'deploy card', r.screenshots && `screenshots for ${r.screenshots}`].filter(Boolean) as string[]
// what every upload to a repository must carry; the server answers 422 with what is missing and the agent adds it
function RulesForm({ id, rules, done }: { id: string; rules: Rules; done: () => void }) {
  const [r, setR] = useState(rules)
  const save = useSubmit(async () => { await api(`/api/repositories/${id}/rules`, r, 'PUT'); done() })
  return <form className="rules" onSubmit={save.submit}>
    <label><input type="checkbox" checked={!!r.risk} onChange={(e) => setR({ ...r, risk: e.target.checked })} /> every note rates its risk</label>
    <label><input type="checkbox" checked={!!r.deploy} onChange={(e) => setR({ ...r, deploy: e.target.checked })} /> a deploy card (migrations, env vars, flags, rollback)</label>
    <label>screenshots or a recording when a note touches <input placeholder="web/**, **/*.css" value={r.screenshots ?? ''} onChange={(e) => setR({ ...r, screenshots: e.target.value })} /></label>
    <div><button>save rules</button></div>
    {save.error && <div className="error">{save.error}</div>}
  </form>
}

function Repositories({ id, data, admin, reload }: TabProps) {
  const [repo, setRepo] = useState(''), [editing, setEditing] = useState('')
  const add = useSubmit(async () => { await api(`/api/accounts/${id}/repositories`, { full_name: repo }); setRepo(''); reload() })
  return <>
    <div className="list">
      {data.repositories.length ? data.repositories.map((r) => <div key={r.id}>
        <a className="grow" href={repoUrl(r.full_name)} target="_blank" rel="noreferrer">{r.full_name}</a>
        {ruleChips(r.rules).map((c) => <span key={c} className="chip hot" title="every upload must have it">{c}</span>)}
        <span className="chip">{r.pulls} PRs</span>
        {admin && <button className="link" onClick={() => setEditing(editing === r.id ? '' : r.id)}>rules</button>}
        {admin && <button className="link danger" onClick={() => del(`/api/repositories/${r.id}`, reload, `Delete ${r.full_name}? Its pull requests, notes and uploaded files are deleted too. There is no undo.`)}>delete</button>}
        {editing === r.id && <RulesForm id={r.id} rules={r.rules} done={() => { setEditing(''); reload() }} />}
      </div>) : <div className="empty">no repositories yet. they are added on the first upload{admin && ', or here'}.</div>}
    </div>
    {admin && <>
      <form className="row" onSubmit={add.submit}>
        <input placeholder="owner/name, gitlab.com/group/project or a repository URL" value={repo} onChange={(e) => setRepo(e.target.value)} /><button>add</button>
      </form>
      {add.error && <div className="error">{add.error}</div>}
    </>}
  </>
}

function AccountSettings({ id, data, user, reload }: Omit<TabProps, 'admin'> & { user: User }) {
  const [name, setName] = useState(data.account.name), [saved, setSaved] = useState(false)
  const rename = useSubmit(async () => { await api(`/api/accounts/${id}`, { name }, 'PUT'); setSaved(true); reload() })
  const remove = useSubmit(async () => {
    if (prompt(`Type the account name to delete it with all its repositories, notes and files: ${data.account.name}`) !== data.account.name) return
    await api(`/api/accounts/${id}`, undefined, 'DELETE'); go('/dashboard')
  })
  return <>
    <h2>name</h2>
    <form className="row narrow" onSubmit={rename.submit}>
      <input value={name} onChange={(e) => { setName(e.target.value); setSaved(false) }} /><button>save</button>
    </form>
    {rename.error && <div className="error">{rename.error}</div>}
    {saved && <div className="ok">saved</div>}
    {(data.role === 'owner' || !!user.admin) && <>
      <h2>danger zone</h2>
      <p className="hint">Deleting the account removes its repositories, every annotation and every uploaded file. There is no undo.</p>
      <button className="danger" onClick={() => remove.submit()}>delete account</button>
      {remove.error && <div className="error">{remove.error}</div>}
    </>}
  </>
}

function PullPage({ id }: { id: string }) {
  const { data, error } = useLoad<Pull>(`/api/pulls/${id}`)
  if (error) return <p className="error">{error}</p>
  if (!data) return null
  const byFile = Map.groupBy(data.annotations, (a) => a.path)
  const order = ['high', 'medium', 'low']
  const risky = data.annotations.filter((a) => a.risk).sort((a, b) => order.indexOf(a.risk!) - order.indexOf(b.risk!))
  return <>
    <p className="hint">{data.repository}#{data.number}{data.head_sha && <> · written for commit <code>{data.head_sha.slice(0, 7)}</code></>} · updated {fmt(data.updated_at)} · expires {fmt(data.expires_at)}</p>
    <h1>{data.title || 'untitled pull request'}</h1>
    <p><a className="btn primary" href={prUrl(data.repository, data.number)} target="_blank" rel="noreferrer">open on {forge(data.repository)} ↗</a>{' '}
      {data.can_delete && <button className="danger" onClick={() => del(`/api/pulls/${id}`, () => go('/dashboard'),
        'Delete all notes and files of this pull request? Reviewers stop seeing them in the diff.')}>delete notes</button>}</p>
    {data.deploy && <div className="card deploy"><h3>deploy</h3><Md text={data.deploy} /></div>}
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
      </div>)}
    </div>)}
    {!!data.files?.length && <>
      <h2>attachments</h2>
      <div className="files">{data.files.map((f) => <Attachment key={f.name} f={f} />)}</div>
    </>}
  </>
}

function Settings({ me }: { me: Me }) {
  const { data, reload } = useLoad<{ id: string; name: string; created_at: string; last_used_at: string | null }[]>('/api/tokens')
  const [name, setName] = useState(''), [fresh, setFresh] = useState('')
  const make = useSubmit(async () => { setFresh((await api('/api/tokens', { name })).token); setName(''); reload() })
  useEffect(() => { if (location.hash === '#tokens') document.getElementById('tokens')?.scrollIntoView() }, [])
  const [cur, setCur] = useState(''), [next, setNext] = useState(''), [done, setDone] = useState(false)
  const pass = useSubmit(async () => { await api('/api/password', { current: cur, password: next }, 'PUT'); setCur(''); setNext(''); setDone(true) })
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
    <h2>connect your agent</h2>
    <p>1. install the skill for Claude Code, Codex, Cursor and other Agent Skills tools:</p>
    <Code prompt text={`curl -fsSL ${location.origin}/install.sh | sh`} />
    <p>2. make a token below and add it to your shell profile (~/.zshrc or ~/.bashrc):</p>
    {/* the placeholder must stay valid shell: `<token>` pasted into ~/.zshrc is a redirection and a parse error */}
    <Code text={`export DIFFNOTES_URL=${location.origin}\nexport DIFFNOTES_TOKEN=${fresh || 'paste-your-token-here'}`} />
    <p>3. in the browser extension's popup, add this server with the same (or another) token.</p>
    <h2 id="tokens">tokens</h2>
    {fresh && <div className="token"><Code text={fresh} /><span className="hint">copy it now: it is shown only once.</span></div>}
    <div className="list">
      {data?.length ? data.map((t) => <div key={t.id}>
        <span className="grow">{t.name}</span>
        <span className="hint">{t.last_used_at ? `used ${fmt(t.last_used_at)}` : 'never used'}</span>
        <button className="link danger" onClick={() => del(`/api/tokens/${t.id}`, reload, 'Delete this token? Agents and extensions using it stop working.')}>delete</button>
      </div>) : <div className="empty">no tokens yet</div>}
    </div>
    <form className="row" onSubmit={make.submit}>
      <input placeholder="name, e.g. work laptop" value={name} onChange={(e) => setName(e.target.value)} /><button>new token</button>
    </form>
    <h2>password</h2>
    {!me.has_password && <p className="hint">You sign in with GitHub. A password is optional: set one to sign in with your email too.</p>}
    <form className="stack narrow" onSubmit={pass.submit}>
      {me.has_password && <label>current password<input type="password" autoComplete="current-password" value={cur} onChange={(e) => setCur(e.target.value)} /></label>}
      <label>new password<input type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} /></label>
      {pass.error && <div className="error">{pass.error}</div>}
      {done && <div className="ok">password changed, other sessions signed out</div>}
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
  version: string
  accounts: { id: string; name: string; owner: string | null; members: number; repositories: number; pulls: number; bytes: number; created_at: string }[]
  users: { id: string; email: string; name: string; admin: number; accounts: number; created_at: string; token_used_at: string | null; signed_in_at: string | null }[]
}
function Admin({ user }: { user: User }) {
  const { data, error, reload } = useLoad<AdminStats>('/api/admin/stats')
  const [err, setErr] = useState('')
  const flag = async (id: string, admin: boolean) => {
    setErr('')
    try { await api(`/api/admin/users/${id}`, { admin }, 'PUT'); reload() } catch (e) { setErr((e as Error).message) }
  }
  if (error) return <p className="error">{error}</p>
  if (!data) return null
  const t = data.totals, used = t.disk_total_bytes - t.disk_free_bytes
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
      <thead><tr><th>account</th><th>owner</th><th className="num">members</th><th className="num">repos</th><th className="num">PRs</th><th className="num">size</th><th>created</th></tr></thead>
      <tbody>{data.accounts.map((a) => <tr key={a.id}>
        <td><Link to={`/accounts/${a.id}`}>{a.name}</Link></td><td>{a.owner ?? '—'}</td><td className="num">{a.members}</td>
        <td className="num">{a.repositories}</td><td className="num">{a.pulls}</td><td className="num">{bytes(a.bytes)}</td><td>{fmt(a.created_at)}</td>
      </tr>)}</tbody>
    </table></div>
    <h2>users</h2>
    <div className="scroll"><table className="grid">
      <thead><tr><th>user</th><th className="num">accounts</th><th>joined</th><th>last sign-in</th><th>token used</th><th>super admin</th></tr></thead>
      <tbody>{data.users.map((u) => <tr key={u.id}>
        <td>{u.email} <span className="hint">{u.name}</span></td><td className="num">{u.accounts}</td><td>{fmt(u.created_at)}</td>
        <td>{fmt(u.signed_in_at)}</td><td>{fmt(u.token_used_at)}</td>
        <td>{u.id === user.id ? <span className="chip hot">you</span>
          : <input type="checkbox" style={{ width: 'auto' }} checked={!!u.admin} onChange={(e) => flag(u.id, e.target.checked)} aria-label={`super admin: ${u.email}`} />}</td>
      </tr>)}</tbody>
    </table></div>
    {err && <div className="error">{err}</div>}
    <StorageSettings />
  </>
}

type StorageCfg = { kind: 'disk' | 's3'; endpoint?: string; region?: string; bucket?: string; key_id?: string; prefix?: string; has_secret?: boolean }
// endpoint and region examples per provider; any S3-compatible service works
const PRESETS: Record<string, [endpoint: string, region: string, note: string]> = {
  'Backblaze B2': ['https://s3.us-west-004.backblazeb2.com', 'us-west-004',
    'Use the bucket\'s Endpoint from its B2 page; the region is the part after "s3.". Keys: Application Keys → keyID + applicationKey. '
    + 'B2 keeps old versions by default: set the bucket\'s Lifecycle Settings to "Keep only the last version" so deleted files really go.'],
  'Cloudflare R2': ['https://<account-id>.r2.cloudflarestorage.com', 'auto', 'R2 → Manage API tokens → Object Read & Write for this bucket.'],
  'AWS S3': ['https://s3.eu-central-1.amazonaws.com', 'eu-central-1', 'An IAM user with s3:PutObject, s3:GetObject, s3:DeleteObject and s3:PutLifecycleConfiguration on the bucket.'],
  MinIO: ['https://minio.example.com', 'us-east-1', 'Path-style URLs, as MinIO expects by default.'],
}
function StorageSettings() {
  const { data, reload } = useLoad<{ storage: StorageCfg; counts: { backend: string; files: number; bytes: number }[]; retention_days: number }>('/api/admin/storage')
  const [f, setF] = useState<StorageCfg & { secret?: string }>(), [note, setNote] = useState(''), [ok, setOk] = useState('')
  useEffect(() => { if (data) setF({ ...data.storage, secret: '' }) }, [data])
  const save = useSubmit(async () => { setOk(''); await api('/api/admin/storage', f, 'PUT'); setOk(f?.kind === 's3' ? 'bucket checked (write, read, delete) and saved' : 'saved'); reload() })
  const rule = useSubmit(async () => { const r = await api('/api/admin/storage/lifecycle', {}); setOk(`bucket rule set: files under the prefix expire after ${r.days} days`) })
  if (!data || !f) return null
  const set = (k: keyof StorageCfg | 'secret') => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value })
  return <>
    <h2>file storage</h2>
    <p className="hint">Where uploaded screenshots and files go. Existing files stay where they were written.
      {data.counts.map((c) => ` ${c.backend}: ${c.files} files, ${bytes(c.bytes)}.`)}</p>
    <form className="stack card" onSubmit={save.submit}>
      <label>storage
        <select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value as 'disk' | 's3' })}>
          <option value="disk">disk (DATA_DIR/uploads)</option><option value="s3">S3-compatible bucket</option>
        </select></label>
      {f.kind === 's3' && <>
        <div className="presets">{Object.entries(PRESETS).map(([name, [endpoint, region, n]]) =>
          <button type="button" key={name} onClick={() => { setF({ ...f, endpoint, region }); setNote(n) }}>{name}</button>)}</div>
        {note && <p className="hint">{note}</p>}
        <label>endpoint<input value={f.endpoint ?? ''} onChange={set('endpoint')} placeholder="https://s3.us-west-004.backblazeb2.com" /></label>
        <div className="two">
          <label>region<input value={f.region ?? ''} onChange={set('region')} placeholder="auto" /></label>
          <label>bucket<input value={f.bucket ?? ''} onChange={set('bucket')} placeholder="diffnotes-files" /></label>
        </div>
        <div className="two">
          <label>key id<input value={f.key_id ?? ''} onChange={set('key_id')} autoComplete="off" /></label>
          <label>secret key<input type="password" value={f.secret ?? ''} onChange={set('secret')} autoComplete="new-password"
            placeholder={f.has_secret ? 'saved, leave blank to keep' : ''} /></label>
        </div>
        <label>prefix (folder inside the bucket)<input value={f.prefix ?? ''} onChange={set('prefix')} placeholder="diffnotes/" /></label>
      </>}
      {save.error && <div className="error">{save.error}</div>}
      {ok && <div className="ok">{ok}</div>}
      <div><button className="primary" disabled={save.busy}>{save.busy ? 'checking…' : 'save'}</button></div>
    </form>
    {data.storage.kind === 's3' && <div className="card" style={{ marginTop: 12 }}>
      <p>Files are deleted from the bucket when their PR expires ({data.retention_days} days after the last upload). As a safety net, add a bucket
        rule that expires everything under the prefix after {data.retention_days + 1} days. It replaces the bucket's lifecycle rules: use a bucket
        just for DiffNotes. Some providers (Backblaze B2) only accept rules in their console.</p>
      <button type="button" onClick={() => rule.submit()} disabled={rule.busy}>set the expiry rule on the bucket</button>
      {rule.error && <div className="error">{rule.error}</div>}
    </div>}
  </>
}

const APP_PATHS = /^\/(dashboard|settings|admin|accounts\/[\w-]+|pulls\/[\w-]+)$/

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
  if (me === undefined) return null
  const m = (re: RegExp) => path.match(re)?.[1]
  if (!me || !APP_PATHS.test(path)) {
    const invite = m(/^\/invite\/([\w-]+)$/)
    // signed out on an app page: sign in right there, so links from the skill, the extension and install.sh survive
    const login = !me && (path === '/login' || APP_PATHS.test(path))
    return <PublicLayout signedIn={!!me} signup={sign.signup}>{invite ? <Invite token={invite} sign={sign} /> : login ? <Login sign={sign} />
      : path === '/privacy' ? <Privacy /> : path === '/badge' ? <BadgePage />
      : path === '/demo' ? <DemoPage signedIn={!!me} github={sign.github} demo={sign.demo && { url: prUrl(sign.demo.repository, sign.demo.number), label: `${sign.demo.repository} #${sign.demo.number}` }} />
      : <Landing signedIn={!!me} signup={sign.signup} demo={!!sign.demo} />}</PublicLayout>
  }
  let page: ReactNode
  if (m(/^\/accounts\/([\w-]+)$/)) page = <Account key={path} id={m(/^\/accounts\/([\w-]+)$/)!} user={me.user} />
  else if (m(/^\/pulls\/([\w-]+)$/)) page = <PullPage id={m(/^\/pulls\/([\w-]+)$/)!} />
  else if (path === '/settings') page = <Settings me={me} />
  else if (path === '/admin' && me.user.admin) page = <Admin user={me.user} />
  else page = <Dashboard />
  return <AppLayout me={me} path={path}>{page}<Gallery /></AppLayout>
}

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>)
