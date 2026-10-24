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
const fmt = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
const Link = ({ to, children }: { to: string; children: ReactNode }) =>
  <a href={to} onClick={(e) => { if (!e.metaKey && !e.ctrlKey) { e.preventDefault(); go(to) } }}>{children}</a>
const Md = ({ text }: { text: string }) => <div className="md" dangerouslySetInnerHTML={{ __html: r42Markdown(text) }} />

function useLoad<T>(url: string, deps: unknown[] = []) {
  const [data, setData] = useState<T>(), [error, setError] = useState(''), [n, setN] = useState(0)
  useEffect(() => { api<T>(url).then(setData, (e) => setError(e.message)) }, [url, n, ...deps])
  return { data, error, reload: () => setN(n + 1) }
}

// a form whose submit calls fn and shows its error
function useSubmit(fn: () => Promise<unknown>) {
  const [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setError('')
    try { await fn() } catch (err) { setError((err as Error).message) } finally { setBusy(false) }
  }
  return { submit, error, busy }
}

function Shell({ user, children }: { user: User | null; children: ReactNode }) {
  const logout = async () => { await api('/api/logout', {}); location.href = '/' }
  return <>
    <header className="top">
      <Link to="/"><span className="brand"><img src="/icon.svg" alt="" />Reviews42</span></Link>
      <nav>
        {user ? <>
          <Link to="/">Dashboard</Link>
          <Link to="/settings">Settings</Link>
          <button className="link" onClick={logout}>Log out</button>
        </> : <Link to="/login">Sign in</Link>}
      </nav>
    </header>
    <main>{children}</main>
  </>
}

function Landing() {
  return <>
    <section className="hero">
      <h1>Your agent explains the pull request. Your team reads it on GitHub.</h1>
      <p>Reviews42 is a self-hosted home for PR annotations. A coding agent uploads notes, screenshots and files for the
        lines that matter; the browser extension shows them right inside GitHub's changes view.</p>
      <p><Link to="/login"><span className="btn primary">Sign in</span></Link> <span className="hint">Accounts are by invitation.</span></p>
    </section>
    <div className="three">
      <div className="card"><h3>Agent skill</h3><p>Works with Claude Code, Codex, Cursor and other Agent Skills tools. One command to install, one token to upload.</p></div>
      <div className="card"><h3>Dashboard</h3><p>Accounts, people, repositories and every annotated pull request in one place. Notes expire on their own.</p></div>
      <div className="card"><h3>Chrome extension</h3><p>Connect it once. Open a PR that has notes and they appear next to the diff: expand, collapse, preview.</p></div>
    </div>
    <h2>How it works</h2>
    <ol className="steps">
      <li>You work on a task and open a pull request.</li>
      <li>You ask your agent to annotate it; the skill uploads notes, screenshots and files.</li>
      <li>You share the PR with your team.</li>
      <li>Anyone in your account opens it on GitHub and sees the notes on the changed files and lines.</li>
    </ol>
    <h2>Install the skill</h2>
    <pre>curl -fsSL {location.origin}/install.sh | sh</pre>
  </>
}

function Login() {
  const [email, setEmail] = useState(''), [password, setPassword] = useState('')
  const { submit, error, busy } = useSubmit(async () => { await api('/api/login', { email, password }); location.href = '/' })
  return <div className="narrow">
    <h1>Sign in</h1>
    <form className="stack" onSubmit={submit}>
      <label>Email<input autoFocus autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} /></label>
      <label>Password<input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} /></label>
      {error && <div className="error">{error}</div>}
      <button className="primary" disabled={busy}>Sign in</button>
      <p className="hint">No account? Ask a teammate for an invitation link.</p>
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
    <h1>Join {data.account}</h1>
    <p className="hint">Invitation for {data.email}.{data.exists && ' You already have an account: enter your password to join.'}</p>
    <form className="stack" onSubmit={submit}>
      {!data.exists && <label>Your name<input autoFocus value={name} onChange={(e) => setName(e.target.value)} /></label>}
      <label>{data.exists ? 'Password' : 'Choose a password (8+ characters)'}
        <input type="password" autoComplete={data.exists ? 'current-password' : 'new-password'} value={password} onChange={(e) => setPassword(e.target.value)} /></label>
      {error && <div className="error">{error}</div>}
      <button className="primary" disabled={busy}>Join</button>
    </form>
  </div>
}

type Dash = { accounts: { id: string; name: string; role: string }[]; pulls: (Pull & { annotations: number })[]; retention_days: number }
function Dashboard() {
  const { data, reload } = useLoad<Dash>('/api/dashboard')
  const [name, setName] = useState('')
  const { submit, error } = useSubmit(async () => { await api('/api/accounts', { name }); setName(''); reload() })
  if (!data) return null
  return <>
    <h1>Dashboard</h1>
    <h2>Annotated pull requests</h2>
    <div className="list">
      {data.pulls.length ? data.pulls.map((p) => <div key={p.id}>
        <span className="mono">{p.repository}#{p.number}</span>
        <span className="grow"><Link to={`/pulls/${p.id}`}>{p.title || 'Untitled'}</Link></span>
        <span className="chip">{p.annotations} notes</span>
        <a href={`https://github.com/${p.repository}/pull/${p.number}/changes`} target="_blank" rel="noreferrer">GitHub ↗</a>
      </div>) : <div className="empty">Nothing yet. Install the skill (see Settings) and ask your agent to annotate a pull request.</div>}
    </div>
    <p className="hint">Annotations are kept for {data.retention_days} days after the last upload.</p>
    <h2>Accounts</h2>
    <div className="list">
      {data.accounts.map((a) => <div key={a.id}>
        <span className="grow"><Link to={`/accounts/${a.id}`}>{a.name}</Link></span><span className="chip">{a.role}</span>
      </div>)}
    </div>
    <form className="row" style={{ marginTop: 12 }} onSubmit={submit}>
      <input placeholder="New account (team) name" value={name} onChange={(e) => setName(e.target.value)} />
      <button>Create</button>
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
function Account({ id, user }: { id: string; user: User }) {
  const { data, error: loadError, reload } = useLoad<Acc>(`/api/accounts/${id}`)
  const [email, setEmail] = useState(''), [repo, setRepo] = useState('')
  const invite = useSubmit(async () => { await api(`/api/accounts/${id}/invites`, { email }); setEmail(''); reload() })
  const addRepo = useSubmit(async () => { await api(`/api/accounts/${id}/repositories`, { full_name: repo }); setRepo(''); reload() })
  const del = async (url: string) => { if (confirm('Are you sure?')) { await api(url, undefined, 'DELETE'); reload() } }
  if (loadError) return <p className="error">{loadError}</p>
  if (!data) return null
  const owner = data.role === 'owner' || !!user.admin
  return <>
    <h1>{data.account.name}</h1>
    <h2>Repositories</h2>
    <div className="list">
      {data.repositories.length ? data.repositories.map((r) => <div key={r.id}>
        <a className="grow mono" href={`https://github.com/${r.full_name}`} target="_blank" rel="noreferrer">{r.full_name}</a>
        <span className="chip">{r.pulls} PRs</span>
        {owner && <button className="link danger" onClick={() => del(`/api/repositories/${r.id}`)}>remove</button>}
      </div>) : <div className="empty">No repositories yet. They are added on the first upload, or here.</div>}
    </div>
    <form className="row" style={{ marginTop: 12 }} onSubmit={addRepo.submit}>
      <input placeholder="owner/name" value={repo} onChange={(e) => setRepo(e.target.value)} /><button>Add</button>
    </form>
    {addRepo.error && <div className="error">{addRepo.error}</div>}
    <h2>Members</h2>
    <div className="list">
      {data.members.map((m) => <div key={m.id}>
        <span className="grow">{m.name || m.email} <span className="hint">{m.name && m.email}</span></span><span className="chip">{m.role}</span>
        {owner && m.id !== user.id && <button className="link danger" onClick={() => del(`/api/accounts/${id}/members/${m.id}`)}>remove</button>}
      </div>)}
    </div>
    {owner && <>
      <h2>Invitations</h2>
      {!!data.invites.length && <div className="list" style={{ marginBottom: 12 }}>
        {data.invites.map((i) => <div key={i.token}>
          <span className="grow">{i.email} <span className="hint">until {fmt(i.expires_at)}</span></span>
          <button className="link" onClick={() => navigator.clipboard.writeText(`${location.origin}/invite/${i.token}`)}>copy link</button>
          <button className="link danger" onClick={() => del(`/api/accounts/${id}/invites/${i.token}`)}>revoke</button>
        </div>)}
      </div>}
      <form className="row" onSubmit={invite.submit}>
        <input type="email" placeholder="teammate@company.com" value={email} onChange={(e) => setEmail(e.target.value)} /><button>Invite</button>
      </form>
      {invite.error && <div className="error">{invite.error}</div>}
      <p className="hint">Send them the invitation link; it works for 7 days.</p>
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
    <p className="mono hint">{data.repository}#{data.number} · updated {fmt(data.updated_at)} · expires {fmt(data.expires_at)}</p>
    <h1>{data.title || 'Untitled pull request'}</h1>
    <p><a className="btn primary" href={gh} target="_blank" rel="noreferrer">Open on GitHub ↗</a></p>
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
  const remove = async (id: string) => { if (confirm('Delete this token? Agents and extensions using it stop working.')) { await api(`/api/tokens/${id}`, undefined, 'DELETE'); reload() } }
  return <>
    <h1>Settings</h1>
    <h2>Connect your agent</h2>
    <p>1. Install the skill for Claude Code, Codex, Cursor and other Agent Skills tools:</p>
    <pre>curl -fsSL {location.origin}/install.sh | sh</pre>
    <p>2. Make a token below and add it to your shell profile:</p>
    <pre>{`export REVIEWS42_URL=${location.origin}\nexport REVIEWS42_TOKEN=${fresh || '<token>'}`}</pre>
    <p>3. In the Chrome extension's popup, enter this server's address and the same (or another) token.</p>
    <h2>Tokens</h2>
    {fresh && <p className="token mono">{fresh}<br /><span className="hint">Copy it now: it is shown only once.</span></p>}
    <div className="list">
      {data?.length ? data.map((t) => <div key={t.id}>
        <span className="grow">{t.name}</span>
        <span className="hint">{t.last_used_at ? `used ${fmt(t.last_used_at)}` : 'never used'}</span>
        <button className="link danger" onClick={() => remove(t.id)}>delete</button>
      </div>) : <div className="empty">No tokens yet.</div>}
    </div>
    <form className="row" style={{ marginTop: 12 }} onSubmit={make.submit}>
      <input placeholder="Name, e.g. work laptop" value={name} onChange={(e) => setName(e.target.value)} /><button>New token</button>
    </form>
    <h2>Password</h2>
    <form className="stack narrow" onSubmit={pass.submit}>
      <label>Current password<input type="password" autoComplete="current-password" value={cur} onChange={(e) => setCur(e.target.value)} /></label>
      <label>New password<input type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} /></label>
      {pass.error && <div className="error">{pass.error}</div>}
      {done && <div className="hint">Password changed.</div>}
      <button disabled={pass.busy}>Change password</button>
    </form>
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
  else if (m(/^\/accounts\/([\w-]+)$/)) page = <Account id={m(/^\/accounts\/([\w-]+)$/)!} user={user} />
  else if (m(/^\/pulls\/([\w-]+)$/)) page = <PullPage id={m(/^\/pulls\/([\w-]+)$/)!} />
  else if (path === '/settings') page = <Settings />
  else page = <Dashboard />
  return <Shell user={user}>{page}</Shell>
}

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>)
