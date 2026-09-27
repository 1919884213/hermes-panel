/**
 * 会话 Token 详情 · 费用估算 — 离线测试台
 *
 * 用桩掉的 @hermes/plugin-sdk（node_modules/@hermes/plugin-sdk/index.mjs）加载
 * **真正**的 ../plugin.js，跑三类断言：
 *
 *   A. 纯函数：computeCost / formatMoney / normalizeRates / parseStoredPrices /
 *      mergePrices —— 钱算错比界面丑严重得多，逐个手算核对。
 *   B. 异步引擎：primeCost 去抖 + 过期丢弃（被取代的调用方不能挂住）、
 *      schedulePersist 同样只写最后一次。
 *   C. 渲染：chip 与面板用 react-dom/server 静态渲染后逐条查文本 —— 注册形状、
 *      上下文、费用分项、≈ 标记、价格输入框、填价格→写存储→重算的完整链路、
 *      i18n 两套 bundle 全覆盖、只 import 三个允许的说明符、无 JSX 语法。
 *
 * 跑法：node tests/test.mjs   （退出码非 0 = 有 FAIL）
 */
import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'

import * as sdk from '@hermes/plugin-sdk'

import plugin, {
  $usdOpen,
  clearManual,
  convertPrices,
  effectivePrices,
  ensureGatewayPrices,
  gatewayPricesFor,
  parseGatewayPrice,
  putGatewayPrices,
  resolvePrices,
  setDefaults,
  setStorageDoor,
  mergePrices,
  normalizeRates,
  parseStoredPrices,
  PRICE_KEYS,
  computeCost,
  costSignature,
  formatMoney,
  primeCost,
  schedulePersist
} from '../plugin.js'

const ID = 'session-token-detail'
const PASS = []
const FAIL = []

function check(label, condition, detail) {
  ;(condition ? PASS : FAIL).push(label)

  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}${detail === undefined ? '' : `  → ${detail}`}`)
}

const near = (a, b, tolerance = 1e-6) => Math.abs(a - b) < tolerance
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

// ── 测试数据 ───────────────────────────────────────────────────────────────
const SEED_MODEL = 'deepseek-v4.1-flash'
const PLAIN_MODEL = 'plain-model'

/** 单位：每百万 tokens；request 是每次调用的固定费。 */
const SEED_PRICES = { cacheRead: 0.5, cacheWrite: 2, input: 2, output: 3, request: 0.01 }

// prompt = input + cache_read + cache_write（Hermes 的 CanonicalUsage 口径）：
// 500k = 100k(未命中) + 300k(命中 60%) + 100k(写入)
const USAGE = {
  avg_latency_s: 3.7,
  avg_tps: 42.3,
  cache_hit_pct: 60,
  calls: 10,
  completion: 10000,
  compressions: 1,
  context_estimated: false,
  context_max: 200000,
  context_percent: 23,
  context_source: 'provider_usage_plus_estimate',
  context_used: 45200,
  input: 100000,
  model: SEED_MODEL,
  output: 10000,
  prompt: 500000,
  reasoning: 4000,
  total: 510000
}

const USAGE_PLAIN = { ...USAGE, model: PLAIN_MODEL }

const BREAKDOWN = {
  categories: [
    { color: '#ff8800', id: 'system_prompt', label: 'System prompt', tokens: 3800 },
    { color: '#00aaff', id: 'conversation', label: 'Conversation', tokens: 41000 }
  ],
  context_estimated: false,
  context_max: 200000,
  context_percent: 23,
  context_source: 'provider_usage_plus_estimate',
  context_used: 45200,
  model: SEED_MODEL
}

// ── A. 纯函数 ──────────────────────────────────────────────────────────────
const rates = normalizeRates({ cacheRead: '0.5', input: 2, output: '', request: 'abc' })

check(
  'normalizeRates：数字/数字字符串都收，空与乱输入当 0',
  rates.cacheRead === 0.5 && rates.input === 2 && rates.output === 0 && rates.request === 0 && rates.cacheWrite === 0,
  JSON.stringify(rates)
)

const cost = computeCost(USAGE, SEED_PRICES)

check('computeCost：状态 ready', cost.status === 'ready', cost.status)
check('computeCost：五个分项齐全', cost.parts.map(part => part.id).join(',') === PRICE_KEYS.join(','), cost.parts.map(part => part.id).join(','))
check(
  'computeCost：合计 = 0.2 + 0.03 + 0.15 + 0.2 + 0.1（手算）',
  near(cost.total, 0.68),
  JSON.stringify(cost.total)
)
check(
  'computeCost：缓存读按命中率推算（500k × 60% = 300k），缓存写取残差（100k）',
  cost.parts.find(part => part.id === 'cacheRead').tokens === 300000 && cost.parts.find(part => part.id === 'cacheWrite').tokens === 100000,
  JSON.stringify(cost.parts.map(part => [part.id, part.tokens]))
)
check(
  'computeCost：推算出来的两行标 measurable=false（面板上打 ≈）',
  cost.parts.every(part => part.measured === (part.id !== 'cacheRead' && part.id !== 'cacheWrite')),
  JSON.stringify(cost.parts.map(part => [part.id, part.measured]))
)
check('computeCost：单次调用费不除以百万（10 × 0.01 = 0.1）', near(cost.parts.find(part => part.id === 'request').cost, 0.1), String(cost.parts.find(part => part.id === 'request').cost))

const unpriced = computeCost(USAGE, {})

check('computeCost：没填价格 → unpriced，不算出 0 元假账单', unpriced.status === 'unpriced' && unpriced.total === 0 && unpriced.parts.length === 0)
check('computeCost：没有 usage 也不炸', computeCost(null, SEED_PRICES).status === 'unpriced')

const onlyRequest = computeCost({ calls: 3, input: 0, output: 0, prompt: 0 }, { request: 0.02 })

check('computeCost：只填单次费用也能算', onlyRequest.status === 'ready' && near(onlyRequest.total, 0.06), JSON.stringify(onlyRequest.total))

const noPrompt = computeCost({ input: 1000, output: 0 }, { input: 1 })

check('computeCost：缺 prompt/cache_hit_pct 时按 input 兜底、缓存读为 0', near(noPrompt.total, 0.001), JSON.stringify(noPrompt.total))

const negativeResidual = computeCost({ cache_hit_pct: 0, input: 5000, output: 0, prompt: 1000 }, { input: 1, cacheWrite: 1 })

check('computeCost：残差为负时夹到 0，不会算出负费用', negativeResidual.parts.every(part => part.cost >= 0), JSON.stringify(negativeResidual.parts.map(part => part.cost)))

check('formatMoney：分级小数位', formatMoney(12.3456, 'CNY') === '¥12.35' && formatMoney(0.68, 'CNY') === '¥0.680' && formatMoney(0.0004, 'CNY') === '¥0.000400' && formatMoney(0, 'CNY') === '¥0.00', [formatMoney(12.3456), formatMoney(0.68), formatMoney(0.0004), formatMoney(0)].join(' '))
check('formatMoney：美元符号', formatMoney(0.5, 'USD') === '$0.500', formatMoney(0.5, 'USD'))
check('formatMoney：非数字给横杠', formatMoney(undefined) === '—')

check(
  'costSignature：数字与同值字符串同签名，价格变了签名就变',
  costSignature(USAGE, SEED_PRICES, 'CNY') === costSignature(USAGE, { input: '2', output: '3', cacheRead: '0.5', cacheWrite: '2', request: '0.01' }, 'CNY') &&
    costSignature(USAGE, SEED_PRICES, 'CNY') !== costSignature(USAGE, { ...SEED_PRICES, input: 3 }, 'CNY')
)

const blank = parseStoredPrices('nonsense')

check(
  'parseStoredPrices：坏输入退回空配置（v1 老配置照样读得进来）',
  Object.keys(blank.byModel).length === 0 &&
    Object.keys(blank.gateway).length === 0 &&
    blank.currency === 'CNY' &&
    blank.rate === 7.2 &&
    parseStoredPrices(null).currency === 'CNY'
)
check('parseStoredPrices：USD 与坏条目处理', (() => {
  const parsed = parseStoredPrices({ byModel: { bad: 'x', empty: { input: 0 }, good: { input: '2.5' } }, currency: 'USD' })

  return parsed.currency === 'USD' && !parsed.byModel.bad && !parsed.byModel.empty && parsed.byModel.good.input === 2.5
})(), JSON.stringify(parseStoredPrices({ byModel: { bad: 'x', empty: { input: 0 }, good: { input: '2.5' } }, currency: 'USD' })))

const merged = mergePrices({ byModel: { other: { input: 1 } }, currency: 'CNY' }, SEED_MODEL, { ...SEED_PRICES, currency: 'USD' })

check('mergePrices：写入新模型、保留别的模型、货币跟着草稿走', merged.byModel[SEED_MODEL].input === 2 && merged.byModel.other.input === 1 && merged.currency === 'USD', JSON.stringify(merged))
check('mergePrices：全清空就删掉这个模型，不留空壳', !mergePrices({ byModel: { [SEED_MODEL]: SEED_PRICES } }, SEED_MODEL, {}).byModel[SEED_MODEL])

// ── 注册（价格从存储载入）─────────────────────────────────────────────────
const storageWrites = []
const storage = {
  get: (key, fallback) => (key === 'prices' ? { byModel: { [SEED_MODEL]: SEED_PRICES }, currency: 'CNY' } : fallback),
  remove: () => {},
  set: (key, value) => {
    storageWrites.push({ key, value })
  }
}

const contributions = []
const ctx = {
  i18n: { register: bundles => Object.assign(sdk.__i18n.bundles, bundles) },
  onEvent: () => () => {},
  os: {},
  register: contribution => {
    contributions.push(contribution)

    return () => {}
  },
  registerMany: list => {
    list.forEach(contribution => contributions.push(contribution))

    return () => {}
  },
  rest: async () => ({}),
  socket: () => () => {},
  storage
}

sdk.__setRequestResponder((method, params) => {
  if (method === 'session.usage') {
    return USAGE
  }

  if (method === 'session.context_breakdown') {
    return BREAKDOWN
  }

  throw new Error(`unexpected RPC ${method} ${JSON.stringify(params)}`)
})

plugin.register(ctx)

const chips = contributions.filter(contribution => contribution.area === 'statusBar.right')

check('插件 id 与文件夹名一致', plugin.id === ID, plugin.id)
check('只注册一个 statusBar.right chip，排在核心项之前', chips.length === 1 && chips[0].order === 126 && contributions.length === 1, `count=${chips.length} order=${chips[0]?.order}`)

const renderChip = () => renderToStaticMarkup(chips[0].render())

// ── B. 异步引擎 ────────────────────────────────────────────────────────────
const first = primeCost({ currency: 'CNY', prices: SEED_PRICES, usage: USAGE }, 5)
const second = primeCost({ currency: 'CNY', prices: { ...SEED_PRICES, input: 4 }, usage: USAGE }, 0)
const [firstResult, secondResult] = await Promise.all([first, second])

check('primeCost：被取代的调用方立刻拿到 superseded（不会挂住）', firstResult.status === 'superseded', JSON.stringify(firstResult))
check('primeCost：只算最后一次，结果是新价格的', secondResult.status === 'ready' && !near(secondResult.total, 0.68), JSON.stringify(secondResult.total))
check('primeCost：返回的签名与 costSignature 一致', secondResult.signature === costSignature(USAGE, { ...SEED_PRICES, input: 4 }, 'CNY'))

const persistA = schedulePersist(storage, { byModel: { a: { input: 1 } }, currency: 'CNY' }, 5)
const persistB = schedulePersist(storage, { byModel: { b: { input: 2 } }, currency: 'CNY' }, 0)
const [persistResultA, persistResultB] = await Promise.all([persistA, persistB])

check('schedulePersist：去抖只写最后一次', persistResultA.status === 'superseded' && persistResultB.status === 'saved' && storageWrites.length === 1 && storageWrites[0].value.byModel.b.input === 2, JSON.stringify(storageWrites))

storageWrites.length = 0

// ── C. 渲染：有价格（已填过的模型）────────────────────────────────────────
sdk.host.state.focusedSessionId.set('rt-1')
sdk.host.state.focusedUsage.set(USAGE)
await Promise.all(sdk.__pending)
await primeCost({ currency: 'CNY', prices: SEED_PRICES, usage: USAGE }, 0)

const htmlPriced = renderChip()

check('chip 报上下文百分比与已用/上限', htmlPriced.includes('23%') && htmlPriced.includes('45.2k/200k'))
check('chip 带上算出来的费用', htmlPriced.includes('· ¥0.680'), htmlPriced.slice(0, 220))
check('面板有「会话费用」总额', htmlPriced.includes('会话费用') && htmlPriced.includes('¥0.680'))
check('费用分项算式齐全（含 ≈ 标记与单次调用）', htmlPriced.includes('100k × 2/M') && htmlPriced.includes('≈300k × 0.5/M') && htmlPriced.includes('≈100k × 2/M') && htmlPriced.includes('10 × 0.01'), htmlPriced.match(/[=≈]?\d[\dk.]* × [\d./M次]+/g)?.join(' | '))
check('缓存命中读/写用的是价格字段名', htmlPriced.includes('缓存命中（读）') && htmlPriced.includes('缓存写入'))
check('已填价格时价格输入框按用户折叠状态隐藏（这里默认折叠）', !htmlPriced.includes('priceHint 留空') && !htmlPriced.includes('data-adornment'))
check('没有把 i18n key 或 undefined 渲染出来', !/section[A-Z]|row[A-Z]|cost[A-Z]|price[A-Z]|undefined/.test(htmlPriced))

// 按类拆分
sdk.__setQueryData([ID, 'breakdown', 'rt-1'], BREAKDOWN)

const htmlBreakdown = renderChip()

check('拆分项渲染标签与后端颜色', htmlBreakdown.includes('System prompt') && htmlBreakdown.includes('background:#ff8800'))
check('breakdown 查询只在面板打开时 enabled', sdk.record.queries.filter(q => q.key.includes('breakdown')).every(q => q.enabled === false))

// ── D. 渲染：没填价格（新模型）→ 输入框自动摊开 ────────────────────────────
sdk.host.state.focusedUsage.set(USAGE_PLAIN)
await primeCost({ currency: 'CNY', prices: {}, usage: USAGE_PLAIN }, 0)

const htmlUnpriced = renderChip()

check('没填价格时提示去哪填', htmlUnpriced.includes('还没填价格'), htmlUnpriced.slice(0, 200))
check('没填价格时价格区自动摊开（找得到输入框）', htmlUnpriced.includes('每百万 tokens') && htmlUnpriced.includes('缓存命中（读）') && htmlUnpriced.includes('每次调用'))
check('输入框带货币前缀与单位后缀', htmlUnpriced.includes('data-adornment="prefix"') && htmlUnpriced.includes('>¥<') && htmlUnpriced.includes('/M') && htmlUnpriced.includes('/次'))
check('没填价格时 chip 不带费用', !htmlUnpriced.includes('· ¥'))
check('货币切换控件在（¥ / $ 两档）', sdk.record.segments.at(-1)?.options.map(option => option.id).join(',') === 'CNY,USD')
check('“按会话累计 token 估算、≈ 行有误差”的说明在', htmlUnpriced.includes('缓存读由命中率推算'))

// 用量变了但异步结果还没回来的那一瞬：显示「计算中…」，不留上一份旧数字
await primeCost({ currency: 'CNY', prices: { input: 1 }, usage: { ...USAGE_PLAIN, input: 999999 } }, 0)

const htmlPending = renderChip()

check('签名变了但结果还没回来时显示「计算中…」', htmlPending.includes('计算中…'), htmlPending.slice(0, 200))

// ── E. 用户输入价格 → 去抖写存储 → 立刻重算 ───────────────────────────────
// 五个价格框（末尾那个 ¥ 后缀的是汇率框，不算）
const inputFields = sdk.record.inputs.filter(field => field.suffix !== '¥').slice(-5)

check('价格输入框一共五个，顺序与字段一致', inputFields.length === 5 && inputFields[4].suffix === '/次', inputFields.map(field => field.suffix).join(','))

inputFields[0].onChange({ target: { value: '5' } })
await sleep(900)

const saved = storageWrites.at(-1)

check('敲价格会写进插件自己的存储（去抖后一次）', storageWrites.length === 1 && saved.key === 'prices' && saved.value.byModel[PLAIN_MODEL].input === 5, JSON.stringify(saved?.value))

await primeCost({ currency: saved.value.currency, prices: saved.value.byModel[PLAIN_MODEL], usage: USAGE_PLAIN }, 0)

const htmlTyped = renderChip()

check('填完价格立刻算出钱（100k × 5/M = 0.5）', htmlTyped.includes('· ¥0.500') && htmlTyped.includes('100k × 5/M'), htmlTyped.slice(0, 220))
check('输入框回显用户输入的值（填完价格设置区不自动折叠）', htmlTyped.includes('value="5"'))
check(
  '只写这个模型的改动，别的模型的价格原样保留',
  Object.keys(saved.value.byModel).sort().join(',') === [PLAIN_MODEL, SEED_MODEL].sort().join(',') &&
    saved.value.byModel[SEED_MODEL].cacheRead === 0.5 &&
    saved.value.byModel[PLAIN_MODEL].input === 5 &&
    saved.value.byModel[PLAIN_MODEL].output === 0,
  JSON.stringify(saved.value.byModel)
)

// 切货币
sdk.record.segments.at(-1).onChange('USD')
await sleep(900)

const savedUsd = storageWrites.at(-1).value

check('切货币会持久化', savedUsd.currency === 'USD', JSON.stringify(savedUsd.currency))

await primeCost({ currency: 'USD', prices: savedUsd.byModel[PLAIN_MODEL], usage: USAGE_PLAIN }, 0)

const htmlUsd = renderChip()

check('换成美元后金额变 $', htmlUsd.includes('· $0.500') && htmlUsd.includes('$ 美元'))

// ── F. 约束与 i18n ─────────────────────────────────────────────────────────
const source = readFileSync(new URL('../plugin.js', import.meta.url), 'utf8')
const specifiers = [...source.matchAll(/(?:from\s*|import\s*\(\s*)['"]([^'"]+)['"]/g)].map(match => match[1])
const allowed = new Set(['@hermes/plugin-sdk', 'react', 'react/jsx-runtime'])
const stripped = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
const literals = [...new Set([...source.matchAll(/'([A-Za-z][A-Za-z0-9]*)'/g)].map(match => match[1]))]
const zhKeys = Object.keys(sdk.__i18n.bundles.zh ?? {}).sort()
const enKeys = Object.keys(sdk.__i18n.bundles.en ?? {}).sort()
const camelKeys = zhKeys.filter(key => key !== key.toLowerCase())
const dead = zhKeys.filter(key => !literals.includes(key))

check('zh / en 两套 bundle 的 key 集合一致', zhKeys.join(',') === enKeys.join(','), `${zhKeys.length} vs ${enKeys.length}`)
check('没有多余的死 key（bundle 里的 key 在源码里都有字面量）', dead.length === 0, dead.join(','))
check('没有插件级错误提示', sdk.record.notify.length === 0, JSON.stringify(sdk.record.notify))

// 复制出来的文本也要含费用
const report = sdk.record.copies.at(-1)?.text?.()

check('复制文本含费用合计与分项', Boolean(report) && report.includes('费用合计') && report.includes('100k × 5/M'), report?.split('\n').slice(0, 3).join(' | '))

// ── G. 网关价目：换模型不用重新填价格 ──────────────────────────────────────
check(
  'parseGatewayPrice：$ 前缀 / free / 未知 / 解析失败',
  parseGatewayPrice('$0.27') === 0.27 &&
    parseGatewayPrice('free') === 0 &&
    parseGatewayPrice('') === null &&
    parseGatewayPrice('?') === null &&
    parseGatewayPrice(undefined) === null,
  [parseGatewayPrice('$0.27'), parseGatewayPrice('free'), parseGatewayPrice(''), parseGatewayPrice('?')].join('|')
)

const PAYLOAD = {
  model: 'glm-4.6',
  provider: 'zhipu',
  providers: [
    {
      is_current: false,
      models: ['hermes-4'],
      pricing: { 'hermes-4': { cache: '$0.30', free: false, input: '$3.00', output: '$15.00' } },
      slug: 'nous'
    },
    {
      is_current: true,
      models: ['GLM-4.6'],
      pricing: { 'GLM-4.6': { cache: '$0.11', free: false, input: '$0.60', output: '$2.20' } },
      slug: 'zhipu'
    }
  ]
}

const found = gatewayPricesFor(PAYLOAD, 'glm-4.6')

check('gatewayPricesFor：忽略大小写与 provider/ 前缀，优先当前 provider 行', found?.prices.input === 0.6 && found.provider === 'zhipu', JSON.stringify(found))
check('gatewayPricesFor：网关只给 input/output/cache，缓存写与单次调用按 0', found.prices.cacheRead === 0.11 && found.prices.cacheWrite === 0 && found.prices.request === 0)
check('gatewayPricesFor：查不到就返回 null，不瞎编', gatewayPricesFor(PAYLOAD, 'local-vllm') === null)
check('gatewayPricesFor：payload 空/坏的也不炸', gatewayPricesFor(null, 'x') === null && gatewayPricesFor({ providers: [] }, 'x') === null)

const gConfig = putGatewayPrices(parseStoredPrices(null), 'glm-4.6', found, 1)

check('putGatewayPrices：写进缓存并带时间戳与 provider', gConfig.gateway['glm-4.6'].prices.input === 0.6 && gConfig.gateway['glm-4.6'].at === 1 && gConfig.gateway['glm-4.6'].provider === 'zhipu')

const layered = { ...gConfig, defaults: { cacheRead: 1, cacheWrite: 1, input: 1, output: 1, request: 1 } }

check('优先级：没手填 → 用网关价目', resolvePrices(layered, 'glm-4.6').source === 'gateway')
check('优先级：手填压过网关价目', resolvePrices({ ...layered, byModel: { 'glm-4.6': { input: 9 } } }, 'glm-4.6').source === 'manual')
check('优先级：网关没有这个模型 → 落通用默认价', resolvePrices(layered, 'local-vllm').source === 'defaults')
check('优先级：三层都空 → none', resolvePrices(parseStoredPrices(null), 'x').source === 'none')
check('setDefaults：给没价目的模型兜一层', resolvePrices(setDefaults(parseStoredPrices(null), SEED_PRICES), 'x').source === 'defaults')
check('clearManual：清掉手填价就退回网关价目', resolvePrices(clearManual({ ...layered, byModel: { 'glm-4.6': { input: 9 } } }, 'glm-4.6'), 'glm-4.6').source === 'gateway')

const cny = effectivePrices(gConfig, 'glm-4.6')

check('effectivePrices：网关的美元价按汇率折成 ¥（0.6 × 7.2 ≈ 4.32）', Math.abs(cny.prices.input - 4.32) < 1e-9 && cny.converted === true && Math.abs(cny.raw.input - 0.6) < 1e-9, `${cny.prices.input} / raw ${cny.raw.input}`)
check('effectivePrices：显示货币选 $ 就不折算', effectivePrices({ ...gConfig, currency: 'USD' }, 'glm-4.6').prices.input === 0.6)
check('convertPrices：汇率可调（×10）', Math.abs(convertPrices({ input: 1 }, { currency: 'CNY', rate: 10 }).input - 10) < 1e-9)

// 真跑一遍：RPC → 缓存 → 落盘
sdk.record.segments.at(-1).onChange('CNY')
await sleep(900)
setStorageDoor(storage)
storageWrites.length = 0

const rpc = []
const gatewayRequest = async (method, params) => {
  rpc.push({ method, params })

  if (method === 'model.options') {
    return PAYLOAD
  }

  throw new Error(`unexpected RPC ${method}`)
}

const fetched = await ensureGatewayPrices({ model: 'glm-4.6', profile: 'default', request: gatewayRequest, retryDelay: 0 })

check('ensureGatewayPrices：拿到价目并写进配置', fetched.status === 'ready' && rpc.length === 1 && rpc[0].method === 'model.options', `${fetched.status} rpc=${rpc.length}`)

await sleep(900)

const live = storageWrites.at(-1)?.value

check('网关价目落盘、且没往「手填」里塞东西', live?.gateway?.['glm-4.6']?.prices?.input === 0.6 && !live?.byModel?.['glm-4.6'], JSON.stringify(live?.gateway))

check(
  '重启后能读回来（落盘形状 ↔ parseStoredPrices 对得上）',
  parseStoredPrices(live).gateway['glm-4.6'].prices.input === 0.6 && parseStoredPrices(live).gateway['glm-4.6'].provider === 'zhipu'
)
check('ensureGatewayPrices：24 小时内不再重复发 RPC', (await ensureGatewayPrices({ model: 'glm-4.6', profile: 'default', request: gatewayRequest, retryDelay: 0 })).status === 'cached' && rpc.length === 1, `rpc=${rpc.length}`)
check('ensureGatewayPrices：force 绕过缓存重取', (await ensureGatewayPrices({ force: true, model: 'glm-4.6', profile: 'default', request: gatewayRequest, retryDelay: 0 })).status === 'ready' && rpc.length === 2)
check('ensureGatewayPrices：网关没这个模型 → empty，不写脏数据', (await ensureGatewayPrices({ force: true, model: 'local-vllm', profile: 'default', request: gatewayRequest, retryDelay: 0 })).status === 'empty')
check('ensureGatewayPrices：RPC 挂了标错误，不崩', (await ensureGatewayPrices({ force: true, model: 'x', profile: 'default', request: async () => { throw new Error('gateway down') }, retryDelay: 0 })).status === 'error')

// 渲染：换成一个从没手填过的模型，费用该自己出来
const GLM_USAGE = { ...USAGE, model: 'glm-4.6' }

sdk.host.state.focusedUsage.set(GLM_USAGE)
await primeCost({ currency: 'CNY', prices: effectivePrices(live, 'glm-4.6').prices, usage: GLM_USAGE }, 0)

const htmlGateway = renderChip()

check('换到没手填过的模型：费用自动出来（4.32×100k + 15.84×10k + 0.792×300k ≈ ¥0.828）', /· ¥0\.82\d/.test(htmlGateway), htmlGateway.slice(0, 230))
check('分项用的是折算后的单价', /100k × 4\.3\d*\/M/.test(htmlGateway) && /300k × 0\.79\d*\/M/.test(htmlGateway), htmlGateway.match(/100k × [\d.]+/g)?.join(' '))
check('面板标出价格来源是网关价目', htmlGateway.includes('价格来源') && htmlGateway.includes('网关价目'))
check(
  '面板标出这套价属于哪个模型',
  htmlGateway.includes('模型') && htmlGateway.includes('glm-4.6'),
  'model name rides the source row'
)
check(
  '价格行优先给人民币（¥），不再挂 ×汇率',
  htmlGateway.includes('¥4.32 /') && htmlGateway.includes('每 M') && !htmlGateway.includes('×7.2'),
  htmlGateway.match(/¥[\d.]+ \/ ¥[\d.]+ \/ ¥[\d.]+/)?.[0]
)
check(
  '美元细节默认收起：网关原价与汇率都不渲染',
  !htmlGateway.includes('$0.6') &&
    !htmlGateway.includes('1 USD =') &&
    htmlGateway.includes('美元') &&
    htmlGateway.includes('更新于'),
  'collapsed — only the ¥ row is visible'
)

$usdOpen.set(true)
const htmlUsdOpen = renderChip()

check(
  '展开「美元」后才露出网关原价与汇率',
  htmlUsdOpen.includes('$0.6 /') && htmlUsdOpen.includes('×7.2') && htmlUsdOpen.includes('1 USD ='),
  htmlUsdOpen.match(/网关原价[^<]*/)?.[0]
)

$usdOpen.set(false)

// ── 网关取回的价必须真的落进输入框 ──────────────────────────────────────────
// （以前输入框只显示「手填」层，于是出现「来源=网关 + 五个空框」的自相矛盾）
const gwFields = sdk.record.inputs.filter(field => field.suffix !== '¥').slice(-5)

check(
  '网关取回的价填进输入框（折算后的 ¥ 数）',
  gwFields[0]?.value === 4.32 && gwFields[1]?.value === 15.84 && gwFields[2]?.value === 0.792,
  gwFields.map(field => field.value).join(' / ')
)
check(
  '备注写明这几格是网关取回的、不是手填',
  htmlGateway.includes('网关价目取回的价') && htmlGateway.includes('变成手填'),
  htmlGateway.match(/这几格[^<]*/)?.[0]
)

// 以网关价为基础改一格：其余格子必须留着（草稿要先种成框里那套数）
gwFields[1].onChange({ target: { value: '20' } })

const htmlEdited = renderChip()
const editedFields = sdk.record.inputs.filter(field => field.suffix !== '¥').slice(-5)

check(
  '以网关价为基础改一格，其余格子不被清空',
  editedFields[0]?.value === 4.32 &&
    Number(editedFields[1]?.value) === 20 &&
    editedFields[2]?.value === 0.792,
  editedFields.map(field => field.value).join(' / ')
)
check(
  '改过之后来源翻成「手填」，并提示手填优先级最高',
  htmlEdited.includes('手填') && htmlEdited.includes('优先级最高'),
  htmlEdited.match(/这五个数[^<]*/)?.[0]
)

// 回归：输入框必须回放「用户打的原文」，不能回放归一化后的数字 ——
// 否则打「1.」的瞬间被抹成「1」，小数点永远打不进去（只能输整数）。
const typingField = sdk.record.inputs.filter(field => field.suffix !== '¥').slice(-5)[0]

typingField.onChange({ target: { value: '1.' } })
const htmlTyping = renderChip()
const typingFields = sdk.record.inputs.filter(field => field.suffix !== '¥').slice(-5)

check(
  '打「1.」时框里就是「1.」（小数能接着打）',
  typingFields[0]?.value === '1.',
  `shows ${JSON.stringify(typingFields[0]?.value)}`
)

typingFields[0].onChange({ target: { value: '1.5' } })
renderChip() // 不重渲染的话下面取到的还是上一次的快照
const decimalFields = sdk.record.inputs.filter(field => field.suffix !== '¥').slice(-5)

check(
  '接着打「1.5」也原样留住',
  decimalFields[0]?.value === '1.5',
  `shows ${JSON.stringify(decimalFields[0]?.value)}`
)
check(
  '手填时其余格子照旧保留（种子来自框里那套数）',
  Number(decimalFields[1]?.value) === 20 && Number(decimalFields[2]?.value) === 0.792,
  decimalFields.map(field => field.value).join(' / ')
)
check('说明当前这套是网关价目（不用手填）', htmlGateway.includes('自动取回并缓存在本地'))

const leaked = camelKeys.filter(key => htmlGateway.includes(key))

check('i18n key 没被当文案渲染出来（网关那套文案也一样）', leaked.length === 0, leaked.join(','))

// ── F. 价格配置文件（v2）────────────────────────────────────────────────────
import {
  addProfile,
  bindSessionProfile,
  deleteProfile,
  newProfileId,
  profileForSession,
  setActiveProfile,
  updateProfile
} from '../plugin.js'

const P_A = { cacheRead: 0.5, cacheWrite: 2, input: 2, output: 3, request: 0.01 }
const P_B = { cacheRead: 0, cacheWrite: 0, input: 1, output: 8, request: 0 }

// 新建：第一个自动激活；名字空着自动编号
const cfg1 = addProfile(parseStoredPrices(null), '贵价', P_A)
check('addProfile：第一个建的自动成为激活配置', cfg1.activeProfile === Object.keys(cfg1.profiles)[0], cfg1.activeProfile)
check('addProfile：名字与价格都落进去', cfg1.profiles[cfg1.activeProfile]?.name === '贵价' && near(cfg1.profiles[cfg1.activeProfile]?.prices.input, 2), JSON.stringify(cfg1.profiles))

const cfg2 = addProfile(cfg1, '', P_B)
check('addProfile：第二个名字自动编号「配置 2」', Object.values(cfg2.profiles)[1]?.name === '配置 2', Object.values(cfg2.profiles)[1]?.name)
// 「新建 → 再填数」是正常路径：价格先空着也必须能建、能存下来
const cfgEmpty = addProfile(cfg1, '空着填', { input: 0 })
check(
  'addProfile：价格可以全 0（新建后还没填）',
  cfgEmpty.profiles.p2 !== undefined && cfgEmpty.profiles.p2.prices.input === 0,
  JSON.stringify(cfgEmpty.profiles.p2)
)
check(
  '往返：价格全 0 的配置刷新后还在（不会「建了又没了」）',
  parseStoredPrices(cfgEmpty).profiles.p2?.name === '空着填'
)

// 上限：第 21 个被拒
let cfgFull = cfg2
for (let i = 0; i < 25; i += 1) {
  cfgFull = addProfile(cfgFull, `m${i}`, P_A)
}
check('addProfile：最多 20 个，第 21 个不动', Object.keys(cfgFull.profiles).length === 20, Object.keys(cfgFull.profiles).length)

// 改名 + 改价
const renamed = updateProfile(cfg2, 'p1', { name: '便宜价', prices: P_B })
check('updateProfile：名称与价格一起改', renamed.profiles.p1?.name === '便宜价' && near(renamed.profiles.p1?.prices.output, 8), JSON.stringify(renamed.profiles.p1))
check('updateProfile：只改名字时价格不动', updateProfile(cfg2, 'p1', { name: '改名' }).profiles.p1?.prices.input === 2)
check('updateProfile：不存在的 id 原样返回', updateProfile(cfg2, 'nope', { name: 'x' }) === cfg2 || updateProfile(cfg2, 'nope', { name: 'x' }).profiles.nope === undefined)
check('updateProfile：名字清空被拒（保留原名）', updateProfile(cfg2, 'p1', { name: '   ' }).profiles.p1?.name === '贵价')

// 切换
check('setActiveProfile：切到存在的配置', setActiveProfile(cfg2, 'p2').activeProfile === 'p2')
check('setActiveProfile：不存在的 id 不动', setActiveProfile(cfg2, 'nope').activeProfile === cfg2.activeProfile)

// 删除：绑定与激活指针一并清干净
const bound = bindSessionProfile(cfg2, 'sess-1', 'p2')
check('bindSessionProfile：会话绑到 p2', bound.sessions['sess-1'] === 'p2')
const removed = deleteProfile(bound, 'p2')
check('deleteProfile：删除后绑定被清、不留悬空引用', removed.profiles.p2 === undefined && removed.sessions['sess-1'] === undefined, JSON.stringify(removed.sessions))
check('deleteProfile：删的是激活配置时指针清空', deleteProfile(setActiveProfile(cfg2, 'p2'), 'p2').activeProfile === '')

// 落盘形状 ↔ 解析形状必须成对测（技能要求）：profiles 嵌 { id, name, prices }
const stored = {
  activeProfile: 'p1',
  currency: 'CNY',
  profiles: { p1: { id: 'p1', name: '贵价', prices: P_A }, p2: { id: 'p2', name: 'B', prices: P_B } },
  rate: 7.2,
  sessions: { 'sess-9': 'p2' }
}
const reparsed = parseStoredPrices(stored)
check(
  '往返：落盘的 profiles/sessions/activeProfile 原样读回',
  reparsed.profiles.p1?.name === '贵价' &&
    near(reparsed.profiles.p1?.prices.input, 2) &&
    reparsed.sessions['sess-9'] === 'p2' &&
    reparsed.activeProfile === 'p1',
  JSON.stringify(reparsed.profiles)
)
// 会话绑定优先于全局激活：sess-9 绑了 p2，就算激活的是 p1 也用 p2
const effBound = resolvePrices(reparsed, SEED_MODEL, 'sess-9')
check('resolvePrices：会话绑定的配置优先于全局激活', effBound.source === 'profile' && effBound.profileName === 'B' && near(effBound.prices.output, 8), JSON.stringify({ source: effBound.source, name: effBound.profileName }))
const effGlobal = resolvePrices(reparsed, SEED_MODEL, 'other-session')
check('resolvePrices：没绑的会话跟随全局激活配置', effGlobal.source === 'profile' && effGlobal.profileName === '贵价', JSON.stringify({ source: effGlobal.source, name: effGlobal.profileName }))
// 会话绑定指向已删配置：悬空绑丢弃，回落全局
check(
  'parseStoredPrices：悬空的会话绑定一律丢弃',
  parseStoredPrices({ ...stored, sessions: { 'sess-9': 'gone' } }).sessions['sess-9'] === undefined
)

// 优先级：配置文件 > 手填 > 网关 > 默认
const layeredV2 = parseStoredPrices({
  byModel: { [SEED_MODEL]: { input: 9 } },
  profiles: { p1: { id: 'p1', name: 'P', prices: P_A } },
  sessions: {}
})
layeredV2.activeProfile = 'p1'
const effProfile = resolvePrices(layeredV2, SEED_MODEL)
check('resolvePrices：配置文件压过手填', effProfile.source === 'profile', effProfile.source)
const noProfile = parseStoredPrices({ byModel: { [SEED_MODEL]: { input: 9 } }, profiles: {} })
check('resolvePrices：没有配置文件时回落手填', resolvePrices(noProfile, SEED_MODEL).source === 'manual')

// v1 → v2 迁移：老配置没有 profiles，手填那套被收编成「默认配置」（不自动激活，
// 免得把老用户「按模型手填」的行为静默改成「所有模型都套这套价」）
const v1 = parseStoredPrices({ byModel: { [SEED_MODEL]: P_A }, currency: 'CNY', rate: 7.2 })
check(
  'v1 迁移：老配置收编成一个「默认配置」',
  Object.keys(v1.profiles).length === 1 && Object.values(v1.profiles)[0]?.name === '默认配置',
  JSON.stringify(v1.profiles)
)
check('v1 迁移：不自动激活（老行为不变，仍是按模型手填）', v1.activeProfile === '' && resolvePrices(v1, SEED_MODEL).source === 'manual', `${v1.activeProfile} / ${resolvePrices(v1, SEED_MODEL).source}`)
check(
  'v1 迁移：收编的价格就是原手填价',
  near(Object.values(v1.profiles)[0]?.prices.input, 2) && near(Object.values(v1.profiles)[0]?.prices.output, 3)
)

// 计费真的用配置文件的价：USAGE × P_B（input=1, output=8）手算
const costViaProfile = computeCost(USAGE, resolvePrices(reparsed, SEED_MODEL, 'sess-9').prices)
check(
  'computeCost：走配置文件价的钱对得上（1×0.1 + 8×0.01 = 0.18）',
  near(costViaProfile.total, 0.18),
  JSON.stringify(costViaProfile.total)
)

// 改配置文件的价格 → 用它计费的会话立刻跟着变；没绑它的会话不受影响
const editedProfiles = updateProfile(reparsed, 'p2', { prices: { input: 5, output: 50 } })
const afterEdit = resolvePrices(editedProfiles, SEED_MODEL, 'sess-9')
check(
  '改配置文件价格 → 绑它的会话计费立刻按新价',
  near(afterEdit.prices.input, 5) && near(afterEdit.prices.output, 50),
  JSON.stringify(afterEdit.prices)
)
check(
  '改 p2 不影响没绑它的会话（仍走全局激活的 p1）',
  near(resolvePrices(editedProfiles, SEED_MODEL, 'other-session').prices.input, 2)
)
check(
  '改配置文件价格不影响另一个配置文件',
  near(editedProfiles.profiles.p1.prices.input, 2)
)

// UI：配置文件管理区渲染 —— 折叠头带计数，绑定标记与会话绑定下拉都在
const $profilesOpen = await import('../plugin.js').then(m => m.$profilesOpen)
$profilesOpen.set(true)
const htmlProfiles = renderChip()
check(
  '面板渲染出「价格配置」区（n/20 计数 + 会话绑定下拉）',
  htmlProfiles.includes('价格配置') && htmlProfiles.includes('/20') && htmlProfiles.includes('此会话独立用'),
  htmlProfiles.match(/价格配置[^<]*/)?.[0]
)
check('新来源文案在两套 i18n 里都有（没漏 key）', htmlProfiles.includes('配置文件') && !htmlProfiles.includes('srcProfile'))
$profilesOpen.set(false)

// ── 汇总 ──────────────────────────────────────────────────────────────────
console.log(`\n${PASS.length} passed, ${FAIL.length} failed`)

if (FAIL.length) {
  console.log(`FAILED: ${FAIL.join(' | ')}`)
  process.exit(1)
}
