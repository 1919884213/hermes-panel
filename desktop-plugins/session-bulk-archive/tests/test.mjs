/**
 * Harness for the session-bulk-archive desktop plugin.
 *
 * Loads the REAL plugin file (./plugin.mjs, a copy of plugin.js) with a stubbed
 * @hermes/plugin-sdk, renders its contributions through react-dom/server, and
 * drives its handlers against the LIVE dashboard REST API on loopback:
 *   - GET requests are really issued (with the app's session token) so the
 *     list/​mapping code is exercised end to end;
 *   - write requests are recorded but NOT sent (dry run), so no session state
 *     is touched.
 */
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'

import * as sdk from '@hermes/plugin-sdk'

import plugin from '../plugin.js'

// Which backend to test against: SBA_BASE / SBA_TOKEN_FILE win; otherwise
// discover a live one — the desktop app spawns a loopback backend per profile
// (ports change on every restart) and each injects its session token into the
// served index.html, so `/` on any of them hands the token out.
async function discoverBackend() {
  const listing = execSync('netstat -ano', { encoding: 'utf8' })
  const ports = [
    ...new Set(
      listing
        .split(/\r?\n/)
        .filter(line => /LISTENING/i.test(line) && line.includes('127.0.0.1:'))
        .map(line => line.trim().split(/\s+/)[1].split(':').pop())
        .filter(port => /^\d+$/.test(port))
    )
  ]
  const candidates = []

  for (const port of ports) {
    const base = `http://127.0.0.1:${port}`

    try {
      const html = await fetch(`${base}/`, { signal: AbortSignal.timeout(800) }).then(response => response.text())
      const token = /window\.__HERMES_SESSION_TOKEN__="([^"]+)"/.exec(html)?.[1]

      if (!token) {
        continue
      }

      const probe = await fetch(`${base}/api/sessions?limit=5&archived=exclude`, {
        headers: { 'X-Hermes-Session-Token': token },
        signal: AbortSignal.timeout(4_000)
      })

      if (!probe.ok) {
        continue
      }

      const body = await probe.text()
      candidates.push({ base, body, port, token })
    } catch {
      // not a Hermes backend — next port
    }
  }

  if (candidates.length === 0) {
    throw new Error('no live Hermes backend found — start the desktop app, or pass SBA_BASE=<url>')
  }

  // Prefer the backend that owns the profile this plugin scopes its writes to.
  return candidates.find(candidate => candidate.body.includes('"profile":"olia"')) || candidates[0]
}

const discovered = process.env.SBA_BASE
  ? { base: process.env.SBA_BASE, port: new URL(process.env.SBA_BASE).port }
  : await discoverBackend()
const BASE = discovered.base
const TOKEN = process.env.SBA_TOKEN_FILE
  ? readFileSync(process.env.SBA_TOKEN_FILE, 'utf8').trim()
  : discovered.token ||
    (await (async () => {
      const html = await fetch(`${BASE}/`).then(response => response.text())
      const match = /window\.__HERMES_SESSION_TOKEN__="([^"]+)"/.exec(html)

      if (!match) {
        throw new Error(`no dashboard session token served by ${BASE}`)
      }

      return match[1]
    })())

console.log(`# testing against ${BASE} (port ${discovered.port})\n`)
const PASS = []
const FAIL = []

function check(label, condition, detail) {
  ;(condition ? PASS : FAIL).push(label)

  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}${detail === undefined ? '' : `  → ${detail}`}`)
}

function render(element) {
  return renderToStaticMarkup(element)
}

function idsIn(html) {
  return [...html.matchAll(/data-sba-row="([^"]+)"/g)].map(match => match[1])
}

const apiCalls = sdk.record.api

globalThis.window = {
  hermesDesktop: {
    api: async request => {
      apiCalls.push(request)

      if (request.method && request.method !== 'GET') {
        return { ok: true, dryRun: true }
      }

      const headers = { 'X-Hermes-Session-Token': TOKEN }
      const init = { headers, method: request.method || 'GET' }

      if (request.body) {
        headers['Content-Type'] = 'application/json'
        init.body = JSON.stringify(request.body)
      }

      const response = await fetch(BASE + request.path, init)

      if (!response.ok) {
        throw new Error(`${response.status} ${await response.text()}`)
      }

      return response.json()
    }
  }
}

// -- register -----------------------------------------------------------------

const contributions = []
const ctx = {
  source: 'plugin:session-bulk-archive',
  i18n: {
    register: bundles => {
      sdk.__i18n.bundles = bundles

      return () => {}
    },
    t: sdk.__translate
  },
  register: contribution => {
    contributions.push(contribution)

    return () => {}
  },
  registerMany: list => {
    for (const contribution of list) {
      contributions.push(contribution)
    }

    return () => {}
  },
  os: {},
  storage: {
    get: (key, fallback) => fallback,
    remove: () => {},
    set: (key, value) => sdk.record.storage.push({ key, value })
  },
  rest: async () => ({}),
  socket: () => () => {},
  onEvent: () => () => {}
}

plugin.register(ctx)

const byId = id => contributions.find(contribution => contribution.id === id)

check(
  'registers sidebar nav row + page + 2 palette commands + keybind, no pane by default',
  contributions.length === 5 &&
    ['cmd-open', 'cmd-pane', 'keybind-open', 'nav', 'page'].every(id => Boolean(byId(id))) &&
    !byId('pane'),
  contributions.map(c => c.id).join(',')
)

// Regression guard: the statusbar chip is gone for good. It used to be the
// dialog's always-mounted host, so if it ever comes back, a dialog came with it.
check(
  'registers NO statusbar contribution (the chip stays removed)',
  !contributions.some(c => String(c.area).startsWith('statusBar')),
  contributions.map(c => `${c.id}@${c.area}`).join(',')
)

// The sidebar row is a navigation row, not a button: it must carry a route and
// sort AFTER Kanban's row (core registers order 50) to sit underneath it.
check(
  'sidebar nav row sorts right below Kanban and points at the page route',
  byId('nav')?.area === 'sidebar.nav' &&
    byId('nav')?.order === 60 &&
    byId('nav')?.data?.path === '/session-archive' &&
    byId('nav')?.data?.codicon === 'archive' &&
    Boolean(byId('nav')?.data?.label),
  JSON.stringify(byId('nav')?.data)
)
check(
  'page contribution claims the same route',
  byId('page')?.area === 'routes' && byId('page')?.data?.path === '/session-archive',
  JSON.stringify(byId('page')?.data)
)
check(
  'palette command opens the page (navigate, not dialog)',
  sdk.record.navigations.length === 0 &&
    (byId('cmd-open').data.run(), sdk.record.navigations.at(-1) === '/session-archive'),
  JSON.stringify(sdk.record.navigations)
)

// The side panel is opt-in: nothing touches the layout until it's asked for.
byId('cmd-pane').data.run()
const paneContribution = byId('pane')
check(
  'palette command registers the side panel on demand (right zone, no dock)',
  paneContribution?.data?.placement === 'right' &&
    paneContribution?.data?.dock === undefined &&
    paneContribution?.data?.width === '340px',
  JSON.stringify(paneContribution?.data)
)
check(
  'side-panel choice is persisted and revealed',
  sdk.record.storage.some(entry => entry.key === 'sidePanel' && entry.value === true) &&
    sdk.record.reveals.some(([kind, id]) => kind === 'reveal' && id === 'session-bulk-archive:pane'),
  JSON.stringify(sdk.record.storage)
)

// -- pane: first paint (loading), then real data ------------------------------

let html = render(byId('pane').render())

check('pane renders while loading', html.includes('data-hermes-plugin="session-bulk-archive"') && html.includes('skeleton'))

await Promise.all(sdk.__pending)
html = render(byId('pane').render())

const renderedIds = idsIn(html)
const listCall = apiCalls.find(call => call.path.startsWith('/api/profiles/sessions?'))

check(
  'list request is the sidebar-shaped profile=all query',
  listCall?.path ===
    '/api/profiles/sessions?limit=300&offset=0&min_messages=0&archived=exclude&order=recent&profile=all' &&
    listCall?.profile === 'olia',
  listCall?.path
)

const direct = await fetch(
  `${BASE}/api/profiles/sessions?limit=300&offset=0&min_messages=0&archived=exclude&order=recent&profile=all`,
  { headers: { 'X-Hermes-Session-Token': TOKEN } }
).then(response => response.json())

const directIds = direct.sessions.map(session => session.id)
check(
  'renders exactly the sessions the app lists',
  renderedIds.length === directIds.length && renderedIds.every(id => directIds.includes(id)),
  `${renderedIds.length} rows vs ${directIds.length} live`
)
check(
  'row titles surface real session text',
  directIds.some(id => html.includes(direct.sessions.find(s => s.id === id).title.slice(0, 12))),
  direct.sessions[0]?.title?.slice(0, 24)
)
check('shows the archive action for the active view', html.includes('归档所选（0）') && html.includes('已选 0 个'))
check(
  'primary action is rendered ABOVE the list (a tall list cannot push it out of a clipped card)',
  html.indexOf('data-sba-action="archive"') > -1 &&
    html.indexOf('data-sba-action="archive"') < html.indexOf('data-sba-list='),
  `action@${html.indexOf('data-sba-action="archive"')} < list@${html.indexOf('data-sba-list=')}`
)

// -- selection (checkbox handlers) -------------------------------------------

sdk.record.checkboxes = []
html = render(byId('pane').render())
const checkboxes = sdk.record.checkboxes
check('one checkbox per rendered row', checkboxes.length === renderedIds.length, String(checkboxes.length))

checkboxes[0].onCheckedChange()
html = render(byId('pane').render())
check('picking one row updates the selection count', html.includes('已选 1 个') && html.includes('归档所选（1）'), '1 row')

sdk.record.checkboxes = []
html = render(byId('pane').render())
sdk.record.checkboxes[2].onCheckedChange()
html = render(byId('pane').render())
check('picking a second row accumulates', html.includes('已选 2 个') && html.includes('归档所选（2）'), '2 rows')

// -- archive through the confirm dialog --------------------------------------

sdk.record.confirms = []
apiCalls.length = 0
html = render(byId('pane').render())
const confirm = sdk.record.confirms.at(-1)

check(
  'confirm dialog previews the archive',
  confirm?.open === false && confirm?.title === '归档 2 个会话？',
  confirm?.title
)

confirm.onConfirm()
await new Promise(resolve => setTimeout(resolve, 50))

const patches = apiCalls.filter(call => call.method === 'PATCH')
check('issues one PATCH per selected session', patches.length === 2, patches.map(call => call.path).join(' '))
check(
  'PATCH shape matches the app: path + archived + owning profile',
  patches.every(
    call =>
      call.path.startsWith('/api/sessions/') &&
      call.body?.archived === true &&
      typeof call.body?.profile === 'string' &&
      call.profile === call.body.profile
  ),
  JSON.stringify(patches[0])
)
check(
  'reports the batch outcome and refreshes its own list',
  sdk.record.notify.some(entry => entry.kind === 'success' && entry.message === '已归档 2 个会话') &&
    sdk.record.invalidations.some(filter => JSON.stringify(filter.queryKey) === '["session-bulk-archive","sessions"]'),
  JSON.stringify(sdk.record.notify.at(-1))
)
html = render(byId('pane').render())
check(
  'clears selection after the batch and keeps the outcome note',
  html.includes('归档所选（0）') && html.includes('已归档 2 个会话')
)

// -- archived view ------------------------------------------------------------

apiCalls.length = 0
sdk.record.segments = []
html = render(byId('pane').render())
sdk.record.segments.at(-1).onChange('archived')
html = render(byId('pane').render())
check('view switch flips the action to restore', html.includes('恢复所选（0）'), 'archived tab')

await Promise.all(sdk.__pending)
html = render(byId('pane').render())
check(
  'archived view asks for archived=only',
  apiCalls.some(call => call.path.includes('archived=only')),
  apiCalls.at(-1)?.path
)

const archivedDirect = await fetch(
  `${BASE}/api/profiles/sessions?limit=300&offset=0&min_messages=0&archived=only&order=recent&profile=all`,
  { headers: { 'X-Hermes-Session-Token': TOKEN } }
).then(response => response.json())

check(
  'archived view lists the live archived rows and offers restore',
  idsIn(html).length === archivedDirect.sessions.length && html.includes('恢复所选（0）'),
  `${idsIn(html).length} archived rows`
)

// -- the full page ------------------------------------------------------------

// NOTE: this runs after the archived-view block, so the page opens on whatever
// tab the shared atoms hold — assert on structure, not on the active tab.
html = render(byId('page').render())
check(
  'contributed page renders the same picker with real rows',
  html.includes('data-sba-list=') && html.includes('会话批量归档') && idsIn(html).length > 0,
  `${idsIn(html).length} rows, ${html.length} chars`
)
check(
  'page keeps the action row above the list and hosts the side-panel switch',
  html.indexOf('data-sba-action="archive"') < html.indexOf('data-sba-list=') &&
    html.includes('data-sba-action="toggle-panel"') &&
    html.includes('在侧边显示常驻面板'),
  'action row + panel toggle live on the page now'
)

// -- palette, keybind, pane --------------------------------------------------

byId('cmd-pane').data.run()
check('palette command reveals the pane', sdk.record.reveals.some(([kind, id]) => kind === 'reveal' && id === 'session-bulk-archive:pane'), JSON.stringify(sdk.record.reveals))

sdk.record.navigations = []
check(
  'keybind navigates to the page too (no dialog anywhere)',
  byId('keybind-open').data.defaults.includes('mod+alt+a') &&
    (byId('keybind-open').data.run(), sdk.record.navigations.at(-1) === '/session-archive') &&
    sdk.record.dialogs.length === 0,
  JSON.stringify(sdk.record.navigations)
)

// -- i18n coverage ------------------------------------------------------------

check(
  'every i18n key resolves (no raw keys rendered)',
  sdk.__i18n.missing.size === 0,
  [...sdk.__i18n.missing].join(',')
)

console.log(`\n${PASS.length} passed, ${FAIL.length} failed`)
if (FAIL.length) {
  console.log(`failed: ${FAIL.join(' | ')}`)
  process.exitCode = 1
}
