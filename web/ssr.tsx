// The public pages' HTML for crawlers and link previews: `npm run build` bundles this to dist-ssr/ssr.js, and the server
// (app.ts page()) puts render()'s output in #root. The browser draws its own page over it once /api/me answers (main.tsx).
import { renderToString } from 'react-dom/server'
import type { ReactNode } from 'react'
import { BadgePage, Landing } from './landing.tsx'
import type { ServerInfo } from './landing.tsx'
import { Docs, PublicLayout, Terms } from './main.tsx'

type State = { origin: string; signup: boolean; demo: boolean; info: ServerInfo }
const PAGES: Record<string, (s: State) => ReactNode> = {
  '/': (s) => <Landing signedIn={false} signup={s.signup} demo={s.demo} info={s.info} />, '/docs': () => <Docs />, '/badge': () => <BadgePage />, '/terms': () => <Terms />,
}
export const pages = Object.keys(PAGES)

export function render(path: string, s: State) {
  const page = PAGES[path]
  if (!page) return ''
  // ponytail: the pages read `location` for this server's address; renderToString is synchronous, so a stand-in for the call is safe
  const g = globalThis as { location?: unknown }, was = g.location
  g.location = new URL(s.origin)
  try { return renderToString(<PublicLayout signedIn={false} signup={s.signup} demo={s.demo}>{page(s)}</PublicLayout>) } finally { if (was === undefined) delete g.location; else g.location = was }
}
