# herdr-desktop 功能状态与里程碑

> 截至 2025 年的功能盘点。对照 `docs/architecture.md` 的设计目标，
> 列出已实现 / 部分实现 / 未实现的能力，以及里程碑进度。

---

## 1. 里程碑总览

| 里程碑 | 目标 | 状态 |
|--------|------|------|
| **M1 最小可运行** | Electron + React + xterm.js 骨架，spawn 一个 agent 并显示终端 | ✅ 完成 |
| **M2 多 pane 管理** | 拓扑、分屏布局、多 xterm 实例、惰性渲染 | ✅ 完成（水平并排分屏；惰性渲染留作后续优化） |
| **M3 agent 状态检测** | manifest 检测引擎 + 状态徽标 + 通知 | 🟡 部分完成 |
| **M4 会话持久化** | 布局/状态落盘，重开恢复 | ✅ 完成（2025-09：恢复 + 重启接通） |
| **M5 打包发布** | electron-builder 三平台目标，Windows 安装包 | ✅ 完成（NSIS + zip 验证通过，应用图标已接入） |
| **M6 跨平台** | macOS / Linux 平台实现与构建目标 | ✅ 完成（代码 + 构建配置就绪；未在真机验证） |
| **M7 开源与发布** | README 中英双语、开源协议、CI 手动触发打 6 个安装包并发 Release | ✅ 完成（工作流已就绪；未实跑验证） |

---

## 2. 已实现

### 2.1 架构与基础设施

- ✅ **自研 Agent 运行时后端**（Main 进程，非 herdr 壳）：PTY 生命周期、状态检测、持久化全部自持
- ✅ **State / Runtime 分离**：`shared/state.ts` 纯数据模型可序列化；`PtyRuntime` 仅存在于 Main 进程
- ✅ **版本化 IPC 冻结契约**：统一 envelope `{ type, version, payload }`，破坏性变更须 bump version
- ✅ **双通道分离**：高频 `pty:data` 与低频结构状态互不干扰
- ✅ **单向数据流**：Renderer store 是 Main 端状态的投影，无本地权威状态
- ✅ **平台抽象**：`electron/platform/` 按 `process.platform` 分发（`win.ts` / `unix.ts`→`darwin.ts`·`linux.ts`），核心模块零平台判断
- ✅ **原子持久化**：串行写链 + 唯一临时文件名 + rename，并发写不冲突
- ✅ TypeScript strict（`noUnusedLocals` / `noUnusedParameters`），三端类型贯通

### 2.2 终端

- ✅ **xterm.js 6 + WebGL 渲染器**：闪烁问题已修（5 秒 92 块数据下 DOM mutation 9,993 → 161）
- ✅ **node-pty + ConPTY**：Windows 原生支持
- ✅ **两阶段 pane 创建**：`spawn-agent` 只建 pane → 渲染端 mount xterm 并 fit → `attach-pane` 用精确 cols/rows 启动 PTY。彻底解决 TUI（opencode 等）首帧排版错位
- ✅ **终端背景随主题**：`--terminal-bg: var(--bg-app)`，VSCode `terminal.background` 风格
- ✅ **主题切换时重建 WebGL addon**：修复切浅色主题终端仍黑底的问题
- ✅ **字号设置**（9–24px），fit 联动
- ✅ **PTY 输出 buffer**（200k chars）：供 agent 检测 + 挂载时一次性回放
- ✅ unicode11 addon（宽字符宽度正确）

### 2.3 Agent 管理

- ✅ **项目 → Agent 两级模型**：先添加项目（本地目录），再在项目内创建 agent（参考 Codex）
- ✅ **agent 预设 + 可用性探测**：创建时按 PATH 实际解析结果过滤不可用的 agent
- ✅ **spawn 失败处理**：命令不存在 → pane 回滚 + 用户可见的 toast（主进程不崩溃）
- ✅ **agent 状态徽标**：idle / working / blocked / done + 配色圆点
- ✅ **状态变化通知**：转到 blocked / done 时 toast（key 下发、渲染端本地化）；blocked 且窗口未聚焦时额外发系统通知
- ✅ **标题提取**：ANSI 剥离 + shell 横幅/提示符噪声过滤 + 超长截断
- ✅ **关闭 pane / 移除项目**：级联 kill PTY，聚焦自动转移
- ✅ **项目分组折叠**，折叠状态持久化
- ✅ **多 pane 并排**：运行中的 agent 在主区水平分屏，各自独立 xterm 实例（terminalBus 按 paneId 路由，互不串扰）+ 标签栏（点击聚焦/关闭）

### 2.4 UI / UX

- ✅ **风格左右分栏**：左 sidebar / 右主区完全独立，各自有顶部栏，分隔线从顶到底贯穿
- ✅ **自定义标题栏**：`titleBarOverlay` 保留原生窗口按钮，配色随主题经 IPC 同步到主进程
- ✅ **左栏品牌区**：logo + 应用名 + 副标题，整块为窗口拖拽区
- ✅ **右栏顶部栏**：agent 标签 / 项目名 + 项目路径 + 主题切换三段控件
- ✅ **粗体 SVG 图标集**：统一 `stroke-width: 2`，`currentColor` 继承，不再依赖笔画粗细不一的 Unicode 字形
- ✅ **折叠侧栏**：48px 图标轨（项目首字母徽标 + 状态点 + 设置入口）
- ✅ **设置弹窗**：左侧分类导航 + 搜索 + 右侧内容；通用 / 外观 / 语言 / Agent 检测 / 关于
- ✅ **浅色 / 深色 / 跟随系统** 主题，默认跟随系统
- ✅ **i18n 中英文**：中文默认，手写无依赖实现；key 为类型安全联合（漏译/错拼在 tsc 阶段报错）；复数化（中英文规则分离）
- ✅ **错误 toast**：右下角浮层，文案由主进程下发 key、渲染端按语言渲染
- ✅ **空状态引导**：添加项目 → 创建 agent 的两步引导

---

## 3. 部分实现

| 功能 | 已有 | 缺失 |
|------|------|------|
| **agent 状态检测（M3）** | 简化 regex 检测（关键词匹配 idle/working/blocked/done，仅取底部缓冲 + 词边界）+ 24 个 agent 识别 + 状态徽标 + 状态变化通知（blocked/done → toast + 系统通知） | 非 herdr 式声明式 AND/OR/NOT 状态规则；识别与状态判定分离度有限 |
| **跨平台（M6）** | ✅ 三平台代码路径完整：平台分发、POSIX 可执行解析（PATH + 可执行位）、登录 shell 环境捞取、Cmd/Ctrl 快捷键、macOS 菜单结构、三平台 icon 与构建目标 | 未在 macOS / Linux 真机验证；无 CI 矩阵 |

### 3.1 会话恢复（M4，已完成）

- ✅ 每次结构变更原子落盘 `session.json`（串行写链 + 唯一临时文件）
- ✅ 启动时恢复项目 / pane / agent 元数据（`session.restore()`，防御性归一化）
- ✅ **启动时不选中任何 agent**：不恢复聚焦，主区域显示初始空状态；
  恢复的 pane 在侧栏标记为停止态（压暗 + 播放符号）
- ✅ **选中即自动恢复**：点击侧栏 agent 行时自动拉起进程（与聚焦合并为一次快照推送，
  避免「重新启动」提示闪现）；主区域的重启按钮仅作为恢复失败后的手动入口
- ✅ 恢复复用两阶段创建：暂存参数 → 终端挂载 fit → `attach-pane`
  用精确尺寸拉起 PTY（首帧排版正确）
- ✅ 恢复失败（命令被卸载等）保留 pane 条目回到停止态，不清掉用户的会话结构；
  再次点击该 agent 行即可重试
- ✅ 退出前 `flushState()` 排空挂起写入（`before-quit` + preventDefault 模式）
- ✅ 旧格式兼容：无 `command` 字段的 pane 丢弃（无法重启），项目保留

### 3.2 跨平台实现（M6）

平台差异全部收敛在 `electron/platform/`，核心模块（pty-manager / router / renderer）
不做平台判断。

| 关注点 | Windows（`win.ts`） | macOS / Linux（`unix.ts`） |
|--------|---------------------|---------------------------|
| 命令解析 | PATH × PATHEXT 逐个拼接；已带扩展名则精确查找 | PATH 顺序查同名文件，**要求可执行位**（X_OK） |
| 扩展名补齐 | 有（`.COM;.EXE;.BAT;.CMD`，读 PATHEXT） | 无（`cursor-agent` 就是 `cursor-agent`） |
| 批处理包装 | `.cmd`/`.bat` 需 `cmd.exe /d /c` 包装 | 不存在此概念 |
| 默认 shell | PowerShell，回退 `ComSpec` | `$SHELL` → `/bin/zsh` → `/bin/bash` → `/bin/sh` |
| 启动环境 | 直接继承父进程 | 跑 `shell -l -i -c env` 捞登录环境（GUI 启动拿不到用户 PATH） |
| 终端后端 | ConPTY（`useConpty: true`） | forkpty（不传该选项） |
| 窗口图标 | `BrowserWindow.icon` + exe 内嵌资源 | 同左（macOS 用 bundle `.icns`） |
| 标题栏 | `titleBarOverlay`（主进程同步配色） | macOS `hiddenInset` 保留交通灯 |
| 终端快捷键 | Ctrl+Shift+C/V、Ctrl+F | ⌘C/⌘V、⌘F |

**注意**：macOS / Linux 路径尚未在真机验证。`npm run test:unix` 可在任意平台验证
POSIX 解析逻辑中与平台无关的部分（扩展名补齐、目录判定、批处理判定）；
依赖真实 POSIX 语义的断言（可执行位、绝对路径）在 Windows 上自动跳过，
需在 Linux/macOS 上运行才能覆盖。

---

### 中优先（体验完善）

- ✅ **scrollback 搜索**：Ctrl+F / ⌘F 打开搜索栏，输入即搜 + 上/下一个 + 匹配计数（SearchAddon）
- ✅ **终端复制粘贴**：Windows/Linux 为 Ctrl+Shift+C/V，macOS 为 ⌘C/⌘V（navigator.clipboard）
- ✅ **更多 agent manifest**：24 个 agent 均有识别规则（词边界匹配命令名/品牌）；状态判定仍为通用关键词
- ✅ **应用图标**：`build/icon.png`（512×512，`npm run icon` 可重新生成），
  已接入 win/mac/linux 三端 `icon` 配置；构建产物内嵌 12 档尺寸 PNG 资源（已验证）

### 低优先（远期）

- ❌ workspace / tab 树（已被 Project → Agent 简化模型替代，需先明确是否还要）
- ❌ SSH 多机联邦（架构文档预留，未动工）
- ❌ 自动更新

### 3.3 开源与发布（M7）

- ✅ **README 中英双语**：`README.md`（中文，默认）/ `README.en.md`（英文），互相链接
- ✅ **开源协议**：MIT（`LICENSE`），`package.json` 的 `license` 字段与之一致
- ✅ **仓库元数据**：`repository` / `homepage` / `bugs` / `keywords` 已补，供 npm 与 GitHub 识别
- ✅ **CI 手动触发打包**（`.github/workflows/release.yml`）：
  `Actions → Build & Release → Run workflow`，三个 job：
  1. `prepare`：`npm ci` → `typecheck` → `test:unix` → 产物命名校验 → 解析版本号/tag
  2. `build`：6 个矩阵项（3 平台 × 2 架构）分别构建并上传 artifact
  3. `release`：汇总全部产物 + 生成 `SHA256SUMS.txt` → 发布到 GitHub Release
- ✅ 版本号默认读 `package.json`，可用输入参数覆盖；支持发布为 draft
- ✅ **产物命名**：`${productName}-${version}-${os}-${arch}.${ext}`，
  6 个组合互不冲突；由 `npm run check:artifacts` 在 CI 中守护

**关键约束（决定 CI 结构）**：node-pty 1.1.0 只自带
`prebuilds/{win32,darwin}-{x64,arm64}` 四组预编译产物，**没有 Linux**；
且其 `scripts/prebuild.js` 是按**构建主机**的 `process.arch` 选目录的，
不具备交叉编译能力。由此：

- arm64 必须用原生 arm64 runner 构建，不能在 x64 上交叉编译
  （否则 prebuild 查找命中 x64 目录，静默产出错误架构的二进制）
- Linux 两个架构都要装 `build-essential` + `python3` 从源码 node-gyp 编译
- workflow 中加了「runner 架构 == 目标架构」断言，避免上述静默失败

---

## 5. 已知技术债

1. **检测引擎仍是关键词近似**：已改为底部缓冲 + 词边界，误报大幅降低，但仍无逐 agent 的 AND/OR/NOT 屏幕 manifest，个别 TUI 仍可能误判。
2. **跨平台未在真机验证**：macOS / Linux 的代码路径与构建目标已完整，但只在 Windows 上验证过；`unix.ts` 中依赖 POSIX 语义的分支（可执行位判定、登录 shell 环境捞取）缺真机覆盖。
   已通过 CI 在 `ubuntu-latest` 上跑 `test:unix` 部分补偿（POSIX 断言在那里是真实执行的），但打包产物本身仍未在 mac/Linux 上跑起来过。
3. **arm64 runner 标签未经验证**：CI 用 `ubuntu-24.04-arm` / `windows-11-arm` 构建 arm64，
   这两个标签在私有仓库或组织策略下可能不可用。首次跑 CI 时需确认；若不可用，
   改用自建 arm64 runner 或暂时只出 x64 包。

---

## 6. 建议的下一步（按收益排序）

1. **跑一次 CI 验证 6 个安装包** —— 触发 `Build & Release`，确认 arm64 runner 可用、
   6 个产物齐全且能正常安装启动。这是当前最大的未知项。
2. **声明式状态规则** —— 若误判仍明显，再考虑按 herdr 方式为各 agent 提供 AND/OR/NOT 屏幕 manifest。
3. **代码签名** —— macOS 公证（需 Apple Developer 账号）与 Windows 签名，消除安装时的安全警告。
