import { StrictMode, useEffect, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import '../extension/markdown.js'
import './styles.css'

declare global { var r42Markdown: (md: string) => string }

type User = { id: string; email: string; name: string; admin: number }
type Annotation = { path: string; line: number | null; end_line: number | null; side: string; title: string; body: string }
type Pull = { id: string; repository: string; number: number; title: string; summary: string; updated_at: string; expires_at: string; annotations: Annotation[] }

async function api<T = any>(url: string, body?: unknown, method?: string): Promise<T> {
  const res = await fetch(url, {
    method: method ?? (body === undefined ? 'GET' : 'POST'),
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`)
  return data
}
const go = (to: string) => { history.pushState(null, '', to); dispatchEvent(new PopStateEvent('popstate')) }
const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '—')
const bytes = (n: number) => {
  const u = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++ }
  return `${i ? n.toFixed(1) : n} ${u[i]}`
}
const Link = ({ to, children, className }: { to: string; children: ReactNode; className?: string }) =>
  <a href={to} className={className} onClick={(e) => { if (!e.metaKey && !e.ctrlKey) { e.preventDefault(); go(to) } }}>{children}</a>
const Md = ({ text }: { text: string }) => <div className="md" dangerouslySetInnerHTML={{ __html: r42Markdown(text) }} />
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

function Shell({ user, path, children }: { user: User | null; path: string; children: ReactNode }) {
  const logout = async () => { await api('/api/logout', {}); location.href = '/' }
  const on = (p: string) => (path === p || (p !== '/' && path.startsWith(p)) ? 'on' : undefined)
  return <>
    <header className="top">
      <Link to="/" className="brand"><img src="/icon.svg" alt="" />reviews42<span className="cursor">_</span></Link>
      <nav>
        {user ? <>
          <Link to="/" className={on('/')}>dashboard</Link>
          <Link to="/settings" className={on('/settings')}>settings</Link>
          {!!user.admin && <Link to="/admin" className={on('/admin')}>admin</Link>}
          <button className="link" onClick={logout}>logout</button>
        </> : <Link to="/login" className="btn primary">sign in</Link>}
      </nav>
    </header>
    <main>{children}</main>
    <footer className="foot">
      <span>reviews42 · self-hosted PR annotations</span>
      <a href="/skill/SKILL.md">agent skill</a>
      <a href="https://github.com/igorkasyanchuk/reviews42" target="_blank" rel="noreferrer">source</a>
    </footer>
  </>
}

// the terminal on the landing page: lines appear one after another
const TERM: [string, string][] = [
  ['p', '$ curl -fsSL {host}/install.sh | sh'],
  ['o', 'installed: ~/.claude/skills/reviews42'],
  ['o', 'installed: ~/.agents/skills/reviews42'],
  ['p', '$ claude "annotate PR #42 with reviews42"'],
  ['o', '· reading diff: 6 files, 11 changed blocks (tests skipped)'],
  ['o', '· screenshot: checkout-after.png'],
  ['a', '✓ uploaded 9 notes + 1 file → {host}/pulls/8f3c…'],
  ['p', '$ open github.com/acme/shop/pull/42/changes'],
  ['o', '  notes show up next to the diff for your whole team'],
]
function Landing() {
  const host = location.host
  return <>
    <section className="hero">
      <div>
        <h1>Your agent explains the PR. <em>Your team reads it on GitHub.</em></h1>
        <p>Self-hosted home for pull request annotations. A coding agent uploads notes, screenshots and files for the
          lines that matter; the browser extension draws them inside GitHub's diff.</p>
        <p><Link to="/login" className="btn primary">sign in →</Link> <span className="hint">accounts are invite-only</span></p>
      </div>
      <div className="term" aria-label="Example terminal session">
        <div className="chrome"><i /><i /><i /><span>~/acme/shop — zsh</span></div>
        <div className="body">
          {TERM.map(([k, t], i) => <div key={i} className={`line ${k}`} style={{ animationDelay: `${0.3 + i * 0.45}s` }}>{t.replaceAll('{host}', host)}</div>)}
          <div className="line p" style={{ animationDelay: `${0.3 + TERM.length * 0.45}s` }}>$ <span className="block" /></div>
        </div>
      </div>
    </section>
    <div className="three">
      <div className="card"><h3>agent skill</h3><p>Claude Code, Codex, Cursor and other Agent Skills tools. One command to install, one token to upload.</p></div>
      <div className="card"><h3>dashboard</h3><p>Accounts, roles, repositories and every annotated PR. Storage at a glance. Notes expire on their own.</p></div>
      <div className="card"><h3>browser extension</h3><p>Connect one or more servers. Open a PR: notes appear next to the diff, with a sticky summary on top.</p></div>
    </div>
    <h2>how it works</h2>
    <ol className="steps">
      <li>You work on a task and open a pull request.</li>
      <li>You ask your agent to annotate it; the skill uploads notes, screenshots and files.</li>
      <li>You share the PR with your team.</li>
      <li>Everyone in your account opens it on GitHub and reads the notes on the changed lines.</li>
    </ol>
    <h2>install the skill</h2>
    <pre><span className="prompt">$ </span>curl -fsSL {location.origin}/install.sh | sh</pre>
  </>
}

function Login() {
  const [email, setEmail] = useState(''), [password, setPassword] = useState('')
  const { submit, error, busy } = useSubmit(async () => { await api('/api/login', { email, password }); location.href = '/' })
  return <div className="narrow">
    <h1>sign in</h1>
    <form className="stack" onSubmit={submit}>
      <label>email<input autoFocus autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} /></label>
      <label>password<input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} /></label>
      {error && <div className="error">{error}</div>}
      <button className="primary" disabled={busy}>sign in</button>
      <p className="hint">No account? Ask a teammate for an invitation link.<br />
        Forgot your password? Your server admin runs <code>npm run reset-password</code>.</p>
    </form>
  </div>
}

function Invite({ token }: { token: string }) {
  const { data, error: loadError } = useLoad<{ email: string; account: string; exists: boolean }>(`/api/invites/${token}`)
  const [name, setName] = useState(''), [password, setPassword] = useState('')
  const { submit, error, busy } = useSubmit(async () => { await api(`/api/invites/${token}/accept`, { name, password }); location.href = '/' })
  if (loadError) return <p className="error">{loadError}</p>
  if (!data) return null
  return <div className="narrow">
    <h1>join {data.account}</h1>
    <p className="hint">Invitation for {data.email}.{data.exists && ' You already have an account: enter your password to join.'}</p>
    <form className="stack" onSubmit={submit}>
      {!data.exists && <label>your name<input autoFocus value={name} onChange={(e) => setName(e.target.value)} /></label>}
      <label>{data.exists ? 'password' : 'choose a password (8+ characters)'}
        <input type="password" autoComplete={data.exists ? 'current-password' : 'new-password'} value={password} onChange={(e) => setPassword(e.target.value)} /></label>
      {error && <div className="error">{error}</div>}
      <button className="primary" disabled={busy}>join</button>
    </form>
  </div>
}

const PullList = ({ pulls }: { pulls: (Pull & { annotations: number; uploader?: string })[] }) =>
  <div className="list">
    {pulls.length ? pulls.map((p) => <div key={p.id}>
      <span className="mono hint">{p.repository}#{p.number}</span>
      <span className="grow"><Link to={`/pulls/${p.id}`}>{p.title || 'untitled'}</Link></span>
      <span className="chip hot">{p.annotations} notes</span>
      <span className="hint">{fmt(p.updated_at)}</span>
      <a href={`https://github.com/${p.repository}/pull/${p.number}/changes`} target="_blank" rel="noreferrer">github ↗</a>
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
  repositories: { id: string; full_name: string; pulls: number }[]
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
  return <>
    <div className="head"><h1>{data.account.name}</h1><span className="chip hot">{data.role}</span></div>
    <div className="tabs">
      {TABS.filter((t) => t !== 'settings' || admin).map((t) => <button key={t} className={tab === t ? 'on' : ''} onClick={() => pick(t)}>{t}</button>)}
    </div>
    {tab === 'overview' && <AccountOverview id={id} />}
    {tab === 'members' && <Members id={id} data={data} admin={admin} user={user} reload={reload} />}
    {tab === 'repositories' && <Repositories id={id} data={data} admin={admin} reload={reload} />}
    {tab === 'settings' && admin && <AccountSettings id={id} data={data} user={user} reload={reload} />}
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
const del = async (url: string, reload: () => void, what = 'Are you sure?') => { if (confirm(what)) { await api(url, undefined, 'DELETE'); reload() } }

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

function Repositories({ id, data, admin, reload }: TabProps) {
  const [repo, setRepo] = useState('')
  const add = useSubmit(async () => { await api(`/api/accounts/${id}/repositories`, { full_name: repo }); setRepo(''); reload() })
  return <>
    <div className="list">
      {data.repositories.length ? data.repositories.map((r) => <div key={r.id}>
        <a className="grow" href={`https://github.com/${r.full_name}`} target="_blank" rel="noreferrer">{r.full_name}</a>
        <span className="chip">{r.pulls} PRs</span>
        {admin && <button className="link danger" onClick={() => del(`/api/repositories/${r.id}`, reload, `Remove ${r.full_name} and all its notes?`)}>remove</button>}
      </div>) : <div className="empty">no repositories yet. they are added on the first upload{admin && ', or here'}.</div>}
    </div>
    {admin && <>
      <form className="row" onSubmit={add.submit}>
        <input placeholder="owner/name" value={repo} onChange={(e) => setRepo(e.target.value)} /><button>add</button>
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
    await api(`/api/accounts/${id}`, undefined, 'DELETE'); go('/')
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
  const gh = `https://github.com/${data.repository}/pull/${data.number}/changes`
  return <>
    <p className="hint">{data.repository}#{data.number} · updated {fmt(data.updated_at)} · expires {fmt(data.expires_at)}</p>
    <h1>{data.title || 'untitled pull request'}</h1>
    <p><a className="btn primary" href={gh} target="_blank" rel="noreferrer">open on github ↗</a></p>
    {data.summary && <div className="card"><Md text={data.summary} /></div>}
    {[...byFile].map(([file, notes]) => <div className="file" key={file}>
      <h3>{file}</h3>
      {notes.map((n, i) => <div className="note" key={i}>
        <div className="where">{n.line ? `${n.side === 'LEFT' ? 'old ' : ''}line ${n.line}${n.end_line && n.end_line !== n.line ? `–${n.end_line}` : ''}` : 'whole file'}</div>
        {n.title && <div className="title">{n.title}</div>}
        <Md text={n.body} />
      </div>)}
    </div>)}
  </>
}

function Settings() {
  const { data, reload } = useLoad<{ id: string; name: string; created_at: string; last_used_at: string | null }[]>('/api/tokens')
  const [name, setName] = useState(''), [fresh, setFresh] = useState('')
  const make = useSubmit(async () => { setFresh((await api('/api/tokens', { name })).token); setName(''); reload() })
  const [cur, setCur] = useState(''), [next, setNext] = useState(''), [done, setDone] = useState(false)
  const pass = useSubmit(async () => { await api('/api/password', { current: cur, password: next }, 'PUT'); setCur(''); setNext(''); setDone(true) })
  return <>
    <h1>settings</h1>
    <h2>connect your agent</h2>
    <p>1. install the skill for Claude Code, Codex, Cursor and other Agent Skills tools:</p>
    <pre><span className="prompt">$ </span>curl -fsSL {location.origin}/install.sh | sh</pre>
    <p>2. make a token below and add it to your shell profile:</p>
    <pre>{`export REVIEWS42_URL=${location.origin}\nexport REVIEWS42_TOKEN=${fresh || '<token>'}`}</pre>
    <p>3. in the browser extension's popup, add this server with the same (or another) token.</p>
    <h2>tokens</h2>
    {fresh && <p className="token">{fresh}<br /><span className="hint">copy it now: it is shown only once.</span></p>}
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
    <form className="stack narrow" onSubmit={pass.submit}>
      <label>current password<input type="password" autoComplete="current-password" value={cur} onChange={(e) => setCur(e.target.value)} /></label>
      <label>new password<input type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} /></label>
      {pass.error && <div className="error">{pass.error}</div>}
      {done && <div className="ok">password changed, other sessions signed out</div>}
      <button disabled={pass.busy}>change password</button>
    </form>
  </>
}

type AdminStats = {
  totals: Record<'users' | 'accounts' | 'repositories' | 'pulls' | 'annotations' | 'tokens' | 'sessions' | 'invites' | 'uploads_24h' | 'uploads_7d'
    | 'files' | 'upload_bytes' | 'db_bytes' | 'disk_free_bytes' | 'disk_total_bytes', number>
  retention_days: number
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
    <p className="hint">retention: {data.retention_days} days after the last upload.</p>
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
  </>
}

function App() {
  const [path, setPath] = useState(location.pathname), [user, setUser] = useState<User | null>()
  useEffect(() => {
    const on = () => setPath(location.pathname)
    addEventListener('popstate', on)
    api<{ user: User | null }>('/api/me').then((r) => setUser(r.user))
    return () => removeEventListener('popstate', on)
  }, [])
  if (user === undefined) return null
  const m = (re: RegExp) => path.match(re)?.[1]
  let page: ReactNode
  if (m(/^\/invite\/([\w-]+)$/)) page = <Invite token={m(/^\/invite\/([\w-]+)$/)!} />
  else if (!user) page = path === '/login' ? <Login /> : <Landing />
  else if (m(/^\/accounts\/([\w-]+)$/)) page = <Account key={path} id={m(/^\/accounts\/([\w-]+)$/)!} user={user} />
  else if (m(/^\/pulls\/([\w-]+)$/)) page = <PullPage id={m(/^\/pulls\/([\w-]+)$/)!} />
  else if (path === '/settings') page = <Settings />
  else if (path === '/admin' && user.admin) page = <Admin user={user} />
  else page = <Dashboard />
  return <Shell user={user} path={path}>{page}</Shell>
}

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>)
