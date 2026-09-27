/**
 * 会话批量归档 — session-bulk-archive
 *
 * 原生 Hermes Desktop 里归档会话要一个一个点（行内右键 / 悬停菜单）。
 * 这个插件补上「多选 → 一次归档」：
 *
 *   • 侧边栏 Kanban 下方一行「会话归档」→ 打开整页多选列表（/session-archive）
 *   • ⌘K 命令「会话批量归档」/ 快捷键 ⌘⌥A → 同样跳到这个整页（不再弹窗）
 *   • 侧边面板（默认停靠在会话列表那一栏的下方）常驻同一份列表
 *   • 勾选多个会话 → 归档（从侧边栏隐藏）；「已归档」视图里可批量恢复
 *
 * 归档用的是应用自己那条 REST 路径（PATCH /api/sessions/<id>，body 带
 * 会话所属 profile），所以后端 state.db 的签名变化会被 gateway 的
 * change_watcher 抓到并在 ~2s 内广播 sessions.changed，侧边栏自己刷新；
 * 跨窗口再用应用自己的 BroadcastChannel('hermes:sessions') 通知一次。
 *
 * 落盘位置：<HERMES_HOME>/desktop-plugins/session-bulk-archive/plugin.js
 * 文件夹名必须等于插件 id。改这个文件后应用会热重载（也要的话 ⌘K →
 * Reload desktop plugins）。
 *
 * 纯 ESM，不编译：只用 jsx() 调用，不能用 JSX 语法；
 * 只能 import @hermes/plugin-sdk、react、react/jsx-runtime。
 */

import {
  Badge,
  Button,
  Checkbox,
  Codicon,
  ConfirmDialog,
  EmptyState,
  SearchField,
  SegmentedControl,
  Skeleton,
  Tip,
  atom,
  cn,
  haptic,
  host,
  queryClient,
  relativeTime,
  usePluginI18n,
  useQuery,
  useValue,
  KEYBINDS_AREA,
  PALETTE_AREA,
  ROUTES_AREA,
  SIDEBAR_NAV_AREA
} from '@hermes/plugin-sdk'
import { useEffect, useMemo, useRef, useState } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'

const ID = 'session-bulk-archive'
/** Contribution ids get namespaced by the host as `<id>:<localId>`. */
const PANE_ID = `${ID}:pane`
/** Full page route, surfaced as a sidebar nav row right under Kanban. */
const PAGE_PATH = '/session-archive'
const PAGE_LIMIT = 300
const ARCHIVE_CONCURRENCY = 4

const VIEW_ACTIVE = 'active'
const VIEW_ARCHIVED = 'archived'

// -- plugin-local state (shared by the page, the pane and the keybind) -------

/** Selected stored session ids. Always replaced with a new array. */
const $selected = atom([])
const $view = atom(VIEW_ACTIVE)
const $search = atom('')
/** Shift-click anchor, for range selection. */
const $anchor = atom(null)
/** Last action's outcome line, rendered under the list. */
const $note = atom('')
/** Whether the opt-in side panel is registered (default: off). */
const $paneEnabled = atom(false)
/** Set by register() — lets the chip's toggle drive pane registration. */
let setSidePanel = null

/** Focused-profile atom with a fallback: an older desktop may not ship
 *  focusedSessionProfile, and useValue(undefined) would throw in the pane. */
const PROFILE_ATOM = host.state.focusedSessionProfile || host.state.profile || atom('')

// -- data layer: the app's own REST calls -----------------------------------

function desktopBridge() {
  const bridge = typeof window === 'undefined' ? null : window.hermesDesktop

  return bridge && typeof bridge.api === 'function' ? bridge : null
}

/** Owning profile of the chat the user is looking at (falls back to the
 *  gateway's own home). Used as the REQUEST scope so Electron routes to the
 *  right backend; the list itself is cross-profile (profile=all). */
function activeProfile() {
  try {
    const focused = host.state.focusedSessionProfile?.get?.()

    if (focused) {
      return focused
    }
  } catch {
    // atom absent on an older desktop — fall through
  }

  try {
    return host.state.profile?.get?.() || null
  } catch {
    return null
  }
}

async function apiCall(request) {
  const bridge = desktopBridge()

  if (!bridge) {
    throw new Error('桌面 IPC 桥不可用（window.hermesDesktop.api）')
  }

  return bridge.api({ timeoutMs: 30_000, ...request })
}

/** The same list the sidebar shows (all profiles), split by archived state. */
async function fetchSessions(view, profile) {
  const archived = view === VIEW_ARCHIVED ? 'only' : 'exclude'
  const path =
    `/api/profiles/sessions?limit=${PAGE_LIMIT}&offset=0&min_messages=0` +
    `&archived=${archived}&order=recent&profile=all`

  const result = await apiCall({ path, ...(profile ? { profile } : {}) })
  const rows = Array.isArray(result?.sessions) ? result.sessions : []

  return rows.map(row => ({
    id: row.id,
    title: String(row.title || '').trim() || row.id,
    profile: row.profile || '',
    archived: Boolean(row.archived),
    // last_active is epoch SECONDS; relativeTime() wants ms.
    lastActive: typeof row.last_active === 'number' ? row.last_active * 1000 : 0,
    messages: typeof row.message_count === 'number' ? row.message_count : 0,
    pinned: Boolean(row.pinned)
  }))
}

/** Archive / unarchive one session. Mirrors the app's own call: the owning
 *  profile rides in the BODY (the backend picks its target state.db from
 *  body.profile) and again as the request scope (Electron routes by it). */
function setArchived(row, archived) {
  const profile = row.profile || activeProfile() || null

  return apiCall({
    path: `/api/sessions/${encodeURIComponent(row.id)}`,
    method: 'PATCH',
    body: { archived, ...(profile ? { profile } : {}) },
    ...(profile ? { profile } : {})
  })
}

/** Sequential batches of `size`, so 200 selected rows don't open 200 sockets. */
async function runInBatches(items, size, fn) {
  const failures = []

  for (let index = 0; index < items.length; index += size) {
    const slice = items.slice(index, index + size)
    const settled = await Promise.all(
      slice.map(item =>
        Promise.resolve()
          .then(() => fn(item))
          .then(() => null)
          .catch(error => ({ item, error }))
      )
    )

    for (const entry of settled) {
      if (entry) {
        failures.push(entry)
      }
    }
  }

  return failures
}

function refreshEverything() {
  void queryClient.invalidateQueries({ queryKey: [ID, 'sessions'] })

  // Other app windows re-pull the session list. THIS window's sidebar is
  // refreshed by the backend's own sessions.changed broadcast (~2s), which fires
  // because we just wrote to state.db.
  try {
    if (typeof BroadcastChannel !== 'undefined') {
      const channel = new BroadcastChannel('hermes:sessions')

      channel.postMessage(1)
      setTimeout(() => {
        try {
          channel.close()
        } catch {
          // already closed
        }
      }, 1_000)
    }
  } catch {
    // BroadcastChannel unavailable — sessions.changed still covers it
  }
}

function errorMessage(error) {
  if (!error) {
    return '未知错误'
  }

  return String(error.message || error.detail || error || '未知错误')
}

// -- selection helpers ------------------------------------------------------

function selectionIds() {
  return $selected.get()
}

function setSelection(ids) {
  $selected.set([...new Set(ids)])
}

function toggleRow(id, index, ids, shiftKey) {
  const selected = new Set(selectionIds())

  if (shiftKey && $anchor.get() && ids.includes($anchor.get())) {
    const from = ids.indexOf($anchor.get())
    const to = index
    const range = ids.slice(Math.min(from, to), Math.max(from, to) + 1)
    const turnOn = !selected.has(id)

    for (const rowId of range) {
      if (turnOn) {
        selected.add(rowId)
      } else {
        selected.delete(rowId)
      }
    }
  } else if (selected.has(id)) {
    selected.delete(id)
  } else {
    selected.add(id)
  }

  $anchor.set(id)
  setSelection([...selected])
}

// -- UI ---------------------------------------------------------------------

function SessionRow({ row, checked, onToggle, t }) {
  const meta = [
    row.profile || 'default',
    t('metaMessages', row.messages),
    row.lastActive ? relativeTime(row.lastActive) : '',
    row.pinned ? t('pinnedTag') : ''
  ]
    .filter(Boolean)
    .join(' · ')

  return jsxs('div', {
    className: cn(
      'flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 transition-colors',
      'hover:bg-(--chrome-action-hover)',
      checked && 'bg-(--ui-row-active-background)'
    ),
    'data-sba-row': row.id,
    onClick: event => onToggle(event?.shiftKey === true),
    children: [
      jsx(Checkbox, {
        'aria-label': row.title,
        checked,
        onClick: event => event.stopPropagation(),
        onCheckedChange: () => onToggle(false)
      }),
      jsxs('div', {
        className: 'min-w-0 flex-1',
        children: [
          jsx('div', {
            className: 'truncate text-xs font-medium text-foreground/85',
            children: row.title
          }),
          jsx('div', {
            className: 'mt-0.5 truncate text-[0.65rem] text-(--ui-text-quaternary)',
            children: meta
          })
        ]
      })
    ]
  })
}

/** The multi-select list, shared by the page and the pane. The `dialog` variant
 *  is kept for a future popover — nothing calls it today. */
function SessionPicker({ variant }) {
  const t = usePluginI18n(ID)
  const isDialog = variant === 'dialog'
  // Height contract: a PANE gives the picker a definite height, so the list can
  // take the slack (min-h-0 + flex-1). A DIALOG does not — an auto-height column
  // never shrinks a flex-1 child, so the list would grow to its full content
  // height and push the action row out of the dialog. There the list carries an
  // explicit cap and everything else stays shrink-0.
  const listBox = isDialog ? 'max-h-[42vh] shrink-0' : 'min-h-0 flex-1'
  const blockBox = isDialog ? 'shrink-0' : 'flex-1'
  const profile = useValue(PROFILE_ATOM)
  const view = useValue($view)
  const search = useValue($search)
  const selectedIds = useValue($selected)
  const note = useValue($note)
  const [busy, setBusy] = useState(false)
  const [confirming, setConfirming] = useState(false)

  const query = useQuery({
    queryKey: [ID, 'sessions', view, profile || ''],
    queryFn: () => fetchSessions(view, profile),
    refetchInterval: 15_000,
    staleTime: 5_000
  })

  const rows = query.data ?? []
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds])

  const visibleRows = useMemo(() => {
    const needle = search.trim().toLowerCase()

    if (!needle) {
      return rows
    }

    return rows.filter(row => row.title.toLowerCase().includes(needle) || row.id.includes(needle))
  }, [rows, search])

  const visibleIds = useMemo(() => visibleRows.map(row => row.id), [visibleRows])
  const selectedVisible = useMemo(
    () => visibleIds.filter(id => selectedSet.has(id)).length,
    [visibleIds, selectedSet]
  )

  // A view switch invalidates ids from the other view.
  useEffect(() => {
    setSelection([])
    $anchor.set(null)
    $note.set('')
  }, [view])

  const archiving = view !== VIEW_ARCHIVED
  const count = selectedVisible

  async function applySelection() {
    const ids = selectionIds()

    if (ids.length === 0) {
      return
    }

    const byId = new Map(rows.map(row => [row.id, row]))
    const targets = ids.map(id => byId.get(id) || { id, profile: profile || '', archived: !archiving })

    setBusy(true)

    const failures = await runInBatches(targets, ARCHIVE_CONCURRENCY, row => setArchived(row, archiving))

    setBusy(false)
    setSelection([])
    $anchor.set(null)
    refreshEverything()

    const done = targets.length - failures.length

    if (failures.length === 0) {
      const message = archiving ? t('doneArchived', done) : t('doneRestored', done)

      $note.set(message)
      host.notify({ kind: 'success', message })
      haptic('tap')
    } else {
      const message = t('doneFailed', done, failures.length, errorMessage(failures[0].error))

      $note.set(message)
      host.notify({ kind: 'error', message, durationMs: 6_000 })
    }
  }

  const actionLabel = archiving ? t('archiveSelected', count) : t('restoreSelected', count)
  const confirmTitle = archiving ? t('confirmArchiveTitle', count) : t('confirmRestoreTitle', count)
  const confirmBody = archiving ? t('confirmArchiveBody') : t('confirmRestoreBody')
  const confirmAction = archiving ? t('archive') : t('restore')

  // The primary action lives in the TOP toolbar on purpose: a bottom action row
  // is the first thing a tall list pushes out of a clipped dialog, and a
  // disabled-looking/missing archive button is the one thing the user cannot
  // work around. Top placement means it is on screen the moment the dialog
  // opens, before any row is picked.
  const primaryAction = jsx(Button, {
    'data-sba-action': archiving ? 'archive' : 'restore',
    disabled: count === 0,
    onClick: () => setConfirming(true),
    size: 'xs',
    variant: archiving ? 'default' : 'outline',
    children: actionLabel
  })

  const toolbar = jsxs('div', {
    className: 'flex shrink-0 flex-wrap items-center gap-2',
    children: [
      jsx(SegmentedControl, {
        onChange: next => $view.set(next),
        options: [
          { id: VIEW_ACTIVE, label: t('viewActive') },
          { id: VIEW_ARCHIVED, label: t('viewArchived') }
        ],
        value: view
      }),
      jsx(Badge, {
        size: 'xs',
        variant: 'muted',
        children: t('rows', visibleRows.length)
      }),
      jsx('div', { className: 'flex-1' }),
      jsx(Tip, {
        label: t('selectAllTip'),
        children: jsx(Button, {
          'data-sba-action': 'select-all',
          disabled: visibleIds.length === 0,
          onClick: () => {
            haptic('tap')
            setSelection([...selectionIds(), ...visibleIds])
          },
          size: 'xs',
          variant: 'ghost',
          children: t('selectAll')
        })
      }),
      jsx(Button, {
        'data-sba-action': 'clear',
        disabled: selectedIds.length === 0,
        onClick: () => {
          setSelection([])
          $anchor.set(null)
        },
        size: 'xs',
        variant: 'ghost',
        children: t('clear')
      }),
      jsx(Button, {
        'data-sba-action': 'refresh',
        onClick: () => {
          haptic('tap')
          void query.refetch()
        },
        size: 'icon-xs',
        variant: 'ghost',
        children: jsx(Codicon, { name: 'refresh', size: '0.8rem' })
      }),
      primaryAction
    ]
  })

  const list = query.isError
    ? jsx('div', {
        className: cn('grid min-h-32 place-items-center px-3 text-center', listBox),
        children: jsxs('div', {
          children: [
            jsx('div', { className: 'text-xs font-medium', children: t('loadFailed') }),
            jsx('div', {
              className: 'mt-1 text-[0.68rem] text-(--ui-text-quaternary)',
              children: errorMessage(query.error)
            }),
            jsx(Button, {
              className: 'mt-2',
              onClick: () => void query.refetch(),
              size: 'xs',
              variant: 'outline',
              children: t('retry')
            })
          ]
        })
      })
    : query.isLoading
      ? jsx('div', {
          className: cn('flex flex-col gap-1.5 px-2 py-1', listBox),
          children: [0, 1, 2, 3, 4].map(index =>
            jsx(Skeleton, { className: 'h-7 w-full rounded-md' }, `skeleton-${index}`)
          )
        })
      : visibleRows.length === 0
        ? jsx('div', {
            className: cn(blockBox),
            children: jsx(EmptyState, {
              className: 'min-h-32',
              description: archiving ? t('emptyActiveHint') : t('emptyArchivedHint'),
              title: archiving ? t('emptyActive') : t('emptyArchived')
            })
          })
        : jsx('div', {
            className: cn('flex flex-col overflow-y-auto overscroll-contain', listBox),
            'data-sba-list': view,
            children: visibleRows.map(row =>
              jsx(
                SessionRow,
                {
                  checked: selectedSet.has(row.id),
                  onToggle: shift => toggleRow(row.id, visibleIds.indexOf(row.id), visibleIds, shift),
                  row,
                  t
                },
                row.id
              )
            )
          })

  return jsxs('div', {
    className: cn('flex flex-col gap-2', isDialog ? 'shrink-0' : 'min-h-0 flex-1'),
    'data-hermes-plugin': ID,
    children: [
      toolbar,
      jsx(SearchField, {
        'aria-label': t('searchLabel'),
        containerClassName: 'w-full shrink-0',
        onChange: $search.set,
        placeholder: t('searchPlaceholder'),
        value: search
      }),
      list,
      jsx('div', {
        className:
          'shrink-0 truncate border-t border-(--ui-stroke-secondary) pt-2 text-[0.68rem] text-(--ui-text-quaternary)',
        'data-sba-note': note || `${selectedIds.length}`,
        children: note || t('selectedCount', selectedIds.length)
      }),
      jsx(ConfirmDialog, {
        confirmLabel: confirmAction,
        description: confirmBody,
        destructive: archiving,
        onClose: () => setConfirming(false),
        onConfirm: applySelection,
        open: confirming,
        title: confirmTitle
      }),
      busy
        ? jsx('div', {
            className: 'shrink-0 text-[0.68rem] text-(--ui-text-tertiary)',
            'data-sba-busy': '1',
            children: t('working')
          })
        : null
    ]
  })
}

function BulkArchivePane() {
  const t = usePluginI18n(ID)

  return jsxs('div', {
    className: 'flex h-full min-h-0 flex-col gap-2 p-3 text-sm',
    children: [
      jsxs('div', {
        className: 'flex shrink-0 items-baseline justify-between gap-2',
        children: [
          jsx('div', { className: 'font-medium', children: t('paneTitle') }),
          jsx('div', {
            className: 'text-[0.65rem] text-(--ui-text-quaternary)',
            children: t('paneHint')
          })
        ]
      }),
      jsx(SessionPicker, { variant: 'pane' })
    ]
  })
}

/** The full-page surface behind the sidebar nav row. The workspace gives it a
 *  definite height, so the picker's list can take the slack (like a pane).
 *
 *  Keep this chain height-bounded all the way down: the picker's list carries
 *  `overscroll-behavior: contain`, so if it loses its definite height it can
 *  neither scroll itself NOR chain the wheel to an ancestor — the page goes dead
 *  under the cursor (only the scrollbar still works). A page-level
 *  `overflow-y-auto` here is exactly that mistake: the list grows to content
 *  height, the page becomes the scroller, and the wheel is swallowed. */
function BulkArchivePage() {
  const t = usePluginI18n(ID)
  const paneEnabled = useValue($paneEnabled)

  return jsx('div', {
    className: 'flex h-full min-h-0 w-full flex-col p-4 text-sm',
    children: jsxs('div', {
      className: 'mx-auto flex h-full min-h-0 w-full max-w-[56rem] flex-col gap-3',
      children: [
        jsxs('div', {
          className: 'flex shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-2',
          children: [
            jsx('div', { className: 'text-base font-medium', children: t('pageTitle') }),
            jsxs('div', {
              className: 'flex flex-wrap items-center gap-x-4 gap-y-1',
              children: [
                jsx('div', {
                  className: 'text-[0.7rem] text-(--ui-text-quaternary)',
                  children: t('pageHint')
                }),
                // The dialog used to host this switch; the page inherits it.
                jsxs('label', {
                  className:
                    'flex cursor-pointer items-center gap-2 text-[0.7rem] text-(--ui-text-tertiary)',
                  children: [
                    jsx(Checkbox, {
                      'data-sba-action': 'toggle-panel',
                      checked: paneEnabled,
                      onCheckedChange: value => setSidePanel?.(value === true)
                    }),
                    jsx('span', { children: t('sidePanel') })
                  ]
                })
              ]
            })
          ]
        }),
        jsx(SessionPicker, { variant: 'page' })
      ]
    })
  })
}

// -- registration -----------------------------------------------------------

export default {
  id: ID, // must match the folder name
  name: '会话批量归档',
  register(ctx) {
    ctx.i18n.register({
      en: {
        archive: 'Archive',
        archiveSelected: count => `Archive (${count})`,
        clear: 'Clear',
        cmdOpen: 'Bulk archive sessions: open the page',
        cmdPane: 'Bulk archive sessions: show side panel',
        confirmArchiveBody:
          'Archived sessions are hidden from the sidebar. Restore them any time from the "Archived" view.',
        confirmArchiveTitle: count => `Archive ${count} session(s)?`,
        confirmRestoreBody: 'Restored sessions reappear in the sidebar list.',
        confirmRestoreTitle: count => `Restore ${count} session(s)?`,
        doneArchived: count => `Archived ${count} session(s)`,
        doneFailed: (done, failed, reason) => `${done} ok, ${failed} failed: ${reason}`,
        doneRestored: count => `Restored ${count} session(s)`,
        emptyActive: 'Nothing to archive',
        emptyActiveHint: 'No active sessions found for this account.',
        emptyArchived: 'No archived sessions',
        emptyArchivedHint: 'Sessions you archive show up here.',
        loadFailed: 'Could not load sessions',
        metaMessages: count => `${count} msg`,
        navLabel: 'Session archive',
        pageHint: 'Tick the sessions, then archive or restore them in one go',
        pageTitle: 'Bulk archive sessions',
        paneHint: 'archive packs into the sidebar',
        paneTitle: 'Bulk archive sessions',
        pinnedTag: 'pinned',
        restore: 'Restore',
        restoreSelected: count => `Restore (${count})`,
        retry: 'Retry',
        rows: count => `${count} rows`,
        searchLabel: 'Search sessions',
        searchPlaceholder: 'Search title…',
        selectAll: 'All',
        selectAllTip: 'Select every row shown',
        selectedCount: count => `${count} selected`,
        sidePanel: 'Show a persistent side panel (off by default)',
        viewActive: 'Active',
        viewArchived: 'Archived',
        working: 'Working…'
      },
      zh: {
        archive: '归档',
        archiveSelected: count => `归档所选（${count}）`,
        clear: '清空',
        cmdOpen: '会话批量归档：打开页面',
        cmdPane: '会话批量归档：显示侧边面板',
        confirmArchiveBody: '归档后这些会话会从左侧列表隐藏；随时可在「已归档」视图里恢复。',
        confirmArchiveTitle: count => `归档 ${count} 个会话？`,
        confirmRestoreBody: '恢复后这些会话重新出现在左侧列表。',
        confirmRestoreTitle: count => `恢复 ${count} 个会话？`,
        doneArchived: count => `已归档 ${count} 个会话`,
        doneFailed: (done, failed, reason) => `成功 ${done} 个，失败 ${failed} 个：${reason}`,
        doneRestored: count => `已恢复 ${count} 个会话`,
        emptyActive: '没有可归档的会话',
        emptyActiveHint: '当前账号下没有未归档的会话。',
        emptyArchived: '没有已归档的会话',
        emptyArchivedHint: '归档过的会话会出现在这里。',
        loadFailed: '会话列表加载失败',
        metaMessages: count => `${count} 条`,
        navLabel: '会话归档',
        pageHint: '勾选会话，一次归档或恢复',
        pageTitle: '会话批量归档',
        paneHint: '可拖到任意栏位',
        paneTitle: '会话批量归档',
        pinnedTag: '已固定',
        restore: '恢复',
        restoreSelected: count => `恢复所选（${count}）`,
        retry: '重试',
        rows: count => `${count} 条`,
        searchLabel: '搜索会话',
        searchPlaceholder: '搜索标题…',
        selectAll: '全选',
        selectAllTip: '选中当前列出的全部会话',
        selectedCount: count => `已选 ${count} 个`,
        sidePanel: '在侧边显示常驻面板（默认关闭）',
        viewActive: '未归档',
        viewArchived: '已归档',
        working: '处理中…'
      }
    })

    // The side panel is OPT-IN. Registering a pane changes the layout, and a
    // pane docked into the sessions zone can squeeze the session list itself —
    // so the default is the dialog only (zero layout footprint). The toggle
    // lives in the dialog; the palette command turns it on and reveals it.
    function registerPane() {
      return ctx.register({
        id: 'pane',
        area: 'panes',
        title: ctx.i18n.t('paneTitle'),
        data: { placement: 'right', width: '340px' },
        render: () => jsx(BulkArchivePane, {})
      })
    }

    let paneDispose = null

    setSidePanel = enabled => {
      const next = Boolean(enabled)

      $paneEnabled.set(next)
      ctx.storage.set('sidePanel', next)

      if (next && !paneDispose) {
        paneDispose = registerPane()
      } else if (!next && paneDispose) {
        paneDispose()
        paneDispose = null
      }

      if (next) {
        try {
          host.undismissPane?.(PANE_ID)
        } catch {
          // older desktop
        }

        try {
          host.revealPane?.(PANE_ID)
        } catch {
          // older desktop
        }
      }

      return next
    }

    if (ctx.storage.get('sidePanel', false)) {
      $paneEnabled.set(true)
      paneDispose = registerPane()
    }

    // Sidebar nav row + full page — the same pairing the core Kanban plugin
    // uses (page in ROUTES_AREA, row in SIDEBAR_NAV_AREA). Nav rows sort by
    // `order`, and Kanban registers 50, so 60 lands this one right below it.
    ctx.registerMany([
      {
        id: 'page',
        area: ROUTES_AREA,
        data: { path: PAGE_PATH },
        render: () => jsx(BulkArchivePage, {})
      },
      {
        id: 'nav',
        area: SIDEBAR_NAV_AREA,
        order: 60,
        data: { codicon: 'archive', label: ctx.i18n.t('navLabel'), path: PAGE_PATH }
      }
    ])

    // No statusbar chip any more. It used to double as the dialog's
    // always-mounted host, and a dialog has no other permanent home here — so
    // every entry point lands on the page instead (Kanban's model).
    function openPage() {
      host.navigate(PAGE_PATH)
    }

    ctx.registerMany([
      {
        id: 'cmd-open',
        area: PALETTE_AREA,
        data: {
          id: `${ID}.open`,
          keywords: ['archive', 'session', 'bulk', 'page', '会话', '归档', '多选', '页面'],
          label: ctx.i18n.t('cmdOpen'),
          run: openPage
        }
      },
      {
        id: 'cmd-pane',
        area: PALETTE_AREA,
        data: {
          id: `${ID}.pane`,
          keywords: ['archive', 'session', 'panel', '会话', '归档', '面板'],
          label: ctx.i18n.t('cmdPane'),
          run: () => setSidePanel(true)
        }
      },
      {
        id: 'keybind-open',
        area: KEYBINDS_AREA,
        data: {
          category: '会话批量归档',
          defaults: ['mod+alt+a'],
          id: `${ID}.open`,
          label: ctx.i18n.t('cmdOpen'),
          run: openPage
        }
      }
    ])
  }
}
