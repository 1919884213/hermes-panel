/**
 * 会话 Token 详情 · 费用估算 — session-token-detail
 *
 * 状态栏右下角一枚常驻 chip：显示**当前聚焦会话**的上下文占用（填了价格还会带上
 * 花费），点开是明细面板：
 *
 *   • 上下文窗口：占用条、已用/上限、数据来源（实测 or 估算），以及后端给的按类拆分
 *     （系统提示 / 工具定义 / 技能 / 记忆 / 对话 …）
 *   • 会话费用：按你填的价格算出的本会话花费，分项列出（输入 / 输出 / 缓存读 /
 *     缓存写 / 每次调用），口径与 Hermes 自己的定价引擎一致
 *   • Token 计数：输入 / 输出 / 推理 / 合计、API 调用次数、上下文压缩次数
 *   • 性能与缓存：缓存命中率、平均吞吐 t/s、平均延迟 s
 *   • 价格设置：价格输入框（每百万 tokens），按模型分别保存，改完立刻重算；
 *     面板标出当前模型，单价优先按人民币显示，美元原价与汇率收在默认折叠区；
 *     输入框填的是「当前真正在用的价」（网关取回的也填进去），并注明数据来源
 *   • 面板右上角：复制成纯文本、手动刷新
 *
 * 数据两路取，缺一路也照常显示：
 *   1. host.state.focusedUsage —— 后端每 2~3 秒推一次的实时快照，跟着焦点会话走，
 *      不需要发 RPC。chip 上的数字就是它。
 *   2. session.usage / session.context_breakdown —— 打开面板时补一次权威计数和按类
 *      拆分（面板开着时每 3~5 秒续一次）。resume 回来、本进程还没跑过回合的会话，
 *      实时快照是空的，只有这两个 RPC 有数。
 *
 * 费用怎么算（与 agent/usage_pricing.py 的 CanonicalUsage / PricingEntry 同一口径）：
 *   cost = 输入(未命中) × 输入价 + 输出 × 输出价
 *        + 缓存读 × 缓存读价 + 缓存写 × 缓存写价 + 调用次数 × 单次价
 *   Hermes 的 session_input_tokens 就是「缓存未命中」的那部分，prompt_tokens =
 *   input + cache_read + cache_write。usage 里只带一个四舍五入过的 cache_hit_pct，
 *   拿不到 cache_read/write 的原始计数，所以缓存读按命中率推算、缓存写取残差 ——
 *   这两行在面板里标 ≈。
 *
 * 异步：费用不在渲染里算。usage/价格一变就发一个带签名的异步任务（去抖 250ms，
 * 并发只保留最后一次，过期结果丢弃），算完写进 $cost 原子，chip 与面板只读原子。
 * 签名没变就不重算；签名变了但结果还没回来时显示「计算中…」。
 *
 * 落盘：<HERMES_HOME>/desktop-plugins/session-token-detail/plugin.js
 * 文件夹名必须等于插件 id。保存即热重载；没反应就 ⌘K → Reload desktop plugins。
 * 价格存在插件自己的 ctx.storage（localStorage 命名空间 hermes.plugin.<id>.*）。
 *
 * 纯 ESM、不编译：只能写 jsx() 调用，不能写 JSX 语法；只能 import
 * @hermes/plugin-sdk、react、react/jsx-runtime 这三个说明符。
 * 具名导出（computeCost / mergePrices / …）是给 tests/test.mjs 离线测试台用的，
 * 插件 loader 只读 default。
 */

import {
  Button,
  Codicon,
  CopyButton,
  Input,
  Popover,
  PopoverContent,
  PopoverTrigger,
  SegmentedControl,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  atom,
  cn,
  compactNumber,
  haptic,
  host,
  usePluginI18n,
  useQuery,
  useValue
} from '@hermes/plugin-sdk'
import { useEffect, useMemo, useState } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'

const ID = 'session-token-detail'

/** 缺字段一律显示这个，绝不把「后端没上报」画成 0。 */
const DASH = '—'

const COST_DEBOUNCE_MS = 250
const PERSIST_DEBOUNCE_MS = 600

/** 价格配置文件上限：最多 20 个（含 v1 迁移进来的那个）。 */
const MAX_PROFILES = 20

const CHIP_CLASS = cn(
  'inline-flex h-full items-center gap-1 px-1.5 text-[0.6875rem] transition-colors',
  'text-(--ui-text-tertiary) hover:bg-(--chrome-action-hover) hover:text-foreground'
)

// ── 格式化小工具 ────────────────────────────────────────────────────────────
const isRecord = value => Boolean(value) && typeof value === 'object'
const finite = value => (typeof value === 'number' && Number.isFinite(value) ? value : null)
const fmtCount = value => {
  const n = finite(value)
  return n === null ? DASH : compactNumber(n)
}
const fmtPercent = value => {
  const n = finite(value)
  return n === null ? DASH : `${Math.round(n)}%`
}
const fmtTps = value => {
  const n = finite(value)
  return n !== null && n > 0 ? `${Math.round(n)} t/s` : DASH
}
const fmtSeconds = value => {
  const n = finite(value)
  return n !== null && n > 0 ? `${n.toFixed(1)} s` : DASH
}
const fmtUsd = value => {
  const n = finite(value)
  return n !== null && n > 0 ? `$${n.toFixed(4)}` : null
}
const clamped = (value, max = 100) => Math.max(0, Math.min(max, value || 0))

/** 价格字段 → 非负数字。空串 / 乱输入一律当 0。 */
const rateOf = value => {
  const raw = typeof value === 'string' ? value.trim() : value

  if (raw === '' || raw === null || raw === undefined) {
    return 0
  }

  const n = typeof raw === 'number' ? raw : Number(raw)

  return Number.isFinite(n) && n > 0 ? n : 0
}

export const PRICE_KEYS = ['input', 'output', 'cacheRead', 'cacheWrite', 'request']

/** 「此会话独立用」下拉里代表「跟随全局」的那一项（不能是空串，radix 的 value 不接受空）。 */
const BIND_FOLLOW = '__follow'

/** [字段, 名称 key, 提示 key, 是否按百万 token 计价] */
const PRICE_FIELDS = [
  ['input', 'priceInput', 'priceInputHint', true],
  ['output', 'priceOutput', 'priceOutputHint', true],
  ['cacheRead', 'priceCacheRead', 'priceCacheReadHint', true],
  ['cacheWrite', 'priceCacheWrite', 'priceCacheWriteHint', true],
  ['request', 'priceRequest', 'priceRequestHint', false]
]

const fieldOf = id => PRICE_FIELDS.find(field => field[0] === id) || [id, id, id, true]

export function normalizeRates(prices) {
  const rates = {}

  for (const key of PRICE_KEYS) {
    rates[key] = rateOf(prices?.[key])
  }

  return rates
}

const hasAnyRate = rates => PRICE_KEYS.some(key => rates[key] > 0)

/** 「按模型存的手填价」里有没有任何一套非零价（注意：映射本身不是一组单价）。 */
const hasAnyModelRate = byModel => Object.values(byModel || {}).some(entry => hasAnyRate(normalizeRates(entry)))

export function formatMoney(amount, currency = 'CNY') {
  const symbol = currency === 'USD' ? '$' : '¥'
  const n = finite(amount)

  if (n === null) {
    return DASH
  }

  const abs = Math.abs(n)
  const digits = abs >= 1 ? 2 : abs >= 0.01 ? 3 : abs > 0 ? 6 : 2

  return `${symbol}${n.toFixed(digits)}`
}

/**
 * 纯函数：算一次费用。usage 用 Usage/UsageStats 的字段名（camelCase 的 cache_hit_pct …），
 * prices 每百万 tokens 计价（request 是每次调用的固定费，不除以百万）。
 * 拿不到 cache_read/write 原始计数时按命中率推算 + 取残差，并把那两行标 measured: false。
 */
export function computeCost(usage, prices, currency = 'CNY') {
  const rates = normalizeRates(prices)

  if (!usage || !hasAnyRate(rates)) {
    return { currency, parts: [], status: 'unpriced', total: 0 }
  }

  const inputTokens = finite(usage.input)
  const prompt = finite(usage.prompt) ?? inputTokens
  const cachePct = finite(usage.cache_hit_pct)
  const measuredRead = finite(usage.cache_read)
  const measuredWrite = finite(usage.cache_write)

  // CanonicalUsage.prompt_tokens = input + cache_read + cache_write，而 input 本身
  // 是「缓存未命中」的那部分 —— 所以残差就是缓存写。
  const cacheRead = measuredRead ?? (prompt !== null && cachePct !== null ? Math.round((prompt * cachePct) / 100) : 0)
  const input = inputTokens ?? (prompt !== null ? Math.max(0, prompt - cacheRead) : 0)
  const cacheWrite = measuredWrite ?? (prompt !== null ? Math.max(0, prompt - input - cacheRead) : 0)

  const parts = [
    { id: 'input', measured: inputTokens !== null, perMillion: true, rate: rates.input, tokens: input },
    { id: 'output', measured: true, perMillion: true, rate: rates.output, tokens: finite(usage.output) ?? 0 },
    { id: 'cacheRead', measured: measuredRead !== null, perMillion: true, rate: rates.cacheRead, tokens: cacheRead },
    { id: 'cacheWrite', measured: measuredWrite !== null, perMillion: true, rate: rates.cacheWrite, tokens: cacheWrite },
    { id: 'request', measured: true, perMillion: false, rate: rates.request, tokens: finite(usage.calls) ?? 0 }
  ].map(part => ({
    ...part,
    cost: part.perMillion ? (part.tokens * part.rate) / 1_000_000 : part.tokens * part.rate
  }))

  return { currency, parts, status: 'ready', total: parts.reduce((sum, part) => sum + part.cost, 0) }
}

/** 费用只跟「用量 + 价格」有关：签名没变就不重算。 */
export function costSignature(usage, prices, currency = 'CNY') {
  const rates = normalizeRates(prices)
  const usagePart = usage
    ? `${usage.prompt ?? ''}:${usage.input ?? ''}:${usage.output ?? ''}:${usage.calls ?? ''}:${usage.cache_hit_pct ?? ''}`
    : 'none'

  return [currency, usagePart, ...PRICE_KEYS.map(key => rates[key])].join('|')
}

// ── 价格配置（持久化在 ctx.storage）────────────────────────────────────────
//
// 三层来源，优先级从高到低 —— 目的就一个：换模型不用重新填价格。
//   1. manual   用户手填（按模型存）—— 中转站加价 / 包月 / 想按人民币算，以他为王
//   2. gateway  网关自己的价目表（model.options RPC，$ / Mtok），取回来缓存到本地
//   3. defaults 通用兜底 —— 连网关也不认识的模型（自建 vLLM、自定 endpoint）
//
// 存储形状（v1 只有 currency + byModel，照样读得进来）：
//   { currency, rate, defaults, byModel, gateway: { <model>: { prices, at, provider } } }
export const DEFAULT_RATE = 7.2
export const GATEWAY_TTL_MS = 24 * 60 * 60 * 1000

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/** 存储形状规整（v1 → v2 兼容；坏输入一律退回空配置）。 */
export function parseStoredPrices(raw) {
  const config = {
    activeProfile: '',
    byModel: {},
    currency: 'CNY',
    defaults: {},
    gateway: {},
    profiles: {},
    rate: DEFAULT_RATE,
    sessions: {}
  }

  if (!isRecord(raw)) {
    return config
  }

  config.currency = raw.currency === 'USD' ? 'USD' : 'CNY'

  const rate = finite(raw.rate)

  if (rate !== null && rate > 0) {
    config.rate = rate
  }

  if (isRecord(raw.byModel)) {
    for (const [model, entry] of Object.entries(raw.byModel)) {
      const rates = normalizeRates(entry)

      if (model && hasAnyRate(rates)) {
        config.byModel[model] = rates
      }
    }
  }

  config.defaults = normalizeRates(isRecord(raw.defaults) ? raw.defaults : {})

  if (isRecord(raw.gateway)) {
    for (const [model, entry] of Object.entries(raw.gateway)) {
      // 缓存是 { at, prices, provider }（prices 嵌一层）；扁平形状也认，兼容手改过的配置。
      const prices = normalizeRates(isRecord(entry?.prices) ? entry.prices : entry)

      if (model && isRecord(entry) && hasAnyRate(prices)) {
        config.gateway[model] = { at: finite(entry.at) ?? 0, prices, provider: String(entry.provider ?? '') }
      }
    }
  }

  // ── v2：价格配置文件（最多 MAX_PROFILES 个，每个都能改名改价）─────────────
  // profile = { id, name, prices, tiers?, tierLock? }。prices 是「第一档/不分档」那套
  // 五项单价；tiers 是可选的上下文分档（v3）。
  if (isRecord(raw.profiles)) {
    for (const [id, entry] of Object.entries(raw.profiles)) {
      if (!id || !isRecord(entry) || config.profiles[id]) {
        continue
      }

      const name = String(entry?.name ?? '').trim()
      const tiers = normalizeTiers(entry?.tiers)
      // 分档时 prices 镜像第一档：任何只认 prices 的老读取路径都不会看到过期的数。
      const prices = tiers ? tiers[0].prices : normalizeRates(entry?.prices)

      // 只要求有名字：价格可以暂时全 0（「新建 → 再填数」是正常操作路径，
      // 若因为还没填就把配置丢掉，用户会觉得「建了又没了」）。
      if (!name) {
        continue
      }

      config.profiles[id] = {
        id,
        name: name.slice(0, 40),
        prices,
        ...(tiers ? { tiers } : {}),
        tierLock: tierLockIndex({ prices, tiers, tierLock: entry?.tierLock })
      }
    }
  } else if (raw.profiles === undefined && (hasAnyModelRate(config.byModel) || hasAnyRate(config.defaults))) {
    // v1 → v2 迁移：老落盘里根本没有 profiles 键 —— 把手填的那套（若有）收编成
    // 「默认配置」，老用户升级不丢配置。注意只在键缺失时做：v2 用户删光全部
    // 配置文件是合法状态，不能每次启动都被重新塞回来。
    const first = Object.values(config.byModel)[0]

    config.profiles.legacy = { id: 'legacy', name: '默认配置', prices: hasAnyRate(first) ? first : config.defaults }
  }

  // 激活指针：只在落盘里明确指定、且该配置真实存在时才认。
  // 特意不做「只有一个配置就自动激活」：v1 迁移进来的那个若被自动激活，等于把老用户
  // 「按模型手填」的行为改成「所有模型都套这套价」，是静默的行为变更。要启用请手动点。
  if (typeof raw.activeProfile === 'string' && config.profiles[raw.activeProfile]) {
    config.activeProfile = raw.activeProfile
  }

  // 会话 → 配置文件绑定：{ <sessionId>: <profileId> }；悬空的绑一律丢弃。
  if (isRecord(raw.sessions)) {
    for (const [sessionId, profileId] of Object.entries(raw.sessions)) {
      if (sessionId && typeof profileId === 'string' && config.profiles[profileId]) {
        config.sessions[sessionId] = profileId
      }
    }
  }

  return config
}

/**
 * 网关价目字符串 → 每百万 tokens 的美元数。
 * hermes_cli/models_pricing._format_price_per_mtok 的输出长这样："$0.27"、"free"、
 * ""（未知）、"?"（解析失败）。
 */
export function parseGatewayPrice(text) {
  if (typeof text !== 'string') {
    return null
  }

  const trimmed = text.trim().toLowerCase()

  if (!trimmed || trimmed === '?') {
    return null
  }

  if (trimmed === 'free') {
    return 0
  }

  const value = Number(trimmed.replace(/[^0-9.eE+-]/g, ''))

  return Number.isFinite(value) && value >= 0 ? value : null
}

const modelKey = name => String(name ?? '').trim().toLowerCase().split('/').pop()

/**
 * 从 model.options 的 payload 里挑出某个模型的价格（原始 USD / Mtok）。
 * 优先当前 provider 行，其次 models 列表里含它的行；键比较忽略大小写与 "provider/" 前缀。
 * 网关只给 input / output / cache（读），缓存写与单次调用费按 0 处理。
 */
export function gatewayPricesFor(payload, model) {
  const providers = Array.isArray(payload?.providers) ? payload.providers : []
  const wanted = modelKey(model)
  const rows = [providers.find(row => row?.is_current), ...providers].filter(Boolean)

  for (const row of rows) {
    const table = isRecord(row?.pricing) ? row.pricing : {}

    for (const [key, entry] of Object.entries(table)) {
      if (modelKey(key) !== wanted) {
        continue
      }

      const prices = {
        cacheRead: parseGatewayPrice(entry?.cache) ?? 0,
        cacheWrite: 0,
        input: parseGatewayPrice(entry?.input) ?? 0,
        output: parseGatewayPrice(entry?.output) ?? 0,
        request: 0
      }

      if (hasAnyRate(prices)) {
        return { prices, provider: String(row.slug ?? '') }
      }
    }
  }

  return null
}

/**
 * 纯函数：四层来源挑一个（配置文件 > 手填 > 网关价目 > 通用默认价；gateway 的价是 USD，标 usd: true）。
 * 配置文件带上下文分档时，按 contextUsed（≈ 下一次请求的输入大小）选档；手动锁定优先。
 */
export function resolvePrices(config, model, sessionId, contextUsed) {
  // 价格配置文件优先：用户主动切换的那套价，压过一切自动来源。
  // 会话独立绑定的配置文件 > 全局激活的配置文件（profileForSession 里已排好）。
  const profile = profileForSession(config, sessionId)
  const tiers = tiersOf(profile)
  const lock = tierLockIndex(profile)
  const tierIndex = lock >= 0 ? lock : tierIndexForContext(profile, contextUsed)
  const tiered = profile ? tiers[tierIndex]?.prices ?? tiers[0].prices : null

  if (profile && hasAnyRate(tiered)) {
    return {
      at: 0,
      contextUsed: finite(contextUsed),
      prices: normalizeRates(tiered),
      profileId: profile.id,
      profileName: profile.name,
      provider: '',
      source: 'profile',
      tierCount: tiers.length,
      tierIndex,
      tierLocked: lock >= 0,
      tierMaxContext: tiers[tierIndex]?.maxContext ?? null,
      usd: false
    }
  }

  const flat = { contextUsed: finite(contextUsed), tierCount: 1, tierIndex: 0, tierLocked: false, tierMaxContext: null }
  const manual = normalizeRates(config?.byModel?.[model])

  if (hasAnyRate(manual)) {
    return { ...flat, at: 0, prices: manual, profileId: '', profileName: '', provider: '', source: 'manual', usd: false }
  }

  const cached = config?.gateway?.[model]
  const gateway = normalizeRates(cached?.prices)

  if (cached && hasAnyRate(gateway)) {
    return { ...flat, at: cached.at ?? 0, prices: gateway, profileId: '', profileName: '', provider: cached.provider ?? '', source: 'gateway', usd: true }
  }

  const defaults = normalizeRates(config?.defaults)

  if (hasAnyRate(defaults)) {
    return { ...flat, at: 0, prices: defaults, profileId: '', profileName: '', provider: '', source: 'defaults', usd: false }
  }

  return { ...flat, at: 0, prices: normalizeRates({}), profileId: '', profileName: '', provider: '', source: 'none', usd: false }
}

/** 美元价目按汇率折成当前显示货币（手填的价按你选的货币原样用）。 */
export function convertPrices(prices, config) {
  const rates = normalizeRates(prices)

  if (config?.currency === 'USD') {
    return rates
  }

  const factor = finite(config?.rate) ?? DEFAULT_RATE
  const converted = {}

  for (const key of PRICE_KEYS) {
    // 收掉浮点尾巴：2.2 × 7.2 = 15.840000000000002 —— 这数会直接填进输入框。
    converted[key] = Math.round(rates[key] * factor * 1e6) / 1e6
  }

  return converted
}

/** 面板与费用引擎真正用的价格：挑来源 + 选档 + 该换算就换算。 */
export function effectivePrices(config, model, sessionId, contextUsed) {
  const resolved = resolvePrices(config, model, sessionId, contextUsed)

  return {
    at: resolved.at,
    contextUsed: resolved.contextUsed,
    converted: resolved.usd && config?.currency !== 'USD',
    prices: resolved.usd ? convertPrices(resolved.prices, config) : resolved.prices,
    profileId: resolved.profileId,
    profileName: resolved.profileName,
    provider: resolved.provider,
    raw: resolved.prices,
    source: resolved.source,
    tierCount: resolved.tierCount ?? 1,
    tierIndex: resolved.tierIndex ?? 0,
    tierLocked: Boolean(resolved.tierLocked),
    tierMaxContext: resolved.tierMaxContext ?? null
  }
}

/** 纯函数：把手填价格合并进配置（全 0 就删掉这个模型，别留空壳）。 */
export function mergePrices(config, model, draft) {
  const byModel = { ...(config?.byModel || {}) }
  const rates = normalizeRates(draft)
  const key = model || 'default'

  if (hasAnyRate(rates)) {
    byModel[key] = rates
  } else {
    delete byModel[key]
  }

  return { ...parseStoredPrices(config), byModel, currency: draft?.currency === 'USD' ? 'USD' : 'CNY' }
}

/** 纯函数：把网关价目写进缓存（带时间戳与 provider）。 */
export function putGatewayPrices(config, model, entry, at) {
  const prices = normalizeRates(entry?.prices)
  const gateway = { ...(config?.gateway || {}) }

  if (model && hasAnyRate(prices)) {
    gateway[model] = { at: finite(at) ?? Date.now(), prices, provider: String(entry?.provider ?? '') }
  }

  return { ...parseStoredPrices(config), gateway }
}

/** 纯函数：把一套价格存成「所有未知模型的通用兜底」。 */
export function setDefaults(config, prices) {
  return { ...parseStoredPrices(config), defaults: normalizeRates(prices) }
}

/** 纯函数：清掉某个模型的手填价（退回网关价 / 默认价）。 */
export function clearManual(config, model) {
  const byModel = { ...(config?.byModel || {}) }

  delete byModel[model]

  return { ...parseStoredPrices(config), byModel }
}

// ── 价格配置文件（v2）────────────────────────────────────────────────────────
// 最多 MAX_PROFILES 个；每个 = { id, name, prices }。用户主动切换「当前配置文件」，
// 也可以把某个会话独立绑定到任意一个配置文件（没绑的会话跟随全局激活的那个）。

/** 生成一个不与现有冲突的 profile id。 */
export function newProfileId(config) {
  const taken = new Set(Object.keys(config?.profiles || {}))
  let n = 1

  while (taken.has(`p${n}`)) {
    n += 1
  }

  return `p${n}`
}

/** 纯函数：新建一个配置文件（满 20 个返回原配置不动；价格可以先空着，之后再填）。 */
export function addProfile(config, name, prices, tiers) {
  const base = parseStoredPrices(config)

  if (Object.keys(base.profiles).length >= MAX_PROFILES) {
    return base
  }

  const id = newProfileId(base)
  const label = String(name ?? '').trim().slice(0, 40) || `配置 ${Object.keys(base.profiles).length + 1}`
  const clean = normalizeTiers(tiers)
  const entry = clean
    ? { id, name: label, prices: clean[0].prices, tierLock: -1, tiers: clean }
    : { id, name: label, prices: normalizeRates(prices), tierLock: -1 }

  return {
    ...base,
    // 第一个建的自动成为激活配置，别让用户建完还得再点一下。
    activeProfile: base.activeProfile || id,
    profiles: { ...base.profiles, [id]: entry }
  }
}

/** 纯函数：改配置文件的名称和/或价格（传 null / undefined 表示该字段不动）。 */
export function updateProfile(config, id, { name, prices, tierIndex } = {}) {
  const base = parseStoredPrices(config)
  const current = base.profiles[id]

  if (!current) {
    return base
  }

  const nextName = name === null || name === undefined ? current.name : String(name).trim().slice(0, 40)

  // 名字不能是空的（空名字的配置在解析时会被丢掉，等于白改）；价格可以全 0。
  if (!nextName) {
    return base
  }

  let next = nextName === current.name ? current : { ...current, name: nextName }

  if (prices !== null && prices !== undefined) {
    // 分档的配置：写到「正在生效的那一档」（tierIndex 缺省落到第一档，**绝不**顺手
    // 把档位删掉 —— 只改价不该改变分档结构）。
    const wanted = finite(tierIndex)
    const index = wanted !== null && wanted >= 0 ? Math.floor(wanted) : 0

    next = next.tiers ? setTierPrices(next, index, prices) : { ...next, prices: normalizeRates(prices) }
  }

  return { ...base, profiles: { ...base.profiles, [id]: next } }
}

/** 纯函数：把某个配置换掉（mutator(profile) → profile）；id 不存在就原样返回。 */
export function mutateProfile(config, id, mutator) {
  const base = parseStoredPrices(config)
  const current = base.profiles[id]

  if (!current) {
    return base
  }

  const next = mutator(current)

  return next ? { ...base, profiles: { ...base.profiles, [id]: next } } : base
}

/** 纯函数：删掉一个配置文件。会话绑定与激活指针一并清干净，不留悬空引用。 */
export function deleteProfile(config, id) {
  const base = parseStoredPrices(config)

  if (!base.profiles[id]) {
    return base
  }

  const profiles = { ...base.profiles }

  delete profiles[id]

  const sessions = {}

  for (const [sessionId, profileId] of Object.entries(base.sessions)) {
    if (profileId !== id) {
      sessions[sessionId] = profileId
    }
  }

  return {
    ...base,
    activeProfile: base.activeProfile === id ? '' : base.activeProfile,
    profiles,
    sessions
  }
}

/** 纯函数：切换全局激活的配置文件（id 必须真实存在）。 */
export function setActiveProfile(config, id) {
  const base = parseStoredPrices(config)

  return base.profiles[id] ? { ...base, activeProfile: id } : base
}

/** 纯函数：把会话绑定到某个配置文件；profileId 为空 = 解绑（跟随全局）。 */
export function bindSessionProfile(config, sessionId, profileId) {
  const base = parseStoredPrices(config)

  if (!sessionId) {
    return base
  }

  const sessions = { ...base.sessions }

  if (profileId && base.profiles[profileId]) {
    sessions[sessionId] = profileId
  } else {
    delete sessions[sessionId]
  }

  return { ...base, sessions }
}

/** 纯函数：这个会话该用哪个配置文件（没绑就用全局激活的；都不在 → null）。 */
export function profileForSession(config, sessionId) {
  const base = parseStoredPrices(config)
  const bound = sessionId ? base.sessions[sessionId] : ''

  return base.profiles[bound ?? ''] ?? base.profiles[base.activeProfile] ?? null
}

// ── 上下文分档（v3）────────────────────────────────────────────────────────
// 有些模型按**输入大小**分价（价目表写成 输入 [0, 272K) 与 [272K, +∞) 两套价）。
// 分档只挂在**价格配置文件**上：
//   profile.tiers = [{ maxContext, prices }, …]  —— 按 maxContext 升序，最后一档
//   maxContext = null 表示无上限（∞）；不足 2 档视为不分档。
//   profile.tierLock = -1 自动（按当前上下文占用选档）或档位下标（手动锁定）。
// 没有 tiers 的一律用 profile.prices —— 老数据、按模型手填、网关价、默认价都走这条。
// 不变式：**选档只按 context_used 判断**（它 ≈ 下一次请求的输入大小），不按会话累计
// prompt（累计值会一路涨过阈值，等于永远套高价）。

/** 「加一档」的默认切点：272K（与常见价目表一致）。 */
export const TIER_THRESHOLD_DEFAULT = 272000

/** 档位数组规整：升序、按上限去重、最后一档强制无上限；不足 2 档返回 null。 */
export function normalizeTiers(raw) {
  if (!Array.isArray(raw)) {
    return null
  }

  const tiers = raw
    .filter(entry => isRecord(entry))
    .map(entry => {
      const maxContext = finite(entry.maxContext)

      return {
        maxContext: maxContext !== null && maxContext > 0 ? Math.round(maxContext) : null,
        prices: normalizeRates(entry.prices)
      }
    })
    .sort((a, b) => (a.maxContext ?? Infinity) - (b.maxContext ?? Infinity))

  const unique = []

  for (const tier of tiers) {
    if (tier.maxContext === null || !unique.some(other => other.maxContext === tier.maxContext)) {
      unique.push(tier)
    }
  }

  if (unique.length < 2) {
    return null
  }

  // 最后一档必须是 ∞：落盘里若没写，就把原来那一档当 ∞ 用（超出部分没有别的价目可依）。
  unique[unique.length - 1].maxContext = null

  return unique
}

/** 这套配置的档位；不分档时返回长度 1 的数组（价 = profile.prices）。 */
export function tiersOf(profile) {
  return normalizeTiers(profile?.tiers) ?? [{ maxContext: null, prices: normalizeRates(profile?.prices) }]
}

/** 手动锁定的档位下标（-1 = 自动；越界一律当自动）。 */
export function tierLockIndex(profile) {
  const lock = finite(profile?.tierLock)
  const count = tiersOf(profile).length

  return lock !== null && lock >= 0 && lock < count ? Math.floor(lock) : -1
}

/** 按「当前上下文占用」落在哪一档（`[0, max) 升序`）；上下文未知按第一档。 */
export function tierIndexForContext(profile, contextUsed) {
  const tiers = tiersOf(profile)
  const used = finite(contextUsed)

  if (used === null) {
    return 0
  }

  for (let index = 0; index < tiers.length; index += 1) {
    if (tiers[index].maxContext === null || used < tiers[index].maxContext) {
      return index
    }
  }

  return tiers.length - 1
}

/** 档位标签：`≤272k` / `>272k`（最后一档拿上一档的上限当起点）。 */
export function tierLabel(tier, index, tiers) {
  if (tier?.maxContext === null) {
    const prev = index > 0 ? tiers[index - 1]?.maxContext : null

    return prev === null || prev === undefined ? '∞' : `>${compactNumber(prev)}`
  }

  return `≤${compactNumber(tier.maxContext)}`
}

/** 纯函数：改某一档的价（不分档时就是改 profile.prices）。 */
export function setTierPrices(profile, index, prices) {
  const tiers = tiersOf(profile)
  const rates = normalizeRates(prices)

  if (!tiers[index]) {
    return { ...profile, prices: rates }
  }

  const next = tiers.map((tier, i) => (i === index ? { ...tier, prices: rates } : tier))
  const clean = normalizeTiers(next)

  return clean ? { ...profile, prices: clean[0].prices, tiers: clean } : { ...profile, prices: next[0].prices, tiers: undefined }
}

/**
 * 纯函数：加一档 —— 原最后一档补上阈值，末尾再补一个无上限档（价复制）。
 * 切点必须**严格大于**已有最后一档的上限，否则两个档会因上限相同被规整成一个
 * （表现就是「点了加档没反应」）；默认 272K，撞上了就按上一档上限翻倍。
 * 加完两档价一样，用户再去改其中一档；锁复位成自动。
 */
export function addTier(profile, threshold) {
  const tiers = tiersOf(profile)
  const last = tiers[tiers.length - 1]
  const lastFinite = [...tiers].reverse().find(item => item.maxContext !== null)?.maxContext ?? null
  const wanted = finite(threshold)
  const asked = wanted !== null && wanted > 0 ? Math.round(wanted) : TIER_THRESHOLD_DEFAULT
  const bound = lastFinite === null ? asked : Math.max(asked, lastFinite * 2)
  const head = tiers.slice(0, -1).concat([{ maxContext: bound, prices: { ...last.prices } }])
  const clean = normalizeTiers(head.concat([{ maxContext: null, prices: { ...last.prices } }]))

  return { ...profile, prices: clean[0].prices, tierLock: -1, tiers: clean }
}

/** 纯函数：删掉一档；只剩一档就退回不分档（价 = 留下的那档）。 */
export function removeTier(profile, index) {
  const tiers = tiersOf(profile)

  if (tiers.length < 2 || !tiers[index]) {
    return profile
  }

  const rest = tiers.filter((_, i) => i !== index).map(tier => ({ ...tier, prices: { ...tier.prices } }))
  const clean = normalizeTiers(rest)

  return clean
    ? { ...profile, prices: clean[0].prices, tierLock: -1, tiers: clean }
    : { ...profile, prices: rest[0].prices, tierLock: -1, tiers: undefined }
}

/** 纯函数：改某一档的输入上限（最后一档是无上限，改不动）；不许越过上一档。 */
export function setTierThreshold(profile, index, value) {
  const tiers = tiersOf(profile)
  const tier = tiers[index]

  if (!tier || tier.maxContext === null) {
    return profile
  }

  const wanted = finite(Number(value))
  const bound = wanted !== null && wanted > 0 ? Math.round(wanted) : tier.maxContext
  const prev = index > 0 ? tiers[index - 1].maxContext : 0

  if (prev !== null && prev !== undefined && bound <= prev) {
    return profile
  }

  const clean = normalizeTiers(tiers.map((item, i) => (i === index ? { ...item, maxContext: bound } : item)))

  return clean ? { ...profile, prices: clean[0].prices, tiers: clean } : profile
}

/** 纯函数：手动锁定某一档；传 -1（或越界值）就是「自动」复位。 */
export function setTierLock(profile, index) {
  const tiers = tiersOf(profile)
  const value = finite(index)

  return { ...profile, tierLock: value !== null && value >= 0 && value < tiers.length ? Math.floor(value) : -1 }
}

const $config = atom(parseStoredPrices(null))
const $draft = atom(null)
const $cost = atom({ signature: '', status: 'idle' })
/** 价格设置区是否摊开（导出给离线测试台：要驱动价格框就得先把它摊开）。 */
export const $pricesOpen = atom(false)
/** 配置文件管理区是否展开（默认展开：这是主入口，收起来用户会找不到）。 */
export const $profilesOpen = atom(true)
/** 上下文构成（按类拆分）是否展开：默认收起 —— 面板已经够长，进度条先给个大概。 */
export const $breakdownOpen = atom(false)
/** 配置文件里正在编辑名字的那个 id（空 = 没有在改名）。 */
export const $renamingProfile = atom('')
/** 美元细节（网关原价 + 汇率）默认收起 —— 平时只看人民币。 */
export const $usdOpen = atom(false)
const $gateway = atom({ at: 0, error: '', model: '', provider: '', status: 'idle' })

/**
 * 草稿起点 = 这个会话当前真正生效的那套价（配置文件 > 按模型手填）。
 * 配置带上下文分档时，起点是**当前生效那一档**的价，并把档位下标一起带上 —— 改价时
 * 才能落回同一档（框里改的 = 正在用的，不变式）。
 */
function draftFor(config, model, sessionId, contextUsed) {
  const base = parseStoredPrices(config)
  const resolved = resolvePrices(base, model, sessionId, contextUsed)
  const values = resolved.profileId ? resolved.prices : base.byModel[model] || {}

  return { currency: base.currency, model, tierIndex: resolved.tierIndex ?? 0, values: { ...values } }
}

// ── 网关价目（model.options RPC）──────────────────────────────────────────

let storageDoor = null

/** register() 时把 ctx.storage 存下来：价格相关的写盘都走它，省得处处传 props。 */
export function setStorageDoor(storage) {
  storageDoor = storage
}

function persistConfig(next) {
  if (storageDoor) {
    void schedulePersist(storageDoor, next)
  }
}

/**
 * 异步取一次网关价目并缓存进配置。同一模型 24 小时内直接复用缓存，除非 force。
 *
 * 这是「换模型不用重新填价格」的主力：deepseek / GLM / 大多数云模型都在网关的价目表里，
 * 取一次存本地，下次换回这个模型零等待零输入。网关侧是「先给缓存、后台预热」，
 * 首次打开可能还没热好 —— 那时等 retryDelay 再问一次（只重试一次，不无脑轮询）。
 */
export async function ensureGatewayPrices({ force = false, model, profile, request, retryDelay = 2500 } = {}) {
  const config = $config.get()

  if (!model || typeof request !== 'function') {
    return { status: 'skipped' }
  }

  const cached = config.gateway?.[model]

  if (!force && cached && Date.now() - (finite(cached.at) ?? 0) < GATEWAY_TTL_MS) {
    return { status: 'cached' }
  }

  $gateway.set({ at: cached?.at ?? 0, error: '', model, provider: cached?.provider ?? '', status: 'fetching' })

  const ask = refresh => request('model.options', { profile, refresh: Boolean(refresh), session_id: undefined })

  try {
    let payload = await ask(force)
    let found = gatewayPricesFor(payload, model)

    if (!found && !force && retryDelay > 0) {
      await sleep(retryDelay)
      payload = await ask(false)
      found = gatewayPricesFor(payload, model)
    }

    if (!found) {
      $gateway.set({ at: cached?.at ?? 0, error: '', model, provider: '', status: 'empty' })

      return { status: 'empty' }
    }

    const at = Date.now()
    const next = putGatewayPrices($config.get(), model, found, at)

    $config.set(next)
    $gateway.set({ at, error: '', model, provider: found.provider, status: 'ready' })
    persistConfig(next)

    return { prices: found.prices, status: 'ready' }
  } catch (error) {
    $gateway.set({ at: cached?.at ?? 0, error: String(error), model, provider: '', status: 'error' })

    return { error: String(error), status: 'error' }
  }
}

// ── 异步费用引擎 ───────────────────────────────────────────────────────────

let costTimer = null
let costToken = 0
let costWaiting = []

/**
 * 异步算一次费用并写进 $cost（chip 与面板只读它）。去抖 COST_DEBOUNCE_MS：一轮回合里
 * usage 每两三秒推一次、价格每敲一个键变一次，只需要算最后一次；计算挪到下一个宏任务，
 * 过期结果直接丢弃（按 token 判定），但被取代的调用方会立刻拿到 { status: 'superseded' }
 * —— 不能让别人 await 一个已经被 clearTimeout 掉的定时器，那样永远不返回。
 */
export function primeCost({ currency = 'CNY', prices, usage }, delay = COST_DEBOUNCE_MS) {
  const signature = costSignature(usage, prices, currency)

  costToken += 1
  const token = costToken
  const superseded = costWaiting

  costWaiting = []
  superseded.forEach(resolve => resolve({ signature, status: 'superseded' }))

  if (costTimer) {
    clearTimeout(costTimer)
  }

  return new Promise(resolve => {
    costWaiting.push(resolve)

    costTimer = setTimeout(() => {
      costTimer = null

      const pending = costWaiting

      costWaiting = []

      Promise.resolve()
        .then(() => computeCost(usage, prices, currency))
        .then(result => {
          const next = { ...result, computedAt: Date.now(), signature }

          if (token === costToken) {
            $cost.set(next)
          }

          pending.forEach(settle => settle(next))
        })
        .catch(error => {
          const next = { error: String(error), signature, status: 'error' }

          if (token === costToken) {
            $cost.set(next)
          }

          pending.forEach(settle => settle(next))
        })
    }, delay)
  })
}

let persistTimer = null
let persistWaiting = []

/** 持久化也去抖：连着敲价格只写一次 localStorage；被取代的调用方立刻返回。 */
export function schedulePersist(storage, next, delay = PERSIST_DEBOUNCE_MS) {
  const superseded = persistWaiting

  persistWaiting = []
  superseded.forEach(resolve => resolve({ status: 'superseded' }))

  if (persistTimer) {
    clearTimeout(persistTimer)
  }

  return new Promise(resolve => {
    persistWaiting.push(resolve)

    persistTimer = setTimeout(() => {
      persistTimer = null

      const pending = persistWaiting

      persistWaiting = []

      Promise.resolve()
        .then(() => storage.set('prices', next))
        .then(() => pending.forEach(settle => settle({ config: next, status: 'saved' })))
        .catch(() => pending.forEach(settle => settle({ config: next, status: 'save-failed' })))
    }, delay)
  })
}

// ── 数据：实时快照 + 两个只读 RPC ──────────────────────────────────────────

/**
 * `session.usage` 是权威计数，`host.state.focusedUsage` 是同一份后端快照的实时推送。
 * 合并时让实时那份覆盖（它是新的），RPC 补齐实时流里还没到的字段。
 */
function useTokenUsage(sessionId, active) {
  const live = useValue(host.state.focusedUsage)
  const query = useQuery({
    enabled: Boolean(sessionId),
    queryFn: () => host.request('session.usage', { session_id: sessionId }),
    queryKey: [ID, 'usage', sessionId || 'none'],
    refetchInterval: active ? 3000 : false,
    retry: 0,
    staleTime: 0
  })

  const usage = useMemo(() => {
    const rpc = isRecord(query.data) ? query.data : null
    const stream = isRecord(live) ? live : null

    if (!rpc && !stream) {
      return null
    }

    return { ...(rpc || {}), ...(stream || {}) }
  }, [live, query.data])

  return { error: query.isError, loading: query.isLoading, refresh: query.refetch, usage }
}

/** 上下文按类拆分：回合进行中不拉（转录每帧都在变，实时快照更准）。 */
function useContextBreakdown(sessionId, open, busy) {
  const active = Boolean(sessionId) && open && !busy
  const query = useQuery({
    enabled: active,
    queryFn: () => host.request('session.context_breakdown', { session_id: sessionId }),
    queryKey: [ID, 'breakdown', sessionId || 'none'],
    refetchInterval: active ? 5000 : false,
    retry: 0,
    staleTime: 0
  })

  return { breakdown: isRecord(query.data) ? query.data : null, loading: query.isLoading && active }
}

// ── 展示件 ─────────────────────────────────────────────────────────────────

/**
 * 统计格：标签在上、数字在下。九个指标排成三列只要三行 —— 换成「一行一指标」
 * 要九行，面板立刻长到看不完（用户反馈过）。
 */
function Stat({ hint, label, value }) {
  return jsxs('div', {
    className: 'flex min-w-0 flex-col gap-0.5',
    title: hint || undefined,
    children: [
      jsx('span', { className: 'truncate text-[0.625rem] text-(--ui-text-quaternary)', children: label }),
      jsx('span', { className: 'truncate tabular-nums text-[0.8125rem] text-foreground', children: value })
    ]
  })
}

function StatGrid({ items }) {
  return jsx('div', {
    className: 'grid grid-cols-3 gap-x-3 gap-y-2',
    children: items.map(item => jsx(Stat, { hint: item[2], label: item[0], value: item[1] }, item[0]))
  })
}

/** 折叠区标题（把自己那块的内容收起/展开，省高度）。 */
function SectionToggle({ count, onToggle, open, title }) {
  return jsxs('button', {
    className: 'flex items-center gap-1 text-[0.6875rem] font-medium text-(--ui-text-tertiary) hover:text-foreground',
    onClick: () => {
      haptic('tap')
      onToggle()
    },
    type: 'button',
    children: [
      jsx(Codicon, { className: cn('shrink-0 transition-transform', !open && '-rotate-90'), name: 'chevron-down', size: '0.75rem' }),
      jsx('span', { children: title }),
      count === null || count === undefined ? null : jsx('span', { className: 'font-normal text-(--ui-text-quaternary)', children: count })
    ]
  })
}

/** 费用分项：左名字，中算式（标 ≈ 的行是推算值），右金额。 */
function CostRow({ currency, hint, label, part }) {
  const formula = `${part.measured ? '' : '≈'}${compactNumber(part.tokens)} × ${part.rate}${part.perMillion ? '/M' : ''}`

  return jsxs('div', {
    className: 'flex items-baseline justify-between gap-2',
    children: [
      jsx('span', { className: 'min-w-0 truncate text-(--ui-text-tertiary)', title: hint, children: label }),
      jsxs('span', {
        className: 'flex shrink-0 items-baseline gap-2',
        children: [
          jsx('span', { className: 'text-[0.6875rem] tabular-nums text-(--ui-text-quaternary)', children: formula }),
          jsx('span', { className: 'tabular-nums text-foreground', children: formatMoney(part.cost, currency) })
        ]
      })
    ]
  })
}

function Stack({ children, title }) {
  return jsxs('div', {
    className: 'flex flex-col gap-1.5',
    children: [
      title ? jsx('p', { className: 'text-[0.6875rem] font-medium text-(--ui-text-tertiary)', children: title }) : null,
      ...children
    ]
  })
}

/** 有按类拆分就按后端给的颜色分段；没有就退化成一根百分比进度条。 */
function ContextBar({ categories, percent, segmentTotal }) {
  if (categories.length) {
    return jsx('div', {
      className: 'flex h-1.5 overflow-hidden rounded-full bg-(--ui-stroke-tertiary)',
      children: categories.map(category =>
        jsx(
          'span',
          {
            className: 'h-full min-w-px',
            style: { background: category.color, width: `${(category.tokens / segmentTotal) * 100}%` }
          },
          category.id
        )
      )
    })
  }

  return jsx('div', {
    className: 'h-1.5 overflow-hidden rounded-full bg-(--ui-stroke-tertiary)',
    children: jsx('span', {
      className: 'block h-full rounded-full bg-(--ui-accent)',
      style: { width: `${clamped(percent)}%` }
    })
  })
}

/** 价格设置：按模型存，改完立刻重算（去抖异步写存储）。 */
function agoText(t, at) {
  const age = Date.now() - (finite(at) ?? 0)

  if (!(age > 60_000)) {
    return t('agoNow')
  }

  if (age < 3_600_000) {
    return t('agoMinutes', Math.round(age / 60_000))
  }

  if (age < 48 * 3_600_000) {
    return t('agoHours', Math.round(age / 3_600_000))
  }

  return t('agoDays', Math.round(age / 86_400_000))
}

/** 网关价目按 $ 显示（它是 USD / Mtok），两位小数够用。 */
const perMillion = value => `$${Number((finite(value) ?? 0).toFixed(4))}`

/** 单价跟着显示货币走，并去掉多余的尾随 0（¥0.720 → ¥0.72）。 */
const fmtRate = (value, currency) =>
  formatMoney(value, currency)
    .replace(/(\.\d*?)0+$/, '$1')
    .replace(/\.$/, '')

const SOURCE_KEYS = { defaults: 'srcDefaults', gateway: 'srcGateway', manual: 'srcManual', none: 'srcNone', profile: 'srcProfile' }
const SOURCE_NOTES = {
  defaults: 'srcNoteDefaults',
  gateway: 'srcNoteGateway',
  manual: 'srcNoteManual',
  none: 'srcNoteNone',
  profile: 'srcNoteProfile'
}

/**
 * 价格配置文件管理区：列出全部配置文件（≤20），每项可
 *   • 单选 → 切换为当前配置（全局激活；被会话独立绑定的会话不受影响）
 *   • ✎ 改名（行内输入框，Enter / 失焦提交）
 *   • ✕ 删除（该文件的会话绑定一并清除）
 * 另有「新建」按钮（从当前生效价一键复制一套，并立即切到它 —— 让价格框接着改的
 * 就是新建的这一个），以及当前会话的独立绑定：
 * 「此会话独立用」下拉选中某个文件后，这个会话的费用就固定按它算，不再跟全局切换走。
 */
function ProfileManager({ seed, sessionId, t }) {
  const config = useValue($config)
  const open = useValue($profilesOpen)
  const renaming = useValue($renamingProfile)
  const [nameDraft, setNameDraft] = useState('')
  const profileIds = Object.keys(config.profiles)
  const boundId = sessionId ? config.sessions[sessionId] || '' : ''
  const activeProfile = profileForSession(config, sessionId)
  const full = profileIds.length >= MAX_PROFILES

  const apply = mutate => {
    haptic('tap')

    const next = mutate($config.get())

    $config.set(next)
    persistConfig(next)
  }

  const beginRename = (id, name) => {
    haptic('tap')
    setNameDraft(name)
    $renamingProfile.set(id)
  }

  const commitRename = id => {
    $renamingProfile.set('')

    // 名字没动就别写存储（省一次无谓的往返与重算）。
    if (nameDraft.trim() && nameDraft.trim() !== config.profiles[id]?.name) {
      apply(config => updateProfile(config, id, { name: nameDraft }))
    }
  }

  const createFromCurrent = () => {
    haptic('tap')

    // 从「当前会话正在生效的那套价」复制一份当起点；一个价都还没有就从空的开始，
    // 建完直接在下面的价格框里填 —— 不能因为「还没有价」就把按钮锁死。
    //
    // 新建之后必须让新配置成为「正在生效」的那一个：价格框写的永远是生效配置
    // （updateDraft 按 effective.profileId 落笔）。否则接着填的数会写回**老配置**，
    // 而新配置是老配置的副本 —— 界面上看就是「新建一个配置，把已创建的配置改了」。
    //   · 这个会话跟随全局 → 新配置设为全局激活（价与刚才一模一样，别的会话费用不变）
    //   · 这个会话独立绑定了某个配置 → 绑定改指新配置（同样是副本，钱不变，只是换了名字）
    const base = $config.get()
    const id = newProfileId(base)
    // 带档位的配置连档位一起复制（否则新建出来的只剩一套价，分档白设）。
    const added = addProfile(base, '', activeProfile?.prices ?? seed, activeProfile?.tiers)
    const next = added.profiles[id]
      ? boundId
        ? bindSessionProfile(added, sessionId, id)
        : setActiveProfile(added, id)
      : added

    $config.set(next)
    persistConfig(next)
  }

  return jsxs('div', {
    className: 'flex flex-col gap-2 rounded-md border border-(--ui-stroke-secondary) p-2',
    children: [
      // 折叠头：标题 + 「n / 20」计数
      jsxs('button', {
        className: 'flex items-center gap-1 text-[0.6875rem] font-medium text-(--ui-text-secondary) hover:text-foreground',
        onClick: () => {
          haptic('tap')
          $profilesOpen.set(!open)
        },
        type: 'button',
        children: [
          jsx(Codicon, {
            className: cn('shrink-0 transition-transform', !open && '-rotate-90'),
            name: 'chevron-down',
            size: '0.75rem'
          }),
          jsx('span', { children: t('sectionProfiles') }),
          jsx('span', { className: 'shrink-0 font-normal text-(--ui-text-quaternary)', children: `${profileIds.length}/${MAX_PROFILES}` }),
          activeProfile ? jsx('span', { className: 'truncate font-normal text-(--ui-text-quaternary)', children: `· ${activeProfile.name}` }) : null
        ]
      }),

      open
        ? jsxs('div', {
            className: 'flex flex-col gap-1.5',
            children: [
              profileIds.length === 0
                ? jsx('p', { className: 'text-[0.6875rem] text-(--ui-text-tertiary)', children: t('profilesEmpty') })
                : null,

              profileIds.map(id => {
                const profile = config.profiles[id]
                const isRenaming = renaming === id

                return jsxs(
                  'div',
                  {
                    className: 'flex items-center gap-1.5 rounded border border-(--ui-stroke-secondary) px-1.5 py-1',
                    children: [
                      // 单选点：选中即全局激活
                      jsx('button', {
                        'aria-label': t('profileActivateHint'),
                        className: cn(
                          'size-3 shrink-0 rounded-full border',
                          config.activeProfile === id ? 'border-(--ui-accent) bg-(--ui-accent)' : 'border-(--ui-stroke-secondary) hover:border-(--ui-accent)'
                        ),
                        onClick: () => apply(config => setActiveProfile(config, id)),
                        title: t('profileActivateHint'),
                        type: 'button'
                      }),
                      isRenaming
                        ? jsx(Input, {
                            className: 'min-w-0 flex-1',
                            onBlur: () => commitRename(id),
                            onChange: event => setNameDraft(event.target.value),
                            onKeyDown: event => {
                              if (event.key === 'Enter') {
                                commitRename(id)
                              } else if (event.key === 'Escape') {
                                $renamingProfile.set('')
                              }
                            },
                            placeholder: profile.name,
                            value: nameDraft
                          })
                        : jsxs('button', {
                            className: 'min-w-0 flex-1 truncate text-left text-[0.75rem] hover:text-foreground',
                            onClick: () => beginRename(id, profile.name),
                            title: t('profileRenameHint'),
                            type: 'button',
                            children: [
                              jsx('span', { className: 'truncate', children: profile.name }),
                              boundId === id
                                ? jsx('span', { className: 'ml-1 shrink-0 text-[0.625rem] text-(--ui-accent)', children: t('profileBoundTag') })
                                : null
                            ]
                          }),
                      jsx('span', {
                        className: 'shrink-0 tabular-nums text-[0.625rem] text-(--ui-text-quaternary)',
                        children: `${fmtRate(profile.prices.input, config.currency)} / ${fmtRate(profile.prices.output, config.currency)}`
                      }),
                      tiersOf(profile).length > 1
                        ? jsx('span', {
                            className: 'shrink-0 text-[0.625rem] text-(--ui-text-quaternary)',
                            title: t('tierCountHint'),
                            children: t('tierCountTag', tiersOf(profile).length)
                          })
                        : null,
                      jsx('button', {
                        'aria-label': t('profileDeleteHint'),
                        className: 'shrink-0 text-(--ui-text-quaternary) hover:text-foreground',
                        onClick: () => apply(config => deleteProfile(config, id)),
                        title: t('profileDeleteHint'),
                        type: 'button',
                        children: jsx(Codicon, { name: 'close', size: '0.7rem' })
                      })
                    ]
                  },
                  id
                )
              }),

              jsx(Button, {
                children: full ? t('profileFull') : t('profileAddBtn'),
                disabled: full,
                onClick: createFromCurrent,
                size: 'micro',
                title: full ? t('profileFullHint') : t('profileAddHint'),
                variant: 'ghost'
              }),

              // 当前会话的独立绑定：默认「跟随全局」，选了某个文件就固定用它。
              // 用 SDK 的 Select（radix，主题化 + 自动 portal）—— 原生 <select> 在深色
              // 面板里是白底、展开一片白，用户明确反馈过。
              sessionId
                ? jsxs('label', {
                    className: 'flex items-center gap-2 pt-1 text-[0.6875rem] text-(--ui-text-tertiary)',
                    children: [
                      jsx('span', { className: 'shrink-0', children: t('sessionBindLabel') }),
                      jsx(Select, {
                        onValueChange: value => apply(config => bindSessionProfile(config, sessionId, value)),
                        value: boundId || BIND_FOLLOW,
                        children: [
                          jsx(SelectTrigger, {
                            className: 'min-w-0 flex-1 text-[0.6875rem]',
                            size: 'sm',
                            children: jsx(SelectValue, {})
                          }),
                          jsx(SelectContent, {
                            children: [
                              jsx(SelectItem, { value: BIND_FOLLOW, children: t('sessionBindFollow') }),
                              ...profileIds.map(id => jsx(SelectItem, { value: id, children: config.profiles[id].name }, id))
                            ]
                          })
                        ]
                      })
                    ]
                  })
                : null
            ]
          })
        : null
    ]
  })
}

/**
 * 档位条：给「按上下文阈值分档」的价格配置选档。
 *   自动    —— 按当前上下文占用（≈ 下一次请求的输入大小）切档，价格随阈值变化；
 *   点某一档 —— 手动锁定为它，不随上下文变化（点回「自动」复位）。
 * 「加一档 / 删掉这一档」决定**是否**分档：只有一档 = 所有输入一个价。
 * 分档只挂在价格配置文件上（手填 / 网关价 / 通用默认价都是单档）。
 */
function TierBar({ contextUsed, editProfile, effective, profile, t }) {
  const tiers = tiersOf(profile)
  const multi = tiers.length >= 2
  const index = Math.min(Math.max(effective.tierIndex ?? 0, 0), tiers.length - 1)
  const tier = tiers[index]
  const prevBound = index > 0 ? tiers[index - 1].maxContext : 0
  const [draft, setDraft] = useState(null)

  // 换了档就把阈值框的临时输入丢掉，免得上一档的草稿串到这一档。
  useEffect(() => {
    setDraft(null)
  }, [index, effective.profileId])

  const commitThreshold = value => {
    setDraft(value)

    const wanted = finite(Number(value))

    // 只提交合法值（正的、且大于上一档的上限）—— 打字中间态留在草稿里，不往回弹。
    if (wanted !== null && wanted > 0 && (prevBound === null || wanted > prevBound)) {
      editProfile(item => setTierThreshold(item, index, wanted))
    }
  }

  return jsxs('div', {
    className: 'mb-2 flex flex-col gap-1.5 rounded border border-(--ui-stroke-secondary) p-1.5',
    children: [
      jsxs('div', {
        className: 'flex items-center justify-between gap-2',
        children: [
          jsxs('span', {
            className: 'flex min-w-0 items-center gap-1 text-[0.6875rem] text-(--ui-text-secondary)',
            children: [
              jsx(Codicon, { className: 'shrink-0', name: 'layers', size: '0.7rem' }),
              jsx('span', { className: 'shrink-0', children: t('tierSection') }),
              multi
                ? jsxs('span', {
                    className: 'truncate text-(--ui-text-quaternary)',
                    children: [
                      t('tierTag', index + 1, tiers.length),
                      effective.tierLocked ? ` · ${t('tierLocked')}` : ''
                    ].join('')
                  })
                : null
            ]
          }),
          jsxs('span', {
            className: 'flex shrink-0 items-center gap-1',
            children: [
              jsx(Button, {
                children: t('tierAddBtn'),
                onClick: () => {
                  haptic('tap')
                  // 切点由 addTier 自己定（默认 272K，撞上已有上限就按上一档翻倍）。
                  editProfile(item => addTier(item))
                },
                size: 'micro',
                title: t('tierAddHint'),
                variant: 'ghost'
              }),
              multi
                ? jsx(Button, {
                    children: t('tierRemoveBtn'),
                    onClick: () => {
                      haptic('tap')
                      editProfile(item => removeTier(item, index))
                    },
                    size: 'micro',
                    title: t('tierRemoveHint'),
                    variant: 'ghost'
                  })
                : null
            ]
          })
        ]
      }),

      multi
        ? jsx(SegmentedControl, {
            onChange: id => {
              haptic('tap')
              editProfile(item => setTierLock(item, id === 'auto' ? -1 : Number(id)))
            },
            options: [
              { id: 'auto', label: t('tierAuto') },
              ...tiers.map((item, i) => ({ id: String(i), label: tierLabel(item, i, tiers) }))
            ],
            value: effective.tierLocked ? String(index) : 'auto'
          })
        : null,

      multi && tier && tier.maxContext !== null
        ? jsxs('label', {
            className: 'flex items-center gap-2 text-[0.6875rem] text-(--ui-text-tertiary)',
            children: [
              jsx('span', { className: 'shrink-0', title: t('tierLimitHint'), children: t('tierLimitLabel') }),
              jsx(Input, {
                inputMode: 'numeric',
                onChange: event => commitThreshold(event.target.value),
                onKeyDown: event => {
                  if (event.key === 'Enter') {
                    setDraft(null)
                  }
                },
                placeholder: String(TIER_THRESHOLD_DEFAULT),
                suffix: 'tok',
                value: draft ?? String(tier.maxContext)
              })
            ]
          })
        : null,

      jsx('p', {
        className: 'text-[0.6875rem] text-(--ui-text-quaternary)',
        children: multi
          ? effective.tierLocked
            ? t('tierHintLocked')
            : finite(contextUsed) === null
              ? t('tierUnknown')
              : t('tierHint')
          : t('tierOffHint')
      })
    ]
  })
}

function PriceEditor({ contextUsed, currency, model, onChange, onCurrency, onReset, open, setOpen, t, values }) {
  const config = useValue($config)
  const gateway = useValue($gateway)
  const profile = useValue(host.state.focusedSessionProfile)
  const sessionId = useValue(host.state.focusedSessionId)
  const effective = effectivePrices(config, model, sessionId, contextUsed)
  const symbol = currency === 'USD' ? '$' : '¥'
  const usdOpen = useValue($usdOpen)
  const fetching = gateway.status === 'fetching' && gateway.model === model
  // 分档操作只作用在「正在生效的配置」上（与价格框同一个落笔目标，别造第二个编辑目标）。
  const tierProfile = effective.profileId ? config.profiles[effective.profileId] : null

  const editProfile = mutator => {
    const next = mutateProfile($config.get(), effective.profileId, mutator)

    $config.set(next)
    persistConfig(next)
  }

  // 没手填过也还没有默认价 → 自动去网关要一次价目。换模型的痛点就靠这一句消掉。
  useEffect(() => {
    if (!model || effective.source !== 'none') {
      return
    }

    void ensureGatewayPrices({ model, profile, request: host.request })
  }, [effective.source, model, profile])

  const fetchGateway = () => {
    haptic('tap')
    void ensureGatewayPrices({ force: true, model, profile, request: host.request })
  }

  const saveDefault = () => {
    haptic('tap')

    const next = setDefaults($config.get(), effective.prices)

    $config.set(next)
    persistConfig(next)
    $pricesOpen.set(true)
  }

  const dropManual = () => {
    haptic('tap')

    const next = clearManual($config.get(), model)

    $config.set(next)
    $draft.set(draftFor(next, model, sessionId, contextUsed))
    persistConfig(next)
  }

  const setRate = value => {
    const rate = finite(Number(value))
    const next = { ...parseStoredPrices($config.get()), rate: rate !== null && rate > 0 ? rate : DEFAULT_RATE }

    $config.set(next)
    persistConfig(next)
  }

  const backendNote =
    gateway.status === 'error'
      ? t('gatewayErr')
      : gateway.status === 'empty' && gateway.model === model
        ? t('gatewayNone')
        : null

  return jsxs('div', {
    className: 'flex flex-col gap-2 rounded-md border border-(--ui-stroke-secondary) p-2',
    children: [
      jsxs('div', {
        className: 'flex items-center justify-between gap-2',
        children: [
          jsxs('button', {
            className: 'flex min-w-0 items-center gap-1 text-[0.6875rem] font-medium text-(--ui-text-secondary) hover:text-foreground',
            onClick: () => {
              haptic('tap')
              setOpen(!open)
            },
            type: 'button',
            children: [
              jsx(Codicon, {
                className: cn('shrink-0 transition-transform', !open && '-rotate-90'),
                name: 'chevron-down',
                size: '0.75rem'
              }),
              jsx('span', { className: 'truncate', children: t('sectionPrices') }),
              jsx('span', { className: 'shrink-0 text-(--ui-text-quaternary)', children: t('priceUnit') })
            ]
          }),
          jsxs('div', {
            className: 'flex shrink-0 items-center gap-1',
            children: [
              jsx(SegmentedControl, {
                onChange: onCurrency,
                options: [
                  { id: 'CNY', label: t('priceCurrencyCny') },
                  { id: 'USD', label: t('priceCurrencyUsd') }
                ],
                value: currency
              }),
              jsx(Button, {
                children: t('priceReset'),
                onClick: () => {
                  haptic('tap')
                  onReset()
                },
                size: 'micro',
                title: t('priceResetHint'),
                variant: 'ghost'
              })
            ]
          })
        ]
      }),

      // 当前到底在用哪套价 + 这套价属于哪个模型：价格按模型分别存，模型名不写
      // 出来最容易搞混；单价用当前显示货币（默认 ¥），美元原价收在下面的折叠区。
      jsxs('div', {
        className: 'flex flex-wrap items-center gap-x-2 gap-y-1 text-[0.6875rem] text-(--ui-text-tertiary)',
        children: [
          model
            ? jsxs('span', {
                className: 'flex min-w-0 max-w-[18rem] items-center gap-1',
                children: [
                  jsx('span', { className: 'shrink-0', children: `${t('modelLabel')}:` }),
                  jsx('span', {
                    className: 'truncate font-medium text-(--ui-text-secondary)',
                    children: model,
                    title: model
                  })
                ]
              })
            : null,
          jsx('span', { children: `${t('priceSource')}:` }),
          jsx('span', { className: 'font-medium text-(--ui-text-secondary)', children: t(SOURCE_KEYS[effective.source]) }),
          effective.source === 'profile' && effective.profileName
            ? jsx('span', {
                className: 'max-w-[10rem] truncate font-medium text-(--ui-text-secondary)',
                title: effective.profileName,
                children: `「${effective.profileName}」`
              })
            : null,
          effective.source === 'profile' && effective.tierCount > 1
            ? jsxs('span', {
                className: 'shrink-0 tabular-nums',
                children: [
                  t('tierTag', effective.tierIndex + 1, effective.tierCount),
                  effective.tierLocked ? ` · ${t('tierLocked')}` : ''
                ].join('')
              })
            : null,
          effective.source === 'gateway'
            ? jsxs('span', {
                className: 'tabular-nums',
                children: [
                  `${fmtRate(effective.prices.input, currency)} / ${fmtRate(effective.prices.output, currency)} / ${fmtRate(effective.prices.cacheRead, currency)} ${t('pricePerM')}`,
                  ` · ${t('priceSourceAt')} ${agoText(t, effective.at)}`
                ]
              })
            : null,
          backendNote ? jsx('span', { className: 'text-(--ui-text-quaternary)', children: backendNote }) : null
        ]
      }),

      // 美元细节默认收起：要看网关原始 $/Mtok 或改汇率再展开。
      currency === 'CNY'
        ? jsxs('div', {
            className: 'flex flex-col',
            children: [
              jsxs('button', {
                className: 'flex w-fit items-center gap-1 text-[0.6875rem] text-(--ui-text-quaternary) hover:text-foreground',
                onClick: () => {
                  haptic('tap')
                  $usdOpen.set(!$usdOpen.get())
                },
                title: t('usdToggleHint'),
                type: 'button',
                children: [
                  jsx(Codicon, {
                    className: cn('shrink-0 transition-transform', !usdOpen && '-rotate-90'),
                    name: 'chevron-down',
                    size: '0.7rem'
                  }),
                  jsx('span', { children: t('usdToggle') })
                ]
              }),
              usdOpen
                ? jsxs('div', {
                    className: 'mt-1 flex flex-col gap-1 text-[0.6875rem] text-(--ui-text-tertiary)',
                    children: [
                      effective.source === 'gateway'
                        ? jsxs('span', {
                            className: 'tabular-nums',
                            children: [
                              `${t('usdRawLabel')}: ${perMillion(effective.raw.input)} / ${perMillion(effective.raw.output)} / ${perMillion(effective.raw.cacheRead)} ${t('pricePerM')}`,
                              effective.converted ? ` ×${config.rate}` : ''
                            ]
                          })
                        : null,
                      jsxs('label', {
                        className: 'flex items-center gap-2',
                        children: [
                          jsx('span', { title: t('rateHint'), children: t('rateLabel') }),
                          jsx(Input, {
                            inputMode: 'decimal',
                            onChange: event => setRate(event.target.value),
                            placeholder: String(DEFAULT_RATE),
                            suffix: '¥',
                            value: String(config.rate ?? DEFAULT_RATE)
                          })
                        ]
                      })
                    ]
                  })
                : null
            ]
          })
        : null,

      open
        ? jsxs('div', {
            className: 'flex flex-col',
            children: [
              jsxs('div', {
                className: 'mb-2 flex flex-wrap items-center gap-1',
                children: [
                  jsx(Button, {
                    children: fetching ? t('gatewayBtnBusy') : t('gatewayBtn'),
                    disabled: fetching,
                    onClick: fetchGateway,
                    size: 'micro',
                    title: t('gatewayBtnHint'),
                    variant: 'ghost'
                  }),
                  jsx(Button, {
                    children: t('defaultBtn'),
                    disabled: effective.source === 'none',
                    onClick: saveDefault,
                    size: 'micro',
                    title: t('defaultBtnHint'),
                    variant: 'ghost'
                  }),
                  effective.source === 'manual'
                    ? jsx(Button, {
                        children: t('clearBtn'),
                        onClick: dropManual,
                        size: 'micro',
                        title: t('clearBtnHint'),
                        variant: 'ghost'
                      })
                    : null
                ]
              }),
              // 框里的数来自网关时把话说清楚：这不是你手填的，改一格才会变手填。
              jsx('p', {
                className: 'mb-2 text-[0.6875rem] text-(--ui-text-tertiary)',
                children: effective.source === 'gateway' ? t('priceFromGateway') : t('priceHint')
              }),
              // 分档（只对价格配置文件出现）：选档 / 加档删档 / 改阈值。
              tierProfile ? jsx(TierBar, { contextUsed, editProfile, effective, profile: tierProfile, t }) : null,
              jsxs('div', {
                className: 'grid grid-cols-2 gap-2',
                children: PRICE_FIELDS.map(([key, labelKey, hintKey, isMillion]) =>
                  jsxs(
                    'label',
                    {
                      className: 'flex flex-col gap-1',
                      children: [
                        jsx('span', {
                          className: 'truncate text-[0.6875rem] text-(--ui-text-tertiary)',
                          title: t(hintKey),
                          children: t(labelKey)
                        }),
                        jsx(Input, {
                          inputMode: 'decimal',
                          onChange: event => onChange(key, event.target.value),
                          placeholder: '0',
                          prefix: symbol,
                          suffix: isMillion ? '/M' : '/次',
                          value: values?.[key] ?? ''
                        })
                      ]
                    },
                    key
                  )
                )
              }),
              jsx('p', { className: 'mt-2 text-[0.6875rem] text-(--ui-text-tertiary)', children: t(SOURCE_NOTES[effective.source]) }),
              jsx('p', { className: 'mt-1 text-[0.6875rem] text-(--ui-text-quaternary)', children: t('costNote') })
            ]
          })
        : null
    ]
  })
}

/** 复制按钮用的纯文本快照。 */
function buildReport(t, usage, breakdown, cost, effective) {
  const max = finite(usage?.context_max)

  const lines = [
    t('title'),
    usage?.model ? `${t('rowModel')}: ${usage.model}` : null,
    effective?.source === 'profile' && effective.profileName
      ? `${t('priceSource')}: ${t('srcProfile')}「${effective.profileName}」${
          effective.tierCount > 1
            ? ` · ${t('tierTag', effective.tierIndex + 1, effective.tierCount)}${effective.tierLocked ? ` · ${t('tierLocked')}` : ''}`
            : ''
        }`
      : null,
    `${t('sectionContext')}: ${fmtCount(usage?.context_used)} / ${max === null ? DASH : compactNumber(max)} (${fmtPercent(usage?.context_percent)})`,
    `${t('rowInput')}: ${fmtCount(usage?.input)}`,
    `${t('rowOutput')}: ${fmtCount(usage?.output)}`,
    `${t('rowReasoning')}: ${fmtCount(usage?.reasoning)}`,
    `${t('rowTotal')}: ${fmtCount(usage?.total)}`,
    `${t('rowCalls')}: ${fmtCount(usage?.calls)}`,
    `${t('rowCompressions')}: ${fmtCount(usage?.compressions)}`,
    `${t('rowCacheHit')}: ${fmtPercent(usage?.cache_hit_pct)}`,
    `${t('rowTps')}: ${fmtTps(usage?.avg_tps)}`,
    `${t('rowLatency')}: ${fmtSeconds(usage?.avg_latency_s)}`
  ].filter(Boolean)

  const backendCost = fmtUsd(usage?.cost_usd)

  if (backendCost) {
    lines.push(`${t('rowCost')}: ${backendCost}`)
  }

  if (cost?.status === 'ready') {
    lines.push(`${t('sectionCost')} (${t('costEstimated')}):`)

    for (const part of cost.parts) {
      const label = t(fieldOf(part.id)[1])

      lines.push(
        `  ${label}: ${compactNumber(part.tokens)} × ${part.rate}${part.perMillion ? '/M' : ''} = ${formatMoney(part.cost, cost.currency)}`
      )
    }

    lines.push(`${t('costTotal')}: ${formatMoney(cost.total, cost.currency)}`)
  }

  const categories = Array.isArray(breakdown?.categories) ? breakdown.categories : []

  if (categories.length) {
    lines.push(`${t('sectionBreakdown')}:`)
    categories.forEach(category => lines.push(`  ${category.label}: ~${compactNumber(category.tokens)}`))
  }

  return lines.join('\n')
}

function TokenPanel({
  breakdown,
  breakdownLoading,
  cost,
  costPending,
  error,
  loading,
  onCurrency,
  onPrice,
  onReset,
  priceValues,
  pricesOpen,
  refresh,
  sessionId,
  setPricesOpen,
  usage
}) {
  const t = usePluginI18n(ID)

  const breakdownOpen = useValue($breakdownOpen)
  const contextMax = finite(usage?.context_max)
  const contextUsed = finite(usage?.context_used)
  const percent = finite(usage?.context_percent)
  const estimated = Boolean(usage?.context_estimated)
  const categories = Array.isArray(breakdown?.categories) ? breakdown.categories : []
  const categoryTotal = categories.reduce((sum, category) => sum + (finite(category.tokens) || 0), 0) || contextUsed || 1
  const currency = cost?.currency || 'CNY'

  const sourceName = breakdown?.context_source || usage?.context_source || t('sourceUnknown')
  const sourceLine = usage ? `${t('source')}：${sourceName} · ${estimated ? t('estimated') : t('measured')}` : null

  // 九个指标挤成一个 3×3 网格（原来一行一个要九行；面板高度是用户反馈过的痛点）。
  const stats = [
    [t('rowInput'), fmtCount(usage?.input), t('rowInputHint')],
    [t('rowOutput'), fmtCount(usage?.output), t('rowOutputHint')],
    [t('rowReasoning'), fmtCount(usage?.reasoning), t('rowReasoningHint')],
    [t('rowCacheHit'), fmtPercent(usage?.cache_hit_pct), t('rowCacheHitHint')],
    [t('rowTps'), fmtTps(usage?.avg_tps), t('rowTpsHint')],
    [t('rowLatency'), fmtSeconds(usage?.avg_latency_s), t('rowLatencyHint')],
    [t('rowTotal'), fmtCount(usage?.total), null],
    [t('rowCalls'), fmtCount(usage?.calls), t('rowCallsHint')],
    [t('rowCompressions'), fmtCount(usage?.compressions), t('rowCompressionsHint')]
  ]

  // 面板也要自己判「当前用哪套价」（它只拿到 usage，拿不到 chip 的 model 局部量）。
  const config = useValue($config)
  const model = usage?.model || useValue(host.state.model) || ''

  const backendCost = fmtUsd(usage?.cost_usd)
  const priced = cost?.status === 'ready'
  // 四层来源挑一个（配置文件 > 手填 > 网关价目 > 通用默认价）：有没有价可算，看它。
  // 传 sessionId：会话独立绑定了配置文件时，面板显示的就是绑定那套。
  // 传 contextUsed：配置带上下文分档时，显示/计费的是「当前上下文落在的那一档」。
  const effective = effectivePrices(config, model, sessionId, contextUsed)
  const hasPrices = effective.source !== 'none'

  return jsx('div', {
    'data-slot': 'session-token-detail',
    className: 'max-h-[78vh] w-[23rem] overflow-y-auto p-3 text-[0.8125rem]',
    children: jsxs('div', {
      className: 'flex flex-col gap-3',
      children: [
        // 标题行：名字 + 模型 + 两个小按钮
        jsxs('div', {
          className: 'flex items-start justify-between gap-2',
          children: [
            jsxs('div', {
              className: 'flex min-w-0 flex-col',
              children: [
                jsx('p', { className: 'truncate font-medium text-foreground', children: t('title') }),
                usage?.model
                  ? jsx('p', { className: 'truncate text-[0.6875rem] text-(--ui-text-tertiary)', children: usage.model })
                  : null
              ]
            }),
            jsxs('div', {
              className: 'flex shrink-0 items-center gap-0.5',
              children: [
                jsx(CopyButton, {
                  appearance: 'icon',
                  buttonSize: 'icon-xs',
                  text: () => buildReport(t, usage, breakdown, cost, effective),
                  title: t('copyTip')
                }),
                jsx(Button, {
                  children: jsx(Codicon, { name: 'refresh', size: '0.75rem' }),
                  onClick: () => {
                    haptic('tap')
                    void refresh()
                  },
                  size: 'icon-xs',
                  title: t('refreshTip'),
                  variant: 'ghost'
                })
              ]
            })
          ]
        }),

        !sessionId ? jsx('p', { className: 'text-[0.6875rem] text-(--ui-text-tertiary)', children: t('noSession') }) : null,
        sessionId && loading && !usage ? jsx(Skeleton, { className: 'h-3 w-full' }) : null,
        sessionId && !loading && !usage
          ? jsx('p', { className: 'text-[0.6875rem] text-(--ui-text-tertiary)', children: t('empty') })
          : null,

        usage
          ? jsxs(Stack, {
              children: [
                jsxs('div', {
                  className: 'flex items-baseline justify-between gap-2',
                  children: [
                    jsx('span', { className: 'text-(--ui-text-tertiary)', children: t('sectionContext') }),
                    jsx('span', {
                      className: 'tabular-nums text-foreground',
                      children: `${estimated ? '~' : ''}${contextUsed === null ? DASH : compactNumber(contextUsed)}/${contextMax === null ? DASH : compactNumber(contextMax)} · ${fmtPercent(percent)}`
                    })
                  ]
                }),
                jsx(ContextBar, { categories, percent, segmentTotal: categoryTotal }),
                sourceLine
                  ? jsx('span', { className: 'text-[0.6875rem] text-(--ui-text-tertiary)', children: sourceLine })
                  : null
              ]
            })
          : null,

        usage ? jsx('div', { className: 'h-px bg-(--ui-stroke-secondary)' }) : null,

        // 会话费用
        usage
          ? jsxs(Stack, {
              title: t('sectionCost'),
              children: [
                costPending
                  ? jsx('p', { className: 'text-[0.6875rem] text-(--ui-text-tertiary)', children: t('costComputing') })
                  : null,
                !costPending && !priced
                  ? jsx('p', { className: 'text-[0.6875rem] text-(--ui-text-tertiary)', children: t('costUnpriced') })
                  : null,
                priced
                  ? jsxs('div', {
                      className: 'flex items-baseline justify-between gap-2',
                      children: [
                        jsx('span', { className: 'font-medium text-foreground', children: t('costTotal') }),
                        jsx('span', {
                          className: 'text-[0.9375rem] font-medium tabular-nums text-foreground',
                          children: formatMoney(cost.total, currency)
                        })
                      ]
                    })
                  : null,
                ...(priced
                  ? cost.parts
                      .filter(part => part.tokens > 0 || part.rate > 0)
                      .map(part =>
                        jsx(
                          CostRow,
                          {
                            currency,
                            hint: t(fieldOf(part.id)[2]),
                            label: t(fieldOf(part.id)[1]),
                            part
                          },
                          part.id
                        )
                      )
                  : []),
                backendCost
                  ? jsx('p', {
                      className: 'text-[0.6875rem] text-(--ui-text-tertiary)',
                      children: `${t('rowCost')}：${backendCost}`
                    })
                  : null
              ]
            })
          : null,

        usage
          ? jsx(Stack, {
              title: t('sectionStats'),
              children: [jsx(StatGrid, { items: stats })]
            })
          : null,

        // 上下文构成默认收起：分段进度条已经给了大概，要看每类数字再点开。
        usage && categories.length
          ? jsxs('div', {
              className: 'flex flex-col gap-1.5',
              children: [
                jsx(SectionToggle, {
                  count: `· ${t('breakdownCount', categories.length)}`,
                  onToggle: () => $breakdownOpen.set(!$breakdownOpen.get()),
                  open: breakdownOpen,
                  title: t('sectionBreakdown')
                }),
                breakdownOpen
                  ? jsx('div', {
                      className: 'flex flex-col gap-1',
                      children: categories.map(category =>
                        jsxs(
                          'div',
                          {
                            className: 'flex items-center justify-between gap-2',
                            children: [
                              jsxs('span', {
                                className: 'flex min-w-0 items-center gap-2',
                                children: [
                                  jsx('span', { className: 'size-2 shrink-0 rounded-[2px]', style: { background: category.color } }),
                                  jsx('span', { className: 'truncate text-(--ui-text-tertiary)', children: category.label })
                                ]
                              }),
                              jsx('span', { className: 'shrink-0 tabular-nums text-foreground', children: `~${compactNumber(category.tokens)}` })
                            ]
                          },
                          category.id
                        )
                      )
                    })
                  : null
              ]
            })
          : null,

        usage && !categories.length
          ? jsx('p', {
              className: 'text-[0.6875rem] text-(--ui-text-tertiary)',
              children: breakdownLoading ? t('breakdownLoading') : t('breakdownEmpty')
            })
          : null,

        usage
          ? jsx(ProfileManager, { seed: effective.prices, sessionId, t })
          : null,

        usage
          ? jsx(PriceEditor, {
              contextUsed,
              currency,
              model,
              onChange: onPrice,
              onCurrency,
              onReset,
              // 没填过价格就一直摊开（不然用户根本找不到该往哪填）；填过之后听用户的开关。
              open: pricesOpen || !hasPrices,
              setOpen: setPricesOpen,
              t,
              values: priceValues
            })
          : null,

        error ? jsx('p', { className: 'text-[0.6875rem] text-(--ui-text-tertiary)', children: t('errorHint') }) : null
      ]
    })
  })
}

function TokenChip({ storage }) {
  const t = usePluginI18n(ID)
  const [open, setOpen] = useState(false)
  const sessionId = useValue(host.state.focusedSessionId)
  const busy = useValue(host.state.busy)
  const gatewayModel = useValue(host.state.model)
  const config = useValue($config)
  const draft = useValue($draft)
  const cost = useValue($cost)
  const pricesOpen = useValue($pricesOpen)
  const { error, loading, refresh, usage } = useTokenUsage(sessionId, open)
  const { breakdown, loading: breakdownLoading } = useContextBreakdown(sessionId, open, busy)

  const model = usage?.model || gatewayModel || ''
  const currency = draft?.currency || config.currency
  // 当前上下文占用（≈ 下一次请求的输入大小）—— 分档价按它选档，所以要在取价之前算出来。
  const contextUsed = finite(usage?.context_used)
  // 真正参与计费的是「四层来源挑一个 + 选档 + 折算过的价」，手填那一层仍由草稿即时驱动。
  // 传 sessionId：这个会话独立绑定了配置文件时，费用按绑定那套算。
  // 传 contextUsed：配置带上下文分档时，价格随阈值自动切档。
  const effective = effectivePrices(config, model, sessionId, contextUsed)
  // 输入框显示「当前真正在用的价」：手填的、网关取回的、还是默认价 —— 框里的数
  // 永远和上面那行「价格来源」对得上（以前只显示手填，于是出现「来源=网关 + 空框」）。
  //
  // 但手填字段必须回放草稿里的**原始字符串**：价格算完会被归一化成数字，拿那个数
  // 回填输入框会把「1.」「0.50」这类输入中间态当场抹掉 —— 表现就是小数点打不进去、
  // 只能输整数。只有草稿里没有的字段（从没手填过）才用当前生效价兜底。
  // 0 显示成空框，因为 hint 说的是「留空即 0」。
  // 档位与配置都要对上：草稿停在别的配置（刚切配置）或别的档（上下文刚越过阈值）上时，
  // 不能拿它的数当这一档的起点 —— 那会让「框里的数」和「价格来源」对不上。
  const sameTier =
    (draft?.tierIndex ?? 0) === (effective.tierIndex ?? 0) && (draft?.profileId ?? '') === (effective.profileId ?? '')
  const manualValues = draft?.model === model && sameTier ? draft.values : {}
  const priceValues = Object.fromEntries(
    PRICE_KEYS.map(key => [
      key,
      manualValues[key] !== undefined
        ? manualValues[key]
        : effective.prices[key]
          ? effective.prices[key]
          : ''
    ])
  )
  const costKey = costSignature(usage, effective.prices, currency)
  // 生效的配置文件（会话绑定 > 全局激活）；切它要重置草稿，否则框里留着上一套的数。
  const activeProfileId = effective.profileId

  // 首次挂载 / 切模型 / 切配置文件 / 切档：把该生效价读进草稿（有没有价、用哪一套由面板自己判断）。
  useEffect(() => {
    const current = $draft.get()

    if (
      !current ||
      current.model !== model ||
      current.profileId !== activeProfileId ||
      (current.tierIndex ?? 0) !== (effective.tierIndex ?? 0)
    ) {
      $draft.set({ ...draftFor($config.get(), model, sessionId, contextUsed), profileId: activeProfileId })
    }
  }, [config, model, activeProfileId, effective.tierIndex])

  // 用量或价格一变就发一个异步费用任务（去抖 + 过期丢弃），渲染只读结果。
  // 依赖用签名而不是价格对象：价格对象每帧都新建，按对象比较会每帧重发一个任务。
  useEffect(() => {
    if (!usage) {
      return
    }

    void primeCost({ currency, prices: effective.prices, usage })
  }, [costKey])

  const costPending = Boolean(usage) && cost.signature !== costKey
  const costView = costPending ? null : cost
  const money = costView?.status === 'ready' ? formatMoney(costView.total, currency) : null

  const contextMax = finite(usage?.context_max)
  const percent = finite(usage?.context_percent)
  const total = finite(usage?.total)
  const estimated = Boolean(usage?.context_estimated)

  // 有上下文窗口就报百分比，没有就退到会话累计 token，再没有就一根横杠。
  const label =
    percent !== null
      ? `${estimated ? '~' : ''}${Math.round(percent)}%`
      : total !== null
        ? `${compactNumber(total)} tok`
        : DASH

  const detail =
    contextMax !== null ? `${estimated ? '~' : ''}${compactNumber(contextUsed ?? 0)}/${compactNumber(contextMax)}` : null

  const updateDraft = mutate => {
    const stored = $draft.get()
    // 草稿可能还停在别的模型 / 别的档上（刚换模型，或上下文越过阈值换了档）——先换回来，
    // 否则会把上一处编辑的数当成这一处的起点。
    const current =
      stored &&
      stored.model === model &&
      stored.profileId === effective.profileId &&
      (stored.tierIndex ?? 0) === (effective.tierIndex ?? 0)
        ? stored
        : { ...draftFor($config.get(), model, sessionId, contextUsed), profileId: effective.profileId }
    const next = { ...mutate(current), model, profileId: effective.profileId, tierIndex: effective.tierIndex ?? 0 }
    const base = parseStoredPrices($config.get())
    const currency = next.currency === 'USD' ? 'USD' : 'CNY'
    const rates = normalizeRates(next.values)
    // 有配置文件生效时，这五个框改的是**那个配置文件里正在生效的那一档**（用户改的就是它）；
    // 没有配置文件才落回老路径（按模型的手填层），行为与以前一致。
    const nextConfig = effective.profileId
      ? updateProfile({ ...base, currency }, effective.profileId, { prices: rates, tierIndex: effective.tierIndex })
      : mergePrices(base, model, { ...rates, currency })

    $draft.set(next)
    $config.set(nextConfig)
    // 动过设置就把设置区钉住摊开：否则第一格刚填完、费用一算出来，设置区就自己折叠了。
    $pricesOpen.set(true)
    void schedulePersist(storage, nextConfig)
  }

  return jsxs(Popover, {
    onOpenChange: next => {
      haptic('tap')
      setOpen(next)

      if (next) {
        void refresh()
      }
    },
    open,
    children: [
      jsx(PopoverTrigger, {
        asChild: true,
        children: jsxs('button', {
          'aria-label': t('chipTip'),
          className: cn(CHIP_CLASS, open && 'bg-(--chrome-action-hover) text-foreground'),
          'data-session-token-detail': 'chip',
          type: 'button',
          children: [
            jsx(Codicon, { name: 'dashboard', size: '0.75rem' }),
            jsx('span', { className: cn('tabular-nums', busy && 'animate-pulse'), children: label }),
            detail ? jsx('span', { className: 'tabular-nums text-(--ui-text-quaternary)', children: detail }) : null,
            money ? jsx('span', { className: 'tabular-nums text-(--ui-text-quaternary)', children: `· ${money}` }) : null
          ]
        })
      }),
      jsx(PopoverContent, {
        align: 'end',
        className: 'w-[23rem] p-0',
        side: 'top',
        sideOffset: 6,
        children: jsx(TokenPanel, {
          breakdown,
          breakdownLoading,
          cost: costView,
          costPending,
          error,
          loading,
          onCurrency: next => updateDraft(current => ({ ...current, currency: next })),
          onPrice: (key, value) =>
            updateDraft(current => ({
              ...current,
              // 草稿还没动过就先用框里那套数当起点（网关价 / 默认价一并落下），
              // 否则「以网关价为基础改一格」会把其余格子清空。
              values: {
                ...(Object.keys(current.values ?? {}).length ? current.values : priceValues),
                [key]: value
              }
            })),
          onReset: () => updateDraft(current => ({ ...current, values: {} })),
          priceValues,
          pricesOpen,
          refresh,
          sessionId,
          setPricesOpen: $pricesOpen.set,
          usage
        })
      })
    ]
  })
}

export default {
  id: ID,
  name: '会话 Token 详情 · 费用估算',

  register(ctx) {
    ctx.i18n.register({
      zh: {
        breakdownEmpty: '暂无归类数据（先发一条消息）',
        breakdownLoading: '正在估算上下文构成…',
        chipTip: '当前会话的 token 用量与费用，点击查看明细',
        copyTip: '复制为文本',
        costComputing: '计算中…',
        costEstimated: '估算',
        costNote: '按会话累计 token 估算；缓存读由命中率推算、缓存写取残差（标 ≈ 的行有误差）',
        costTotal: '费用合计',
        costUnpriced: '还没填价格 — 在下面「价格设置」里填一下，自动算钱',
        agoDays: n => `${n} 天前`,
        agoHours: n => `${n} 小时前`,
        agoMinutes: n => `${n} 分钟前`,
        agoNow: '刚刚',
        clearBtn: '清空手填价',
        clearBtnHint: '清掉手填价，退回用网关价目 / 通用默认价',
        defaultBtn: '设为默认价',
        defaultBtnHint: '把当前这套存成「所有没价目的模型的兜底」，以后换到那种模型不用再填',
        gatewayBtn: '取网关价目',
        gatewayBtnBusy: '取价中…',
        gatewayBtnHint: '从网关的模型价目表重新取一次（强制刷新，绕过 24 小时缓存）',
        gatewayErr: '网关价目暂时取不到',
        gatewayNone: '网关没给这个模型的价目',
        pricePerM: '每 M',
        priceSource: '价格来源',
        priceSourceAt: '更新于',
        profileActivateHint: '切换为当前配置（全局生效；被会话独立绑定的会话不受影响）',
        profileAddBtn: '新建配置（复制当前价）',
        profileAddHint: '把当前正在生效的那套价复制成一个新配置文件，并立即切到它（下面那几个框接着改的就是它；本会话若独立绑定了配置，也会跟着切过去）',
        profileBoundTag: '本会话',
        profileDeleteHint: '删除这个配置文件（绑定了它的会话会退回跟随全局）',
        profileFull: '已满 20 个',
        profileFullHint: '最多 20 个配置文件，删掉一个才能再建',
        profileRenameHint: '点击改名',
        rateHint: '美元→人民币汇率：网关价目是 $/Mtok，显示货币选 ¥ 时按它折算',
        rateLabel: '1 USD =',
        srcDefaults: '通用默认价',
        srcGateway: '网关价目',
        srcManual: '手填',
        srcNone: '未设置',
        srcNoteDefaults: '当前用的是通用默认价（网关没有这个模型的价目）',
        srcNoteGateway: '这套价是网关自己的价目，自动取回并缓存在本地；想用自己的数就在下面填，手填优先',
        srcNoteManual: '这五个数是你手填的，优先级最高（网关价目 / 默认价都不参与）',
        srcNoteNone: '还没有价格：手填，或点「取网关价目」自动取，费用立刻出来',
        srcNoteProfile: '这套价来自价格配置文件（会话绑定 > 全局激活），压过手填与网关价',
        srcProfile: '配置文件',
        tierAddBtn: '加一档',
        tierAddHint: '在末尾补一个「无上限」档（价复制最后一档）；原来那档的上限默认切在 272K，撞上已有上限就按上一档翻倍',
        tierAuto: '自动',
        tierCountHint: '这个配置按输入大小分档计价',
        tierCountTag: n => `${n} 档`,
        tierHint: '自动 = 按当前上下文占用（≈ 下一次请求的输入大小）切档，价格随阈值变化；点某一档 = 固定用它，不随上下文变',
        tierHintLocked: '已锁定这一档：费用固定按它算，不随上下文变化；点「自动」恢复随阈值变价',
        tierLimitHint: '这一档覆盖「输入小于该值」；最后一档是无上限',
        tierLimitLabel: '输入上限',
        tierLocked: '已锁定',
        tierOffHint: '当前不分档：所有输入一个价。点「加一档」就能按输入大小分价',
        tierRemoveBtn: '删掉这一档',
        tierRemoveHint: '删掉正在编辑的这一档；只剩一档就退回不分档',
        tierSection: '按上下文分档',
        tierTag: (i, n) => `档 ${i}/${n}`,
        tierUnknown: '这个会话还没报上下文大小，暂时按第一档算',
        sectionProfiles: '价格配置',
        usdRawLabel: '网关原价',
        usdToggle: '美元',
        usdToggleHint: '网关价目的原始美元数与汇率；默认收起，要看 $/Mtok 或改汇率再展开',

        empty: '这个会话还没有 token 记录',
        errorHint: '权威计数没读到，上面是实时快照',
        estimated: '估算',
        measured: '实测',
        modelLabel: '模型',
        noSession: '当前没有聚焦的会话',
        priceCacheRead: '缓存命中（读）',
        priceCacheReadHint: 'prompt 缓存读取的单价',
        priceCacheWrite: '缓存写入',
        priceCacheWriteHint: '写进 prompt 缓存的单价',
        priceCurrencyCny: '¥ 元',
        priceCurrencyUsd: '$ 美元',
        priceFromGateway: '这几格是网关价目取回的价（已折算成当前货币）；改任意一格就变成手填，手填优先',
        priceHint: '留空即 0，按模型分别保存，改完立刻重算，不用保存',
        priceInput: '输入',
        priceInputHint: '缓存未命中的输入单价',
        priceOutput: '输出',
        priceOutputHint: '模型输出（含思考）的单价',
        priceRequest: '每次调用',
        priceRequestHint: '每次 API 调用的固定费用，没有就留空',
        priceReset: '清空',
        priceResetHint: '清掉这个模型的价格',
        priceUnit: '每百万 tokens',
        refreshTip: '刷新',
        rowCacheHit: '缓存命中率',
        rowCacheHitHint: 'prompt 缓存读取占输入 token 的比例',
        rowCalls: 'API 调用',
        rowCallsHint: '本会话向模型发起的请求次数',
        rowCompressions: '上下文压缩',
        rowCompressionsHint: '历史被压缩过几次',
        rowCost: '后端上报',
        rowInput: '输入',
        rowInputHint: '发给模型的 prompt tokens',
        rowLatency: '平均延迟',
        rowLatencyHint: '最近约 10 次调用的平均耗时',
        rowModel: '模型',
        rowOutput: '输出',
        rowOutputHint: '模型生成的 completion tokens',
        rowReasoning: '推理',
        rowReasoningHint: '思考（reasoning）tokens',
        rowTps: '平均吞吐',
        rowTpsHint: '最近约 10 次调用的滚动 t/s',
        rowTotal: '合计',
        sectionBreakdown: '上下文构成',
        sectionContext: '上下文窗口',
        sectionCost: '会话费用',
        sectionStats: '用量与性能',
        breakdownCount: n => `${n} 类`,
        sectionPrices: '价格设置',
        sessionBindFollow: '跟随全局',
        sessionBindLabel: '此会话独立用',
        source: '数据来源',
        sourceUnknown: '未知',
        title: '会话 Token 详情'
      },
      en: {
        breakdownEmpty: 'No breakdown yet — send a message first',
        breakdownLoading: 'Estimating context composition…',
        chipTip: 'Token usage and cost of the focused session — click for details',
        copyTip: 'Copy as text',
        costComputing: 'Calculating…',
        costEstimated: 'estimated',
        costNote: 'Estimated from session token totals; cache reads come from the hit rate and cache writes are the remainder (rows marked ≈ are approximate)',
        costTotal: 'Session cost',
        costUnpriced: 'No prices yet — fill in Price settings below and the cost appears automatically',
        agoDays: n => `${n} d ago`,
        agoHours: n => `${n} h ago`,
        agoMinutes: n => `${n} min ago`,
        agoNow: 'just now',
        clearBtn: 'Clear manual prices',
        clearBtnHint: 'Drop your manual prices and fall back to gateway / global default',
        defaultBtn: 'Save as default',
        defaultBtnHint: 'Store this price set as the fallback for every model without its own pricing',
        gatewayBtn: 'Fetch gateway prices',
        gatewayBtnBusy: 'Fetching…',
        gatewayBtnHint: 'Re-fetch from the gateway model catalog (forces a refresh, bypasses the 24 h cache)',
        gatewayErr: 'Gateway prices unavailable right now',
        gatewayNone: 'Gateway has no pricing for this model',
        pricePerM: 'per M',
        priceSource: 'Price source',
        priceSourceAt: 'updated',
        profileActivateHint: 'Set as the active profile (global; sessions bound to their own profile are unaffected)',
        profileAddBtn: 'New profile (copy current)',
        profileAddHint: 'Copy the price set currently in effect into a new profile and switch to it — the fields below then edit the new one (a session-bound session follows it too)',
        profileBoundTag: 'this session',
        profileDeleteHint: 'Delete this profile (bound sessions fall back to following the global one)',
        profileFull: 'Limit of 20 reached',
        profileFullHint: 'At most 20 profiles — delete one to create another',
        profileRenameHint: 'Click to rename',
        rateHint: 'USD→CNY rate: gateway prices are $/Mtok, converted when the display currency is ¥',
        rateLabel: '1 USD =',
        srcDefaults: 'Global default',
        srcGateway: 'Gateway catalog',
        srcManual: 'Your input',
        srcNone: 'Not set',
        srcNoteDefaults: 'Using the global default prices (the gateway has no pricing for this model)',
        srcNoteGateway: 'These came from the gateway catalog, cached locally; type your own numbers below to override (manual wins)',
        srcNoteManual: 'These five are your manual numbers — highest priority (gateway / default are ignored)',
        srcNoteNone: 'No prices yet: type them in, or hit Fetch gateway prices — the cost appears right away',
        srcNoteProfile: 'These prices come from a price profile (session binding > global active), overriding manual and gateway prices',
        srcProfile: 'Profile',
        tierAddBtn: 'Add tier',
        tierAddHint: 'Append an unlimited tier (prices copied from the last one); the old last tier gets a cut-off of 272K, doubled past any limit already in use',
        tierAuto: 'Auto',
        tierCountHint: 'This profile is priced by input size',
        tierCountTag: n => `${n} tiers`,
        tierHint: 'Auto = pick the tier by current context usage (≈ the next request’s input size), so the price follows the threshold; click a tier to pin it',
        tierHintLocked: 'Pinned to this tier: the cost stays on it whatever the context does; click Auto to follow the threshold again',
        tierLimitHint: 'This tier covers inputs below that value; the last tier is unlimited',
        tierLimitLabel: 'Input under',
        tierLocked: 'pinned',
        tierOffHint: 'Not tiered: one price for every input size. Hit “Add tier” to price by input size',
        tierRemoveBtn: 'Remove tier',
        tierRemoveHint: 'Remove the tier being edited; with a single tier left it goes back to untiered',
        tierSection: 'Context tiers',
        tierTag: (i, n) => `tier ${i}/${n}`,
        tierUnknown: 'This session has not reported a context size yet — tier 1 for now',
        sectionProfiles: 'Price profiles',
        usdRawLabel: 'Gateway raw',
        usdToggle: 'USD',
        usdToggleHint: 'Raw gateway USD prices and the FX rate; collapsed by default',

        empty: 'No token records in this session yet',
        errorHint: 'Authoritative counters unavailable; showing the live snapshot',
        estimated: 'estimated',
        measured: 'measured',
        modelLabel: 'Model',
        noSession: 'No focused session',
        priceCacheRead: 'Cache read',
        priceCacheReadHint: 'Price per prompt-cache read token',
        priceCacheWrite: 'Cache write',
        priceCacheWriteHint: 'Price per prompt-cache write token',
        priceCurrencyCny: '¥ CNY',
        priceCurrencyUsd: '$ USD',
        priceFromGateway: 'These fields hold the gateway prices (already converted to the display currency); edit any field to switch to manual prices, which take priority',
        priceHint: 'Empty means 0. Saved per model; edits recompute immediately, no save button',
        priceInput: 'Input',
        priceInputHint: 'Price per uncached input token',
        priceOutput: 'Output',
        priceOutputHint: 'Price per output (reasoning included) token',
        priceRequest: 'Per call',
        priceRequestHint: 'Flat fee per API call, leave empty if none',
        priceReset: 'Clear',
        priceResetHint: 'Clear this model’s prices',
        priceUnit: 'per million tokens',
        refreshTip: 'Refresh',
        rowCacheHit: 'Cache hit',
        rowCacheHitHint: 'Prompt-cache reads as a share of input tokens',
        rowCalls: 'API calls',
        rowCallsHint: 'Model requests made in this session',
        rowCompressions: 'Compactions',
        rowCompressionsHint: 'How many times the history was compacted',
        rowCost: 'Backend-reported',
        rowInput: 'Input',
        rowInputHint: 'Prompt tokens sent to the model',
        rowLatency: 'Avg latency',
        rowLatencyHint: 'Mean duration of the last ~10 calls',
        rowModel: 'Model',
        rowOutput: 'Output',
        rowOutputHint: 'Completion tokens generated by the model',
        rowReasoning: 'Reasoning',
        rowReasoningHint: 'Thinking tokens',
        rowTps: 'Throughput',
        rowTpsHint: 'Rolling tokens/sec over the last ~10 calls',
        rowTotal: 'Total',
        sectionBreakdown: 'Context composition',
        sectionContext: 'Context window',
        sectionCost: 'Session cost',
        sectionStats: 'Usage & performance',
        breakdownCount: n => `${n} items`,
        sectionPrices: 'Price settings',
        sessionBindFollow: 'Follow global',
        sessionBindLabel: 'This session uses',
        source: 'Source',
        sourceUnknown: 'unknown',
        title: 'Session token details'
      }
    })

    // 价格从插件自己的存储读一次；存坏了 parseStoredPrices 兜底成空配置。
    setStorageDoor(ctx.storage)
    $config.set(parseStoredPrices(ctx.storage.get('prices', null)))

    ctx.register({
      area: 'statusBar.right',
      id: 'chip',
      order: 126,
      render: () => jsx(TokenChip, { storage: ctx.storage })
    })
  }
}
