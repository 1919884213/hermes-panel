# session-token-detail — 离线测试台

插件本体是上一层的 `plugin.js`。这个目录是它的离线测试台：桩掉
`@hermes/plugin-sdk`（`node_modules/@hermes/plugin-sdk/index.mjs`），用真
React 19 + `react-dom/server` 渲染 `register()` 注册出来的 chip，逐条断言。

## 跑法

```bash
cd D:/APP/hermes/desktop-plugins/session-token-detail
node tests/test.mjs        # 退出码非 0 = 有 FAIL；最后一行是 "N passed, M failed"
```

不需要起桌面 App，也不需要网络。

## 覆盖点（改 plugin.js 后重跑）

**A. 纯函数**（钱算错比界面丑严重，逐个手算核对）
- `computeCost`：五个分项、单次调用费不除以百万、缓存读按命中率推算 /
  缓存写取残差、`prompt` 缺失兜底、残差为负夹 0、没价格 → `unpriced`（绝不算出
  0 元假账单）
- `formatMoney` 分级小数位与 ¥/$ 符号；`normalizeRates` 对空串/乱输入的容错；
  `costSignature` 同值不同写法同签名；`parseStoredPrices` / `mergePrices` 的形状校验

**A2. 三层价格来源**（手填 > 网关价目 > 通用默认价）
- `parseGatewayPrice`：`"$0.27"` / `"free"` / `""` / `"?"` 四种网关输出
- `gatewayPricesFor`：忽略大小写与 `provider/` 前缀、优先当前 provider 行、查不到返回
  `null`（不瞎编）、坏 payload 不炸
- `resolvePrices`：每层单独命中、高层压过低层、低层兜底、三层全空、清掉高层回落
- `effectivePrices` / `convertPrices`：网关是 $/Mtok，显示货币为 ¥ 时按 `rate` 折算
- `ensureGatewayPrices` 真跑一遍：RPC → 缓存 → 落盘 → 24h 内不发第二次 RPC →
  `force` 绕过缓存 → 查不到（`empty`）/ RPC 挂了（`error`）都不写脏数据
- **往返断言**：落盘的那份能用 `parseStoredPrices` 读回来（曾漏掉，导致重启丢缓存）
- v1 老配置（只有 `currency` + `byModel`）也读得进来

**B. 异步引擎**
- `primeCost` 去抖 + 过期丢弃：被取代的调用方必须**立刻**拿到 `superseded`
  而不是挂住（曾经的实现 clearTimeout 掉前一个定时器，调用方的 await 永远不返回）
- `schedulePersist` 同样只写最后一次

**C. 渲染**（静态 HTML 逐条查文本）
- 注册形状：只有一个 `statusBar.right` chip、order 126、不占布局
- 上下文百分比 / 已用上限 / 按类拆分颜色 / 数据来源标注
- 费用：合计、五行算式（推算出来的两行带 ≈）、后端上报单列
- 输入框填的是「当前真正在用的价」：网关取回的也填进去（不再是空框却标着「来源：网关」），
  备注随来源切换；以网关价改一格时其余格子保留（草稿以框里那套数为起点，
  且草稿停在别的模型上时会先换回本模型）
- 折算收掉浮点尾巴：2.2 × 7.2 = 15.84，不是 15.840000000000002（会直接填进输入框）
- **输入框回放用户打的原文**（归一化只用于算钱）：打「1.」不能被抹成「1」，
  否则小数点打不进去、只能输整数（真实回归，测试已钉住）
- 价格设置面板：标出当前模型；单价按显示货币给（默认 ¥，不再挂 ×汇率）；
  **美元细节默认折叠**（网关原价 `$/Mtok` 与 `1 USD =` 汇率只有展开后才渲染）
- 没填价格时：提示 + 设置区自动摊开 + 输入框货币前缀与单位后缀 + chip 不带费用
- 签名变了但异步结果还没回来 → 「计算中…」（不留上一份旧数字）
- **用户输入价格 → 去抖写存储 → 立刻重算**的完整链路（在桩里调 `Input` 的
  `onChange`，等价于一次击键），并验证只改当前模型、别的不动
- **换个没手填过的模型 → 费用自动出来**，面板标出「价格来源：网关价目」并露出
  网关原价与 `×汇率` 折算说明
- 切货币 → 持久化 → 金额符号跟着变
- i18n：zh / en 两套 key 集合一致、没有死 key（bundle 里的 key 在源码里都有字面量）、
  渲染出来的 HTML 里不出现任何 camelCase 的 key 名
- 加载约束：只 import 三个允许的说明符、文件里没有 JSX 语法

## 桩的取舍

`node_modules/@hermes/plugin-sdk/index.mjs` 是手写的桩，行为跟真 SDK 对齐的地方
写在文件头：`useQuery` 复刻 react-query 的可观察契约（缓存命中即便 `enabled:false`
也给数据）、Popover 三件套**内联**渲染（桩里没有 portal，这样面板才可断言）、
`Input`/`SegmentedControl` 记录自己的 `onChange` 以便驱动写路径。

`node_modules/` 只服务于这个测试台，插件运行时不需要它。
