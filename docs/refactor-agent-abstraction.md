# 智能体层重构方案（面向对象：抽象 + 每个智能体一个实现）

> 目标读者：维护 herdr-desktop 的开发者。
> 本文是**方案**，不是实现。所有结论都已逐文件核对当前代码（`03839f9`），行号可对照。

---

## 0. 摘要

> **进度状态（持续更新）**：批 0~6 全部完成。批 2 的「消灭 agent 特例」已完成、
> 结构拆分见附录 E（TerminalState 抽出 7 个协作对象、IpcRouter 拆出 handlers/ 与通知调度）；批 3 的安装器已类化（18/19）。
> 详见文末「附录 E：重构进度」。

一句话：**把"某个智能体长什么样"从散落在 8 张表、6 个文件里的 `if (agent === 'xxx')`，收敛成"一个智能体 = 一个对象"。**

| | 现状 | 目标 |
|---|---|---|
| 智能体知识的落点 | 8 张 agent 清单（成员各不相同）+ 6 个文件、5 种表示形式 | 每个 agent 一个 descriptor，一处声明 |
| 硬编码 agent id | 10 处内联 if（terminal-state）+ 36 处谓词调用 + 32 条白名单条目 | 0（注册表与策略数据除外） |
| 新增一个智能体 | 改 8 个文件 / 14 处（另有 4 个条件文件） | 新增 1 个文件 + 注册 1 行 |
| 最大单文件 | `terminal-state.ts` 2169 行 / 69 方法；`router.ts` 1678 行 | Facade ≤ 400 行 + 6 个协作类 |
| 身份来源 | **`agentId` 从不流经 IPC**，主进程靠猜 | 创建时记录，检测只做校验 |

**手法**：抽象基类（Template Method 固定骨架）＋ 能力面拆成小接口（ISP）＋ 状态仲裁走策略（Strategy）＋ 检测规则保持声明式（Specification）＋ 注册表（Registry，对扩展开放）＋ 旧类用 Facade 保住公共 API（迁移期零风险）。

**节奏**：7 个批次，每批**行为等价**、独立可发布、有明确回滚点。第 0/1 批风险最低、收益最大，可以先合。

---

## 1. 现状诊断：为什么"改一处就坏另一处"

### 1.1 根因：智能体的"身份"从来没有被建模

`SpawnAgentParams`（`shared/state.ts:192`）只有 `command` / `args` / `cwd` / `label`——**没有 `agentId`**。渲染层明明知道用户点的是哪个智能体（`AGENT_PRESETS`，`src/stores/agentsStore.ts:53`），但这个 id 在 `spawnAgent()`（`router.ts:497`）**被直接丢弃**，只把 `command: 'claude'` 传下去。

主进程此后必须用 **4 种互不相同的方式重新猜**它是谁：

| 来源 | 位置 | 问题 |
|---|---|---|
| 命令首 token → 正则 | `router.ts:1082` `parseAgentLabel(commandName)` | 唯一做了规范化的路径 |
| 屏幕文本识别 | `agent-detector.ts:149` `detectAgentName` | TUI 不一定打印品牌名 |
| hook 上报的 `agent` 字段 | `report-server.ts:20` → `router.ts:705` | 第三方可伪造 |
| 硬编码常量 | `session.ts:32` `WEB_AGENT_NAME='dsh'` | 只覆盖 web 型 |

四者可以互相冲突，仲裁逻辑散在 `terminal-state.ts:1415`、`:1932`、`:2061`。**这正是"逻辑杂揉"的总根源**：因为身份不稳，后面每一层都要重新判断一次，于是每层各长出一套 agent 特例。

### 1.2 同一个"agent 清单"有 8 份，成员各不相同

| 表 | 位置 | 条数 | 口径 |
|---|---|---|---|
| `AGENT_IDENTITY`（识别） | `shared/detect-manifest.ts:21` | **25** | 含 `dsh`；不含 `terminal` |
| `MANIFESTS`（屏幕规则） | `shared/detect/manifests/index.ts:36` | **22** | 无 omp / mastracode / dsh |
| `OFFICIAL_AGENTS`（恢复白名单） | `agent-resume.ts:26` | **19** | 含 `dsh`；缺 gemini/cline/kiro/amp/maki/muse |
| `resumeTail`（有恢复命令的） | `agent-resume.ts:312` | **18** | 无 dsh（`canResume` 对它恒 false） |
| `HOOK_TARGETS`（集成） | `integration/index.ts:189` | **19** | 键是 **`'dsh-web'`** 而非 `'dsh'` |
| `INTEGRATION_VERSIONS` | `integration/assets.ts:121` | **19** | 同上 |
| `HookScriptAgent`（脚本型联合类型） | `integration/assets.ts:52` | **13** | 只有传统 hook 脚本型 |
| `AGENT_PRESETS`（渲染层） | `src/stores/agentsStore.ts:53` | **26** | 24 agent + `terminal` + `'dsh-web'` |

**没有任何一处校验这些表彼此一致。** 而且每张表缺一条，失效方式还不一样：

- `AGENT_IDENTITY` 缺 → 屏幕认不出，状态永远是 `unknown`；
- `MANIFESTS` 缺 → 有识别但没规则，一律回落 `idle`（**看起来正常，其实瞎了**）；
- `OFFICIAL_AGENTS` 缺 → hook 上报被当成"非官方来源"全部丢弃；
- `resumeTail` 缺 → 会话恢复了但开的是新会话；
- `HOOK_TARGETS` 缺 → 设置页显示"不支持"，状态只能靠屏幕；
- `AGENT_PRESETS` 缺 → 用户根本选不到它。

**静默降级 + 无编译期约束**，就是"改一处坏另一处"的物理机制。

还有一个隐蔽的口径问题：**同名不同构的两套 manifest 并存**。`AgentManifest`（`engine.ts:49`，`{ id, rules: ManifestRule[] }`）是真正的屏幕规则表；`AgentDetectManifest`（`shared/state.ts:275`，`{ agent, rules: { pattern, status }[] }`）只是被 `BUILTIN_MANIFESTS`（`detect-manifest.ts:194`）用来做名字识别。两个类型都叫 manifest，后者随 §1.4 的整合一并删除。

此外，屏幕规则的**覆盖率本身也不齐**：22 个 agent 有 manifest（共 144 条规则），`omp` / `mastracode` 因为走全生命周期 hook 权威而完全没有，`dsh` 因为是 web pane 没有屏幕；`opencode` 只有 3 条规则且**没有 idle 规则**（靠引擎无命中回落 idle），`pi` 只有 2 条且只有 working。这意味着"检测质量"本身就是逐 agent 不同的——正是需要被某个对象统一表达的差异。

### 1.3 已经发生的静默失效（不是假想风险）

三处可以立刻验证的缺陷，都是"同一概念多处表示"的后果：

1. **`dsh` 的完成判定查表永远 miss**：`router.ts:1285` 用 `hookStatuses()[agent]`，而 `agent` 来自 `detectedAgent`（`'dsh'`），`HOOK_TARGETS` 的键却是 `'dsh-web'`。当前不炸只因为 `router.ts:1282` 的 `screenCompletionIgnored('dsh')` 先返回 `false` 短路了——**修好其中一个特例就会暴露这个 bug**。
2. **`dedupeKey` 算出来没人用**：`agent-resume.ts:257` 的值在 `plan()`（`:279`）里生成，注释声称"同一会话不允许被两个 pane 同时恢复"，**实际从未执行**。
3. **会话替换仲裁有两份实现，其中一份是死码**：`agent-resume.ts:199` 的 `shouldReplacePaneAgentSession` 无任何调用者，`terminal-state.ts:1846` 另写了一遍。

另有一处口径不一致导致的逻辑漏洞：`sessionStartSource` 的合法值在 `agent-resume.ts:121` 是 8 个（含 `branch`），在 `terminal-state.ts:1885` 只有 7 个（**缺 `branch`**）。结果是 `SESSION_REPLACEMENT_ALLOWED` 里 qwen 的 `branch` 条目（`:183`）永远无法命中。

### 1.4 一个智能体的知识横跨 6~8 个文件

以 `antigravity` 为例：

| # | 文件 | 存了什么 | 行 |
|---|---|---|---|
| 1 | `src/stores/agentsStore.ts` | 展示名、启动命令 `agy` | 60 |
| 2 | `shared/detect-manifest.ts` | 识别正则、别名 `agy→antigravity` | 28 / 63 |
| 3 | `shared/detect/manifests/antigravity.ts` | 屏幕规则（84 行） | 全文件 |
| 4 | `shared/detect-manifest.ts` | 屏幕不判完成 + 启动窗口生效 | 175 / 191 |
| 5 | `electron/runtime/integration/index.ts` | 配置目录、`PreInvocation`/`Stop` 事件、`herdr-desktop` 块形状、目录预检 | 1077-1138 |
| 6 | `electron/runtime/integration/assets.ts` | 脚本资产、版本号 `5` | 35 / 133 |
| 7 | `electron/runtime/agent-resume.ts` | 恢复参数 `--conversation` | 338 |
| 8 | `electron/runtime/terminal-state.ts` | 启动窗口判定 | 2163 |

改 antigravity 的检测规则要动 3 处，加一个 hook 事件要动 2 处（还容易忘版本号）。

### 1.5 四个"隐藏的类"：能力被写成了谓词函数

```ts
// shared/detect-manifest.ts —— 这 4 个函数就是 4 个能力维度，却写成了 if 链
fullLifecycleHookAuthority(source, agentLabel): boolean     // :126  pi/omp/mastracode/opencode/kilo/kimi（6 个）
sessionIdentityOnlyIntegration(source, agentLabel): boolean // :148  hermes/qwen/letta（3 个）
screenCompletionIgnored(agentLabel): boolean                // :174  antigravity/claude（2 个）
screenStartupIgnored(agentLabel): boolean                   // :190  antigravity（1 个）
```

它们被 `terminal-state.ts` 调用了 **36 次**（`fullLifecycleHookAuthority` 占 14 处），一条 `fullLifecycleHookAuthority` 同时决定 4 件事：hook 是否压过屏幕、抑制表/陈腐会话表是否参与、working 是否有 TTL、会话上报走不走全生命周期闸门。

后果：
- **新增 agent 要同时记得改 4 个函数**，漏一个的表现分别是"没有完成提示音"或"响两次"，没有编译期检查——`agentLabel` 是 `string`。
- 注释里已经出现"往这里加 agent 时必须确认…"（`:170`）——**靠注释维持的不变量**，就是设计该被重构的信号。
- `antigravity` 从 `sessionIdentityOnlyIntegration` 移出时留了 6 行解释（`:142-147`），这类"迁移痕迹"会持续累积。

### 1.6 `TerminalState`：2169 行 / 69 方法的 God class

一个类扛了 7 件事：

| 职责 | 代表成员 | 行 |
|---|---|---|
| 状态机与迁移合法性 | `setDetectedStateWithScreenSignalsAt`（**272 行**）、`recomputeEffectiveState` | 262-533 / 2084-2111 |
| hook 权威账本 | `setHookAuthorityAt`（**128 行**）、seq 水位 `acceptHookReport` | 535-662 / 1974 |
| 会话身份与冲突仲裁 | `setAgentSessionRefForSessionStart`（**269 行**）、owner 冲突 | 686-954 / 1841-1872 |
| 全生命周期上报的抑制/路由/陈腐会话 | `routeFullLifecycleHookReport`（113 行）、`clearFullLifecycleHookSuppressionForDetectedAgent`（90 行） | 1487-1599 / 1681-1770 |
| 托管 agent 启动阶段机 | `beginManagedAgent` / `reconcileManagedAgentAt` | 1208-1345 |
| agent 名归属与进程退出 | `reconcileAgentNameOwner` | 2057-2082 |
| 屏幕信号与 blocker 覆盖 | `visibleBlockerOverridesHook` | 1995-2017 |

**10 处内联 agent 字面量**（重构的直接依据）：

| 行 | agent | 特例内容 | 应归属 |
|---|---|---|---|
| 358 | codex | non-codex 每次观测都清 `codexPromptReady` | codex readiness |
| 572-581 | codex | 状态上报不允许更换已锚定会话 | 会话重绑策略 |
| 905-915 | codex | 允许换会话时直接清 hook 权威 | 会话重绑策略 |
| 1244-1257 | codex | 唯一接受「prompt 就绪」信号的 API | readiness 探针 |
| 1295-1304 | codex | `unknown + promptReady` 视为就绪 | readiness 探针 |
| 1318-1327 | codex | **与上一行逐字重复** | readiness 探针 |
| 1522-1531 | opencode | 拒绝别家会话上报（防串台） | 会话重绑策略 |
| 1866-1883 | mastracode | 无权威时允许会话覆盖 | 会话重绑策略 |
| 1914-1926 | opencode | `select` 不带 seq 免水位 | 会话重绑策略 |
| 1936-1947 | grok | 排除在「前台可抢占会话」之外 | 接管策略 |

同一个 codex readiness 判定写了两遍（1295 / 1318），同一个 codex 会话判定写了两遍（572 / 905）。

**其它结构性负担**：
- `sessionRefChanged` 的计算重复 **12 处**，其中 `:989` 语义不同（用 `previousSession !== null` 而非比较新旧）——**复制粘贴已经产生了不一致**；
- 7 份相同的「快照前导」4 行代码（274 / 609 / 774 / 900 / 973 / 1029 / 1069）；
- 抑制表 `suppressedFullLifecycleHookReports` 的条目是**可变对象，在 7 个方法里就地改写**（426/753/791/1477/1706），无单一写者，不变量无法局部验证；
- **状态机拥有超时语义但不拥有时钟**：TTL（`HOOK_WORKING_TTL_MS=1500`）在 `effectiveHookState` 求值，但推动它的是一个外部定时器 `router.ts:1443` `scheduleHookWorkingExpiry`（因为"用户按 Esc 后 TUI 静止，不再有观测"）。这个跨层依赖是本次重构最需要显式处理的耦合。
- **15 个公开方法没有生产调用者**（只有 5 个被 `router.ts` 调用，其余只被测试使用）——托管/命名子系统实际上是休眠的，而 codex 的 3 处特例正好寄生在其中。

### 1.7 `IpcRouter`：1678 行 / 约 50 个方法的 God object

它是唯一的粘合层：`Session` 与 `PtyManager` 彼此完全不知情，**所有"读 Session → 操作 runtime → 写回 → 推快照"的四步曲由 router 手写 20+ 次**。

- `refreshAgent`（**:1290-1395，105 行**）把 7 件事串在一起：检测 → 展示字段 → skip 规则 → 状态仲裁 → 完成归属判定 → 跳变通知 → 会话 id 兜底采集 → 推快照。
- `reportAgentSession`（**:701-828，128 行**）：来源校验 → dsh 会话路由 → blocker 边界丢弃 → 心跳丢弃 → seq 兜底 → 状态写入 → aborted 抑制 → 通知 → working TTL → 会话持久化 → 推快照。
- `closePane`（:1232-1249）8 个关注点，且对同一 pane 无条件调 `pty.kill` 与 `web.release`。
- **11 处 agent 特化**：`launchEnvFor('dsh')`、`injectHookEnv(...,'dsh')`、`HERDR_DESKTOP_CWD`（只有 dsh 有）、`source === 'herdr:dsh'`、`screenCompletionIgnored` + `hookStatuses()[agent]`、**自己拼 `herdr:${detectedName}`**（`:1377` 重新实现了一遍约定）、用 `pty.has()` 代理 kind（`:1448`）。
- **`pane.kind` 被当成 agent 类型用了 12 处**（router 8 处 + session 4 处）。`kind` 本意是传输层分类（`'pty' | 'web'`），却被用来回答"是不是 dsh"。

### 1.8 集成安装器：`HookTarget` 是对的雏形，但接口太瘦

`integration/index.ts:347` 的 `HookTarget` 已经是"每个 agent 一个实现"的正确形态，**但它只有 5 个方法、没有身份/版本/校验能力**，于是 5 个 agent 专属检查被迫活在工厂之外：

- `hookStatuses()` 末尾的两段后处理（`:307` opencode、`:311` grok）；
- `opencodeTuiIntegrationIsValid()`（`:1489`）、`grokHookConfigIsValid()`（`:1160`）——自己拼路径、自己读文件，完全绕过 target 对象；
- 通用函数 `ensureFlatHook` 里硬编码了 mastracode 的 description 文案（`:614`）、`ensureDirectHook` 里硬编码了 copilot 的平台字段名（`:619`）、`ensureNestedHook` 的 `async` 修正分支只为 claude 存在（`:591-601`）。

同时它演化了 2 套格式手术系统（TOML 行编辑 ×2、YAML 手写解析、JSONC 解析 **4 份**）、2 套块标记系统（kimi / dsh）、12 处相同的 `fs.rm(...).catch()`。**且 `integration/index.ts` 完全没有测试覆盖**——配置改写的正确性全靠人工验证。

### 1.9 抽象泄漏：通用检测引擎里有 codex 的私有概念

`shared/detect/engine.ts` 是通用 manifest 求值器，却内置了 5 个 codex 专用函数（`:221-271`，`codexPromptLine` 等）和 3 个 codex 专属 region。其他 agent 永远用不到。

值得一提的是：`agent-detector.ts` 本身**零 agent 字面量**，是仓库里唯一被正确参数化的模块——它证明了"数据驱动"这条路在本项目行得通，只是数据源（4 张硬编码表）还没收拢。

### 1.10 因果链

```
身份未建模（无 agentId）
   └─► 每层都要重新猜身份
        ├─► 每层各长一套 agent 特例（8 张表 / 10 处 if / 36 处谓词调用）
        └─► 表之间无一致性校验 → 静默降级
              └─► 改一处只对了其中一层 → 状态/提示音/徽标错乱
                    └─► 不敢改 → 继续加特例 → 维护成本复利上升
```

### 1.11 好消息：渲染端反而是干净的

值得先说明，因为这会明显缩小重构范围。渲染端对"智能体"的全部知识只有 **3 处**：

1. `src/stores/agentsStore.ts:53` 的 26 条 `AGENT_PRESETS` 字面量（外加两个平台命令常量 `:34` / `:40`）；
2. `src/components/AgentPicker.tsx:49` 的 `preset.kind === 'web'` 分支（**唯一按智能体类型分派的地方**）；
3. 两处 id/命令反查：`integrationsStore.ts:59`（`preset.id === hookStatuses` 的键）、`SettingsDialog.tsx:374`（以 `preset.command` 为代理开关的键）。

`AgentRow` / `StatusDot` / `sessionStore` / `agentSort` / `i18n` 全部与具体 agent 无关，也没有 per-agent 图标需要维护。**真正需要抽象的差异 100% 在主进程。**

但这也暴露两个附带问题：

- **能力对所有 UI 不透明**：`AgentPreset` 只有 `id / label / command / kind?`，主进程掌握的 9 项能力一个都不过 IPC，UI 只能用 `hookStatus === 'unsupported'` 反推"该智能体没有集成"（`IntegrationAgentList.tsx:121`）。
- **主进程算好但渲染端零使用的字段**：`stateChangeSeq`、`completionSeq`、`launchPending`、`interactiveReady`、`screenDetectionSkipped` 在 `src/**` 里**零引用**。这同时证实了 §1.6 提到的托管子系统是**端到端死的**（不只是"生产无调用"，连 UI 都没有消费者），直接影响 §6.3 的决策 1。

---

## 2. 设计目标与原则

### 2.1 原则 → 手段 → 落点

| 原则 | 手段 | 落成什么 |
|---|---|---|
| **抽象** | 抽象基类 `Agent` | 一个 agent 的身份/命令/检测/集成/恢复/策略 |
| **封装** | 私有装配，只暴露 getter | 特例不再外泄成 `if (agent === ...)` |
| **多态** | 调用方只问策略对象 | `policy.screenOwnsCompletion` 取代 `screenCompletionIgnored(id)` |
| **模板方法** | `HookInstaller.install()` 固定骨架 | 预检 → 写产物 → 注册配置，子类只填差异 |
| **策略** | `StatePolicy` 数据对象 | 4 个谓词函数 + 10 处内联 if 变成声明 |
| **规约/声明式** | manifest 仍是数据 | 屏幕规则不写成代码，避免类爆炸 |
| **开闭** | 注册表 | 新增 agent = 加文件 + 注册一行 |
| **单一职责** | Facade 组合协作对象 | `TerminalState` 拆 6 个协作类，调用方只认 Facade |
| **接口隔离** | 能力面拆成小接口 | 「不能恢复会话」的 agent 不实现恢复 |

### 2.2 关键判断：**该抽象的是"差异"，不是"数量"**

两种过度设计，本方案明确回避：

1. **不要为每个 agent 写一个空壳类**。19 个 agent 里有 11 个的集成安装只是"配置路径 + 事件表 + 脚本"的差异——这是**数据**。给它们各写一个只调 `super` 的类就是浅类污染。
   → **数据能表达的用 descriptor，行为有差异的才子类。**
2. **不要把 manifest 规则写成代码**。屏幕规则本质是声明式规约，写成方法会让规则无法被表格驱动测试。

判据：**"给这个 agent 加一句话，是改数据还是改逻辑？"** 改数据 → descriptor；改逻辑 → 子类/策略。

按此判据，19 个 agent 的集成安装分布为：
- **纯数据（11）**：`jsonHooksTarget` 覆盖的 8 个（copilot / devin / droid / qodercli / qwen / letta / cursor / mastracode）+ `extensionTarget` 覆盖的 3 个（pi / omp / kilo）；
- **需要真实实现（8）**：claude（`async` 心跳语义）、codex（额外改 `config.toml`）、kimi（装前版本闸门 + `[[hooks]]` 块）、antigravity（目录预检 + 独立块）、grok（独占配置文件 + 漂移校验）、opencode（4 个安装目标 + V1/V2 双注册）、hermes（YAML 编辑）、dsh-web（YAML 块 upsert）。

### 2.3 进程边界约束（硬约束）

`shared/` 目前**零** Node/Electron 依赖（已核对）。重构必须保持：

- `shared/agents/` —— 只放**纯数据与纯函数**（策略、manifest、命令名、恢复参数）。主进程与渲染进程都能 import。
- `electron/agents/` —— 放**需要 fs / 进程能力**的实现（安装器、资产内联）。

这条约束顺带解决另一个积弊：渲染端硬编码的 `AGENT_PRESETS`（26 条、41 处 agent 字面量）可以直接从 `shared/agents` 派生，**主/渲染两侧的清单从此不会漂移**。

---

## 3. 目标架构

### 3.1 目录结构

```
shared/agents/                        # 纯数据契约（主/渲染共享，零 Node 依赖）
├── agent-id.ts                       # AgentId 联合类型 + AGENT_IDS（消灭 stringly-typed）
├── descriptor.ts                     # AgentDescriptor 类型
├── policy.ts                         # StatePolicy 类型 + DEFAULT_STATE_POLICY
├── detection-spec.ts                 # DetectionSpec（manifest + 自定义 region）
├── integration-spec.ts               # 集成声明（路径为纯函数，不做 IO）
├── resume-spec.ts                    # ResumeSpec
├── registry.ts                       # 注册表 + agentById / allAgents
└── descriptors/                      # ★ 每个智能体一处声明
    ├── index.ts                      #   汇总导出（唯一手写注册点）
    ├── claude.ts   codex.ts   antigravity.ts   …
    └── (19 个)

electron/agents/                      # 主进程实现（可触达 fs）
├── core/
│   ├── agent.ts                      # abstract class Agent（组合 descriptor + installer）
│   ├── integration/
│   │   ├── hook-installer.ts         # abstract HookInstaller（Template Method）
│   │   ├── json-hooks-installer.ts   # 4 种 JSON shape 的通用实现
│   │   ├── extension-installer.ts    # pi / omp / kilo
│   │   ├── plugin-installer.ts       # opencode / hermes
│   │   └── web-plugin-installer.ts   # dsh-web
│   └── assets.ts                     # ?raw 资产内联（从 integration/assets.ts 迁入）
├── registry.ts                       # Agent 实例注册表（agentId → Agent）
└── claude/                           # ★ 每个智能体一处实现
    ├── claude-installer.ts           #   仅当行为有差异时才需要
    └── assets/                       #   该 agent 的脚本/插件资产
        ├── herdr-desktop-agent-state.sh
        └── herdr-desktop-agent-state.ps1
```

迁移完成后删除：`electron/runtime/integration/index.ts`、`electron/runtime/integration/assets.ts`、`shared/detect-manifest.ts`、`shared/detect/manifests/`。

### 3.2 `AgentId`：先消灭 stringly-typed

```ts
// shared/agents/agent-id.ts
export const AGENT_IDS = [
  'pi', 'claude', 'codex', 'gemini', 'cursor', 'devin', 'antigravity', 'cline',
  'omp', 'mastracode', 'opencode', 'copilot', 'kimi', 'kiro', 'droid', 'amp',
  'grok', 'hermes', 'kilo', 'qodercli', 'qwen', 'letta', 'maki', 'muse', 'dsh',
] as const;

export type AgentId = (typeof AGENT_IDS)[number];
```

收益立刻可见：别名表、`OFFICIAL_AGENTS`、`INTEGRATION_VERSIONS`、`HOOK_TARGETS` 的键全部拿到编译期校验——**拼错 agent 名从此是编译错误，而不是静默失效**。这是本方案性价比最高的一步。

### 3.3 `AgentDescriptor`：一个智能体的全部静态事实

```ts
// shared/agents/descriptor.ts
/** 宿主环境：注入而非直接读 process.env，便于测试与跨平台断言。 */
export interface HostEnv {
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  home: string;
}

/** 一个智能体的静态定义。纯数据 + 纯函数，主/渲染进程都能直接用。 */
export interface AgentDescriptor {
  readonly id: AgentId;
  /** 展示名（品牌名，不翻译）。 */
  readonly label: string;
  /** 启动命令（按平台解析：cursor 在 Windows 是 cursor-agent.cmd）。 */
  readonly command: (host: HostEnv) => string;
  /** pane 宿主形态。不再是 'pty' | 'web' 的裸分类，而是 agent 的属性。 */
  readonly hosting?: 'pty' | 'web';
  /** 屏幕/OSC 检测声明；缺省表示走引擎的通用回退（回落 idle）。 */
  readonly detection?: DetectionSpec;
  /** 官方集成声明；缺省表示不支持集成。 */
  readonly integration?: IntegrationSpec;
  /** 会话恢复声明；缺省表示不支持恢复。 */
  readonly resume?: ResumeSpec;
  /** 状态仲裁策略（见 3.4）。 */
  readonly policy: StatePolicy;
}
```

### 3.4 `StatePolicy`：把 4 个谓词函数 + 10 处内联 if 变成声明

这是本次重构**收益最直接**的一块。当前散落的判定，逐条对应成一个字段：

```ts
// shared/agents/policy.ts
/**
 * hook 的状态权威等级（把三个谓词函数合成一个枚举）：
 * - 'none'           ：只上报会话身份，状态一律由屏幕决定（hermes / qwen / letta）
 * - 'state'          ：hook 报状态，屏幕仍参与仲裁（claude / codex / antigravity …）
 * - 'full-lifecycle' ：hook 活着时屏幕状态被忽略（pi / omp / mastracode / opencode / kilo / kimi）
 */
export type HookAuthority = 'none' | 'state' | 'full-lifecycle';

export interface StatePolicy {
  readonly hookAuthority: HookAuthority;
  /** 屏幕的 working/blocked → idle 是否算「完成」。false = 完成只认 hook。 */
  readonly screenOwnsCompletion: boolean;
  /** 启动窗口内屏幕 working 是否忽略（初始化不产生状态变化）。 */
  readonly ignoreStartupWorking: boolean;
  /** 是否接受 heartbeat 语义的 working 上报（claude 的 PostToolUse tick）。 */
  readonly acceptsHeartbeat: boolean;
  /** 会话重绑语义。 */
  readonly sessionRebinding: SessionRebinding;
  /** hook 上报是否按 sessionId 反查 pane（dsh 多 pane 看同一会话）。 */
  readonly routeBySessionId: boolean;
  /** managed agent 从 pending 进 active 的就绪判据。 */
  readonly readiness: ReadinessProbe;
  /** 完成归属的额外前提：集成必须已安装（替代 router 的 hookStatuses 查表）。 */
  readonly completionRequiresIntegration: boolean;
}

/** 会话重绑语义：默认 / opencode 的未排序 select / codex 的显式替换 / mastracode 的覆盖 / grok 的不可接管。 */
export interface SessionRebinding {
  readonly mode: 'default' | 'unsequenced-select' | 'explicit-replace' | 'overwrite-persisted';
  /** 是否允许前台 pane 抢占他人会话（grok 为 false）。 */
  readonly allowForegroundTakeover: boolean;
}

export interface ReadinessProbe {
  /** 检测到 idle 即就绪（绝大多数 agent）。 */
  readonly acceptsIdle: boolean;
  /** 还需要屏幕出现「当前 prompt 标记」（codex 的 `›`）。 */
  readonly requiresPromptMarker: boolean;
}

export const DEFAULT_STATE_POLICY: StatePolicy = {
  hookAuthority: 'state',
  screenOwnsCompletion: true,
  ignoreStartupWorking: false,
  acceptsHeartbeat: false,
  sessionRebinding: { mode: 'default', allowForegroundTakeover: true },
  routeBySessionId: false,
  readiness: { acceptsIdle: true, requiresPromptMarker: false },
  completionRequiresIntegration: false,
};
```

### 3.5 `Agent`：抽象基类

```ts
// electron/agents/core/agent.ts
/**
 * 智能体抽象基类。
 *
 * 约定：
 * - 每个实例**无状态**（只持有不可变 descriptor 与 installer），因此是进程内单例，
 *   可被任意多个 pane 共享；
 * - 子类只在「行为确有差异」时存在；纯数据差异请扩展 descriptor。
 */
export abstract class Agent {
  constructor(
    readonly descriptor: AgentDescriptor,
    /** 官方集成安装器；null = 不支持集成。 */
    readonly installer: HookInstaller | null,
  ) {}

  get id(): AgentId { return this.descriptor.id; }
  get label(): string { return this.descriptor.label; }
  get policy(): StatePolicy { return this.descriptor.policy; }
  get hosting(): 'pty' | 'web' { return this.descriptor.hosting ?? 'pty'; }
  get detection(): DetectionSpec | null { return this.descriptor.detection ?? null; }
  get resume(): ResumeSpec { return this.descriptor.resume ?? NO_RESUME; }

  command(host: HostEnv): string { return this.descriptor.command(host); }

  /** 集成版本号（唯一来源，取代 assets.ts 的 INTEGRATION_VERSIONS 双写）。 */
  get integrationVersion(): number | null {
    return this.descriptor.integration?.version ?? null;
  }

  /** 集成安装状态（安装 + 额外一致性校验，取代 hookStatuses() 末尾的两段特例）。 */
  integrationStatus(host: HostEnv): HookStatus {
    if (this.installer === null) return 'unsupported';
    return this.installer.status(host);
  }
}
```

### 3.6 集成安装器：Template Method

当前每个 agent 手写一遍 `install()`/`uninstall()`（claude `:741`、codex `:817`、antigravity `:1077`…），重复着 mkdir / writeFile / chmod / readJson / writeJson / rm 的编排，且**先写脚本后解析配置**——解析抛错就会留下"脚本已落盘、事件没写"的半安装，而 `isInstalled()` 只看脚本文件，于是 `hookStatuses` 直接报 `installed`。模板方法顺手把顺序修正：

```ts
// electron/agents/core/integration/hook-installer.ts
/** 集成安装器骨架（Template Method）。子类只实现有差异的步骤。 */
export abstract class HookInstaller {
  abstract readonly spec: IntegrationSpec;

  /** 固定的安装骨架。 */
  async install(host: HostEnv, reportUrl: string): Promise<void> {
    const dir = this.spec.configDir(host);
    if (!dir) return;
    this.checkPreconditions(host, dir);       // 1. 前置校验（如 antigravity 要求目录已存在）
    await this.checkTargets(host, dir);       // 2. 先校验配置可写，再动文件（修半安装）
    await this.writeArtifacts(host, dir);     // 3. 写脚本/扩展/插件 + 可执行位
    await this.register(host, dir, reportUrl);// 4. 在 agent 配置里登记事件
  }

  /** 固定的卸载骨架（先摘登记，再删产物，顺序不可颠倒）。 */
  async uninstall(host: HostEnv): Promise<void> {
    const dir = this.spec.configDir(host);
    if (!dir) return;
    await this.unregister(host, dir);         // 1. 移除登记（含历史遗留事件）
    await this.removeArtifacts(host, dir);    // 2. 删产物
  }

  /** 安装状态：产物存在 + 版本足够 + 额外一致性校验。 */
  status(host: HostEnv): HookStatus {
    const artifact = this.spec.artifactPath(host);
    if (!artifact || !this.spec.validate?.(host)) return 'not-installed';
    const installed = readInstalledVersion(artifact);
    if (installed === null) return this.spec.validate?.(host) ? 'installed' : 'outdated';
    return installed < this.spec.version ? 'outdated' : 'installed';
  }

  // —— 子类实现（差异点）——
  protected abstract register(host: HostEnv, dir: string, reportUrl: string): Promise<void>;
  protected abstract unregister(host: HostEnv, dir: string): Promise<void>;
  protected checkPreconditions(_host: HostEnv, _dir: string): void { /* 默认无前置条件 */ }
  protected async checkTargets(_host: HostEnv, _dir: string): Promise<void> { /* 默认无预检 */ }
  protected async writeArtifacts(host: HostEnv, dir: string): Promise<void> { /* 默认按 spec 写 */ }
  protected async removeArtifacts(host: HostEnv, dir: string): Promise<void> { /* 默认按 spec 删 */ }
}
```

**11 个 agent 只用数据**，直接实例化通用实现：

```ts
// electron/agents/core/integration/json-hooks-installer.ts
/** JSON 形状的 hook 注册（一个实现覆盖 nested / flat / direct / simple 四种布局）。 */
export class JsonHooksInstaller extends HookInstaller {
  constructor(readonly spec: IntegrationSpec, private readonly layout: JsonHooksLayout) { super(); }
  protected async register(host: HostEnv, dir: string): Promise<void> { /* 4 种 shape 统一处理 */ }
  protected async unregister(host: HostEnv, dir: string): Promise<void> { /* 含 removedEvents */ }
}
```

**只有行为真有差异的才子类化**，差异被压缩成"多做一个动作"：

```ts
// electron/agents/codex/codex-installer.ts
/** codex 除了 hooks.json，还要在 config.toml 里加一张 [features] hooks=true。 */
export class CodexInstaller extends JsonHooksInstaller {
  protected override async register(host: HostEnv, dir: string, reportUrl: string): Promise<void> {
    await super.register(host, dir, reportUrl);          // 复用通用逻辑
    await this.patchToml(host, joinPath(dir, 'config.toml')); // 只加自己的差异
  }
}

// electron/agents/antigravity/antigravity-installer.ts
/** antigravity：目录必须已存在（由 CLI 首次启动创建），且写独立块互不干扰。 */
export class AntigravityInstaller extends HookInstaller {
  protected override checkPreconditions(host: HostEnv, dir: string): void {
    if (!isDirectory(dir)) {
      throw new Error(`antigravity cli config directory not found at ${dir}. install antigravity cli first`);
    }
  }
  protected override async register(host: HostEnv, dir: string): Promise<void> {
    const root = await readJson(joinPath(dir, 'hooks.json'));
    root['herdr-desktop'] = {
      PreInvocation: [{ type: 'command', command: this.hookCommand('session'), timeout: 10 }],
      Stop: [{ type: 'command', command: this.hookCommand('stop'), timeout: 10 }],
    };
    await writeJsonKey(joinPath(dir, 'hooks.json'), 'herdr-desktop', root['herdr-desktop']);
  }
  protected override async unregister(host: HostEnv, dir: string): Promise<void> {
    if (!hasKey(joinPath(dir, 'hooks.json'), 'herdr-desktop')) return; // 无改动不重排用户配置
    await deleteJsonKey(joinPath(dir, 'hooks.json'), 'herdr-desktop');
  }
}
```

> 顺手修掉的两个既有风险：antigravity 现在是 `writeJson` 整文件重写（`:1122`），**会抹掉用户 hooks.json 里的注释**，上面改用 `writeJsonKey` 保留注释；kilo 的产物路径含 `plugin/` 子目录（`:1573`）但只 mkdir 了 configDir（`:1258`），会 ENOENT。

### 3.7 版本号：消除"双写"这个隐式不变量

当前版本要人工同步两处（`AGENTS.md` 的硬性要求），且**已经漂移过**：`integration/index.ts:80-83` 的注释说 claude 的 tick 形态是"集成 v5"，而 `assets.ts:122` 与脚本内标记都是 `4`。

```ts
// shared/agents/integration-spec.ts
export interface IntegrationSpec {
  readonly kind: 'json-hooks' | 'extension' | 'plugin' | 'web-plugin';
  /** 唯一版本来源。资产内的 HERDR_INTEGRATION_VERSION 必须相等，由测试守卫。 */
  readonly version: number;
  readonly configDir: (host: HostEnv) => string | null;
  readonly artifactPath: (host: HostEnv) => string | null;
  /** 额外的「漂移校验」（opencode 的 TUI 注册、grok 的配置一致性）。 */
  readonly validate?: (host: HostEnv) => boolean;
}
```

配套守卫（新增 `npm run test:integration-version`）：遍历每个 agent 的资产文件，抽 `HERDR_INTEGRATION_VERSION=(\d+)`，与 `descriptor.integration.version` 比对，不一致即失败。**这条不变量从"文档约定"变成"CI 拦截"**，同时把 `hookStatuses()` 末尾那两段事后 if（`:306-313`）收进 `IntegrationSpec.validate`。

### 3.8 检测：引擎回归通用

```ts
// shared/agents/detection-spec.ts
export interface DetectionSpec {
  /** 识别该 agent 的正则与别名（取代 AGENT_IDENTITY / AGENT_ALIASES 两张表，并删掉同名的第二套 manifest）。 */
  readonly identity: RegExp;
  readonly aliases?: readonly string[];
  /** 屏幕规则（声明式数据，由 engine 求值）。 */
  readonly manifest: AgentManifest;
  /**
   * 额外 region 解析器（默认为空）。
   * codex 的 prompt 标记区域在这里实现，通用引擎不再认识 codex。
   */
  readonly regions?: Record<string, (input: DetectionInput) => string>;
}
```

`engine.ts` 的 `region()` 改成先查 agent 的 `regions`、再走内置表；`:221-271` 的 5 个 codex 函数整体搬到 `shared/agents/descriptors/codex.ts`。**通用引擎对所有 agent 一视同仁**，三个只有 codex 使用的 region 名也从引擎表面消失。

重建时有三条必须保持的隐含约定（当前只写在代码里）：

1. **`priority` 只在单个 manifest 内有意义**，不可横向比较（grok 用到 1300、letta 1400，而 antigravity 的 idle 是 10、cline 的兜底是 −10）。所以它必须**留在各 agent 的 descriptor 内部**，绝不能提炼成全局序。
2. **同优先级取数组里靠前的规则**（`engine.ts:313` 用严格 `>`）——顺序即语义，迁移时不能重排规则。
3. **`visible*` 标志受 `state` 钳制**（`engine.ts:331-334`）：`visibleIdle` 只在 `state === 'idle'` 时为真，依此类推。这是启动窗口机制正确性的前提，建议在 `DetectionSpec` 层面用类型或测试固化，而不是留在实现细节里。

### 3.9 注册表与旧函数委托（迁移期零调用方改动）

```ts
// shared/agents/registry.ts
import { DESCRIPTORS } from './descriptors';

const BY_ID = new Map<string, AgentDescriptor>(DESCRIPTORS.map((d) => [d.id, d]));

export function agentById(id: string | null | undefined): AgentDescriptor | null {
  if (!id) return null;
  return BY_ID.get(id) ?? null;
}
export function allAgents(): readonly AgentDescriptor[] { return DESCRIPTORS; }
```

**旧的 4 个谓词函数签名一律不变，只改实现**：

```ts
// shared/detect-manifest.ts（保留导出，内部委托策略）
export function screenCompletionIgnored(agentLabel: string | null): boolean {
  const d = agentById(agentLabel);
  return d !== null && !d.policy.screenOwnsCompletion;
}
export function fullLifecycleHookAuthority(source: string, agentLabel: string): boolean {
  const d = agentById(agentLabel);
  return d !== null && d.policy.hookAuthority === 'full-lifecycle' && source === `herdr:${d.id}`;
}
export function sessionIdentityOnlyIntegration(source: string, agentLabel: string): boolean {
  const d = agentById(agentLabel);
  return d !== null && d.policy.hookAuthority === 'none' && source === `herdr:${d.id}`;
}
export function screenStartupIgnored(agentLabel: string | null): boolean {
  return agentById(agentLabel)?.policy.ignoreStartupWorking === true;
}
```

### 3.10 让 `agentId` 流经 IPC（本方案的关键一步）

这是把 8 张表收敛成一个锚点的前提：

```ts
// shared/state.ts（增量，向后兼容）
export interface SpawnAgentParams {
  projectId: string;
  /** 用户选择的智能体；null 表示纯终端（用户可能自己敲 claude）。 */
  agentId?: AgentId | null;
  command: string;          // 保留：仍是启动命令的权威来源
  args?: string[];
  cwd?: string;
  label?: string;
}

export interface PaneState {
  // …既有字段
  /** 创建时声明的智能体。旧 session.json 缺失时按 null 处理，回退到命令解析。 */
  agentId?: AgentId | null;
}
```

**「声明身份」与「观测身份」并存**，职责分离：

| | 来源 | 用途 |
|---|---|---|
| `pane.agentId`（声明） | 用户创建时选择 | 策略查询、集成状态、恢复命令、UI 图标 —— **权威** |
| `terminal.detectedAgent`（观测） | 屏幕 / hook 上报 | 兜底（纯终端 pane 里用户自己敲了 `claude`）、校验 |

策略查询改为 `agentForPane(pane)`：优先 `pane.agentId`，为空才回退 `detectedAgent`。向后兼容：旧 `session.json` 没有 `agentId`，走现有命令解析路径，行为不变。

### 3.11 `TerminalState` 拆分：Facade 保住公共 API

**关键策略：公共方法名与签名一律不变**。生产侧只有 5 个方法被 `router.ts` 调用（`setHookAuthorityAt` / `setAgentSessionRefForSessionStart` / `setDetectedAgentProcessAt` / `setDetectedStateWithScreenSignalsAt` / `clearAgentRuntimeIdentityAfterRespawn`），25 个测试用例也只用这些——**Facade 让两者都不用改**。

```ts
// electron/runtime/state/pane-agent-state.ts
/**
 * pane 级 agent 状态（Facade）。
 *
 * 对外 API 与原 TerminalState 完全一致 —— 拆分是内部重构，调用方不可见。
 */
export class PaneAgentState {
  private readonly machine: StateMachine;            // 状态与迁移合法性（纯函数为主）
  private readonly authority: HookAuthorityLedger;   // seq 水位、抑制表、陈腐会话、full-lifecycle 路由
  private readonly identity: AgentIdentityTracker;   // 名归属、进程退出、release 抑制
  private readonly sessionRefs: SessionRefTracker;   // 会话身份比较与重绑
  private readonly lifecycle: ManagedAgentLifecycle; // pending → blocked → active
  private readonly signals: ScreenSignalTracker;     // visibleIdle/Blocker/Working

  constructor(readonly paneId: string, private readonly policy: () => StatePolicy) { … }

  // —— 原公共方法原样保留（委托）——
  setDetectedStateWithScreenSignalsAt(...) { … }
  setHookAuthorityAt(...) { … }
  // …
}
```

拆分后 agent 特例的去向：

| 原位置 | 迁移后 |
|---|---|
| codex `codexPromptReady`（`:358,1244,1295,1318`，其中两处逐字重复） | `ManagedAgentLifecycle` 读 `policy.readiness`；prompt 标记观测由 codex 的 readiness 探针提供 |
| codex 会话冲突丢弃（`:572`、`:905`） | `SessionRefTracker` 读 `policy.sessionRebinding.mode === 'explicit-replace'` |
| opencode 未排序 select（`:1524`、`:1922`） | `policy.sessionRebinding.mode === 'unsequenced-select'` |
| opencode 防串台（`:1522`） / mastracode 覆盖（`:1866`） | `sessionRebinding.mode` 的对应值 |
| grok 不可接管（`:1943`） | `policy.sessionRebinding.allowForegroundTakeover === false` |
| `screenCompletionIgnored` / `screenStartupIgnored` | `policy.screenOwnsCompletion` / `policy.ignoreStartupWorking` |
| `fullLifecycleHookAuthority` / `sessionIdentityOnlyIntegration` | `policy.hookAuthority` |
| dsh 的 sessionId 反查（`router.ts:730`） | `policy.routeBySessionId` |
| 完成判定查集成状态（`router.ts:1285`） | `policy.completionRequiresIntegration` |

**这张表就是整个重构的骨架**：通用流程只问策略，不再认识具体 agent。

同时必须显式处理两处硬耦合：

1. **TTL 与时钟**：`PaneAgentState` 只提供 `nextDeadline(now)`，定时器归 `router`（现状如此，但要把"为什么必须这样"从注释变成接口签名）。
2. **抑制表的多写者**：收敛成 `HookAuthorityLedger` 的单一写者，条目不可变（改状态时整体替换），把"`pendingReplacementReport.seq` 单调"这类不变量变成可局部验证的。

### 3.12 `IpcRouter` 拆分（第 5 批）

```ts
electron/ipc/
├── router.ts                    # 只做 IPC 注册与 envelope 解包（目标 ≤ 400 行）
├── handlers/
│   ├── project-handlers.ts  pane-handlers.ts  agent-handlers.ts
│   └── settings-handlers.ts integration-handlers.ts
└── services/
    ├── agent-refresh-service.ts # refreshAgent 的 7 件事拆成纯步骤
    ├── notification-service.ts  # PendingNotify / ticker / 冷却 / 证据复核
    └── web-agent-service.ts     # dsh 的进程托管 + 会话绑定
```

`refreshAgent` 切成 5 个可单测步骤（检测 / 展示 / 仲裁 / 通知 / 会话采集），这是当前最难测的一段。`pane.kind` 的 12 处字符串比较改为 `agent.hosting` 或 `isWebPane(pane)` 单一谓词。

---

## 4. 迁移批次

每批**行为等价**、独立可发布、有回滚点；批次之间除标注的依赖外可并行。

| 批次 | 内容 | 风险 | 依赖 | 工作量 |
|---|---|---|---|---|
| **0** | `AgentId` + descriptor + policy 骨架；4 个谓词改委托；`AGENT_PRESETS` 从注册表派生 | 低 | — | 1.5 天 |
| **1** | `agentId` 流经 IPC 与 `PaneState`；`agentForPane()` 统一策略查询；`dsh`/`dsh-web` 命名统一 | 中低 | 0 | 1.5 天 |
| **2** | `TerminalState` → Facade + 6 协作类；10 处内联 if 改读 policy | 中 | 0、1 | 2.5 天 |
| **3** | 集成安装器类化（模板方法 + 11 个声明式 + 8 个实现）；版本单一来源 + 守卫 | 中 | 0 | 3 天 |
| **4** | `agent-resume` 6 张表 → `ResumeSpec`；codex region 搬出引擎；manifest 并入 descriptor | 中低 | 0 | 1.5 天 |
| **5** | `IpcRouter` 拆 handler + service；`pane.kind` 12 处归一 | 中 | 2 | 2 天 |
| **6** | 删旧文件、更新 `architecture.md` / `AGENTS.md`、启用边界 lint | 低 | 全部 | 1 天 |

合计约 **13 人日**；批次 2 与 3 可并行（改动文件几乎不重叠），关键路径约 9 天。

### 第 0 批：建骨架，行为零变化

产出：`shared/agents/` 全套（含 19 个 descriptor）、4 个谓词改委托、`AGENT_PRESETS` 改为派生、新增 `test:agent-policy` 矩阵测试。

**为什么先做**：4 个谓词 + `AGENT_PRESETS` 是 agent 知识最密集的两处（56 + 41 处字面量），换成策略数据后后面每批都受益，且**调用方零改动**。

**验收**：`typecheck` + 全部 `test:*` 通过 + 手工回归（claude / antigravity / opencode 各起一次）。

### 第 1 批：身份流经 IPC

产出：`SpawnAgentParams.agentId`、`PaneState.agentId`、`agentForPane()`、命名统一。

**这一步单独成批的理由**：它把"每层重新猜身份"变成"创建时记录一次"，是后面 5 批能真正收敛的前提。同时消掉 §1.3 的第 1 个静默 bug（`hookStatuses()['dsh']` 永远 miss）。

**向后兼容**：旧 `session.json` 无 `agentId` → 回退到现有的命令解析路径，行为不变。命名统一（`dsh-web` → `dsh`）不影响持久化数据（`session.json` 只存 `command: 'dsh web'`，`settings.json` 的 `proxyAgents` 以命令为键）。

**验收**：新建 claude / codex / dsh 各一个，确认 `pane.agentId` 落地；用改造前的 `session.json` 冷启动，行为一致。

### 第 2 批：状态机拆分

**验收**：`test:terminal-state` 的 25 个用例**一行不改**全绿（本批的核心保护）+ `terminal-state.ts` 行数下降 60% 以上。

**回滚点**：保留 `TerminalState` 作为 `PaneAgentState` 的别名导出，第 2 批期间新旧并存，用开关切换；配套**双跑对账**（见 5.4）。

### 第 3 批：集成安装器类化

**验收**：安装器快照测试（见 5.3）逐 agent 比对生成的配置文件字节级一致。

### 第 4 批：恢复 + 检测收口

**验收**：`test:terminal-state` 的 manifest 相关用例（#9~#12、#16~#18、#24）全绿 + 新增"每个 agent 都能解析别名并生成恢复命令"的表驱动测试。

### 第 5、6 批：router 拆分与收尾

第 6 批同步更新 `AGENTS.md`：新增 agent 的落点从 `integration/assets/` 改为 `electron/agents/<id>/`，版本号规则从"两处同步"改为"单一来源 + CI 守卫"。

---

## 5. 安全网：怎么保证"重构不改变行为"

现有资产比想象中好：`scripts/test-terminal-state.mjs` 有 **25 组、约 180 条断言**（44 KB），已经覆盖 hook 权威、codex readiness、opencode 重绑、antigravity 启动窗口、claude 心跳、完成投影等最易坏的行为。

### 5.1 特征测试：把现状锁死

第 0 批之前跑一遍全部 `test:*` 记录基线。第 0~4 批期间**不允许修改这 25 个用例**——改了就说明行为变了。用例全绿即"行为等价"的客观证据。

### 5.2 矩阵测试：补上"每个 agent × 每个策略"

现有用例是**场景驱动**（举一个例子验一条路径），缺矩阵覆盖。新增表驱动测试：

```js
// scripts/test-agent-policy.mjs
const CASES = [
  // 19 个 agent × 关键策略位都断言一次（值按重构前的代码人工核对填写）
  ['claude',      { hookAuthority: 'state',          screenOwnsCompletion: false, ignoreStartupWorking: false, acceptsHeartbeat: true }],
  ['codex',       { hookAuthority: 'state',          screenOwnsCompletion: true,  ignoreStartupWorking: false, readiness: { requiresPromptMarker: true } }],
  ['antigravity', { hookAuthority: 'state',          screenOwnsCompletion: false, ignoreStartupWorking: true }],
  ['opencode',    { hookAuthority: 'full-lifecycle', sessionRebinding: { mode: 'unsequenced-select' } }],
  ['grok',        { sessionRebinding: { allowForegroundTakeover: false } }],
  ['mastracode',  { sessionRebinding: { mode: 'overwrite-persisted' } }],
  ['dsh',         { routeBySessionId: true, hosting: 'web' }],
  // … 19 行
];

// 同时锁死：注册表完整性（19 个 id 都有 descriptor）、8 张表口径一致、别名可解析、恢复命令可生成
```

最后一组断言尤其重要：**各表之间的包含关系必须在测试里显式表达**，否则 8 张表的漂移还会回来。建议直接写成数据契约：

```js
// 注册表是唯一真源，其余能力都是「可选子集」，逐条断言方向
assert(allAgents().length === 25);                                    // 检测/身份层
for (const a of allAgents()) assert(parseAgentLabel(a.id) === a.id);   // 别名自洽
for (const a of allAgents()) {
  if (a.integration) assert(hookStatuses()[a.id] !== undefined);       // 有集成声明就必须有安装器
  if (a.resume && a.hostIsResumable) assert(plan(a.id) !== null);      // 有恢复声明就必须能生成命令
  if (a.detection) assert(MANIFESTS[a.id] !== undefined);              // 有检测声明就必须有 manifest
}
assert(AGENT_PRESETS.length === registryPresetCount());                // 渲染端与注册表同源
```

`dsh` 就会在这组断言里立刻暴露（有 `OFFICIAL_AGENTS` 条目但没有恢复命令）。

### 5.3 安装器快照测试（第 3 批）

安装器是"写用户配置文件"的高危区，且**当前零测试覆盖**。方法：

```js
// 每个 agent：临时 HOME + 预置一份「已装过旧版」的配置 → 跑 install → 断言
// 1. 配置内容与重构前逐字节一致（基线在重构前用 git stash 采样）
// 2. 幂等：连跑两次 install 不产生重复条目
// 3. uninstall 后无残留（含 removedEvents 里的历史遗留事件）
// 4. 注释保留：用户手写的注释不被抹掉（antigravity 的已知问题在这里回归）
```

"先移除旧版事件再写入"的模式（`:764-776`）是最容易在重构时丢掉的隐式行为，快照测试专门守这条。

### 5.4 双跑对账（第 2 批）

保留旧 `TerminalState`，新 Facade 与旧实现**同时计算**一次 `effectiveStateChange`，不一致时 `console.warn` 带完整上下文。跑 3~5 天，日志零告警后再删旧实现。这是应对"状态机难以完整单测"的现实手段。

### 5.5 边界 lint：让"新增 agent 只改一处"成为机器约束

```js
// scripts/check-agent-boundaries.mjs（新增，接入 CI）
// 规则：在 electron/agents/<id>/ 与 shared/agents/descriptors/ 之外出现 agent id 字面量 → 失败
// 允许名单：注册表、测试、i18n、资产文件（其中 agent 名是有意为之）
```

没有这条约束，重构三个月后会退化成原样。

### 5.6 手工回归清单（每批必过）

- [ ] **claude**：发一轮消息 → 完成提示音只响一次；`/clear`、`/resume` 后状态正确（`/resume` 尤其容易误响）
- [ ] **antigravity**：冷启动 → 初始化结束**不**响完成音；手动 Esc 取消 → 不卡在 working
- [ ] **opencode**：会话中 `select` 切换 → 状态跟随新会话；多 pane 并发不串台
- [ ] **codex**：启动 → 从 pending 正确进入 active（不早不晚）；`codex resume <id>` 能反解会话
- [ ] **mastracode / grok**：各自的会话覆盖 / 不可接管语义不变
- [ ] **设置页**：集成安装/更新/卸载三态正确；版本不一致时显示"更新"
- [ ] **冷启动**：用改造前的 `session.json` 恢复，行为一致
- [ ] **新增 agent 演练**：按附录 C 加一个假 agent，确认只改 2 个文件

---

## 6. 风险、取舍与待决策项

### 6.1 风险

| 风险 | 影响 | 对策 |
|---|---|---|
| **过度抽象**：19 个 agent 各一个类，其中 11 个是空壳 | 代码量增加、阅读负担上升 | 只给有行为差异的 agent 写类；数据差异走 descriptor（见 2.2） |
| **继承深度**：模板方法 + 子类 + 再子类 | 调用链难追 | 硬性约束：继承 ≤ 2 层，其余用组合；`HookInstaller` 只允许一层子类 |
| **`shared/` 被污染**：descriptor 里塞 fs 调用 | 渲染端打包失败 / 架构腐化 | `shared/` 保持零 Node 依赖（现状如此），用 lint 守 |
| **测试文件路径变更**：`test-terminal-state` 用 esbuild 打包具体文件路径 | 用例必须先改才能跑，掩盖真实回归 | 保留旧路径的 re-export 直到第 4 批结束；批内不改用例 |
| **与 herdr 上游对齐**：注释大量引用 herdr 的 Rust 对应实现 | 重构后对应关系丢失 | 每个 descriptor/安装器保留 herdr 对应位置的行内注释 |
| **策略语义漂移**：`hookAuthority` 三态映射错 | 状态权威判断变化 → 提示音异常 | 矩阵测试（5.2）逐 agent 锁死 + 双跑对账（5.4） |
| **渲染端数量断言**：`test-agent-sort.mjs:125` 硬断言 `AGENT_PRESETS.length === 26` | 列表改为派生后用例失败，掩盖真实问题 | 改为"注册表长度 === 预设长度"的同源断言；新增 agent 时这条断言是**特性而非障碍** |
| **休眠子系统被"顺手清理"** | 意外删除未来要用的能力 | 见 6.3 决策项 1：重构期**保持原样**，只搬家 |

### 6.2 明确**不**做的事

1. **不重写状态机算法**。当前仲裁逻辑虽复杂但已被 25 个用例和真实使用打磨过；本次只做"搬家 + 参数化"，不改判定规则。想改规则请另开 PR。
2. **不动平台层**。`electron/platform/` 已经是干净的抽象，与 agent 无关。
3. **不引入依赖注入框架**。手写注册表足够，`HostEnv` 注入已满足可测性。
4. **不把 manifest 规则改写成代码**（见 2.2）。
5. **不顺手修业务缺陷**。附录 D 列出的既有缺陷单独开 PR，避免与"行为等价"目标混在一起、无法判断回归来自哪里。

### 6.3 需要你拍板的三个决策

1. **休眠的托管子系统是否保留？** `TerminalState` 有 15 个公开方法只有测试在用（`beginManagedAgent` / `reconcileManagedAgentAt` / `observeCodexPromptReady` / `restoreManagedAgent` …），codex 的 3 处特例全部寄生其中；而且它投影出的 `launchPending` / `interactiveReady` / `screenDetectionSkipped` 在渲染端**零引用**——也就是说这条链路目前**端到端没有任何消费者**。
   → 建议：**本次原样搬家**（`ManagedAgentLifecycle`），另开 issue 决定"接入还是删除"。理由：车队下线整条链路会动到 `session.ts` 的投影字段、快照契约（`shared/state.ts:86-93`）与 4 个测试用例，已超出"行为等价重构"的范围；但它是最可能被误删的部分，所以需要显式记录。
2. **`dsh-web` 还是 `dsh`？** 现状三套写法（集成键 `dsh-web`、上报来源 `herdr:dsh`、检测/manifest `dsh`）。
   → 建议统一为 **`dsh`**（与检测、来源、命令一致），集成表的键同步改。已确认不影响持久化数据（`session.json` 只存命令字符串）。
3. **`pane.kind` 是否合并进 `agent.hosting`？** 现状 `kind` 是传输层分类，却被当 agent 类型用了 12 处。
   → 建议：**短期保留 `kind`**（它是持久化字段），但所有判断改走 `agent.hosting` 或 `isWebPane(pane)` 单一谓词；字段本身在附录 D 里单独清理。

---

## 7. 验收标准

| 指标 | 现状 | 目标 |
|---|---|---|
| 新增一个 agent 需要改的文件数 | 8 个必改 + 4 个条件 | **2**（新增 descriptor + `descriptors/index.ts` 加一行） |
| `electron/agents/`、`shared/agents/descriptors/` 之外的 agent id 字面量 | 约 195 处 / 8 张表 | **0**（边界 lint 通过） |
| agent 清单的口径数 | 8 张表，成员各不相同 | **1** 个注册表 |
| 同名 manifest 类型 | 2 套（`AgentManifest` / `AgentDetectManifest`） | 1 套 |
| `terminal-state.ts` 行数 / 方法数 | 2169 / 69 | ≤ 400（Facade）/ ≤ 25 |
| `router.ts` 行数 | 1678 | ≤ 400 |
| 集成 install/uninstall 编排的副本数 | 19 份 | 1 份（模板方法） |
| 状态仲裁的内联 agent 特例 | 10 处 | 0（全部走 policy） |
| 版本号双写点 | 2 处人工同步（已漂移 1 次） | 1 处 + CI 守卫 |
| agent 相关测试 | 25 场景（集成安装器 0 覆盖） | 25 场景 + 19×N 矩阵 + 19 个安装器快照 |

---

## 附录 A：19 个智能体的能力矩阵

> 依据 `HOOK_TARGETS`、`assets.ts`、`agent-resume.ts`、`shared/detect-manifest.ts`、`manifests/*.ts`。
> 「屏幕规则」列是该 agent 的 manifest 规则条数；"—" 表示没有 manifest（状态完全靠 hook 或靠引擎兜底）。

| agent | 命令 | 屏幕规则 | 集成形态（工厂） | 配置位置 | hook 权威 | 屏幕判完成 | 启动窗口 | 会话引用 | 恢复参数 | 特殊点 |
|---|---|---|---|---|---|---|---|---|---|---|
| claude | `claude` | 17（含 OSC + prompt_box） | JSON hooks nested（自定义） | `~/.claude/settings.json` | state | **否** | 否 | id | `--resume` | 5 事件含 `async`；Stop/StopFailure；心跳 tick；2 条 skipStateUpdate |
| codex | `codex` | 9（3 个专属 region） | hooks.json **+ config.toml**（自定义） | `~/.codex/` | state | 是 | 否 | id | `resume <id>` | prompt 就绪探针；会话替换直拒；TOML 状态机 |
| kimi | `kimi` | 6 | JSON nested（自定义） | `~/.kimi-code/config.toml` | full-lifecycle | 是 | 否 | id | `--session` | 装前 `kimi --version` 闸门；`[[hooks]]` 块；matcher 区分 AskUserQuestion |
| copilot | `copilot` | 3 | JSON **direct**（声明式） | `~/.copilot/settings.json` | state | 是 | 否 | id | `--resume=` | 平台字段名 `powershell/bash` + `timeoutSec` |
| devin | `devin` | 7 | JSON nested（声明式） | XDG / `%APPDATA%` / `~/.config/devin` | state | 是 | 否 | id | `--resume` | configDir 三态 |
| droid | `droid` | 4 | JSON nested（声明式） | `~/.factory/settings.json` | state | 是 | 否 | id | `--resume` | 9 条旧事件 |
| qodercli | `qoder`/`qodercli` | 3 | JSON nested（声明式） | `~/.qoder/settings.json` | state | 是 | 否 | id | `--resume` | matcher `*`；12 条旧事件 |
| qwen | `qwen` | 10 | JSON nested（session 脚本）（声明式） | `~/.qwen/settings.json` | **none** | 是 | 否 | id | `--resume` | `timeout: 10000`（毫秒，与其它 agent 的秒混用）；9 种语言确认文案 |
| letta | `letta` | 10（含 priority 0 全捕获） | JSON nested（声明式） | `~/.letta/settings.json` | **none** | 是 | 否 | id | `--conversation` | `quiet`；`default:` 前缀特判 |
| cursor | `cursor-agent` | 5 | JSON **simple**（声明式） | `~/.cursor/hooks.json` | state | 是 | 否 | id | `--resume` | `withVersion`；5 条旧 simple 事件；Windows `.cmd` |
| mastracode | `mastracode` | **—**（靠 hook） | JSON **flat**（声明式） | `~/.mastracode/hooks.json` | full-lifecycle | 是 | 否 | id | `--thread` | `-EncodedCommand`；硬编码 description |
| antigravity | `agy` | 7 | 自定义块 | `~/.gemini/config/hooks.json` | state | **否** | **是** | id | `--conversation` | 目录须已存在；PreInvocation/Stop；整文件重写丢注释 |
| grok | `grok` | 13（priority 到 1300） | 自定义 JSON（独占文件） | `~/.grok/hooks/herdr-desktop.json` | state | 是 | 否 | id | `--resume` | 配置漂移校验；Unix 用 `sh`；不可接管会话 |
| pi | `pi` | 2（只有 working） | TS 扩展（声明式） | `~/.pi/agent/extensions` | full-lifecycle | 是 | 否 | **path→id** | `--session` | 会话文件路径优先 |
| omp | `omp` | **—**（靠 hook） | TS 扩展（声明式） | `~/.omp/agent/extensions`（路径规则与 pi 不同） | full-lifecycle | 是 | 否 | **path→id** | `--resume=` | — |
| opencode | `opencode` | 3（**无 idle 规则**） | JS 插件 ×2（自定义） | `~/.config/opencode`（无 env 覆盖） | full-lifecycle | 是 | 否 | id | `--session` | 4 个安装目标；V1/V2 双注册；TUI 校验；未排序 select；防串台 |
| kilo | `kilo` | 2 | JS 插件（声明式） | `~/.config/kilo/plugin/x.js` | full-lifecycle | 是 | 否 | id | `--session` | 子目录未 mkdir → ENOENT |
| hermes | `hermes` | 9 | Python 插件（自定义） | `~/.hermes` / `%LOCALAPPDATA%/hermes` | **none** | 是 | 否 | id | `--resume` | YAML `plugins.enabled` 手写编辑 |
| dsh | `dsh` | **—**（web pane 无屏幕） | ESM 状态插件（自定义） | `~/.dsh/cordis.patch.yml` | state | 是 | 否 | id | —（**无恢复命令**） | sessionId 反查路由；replay；命名三套写法 |

## 附录 B：逐文件改动清单

| 文件 | 现状 | 处置 |
|---|---|---|
| `shared/detect-manifest.ts` | 285 行：识别表、别名表、4 个策略谓词 | 谓词改委托（保留）+ 表并入 descriptor；文件最终删除 |
| `shared/detect/manifests/*.ts` | 22 个 manifest 文件 | 并入对应 descriptor（内容不变） |
| `shared/detect/engine.ts` | 336 行，含 5 个 codex 专用函数 | 搬到 codex descriptor；`region()` 支持 agent 扩展 |
| `shared/state.ts` | 287 行 | 增量：`SpawnAgentParams.agentId`、`PaneState.agentId` |
| `electron/runtime/terminal-state.ts` | 2169 行 God class | 拆 Facade + 6 协作类（⚠ 最大工作量） |
| `electron/runtime/agent-resume.ts` | 352 行 / 6 张表 | 变为 descriptor 的 `resume`；白名单由注册表派生 |
| `electron/runtime/integration/index.ts` | 1797 行 / 19 个手写安装器 | 拆模板方法 + 19 个 agent 目录；文件删除（⚠ 零测试覆盖） |
| `electron/runtime/integration/assets.ts` | 141 行 / 三处清单誊写 | 迁到 `electron/agents/core/assets.ts`；版本入 descriptor |
| `electron/runtime/integration/assets/<agent>/` | 19 组资产（32 文件） | 随 agent 目录迁移 |
| `electron/ipc/router.ts` | 1678 行 God object | 拆 handler + service（第 5 批） |
| `src/stores/agentsStore.ts` | 26 条预设 / 41 处字面量 | 改为从 `shared/agents` 派生 |
| `docs/architecture.md` §6 | 旧目录结构 | 更新 |
| `AGENTS.md`「智能体集成」 | 指向 `integration/assets/` 与双写版本规则 | 更新为新落点与单一版本来源 |

## 附录 C：重构后新增一个智能体的步骤（目标体验）

```bash
# 1. 写一个 descriptor（唯一必写文件）
#    shared/agents/descriptors/newagent.ts
#    声明 id / label / command / detection / policy / resume / integration

# 2. 注册一行
#    shared/agents/descriptors/index.ts —— DESCRIPTORS 数组里加 newagent

# 3. 若有真实行为差异，再加一个安装器子类（19 个里只有 8 个需要）
#    electron/agents/newagent/newagent-installer.ts

# 4. 放资产（如支持集成）
#    electron/agents/newagent/assets/

npm run typecheck && npm run test:agent-policy && npm run check:agent-boundaries
```

对比现在：改 8 个文件（`agentsStore` / `detect-manifest` 两处 / `manifests/<new>.ts` + 索引 / `agent-resume` 三处 / `integration/assets` 三处 / `integration/index` 事件表与工厂），**外加 4 张行为白名单的语义判断**——漏一处的表现是"能启动但状态不对"。

## 附录 D：既有缺陷清单（重构后核对）

重构目标是「行为等价」，因此以下问题当时**有意不修**。本节记录重构完成后的逐条核对结果
（2025-10 核对，核对基准：`router.ts` 678 行 / 1144 条断言全绿）。

图例：✅ 已修复 ／ 🗑 随重构消失 ／ ⚠️ 仍存在

### 一、已修复（9 条）

| # | 缺陷 | 修复方式 |
|---|---|---|
| 1 | `hookStatuses()['dsh']` 键不匹配 | 键改由 `Object.entries(hookTargets())` 产出，`dsh` 登记在 `INSTALLER_FACTORIES`，键名一致 |
| 4 | `sessionStartSource` 枚举两处不一致（缺 `branch`） | 合并为单一真源 `shared/agents/spec/session-start-source.ts`（8 值含 `branch`），修复 qwen 白名单永不命中 |
| 6 | 先写脚本后解析配置 → 半安装被判 installed | `JsonHooksInstaller.install` 顺序固定为 `checkPreconditions` → `checkConfigTarget` → `writeArtifact` |
| 7 | antigravity 整文件重写抹掉用户注释 | 改用 `writeJsonKey` / `removeJsonKey`（`modify` + `applyEdits`），只动 `herdr-desktop` 一个键 |
| 8 | kilo 的 `plugin/` 子目录未 mkdir | `extensionTarget` 改为对 `dirname(path)` 执行 `mkdir({recursive:true})`，兼容任意深度 |
| 9 | kimi 卸载绕过原子写与符号链接检查 | 改用 `writeConfigFile`（原子写 + 符号链接解析）|
| 10 | `scriptInstalled` 是前缀匹配 | 改为精确匹配 `HERDR_DESKTOP_INTEGRATION_ID=herdr-desktop` 标记 |
| 16 | `assets.ts` 注释称 agent 名经 `HERDR_DESKTOP_AGENT` 传入 | `assets.ts` 已删除，资产随智能体各自的安装器 `?raw` 导入，注释随之消失 |
| 20 | `dsh` 在 `OFFICIAL_AGENTS` 但无 `resumeTail` | `OFFICIAL_AGENTS` 表已删除；恢复能力由 descriptor 声明，未声明即不支持，语义正确 |

### 二、随重构消失（2 条）

| # | 说明 |
|---|---|
| 17 | 8 张 agent 表已合并为 1 个注册表，并有 `test:agent-policy` / `test:integration-version` 双重重守卫 |
| 19 | `proxyAgents` 键从**启动命令**改为 **agentId**（`settings.ts` / 主进程 `launchEnvFor` / 渲染层 `preset.id` 三层同步）|

> 注：#19 **不做旧键迁移**，与项目「不留兼容层」的原则一致（同 AGENTS.md 的命名空间规则）。
> 早期版本用启动命令作键，升级后这些旧键会被忽略 —— 用户需重新打开代理开关。
> 当前未发布，这个代价可接受；保留迁移逻辑反而会让「命令键」这个概念继续存在。

### 三、缺陷修复记录

#### P1 —— 静默失效 / 难以排查（4 条，**已全部修复**）

| # | 缺陷 | 修复方式 |
|---|---|---|
| 21 | `region()` 未知 region 名静默返回空串 | 新增 `isKnownRegion` / `validateManifestRegions`；**启动期**（`main.ts` 的 `validateManifestRegionsAtStartup`）遍历全部 manifest 校验，写错即抛错。校验必须能拿到各 agent 的 `extraRegions`（codex 的 `after_last_prompt_marker` 等私有 region 声明在 descriptor 里），因此放在 facade 而非 manifests/index |
| 23 | 无 matcher 的规则命中一切 | `gateMatches` 入口先判 `gateIsEmpty`（所有条件均 undefined/空数组），空 gate 一律**不匹配**。原先会落到 `return true`，一条忘写条件的规则能把状态永久钉死 |
| 11 | `screenObserved` 从不复位 | 根因不是「没复位」，而是**用「是否观测过」反推「是否 web」**不可靠。`AgentStateService.refresh` 现在按 `pane.kind === 'web'` 直接短路，web pane 永远不会误置该标志，因此不需要复位 |
| 5 | `install(reportUrl)` 参数无效 | 删除该参数（接口 + 4 个实现 + 调用点），`installHook(agentId)` 随之简化。真实上报地址仍走 `HERDR_DESKTOP_REPORT_URL` 环境变量 |

> 新增 `test:detect-engine`（25 断言）锁定 #21/#23：#21 覆盖内置名、带参数形态、拼写错误、
> 私有 region 需显式声明、以及「全部真实 manifest 启动期校验通过」（这条能防止将来新增 agent
> 时漏写私有 region 声明）；#23 覆盖空规则、空 `all: []`、以及有条件时的正常命中/不命中。


#### P2 —— 一致性 / 代码质量（5 条）

| # | 缺陷 | 处理 | 说明 |
|---|---|---|---|
| 12 | `sessionRefChanged` 有一处语义不同 | ✅ **已修复** | `clearHookAuthorityWithMutation` 里唯一的 `previousSession !== null` 改为与其余 5 处一致的 `!sessionIdentityEqual(previous, current)`。当前两者等价（该方法已把 `hookAuthority` 与 `persistedAgentSession` 都置 null），但统一写法能防止将来清空逻辑收窄时这里悄悄变成错误答案 |
| 3 | `shouldReplacePaneAgentSession` 是死码 | ✅ **已删除** | 全仓零调用、测试也没用。注意：同文件的 `sessionReportAllowsSessionReplacement` **仍在使用**（`terminal-state.ts` 两处），不能一起删 |
| 2 | `dedupeKey` 生成但无消费者 | ✅ **已删除** | 删除 `AgentResumePlan.dedupeKey` 字段与 `dedupeKey()` 函数。「同一会话不允许被两个 pane 同时恢复」这个上游约束**仍未实现** —— 实现它需要先决定冲突检测时机与处理策略，属功能开发而非清理。原注释已随代码移除，避免「看起来有去重其实没有」的误导 |
| 13 | 时钟混用：内部 `Date.now()` 而 API 收 `now` | ✅ **已修复（内部）** | `suppressCurrentFullLifecycleHookAuthority` / `suppressFullLifecycleHookReport` 两个私有辅助原先直接调 `Date.now()`，现改为透传上层已有的 `now`（5 个调用点全部更新）。`nextHookReportSeq(now = Date.now())` 的默认参数**保留** —— 它是可被调用方覆盖的兜底，属合理设计 |
| 14 | `_visibleWorking` 参数全程未使用 | ❌ **保留不改（有意决策）** | 删除参数会波及 `scripts/test-terminal-state.mjs`（第 51/92 行直接以 7 个实参调用该 API），而**该文件的断言是本次重构唯一的行为等价基准，不可修改**。在「删掉一个无用的形参」与「保住等价性证据」之间，选择后者。检测层 `engine` 仍在计算 `visibleWorking`（与上游 manifest 结构对齐），只是状态机消费端忽略它 —— 这是已知的僵尸信号，等下次能整体重写那段测试时一并处理 |

> 关于 #14 的取舍值得记住：**技术债的偿还顺序要让位于回归保护的完整性**。
> 一个未使用的形参是无害的；把唯一的等价性证据改坏是不可逆的。

#### P3 —— 文档 / 性能（3 条，**已全部处理**）

| # | 缺陷 | 处理 | 说明 |
|---|---|---|---|
| 15 | 注释称 claude tick 是「集成 v5」，标记是 4 | 🗑 **随重构消失** | 注释已随 descriptor 迁移重写为「集成 v4 起用 Stop 上报 idle…」，而当前 `integration.version` 是 5 —— 表述正确（v4 引入该行为，现为 v5）。全仓已无「集成 vN」与版本不符之处 |
| 18 | 两套 manifest 类型（`AgentManifest` / `AgentDetectManifest`） | ✅ **已删除无用类型** | `AgentDetectManifest` 与 `AgentDetectRule` 在重构后**零消费者**（全仓搜索 0 处引用），已从 `shared/state.ts` 移除。检测只用 `engine.ts` 的 `AgentManifest` |
| 22 | `compileRegex` 每次 `new RegExp`，无缓存 | ✅ **已加缓存** | 新增 `regexCache: Map<string, RegExp>`。理由：`gateMatches` 被「每条 PTY chunk × 每条规则」调用，规则数在百条量级。安全性：pattern 来自静态 manifest、总数有界；flags 只取自 `[imsu]`（不含 `g`/`y`），因此**无 `lastIndex` 状态残留**，可安全复用 |

> #22 的验证：`test:detect-engine` 第 7 组用同一 manifest 连续求值 5 次，锁住「命中/不命中两种情况下结果都稳定」——
> 这正是加缓存最容易引入的错误（把带状态的 RegExp 复用导致第二次结果不同）。
> 实测 10 万次求值 16ms。

### 四、核对结论

- **P0 已清零**：三条会破坏用户数据或功能完全不可用的缺陷（#7 毁注释、#8 装不上、#19 静默丢开关）已修复。
- **P1 已清零**：四条「出错时不报错」的缺陷已修复，并由 `test:detect-engine` 守卫。
- **P2 已清零**（#14 为有意保留的技术债，详见该行说明）。
- **P3 已处理完毕**：一条随重构消失、两条已修复。
- **附录 D 的 23 条缺陷已全部处理完毕**（21 条修复、2 条随重构消失；#14 为有意保留的技术债）。
- 后续新增的检测规则/智能体请遵循同一条原则：**写错要报错，不要静默降级**。

---

## 附：先做哪一步？
- **只能做一件事 → 第 0 批**：`AgentId` 类型化 + 策略数据化 + 预设派生。收益最大、风险最小、不阻塞后续。
- **想解决"改一处坏一处"的根 → 第 0 批 + 第 1 批**：身份流经 IPC 之后，"每层重新猜"这条因果链被切断。
- **一次做完 → 0 → 1 → 2 → 3 → 4 → 5 → 6**，其中批次 2 与 3 由两人并行（改动文件几乎不重叠）。

---

## 附录 E：重构进度（实施记录）

> 记录哪些已经落地、哪些还没做，供接续开发对照。所有「已完成」项都由
> `npm run typecheck` + 全部 `test:*` + `check:agent-boundaries` 守护。
>
> **当前状态：本方案列出的批次 0~6 全部完成。** 共 1060 条断言、18 项检查全绿。

### 已完成

#### 抽象层（批次 0~2）

| 项 | 结果 |
|---|---|
| `shared/agents/` 抽象 | `agent-id` / `descriptor` / `registry` / `status` + `spec/`（`policy`、`detection-spec`、`integration-spec`、`integration-paths`、`resume-spec`、`session-start-source`、`host`）+ 25 个智能体 descriptor（19 个有官方集成 + 6 个仅检测） |
| 8 张表 → 1 个注册表 | 识别表、别名表、manifest 表、恢复白名单（19）、恢复命令 switch（18）、会话替换白名单（32）、集成版本表（19）、渲染端预设（26）全部收敛 |
| 渲染端预设 | `AGENT_PRESETS` 由注册表派生（26 条字面量 → 0） |
| 10 处内联 agent if | `terminal-state.ts` 里 **0 处** agent id 分支，全部改为读 `StatePolicy` |
| 4 个谓词函数 | 签名不变，内部委托 descriptor 策略 |
| 身份流经 IPC | `SpawnAgentParams.agentId` → `PaneState.agentId` → `Session.agentForPane()` |
| `dsh-web` → `dsh` | 集成键、资产目录、工厂名、预设 id 全部统一 |
| web 与具体智能体解耦 | `resolveWebAgent()` + `launchArgs`；`WebAgentManager` 由 descriptor 驱动 |
| resume 收口 | `agent-resume.ts` 353 → 256 行，三张表删除 |
| detection 收口 | `engine.ts` 336 → 300 行，5 个 codex 专用函数 + 3 个 region 迁到 codex descriptor |
| `sessionStartSource` 枚举 | 两份（7/8 值不一致）合并为单一真源，修复 qwen `branch` 永不命中的漏洞 |
| 命名空间 | 全部改为 `herdr-desktop`，**无兼容层**（按需求明确不做） |

#### 安装器类化（批次 3）

| 项 | 结果 |
|---|---|
| `JsonHooksInstaller` 骨架 | 模板方法 `install`/`uninstall` + **7 个可覆写钩子**：`checkPreconditions`（可异步）/ `artifactSubdir` / `needsExecutableBit` / `removesArtifactDirectory` / `registerExtra` / `unregisterExtra` / `managesHooksConfig`；`HookEvent` 支持逐事件 matcher / background |
| 子类 | 6 个：`CodexInstaller`（config.toml）、`KimiInstaller`（版本闸门 + TOML 块）、`AntigravityInstaller`（独立块 + 目录预检）、`GrokInstaller`（独占文件）、`DshInstaller`（YAML 块 + 插件无可执行位）、`HermesInstaller`（Python 插件目录 + YAML 启用） |
| 声明式智能体 | 9 个由 descriptor 的 `integration.hooks` 自动派生，各自工厂在 `installers/declarative/<id>.ts` |
| 集成状态判定 | `hookStatuses()` 通用三步（产物 / 版本 / `validate()`），opencode 与 grok 的特例挂到各自 target 的 `validate` |
| 集成版本单一来源 | `INTEGRATION_VERSIONS` 表删除，版本只来自 descriptor |
| **opencode 有意不迁移** | 它有 12 个专用私有函数、约 200 行逻辑，复杂度在 **4 个配置文件的读写协议**（`tui.jsonc` / `tui.json` / `cli.json` / `plugins/` + 迁移检测 + TUI/V2 双注册），不在安装编排。硬塞进钩子模型需要 5~6 个专用钩子，会污染只服务其它 18 个智能体的基类。**保持独立**；等出现第二个同类智能体再设计 `MultiTargetInstaller`，避免过早抽象 |
| 工厂注册表 | `electron/agents/installer-factories.ts` 是唯一的 `id → 工厂` 表；汇总层 `electron/integration.ts` 只做 `createAllInstallers()`，**不再认识任何智能体名字**。选显式清单而非自注册：自注册依赖 import 副作用，模块被 tree-shaking 或漏 import 会静默丢一个智能体 |
| 资产随智能体 | 集中的 `assets.ts` **已删除**；19 个资产目录在 `electron/agents/assets/<agent>/`，由各智能体自己的安装器文件 `?raw` 导入 |

#### 结构拆分（批次 5、6）

| 项 | 结果 |
|---|---|
| `terminal-state.ts` | 2253 行。抽出 6 个协作对象（`agent-session-ref` / `arbitration` / `hook-authority` / `hook-report-sequence` / `hook-suppression-ledger` / `stale-session-registry`）+ 类型移到 `state/terminal-types.ts`；三个超大入口按阶段拆开（272→119 / 269→27 / 130→31） |
| `router.ts` | **1641 → 678 行**。七轮拆分（R1~R6 + 早期三轮），全部落在 `electron/ipc/services/`：`pane-lifecycle-service`（455，两阶段创建/重启/恢复/关闭）、`agent-state-service`（440，状态上报与仲裁）、`web-agent-service`（202，web 托管）、`renderer-bridge`（103，输出层）、`state-arbiter`（69，完成判定规则）、`dsh-session-binding`（56）、`env-probe`（48）、`reviving-panes`（33）、`pane-errors`（20）。早期三轮：混合函数分出（`refreshAgent` 5 步、`reportAgentSession` 3 段、`handleNamed` 按 kind 校验）→ 通知调度抽成 `notification-scheduler.ts` → IPC 注册拆进 `handlers/`（`register()` 132 → 45 行） |
| **拆分手法** | 统一用「**方法体迁出 + 留同名私有委托**」：33 个方法改成一行转调，20 多个调用点一行未改。好处是 diff 里能看清「哪些逻辑搬走了」，而不是被调用点改动淹没；也让每批都能独立验证 |
| **R4b 取消** | 原计划让 `refreshAgent` 改收屏幕快照以消除「状态簇 → pane 服务」的反向依赖。实际拆分后发现该依赖**不存在**：状态簇直接依赖 `PtyManager.snapshot()`，不经过 pane 服务。拆分形态本身已隔离两者 |

#### 目录整理

| 项 | 结果 |
|---|---|
| 消歧义改名 | `ipc/protocol.ts` → `ipc/channels.ts`（原与 `shared/protocol.ts` 同名）；`agents/integration-installer.ts` → `agents/installer.ts`（原与 `agents/integration/` 目录同名）；`shared/detect-manifest.ts` → `shared/detect/facade.ts`（原与 `shared/detect/` 同前缀） |
| 去空壳目录 | `runtime/integration/index.ts` → `electron/integration.ts` |
| electron 归类 | `runtime/{logger,clipboard,git,host-env}` → `support/`；`runtime/state/` + `runtime/terminal-state.ts` → `runtime/terminal/`；`agents/integration/` → `agents/installers/` |
| shared 归类 | 7 个契约文件 → `agents/spec/`；`screen-buffer.ts` → `detect/`；`agent-status.ts` → `agents/status.ts` |

#### 安全网

| 项 | 结果 |
|---|---|
| 行为等价 | `test:terminal-state` 的 **163 条断言全程一行未改** —— 这是等价性的客观证据 |
| 新增守卫 | `test:agent-policy`（247：19 agent × 策略矩阵）、`test:integration-version`（271：版本/标记/工厂注册表一致性）、`test:installer-snapshots`（77：配置改写精确形状）、`test:json-hooks-installer`（75：骨架 + 6 子类，内存 IO）、`test:suppression-ledger`（34）、`test:arbitration`（21）、`test:notification-scheduler`（10）、`test:agent-runtime`（14）、`check:agent-boundaries`（边界 lint） |

### 未完成 / 有意不做

| 项 | 现状 | 建议 |
|---|---|---|
| **`terminal-state.ts` 继续拆** | 2253 行，但**类内已无混合职责方法**；剩下的体量是一个类本身（35 个公开方法） | **不建议做**。TS 的类不能跨文件切分，要再降只能重构成多个「各持一片状态」的协作类 —— 那会改动 35 个公开方法与 163 条断言的调用方式，风险远大于收益 |
| **`router.ts` 继续拆** | 1641 行，剩余是 pane 生命周期业务本体（两阶段启动、web 托管、恢复） | 若要继续，抽 `services/pane-service.ts`。但这部分与 `Session`/`PtyManager` 交互密集，收益递减；应作为独立设计任务，不是整理任务 |
| 休眠的托管子系统 | 15 个公开方法仅测试在用，投影字段渲染端零引用 | 决策项，见 §6.3；重构期保持原样 |

### 已知遗留缺陷（未在本次修，见附录 D）

`dedupeKey` 无消费者、`shouldReplacePaneAgentSession` 是死码、`install()` 的 `reportUrl` 参数无效、
antigravity 整文件重写会抹掉注释、kilo 的 `plugin/` 子目录未 mkdir、`screenObserved` 从不复位等 23 条。
它们与「行为等价重构」正交，应独立 PR。

### 命令

```bash
npm run typecheck
npm run test:terminal-state          # 163 断言：状态机行为等价（唯一不能改的断言集）
npm run test:agent-policy            # 247 断言：策略矩阵（重构前后的行为契约）
npm run test:integration-version     # 271 断言：版本 / 标记 / 工厂注册表一致性
npm run test:installer-snapshots     # 77 断言：安装器配置改写（JSON/TOML/YAML 精确形状）
npm run test:json-hooks-installer    # 75 断言：安装模板方法骨架（内存 IO）
npm run test:suppression-ledger      # 34 断言：抑制账本不变式
npm run test:arbitration             # 21 断言：状态仲裁规则
npm run test:agent-runtime           # 14 断言：安装器注册表
npm run test:notification-scheduler  # 10 断言：通知延迟投递与证据复核
npm run test:pane-service            # 25 断言：两阶段创建的中间态不变量、tryRevive 短路条件
npm run test:state-arbiter           # 20 断言：完成判定两条规则（原先内联在 router 里、零测试）
npm run test:dsh-binding             # 19 断言：会话→pane 路由表（路由错了表现为串台）
npm run check:agent-boundaries       # 边界 lint：禁止业务代码判断 agent id
```

### 继续时的注意事项

1. **不要改 `scripts/test-terminal-state.mjs`**。它按行锁定了 25 组行为，是本轮重构能安全推进的唯一依据；搬家可以，断言不能改。
2. **改协议串/标记名时不做兼容层**（AGENTS.md 命名空间规则）：旧数据直接失效是已接受的代价。
3. **新增「某个智能体才这样」的行为**，加 policy 字段而不是 if 分支 —— 否则 `check:agent-boundaries` 会红。
4. **新增带官方集成的智能体**：① 在自己的文件里写 `createXxxTarget()`；② 在 `installer-factories.ts` 加一行。`electron/integration.ts` 不需要动。
5. **批量改写 import 路径时不要用 PowerShell 的 `-replace`**。本轮 3 次因反引号/引号嵌套的转义把文件写坏（descriptor 被写成空文件、测试文件语法错乱），最终都改用 Node 脚本 + `edit` 工具才可靠。脚本要**幂等**且**按引用者目录分组**（同一个模块在不同深度的文件里相对路径不同，全局替换会改坏正确路径）。
6. **目录移动后会牵动测试脚本里的硬编码路径**（`package.json` 的 esbuild 命令、`scripts/*.entry.mjs` 的 import、`test-integration-version.mjs` 的目录常量）。这是 typecheck 查不到的，只有跑测试才会暴露。
