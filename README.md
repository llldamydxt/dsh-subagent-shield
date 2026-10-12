# dsh-subagent-shield · 子代理信息隔断

> 给 [DeepSeek Harness](https://github.com/deepseek-ai)（DSH）用的一颗插件：
> **拦住子代理读取父会话 / 兄弟子代理的落盘记录、投影缓存与宿主凭据**。
> 带设置页独立分区（颗粒度到工作区与窗口）和一个常驻状态小窗。

**English TL;DR** — A DSH plugin that blocks subagents from reading the parent
session's on-disk transcript (`sessions/**`), the projection cache
(`storages/session_projcache/**`) and the host credentials
(`.credentials.yaml`). Rules can be set per workspace and per window from a
settings section. It is a **tool-layer policy fence, not an OS boundary** — see
[它做不到什么](#它做不到什么). 300 automated checks (5 suites, all runnable
locally, no network) — see [测试](#测试).

---

## 目录

- [为什么需要它](#为什么需要它)
- [它拦什么](#它拦什么)
- [它做不到什么](#它做不到什么) ← **请先读这一节**
- [安装](#安装)
- [配置与设置页](#配置与设置页)
- [判定语义（改代码前必读）](#判定语义改代码前必读)
- [测试](#测试)
- [已知残余风险](#已知残余风险)
- [独立评审与加固记录](#独立评审与加固记录)
- [跑子代理对照实验](#跑子代理对照实验) ← 如果你是为了做对照实验才装它
- [反馈与支持](#反馈与支持)
- [许可证](#许可证)

---

## 为什么需要它

DSH 会把每个会话的**完整记录**（每次工具调用、每段输出）明文落盘到
`%DSH_HOME%\sessions\<cwd 编码>\<session-id>\session.v4.jsonl.zstd`，
并且**按工作目录分组并列**；投影缓存是**明文 JSON**；凭据是**明文 YAML**。

也就是说：一个子代理只要知道路径，就能 `read` 或 `glob` 出**父会话与所有兄弟子代理的记录** ——
这会让"用子代理跑对照实验"这件事失去可信度（对照组之间互相污染），
也会让同机上的任何一次委派变成一次信息外泄。

这颗插件按**工作区 / 窗口**两级给你开关，默认只挡子代理、不挡父会话。

## 它拦什么

| 受保护位置 | 为什么 |
|---|---|
| `%DSH_HOME%\sessions\**` | 父会话 + 全部兄弟子代理的完整落盘记录 —— 泄露的主通道 |
| `%DSH_HOME%\storages\**`（含 `session_projcache`） | 明文 JSON 投影缓存，含进行中的提示词 / todos / 草稿 |
| `%DSH_HOME%\.credentials.yaml` | 明文凭据（`refs.DEEPSEEK_API_KEY`、GUI 的 cookie 签名密钥） |
| **自定义拦住目录**（`protectedPaths`） | 实验产物目录 —— 挂进来后只有「归属者」能碰（归属按 **窗口** 或 **子代理标签** 认），其它窗口与其子代理一律拦 |
| **别的子代理写出的文件**（谁写的谁拥有，**默认开**） | 子代理 `write`/`edit` 过的文件自动归它；**另一个**子代理去读、或去 `glob`/`grep` 那个目录 → 拦。**零配置**，不用先建目录结构、不用填归属 |
| 插件自身文件（规则 / 状态 / 归属登记表 / 审计账本） | 账本里有别的工作区路径与窗口 id（元数据）；**无条件保护**，与用户规则无关 |

判定分两族，**可信度不同**：

| 族 | 工具 | 判定方式 | 可信度 |
|---|---|---|---|
| 路径族 | `read` `write` `edit` `read_image` `str_replace_editor` `glob` `grep` | 取那个**决定访问位置**的参数，归一化（大小写 / 正反斜杠 / `\\?\` / `.` 与 `..` / 首尾引号）后与受保护根做**前缀比较** | **精确** |
| 命令族 | `pwsh` `bash` `run_code` `cordis_define` | **命令文本启发式**（`\.dsh\sessions`、`$env:DSH_HOME…sessions`、`session_projcache`、`.credentials.yaml`、`session*.jsonl`、`--C-Users-…--`） | **启发式，可被绕过** |

被拒时返回：

```
【已隔断】子代理不得访问<受保护位置>。
路径：<原始路径>
这是策略决定，不是临时故障，请勿重试或用其它方式绕过。
```

最后那句是刻意加的：没有它，被拒的模型会反复重试同一个调用。

## 它做不到什么

**它是工具层策略围栏，不是内核边界。** 请勿据此形成安全感：

| 位置 / 手法 | 拦不拦 | 说明 |
|---|---|---|
| `sessions` / `storages` / `.credentials.yaml` / 插件自身文件 | **拦** | 保护的正面 |
| **工作区里的实验产物**（各臂的输出/笔记） | 放行 | **默认不管** —— 两个子代理互相读对方的产物是允许的。要隔开就把它挂进「臂间隔离」 |
| `logs` / `cache` | 放行 | 可能含会话痕迹，但拦了容易误伤正常开发；**其内容未评估** |
| `profiles\**` | 放行 | 含各 profile 的 `node_modules` 与补丁（元数据） |
| `%DSH_HOME%` 根目录 | 放行 | 会暴露 `subagent-shield-*.json` 的**存在性** |
| `%TEMP%\dsh-spill-*`（工具把超大结果落盘的地方） | 放行 | 一次"合法"的大结果查询会把内容写到这里 |
| 命令文本混淆（拼接 / `[char]` / base64 / `cmd /c` 套壳 / `node -e`） | **管不了** | 文本启发式的固有边界：拦的是手滑与惯性触碰，不是恶意对抗 |
| 本机其它进程直接读文件 | **管不了** | 要真在那一层拦，只能整体替换 `ctx.fs` provider（`dsh-fs-sandbox` 的做法，且不能与其并存） |

**真正的硬隔离仍然是**：不同 OS 账户 / 容器 / 另一台机器，各配独立 `DSH_HOME`。
本插件不加密任何东西，也不改会话落盘布局（那些没有插件钩子可用）。

## 安装

前置：Node ≥ 20、PowerShell（Windows）、已装 DSH。

```powershell
git clone https://github.com/llldamydxt/dsh-subagent-shield.git
cd dsh-subagent-shield

# 先干跑看一眼会做什么（一个字节都不改）
powershell -ExecutionPolicy Bypass -File .\tools\install-shield.ps1 -DryRun

# 真装（自动备份 profile 补丁；自验不过会**自动回滚**）
powershell -ExecutionPolicy Bypass -File .\tools\install-shield.ps1

# 只装宿主半区 + 状态小窗（不要设置页分区 —— 见下）
powershell -ExecutionPolicy Bypass -File .\tools\install-shield.ps1 -NoUI
```

装完**必须重启 DSH**（不加 `-Restart` 只会复用现有实例，插件不会加载），然后刷新页面。

`-DshHome` / `-Profile` / `-PluginSrc` 可覆盖默认值。

**两种安装模式**：

| 模式 | 含什么 | 适合 |
|---|---|---|
| 完整（默认） | 隔断 + 设置页独立分区 + 状态小窗 | 日常使用 |
| `-NoUI` | 隔断 + `/shield` 命令 + `/status` 接口 + 状态小窗 | 只想要隔断、不想让任何客户端代码进 GUI |

为什么要给 `-NoUI`：DSH 冷启动时**一颗坏插件会让整棵插件树加载失败**。客户端半区
（`dsh.client`）是唯一有这种威力的部分，所以它被做成可剥离的。安装器本身也 fail-closed：
`package.json` 声明了 `dsh.client` 但 `lib/client.js` 不存在时，**拒绝安装且一个字节不改**。

## 配置与设置页

设置 → **信息隔断**（与其它插件的分区并列）。里面可以：

- 总开关、隔断范围（`subagents` 只挡子代理 / `all` 连父会话一起挡）
- 逐项保护：会话落盘 / 投影缓存 / 凭据 / 命令文本启发式
- **按工作区**、**按窗口**逐条设「拦住 / 放行」，每段带「全开 / 全清空」
- **臂间隔离**：把某个目录挂成「自定义拦住目录」并指定**归属窗口** —— 只有它能碰，别的窗口与子代理一律拦。跑对照实验时用它把各臂的产物隔开
- 审计账本开关与路径、拒绝统计、状态小窗开关

任意窗口里也可以敲命令：

```
/shield on | off | clear | status
```

按窗口的覆盖会持久化，重启后仍在。

配置键（都是 `.volatile()`，热改生效）：

| 键 | 默认 | 含义 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `scope` | `subagents` | `subagents` 只挡子代理 / `all` 连父会话一起挡 |
| `mode` | `all` | 窗口级覆盖的合并方式 |
| `protectSessions` / `protectProjcache` / `protectCredentials` | `true` | 逐项保护 |
| `guardShellText` | `true` | 命令族文本启发式 |
| `enabledAudit` / `auditFile` | `true` / 默认路径 | 审计账本 |
| `dshHome` | `''` | 覆盖 `DSH_HOME`，留空读环境变量 |

## 判定语义（改代码前必读）

优先级：**具体窗口 > 具体工作区 > 目录级（后代的并集）> `defaultPolicy`**。

1. **身份不确定（通配 `*`/`?`、缺失、为空）⇒ 回落到「祖先并集」**，即
   `defaultPolicy === 'protect' || 任何一条点名 true`。
   ⚠ 注意**不是"一律拦"**：祖先并集为空时（`defaultPolicy=allow` 且无人被点名）仍然放行。
   `{ws:'a', sid:'**'}`、`{ws:'**', sid:'s1'}`、`{ws:null, sid:'s1'}` 这三格就是如此 ——
   反直觉但实测为准，测试里显式钉住了。
2. **两侧都具体 = 单个叶子** ⇒ 具体窗口 > 具体工作区 > `defaultPolicy`。
3. **目录级 / 祖先查询** ⇒ 只要下面还可能存在受保护对象就拦
   （`defaultPolicy=protect` 时，工作区下面**未点名的窗口仍受保护**，列举目录会泄漏窗口 id）。
4. **插件自身文件无条件保护**。账本是**两个路径都保护**：默认路径恒常并入，
   自定义 `auditFile` 不同则一并并入。
5. **放行必须能追溯到一条"用户显式允许"**：点名豁免，或 `defaultPolicy=allow` 的未点名对象。
6. **插件自己开的路由挂在 GUI 鉴权层后面**：`/status` 与 `/rules` 服务端调用
   `ctx.connection.requestRejection(req)`（可选注入）—— 通过才给清单，否则 401/403；
   拿不到该服务时**降级为只给计数**，**写操作一律 401**。

> 这一族（"拿不到确定目标 → 回落到宽松默认"）的漏洞历史上出过 5 次，
> 所以第 1–6 条都被 `test/test-matrix.mjs` 的独立预言机穷举覆盖。

## 测试

**300 项，5 套，全在 `%TEMP%` 沙箱里跑，不碰你正在用的 DSH，不需要网络。**

```powershell
cd test
node test-matrix.mjs     #  10 项：语义层族谱矩阵（预言机比对 2280 组 + 形态叉乘 224 组 + 性能回归）
node test-shield.mjs     # 138 项：隔离判定 / 挂载接线 / 沙箱真启动
node test-ui.mjs         #  98 项：客户端半区（无头）/ 鉴权回归 / 状态接口
node test-blast.mjs      #  32 项：爆炸半径 / 安装器 fail-closed / NoUI
node test-browser.mjs    #  22 项：**真浏览器**（Edge/Chrome + CDP）验设置页与浮窗
```

同一份测试文件在**两种目录布局**下都能跑（作者测试台 / 本仓库），无需手工改路径 ——
插件路径、安装器路径、沙箱布局都是自动识别的；环境靠下面这些变量，默认自动探测。

**环境变量**（都不设也能跑，会自动探测）：

| 变量 | 用途 |
|---|---|
| `DSH_CHECKOUT` | 含 `node_modules/@deepseek-ai/{dsh,schemastery}` 的目录 |
| `DSH_BIN` | dsh 的 `lib/bin.js` |
| `DSH_NODE` | 跑子进程用的 node（默认当前 node） |
| `DSH_HOME` | 单元测试里当"受保护根"的样例路径 |
| `DSH_NPX_CACHE` | 额外的 npx 缓存根 |
| `DSH_BROWSER` | Edge/Chrome 可执行文件 |

测试台的立场写在 `test/_env.mjs` 与各文件头部：**预期值来自独立重写的真值机与写死的规范表，
不来自"跑一遍看看结果"**；用 SHA256 证明测的就是当前这份代码；唯一的真机接触是只读采样。

## 已知残余风险

- **客户端半区是逆向来的契约**（槽名 / 服务名靠读别的包源码得到），DSH 仍是 RC 版本
  （本文档对应 `0.2.0-rc.2`）。上游改了可能坏 → 表现为设置页报错。有两条退路：
  `-NoUI` 重装，或移除 profile 补丁里那条。`test-browser.mjs` 会在坏掉时红灯。
- **`/status` 会返回 `auditFile` 字段**（一个工作区路径）。取证用途，影响很低，已知未处理。
- **命令族是可绕的**，上面已列明。
- **没有 CI，这是有意的**：这套测试要跑起来需要 ① 一份**可安装的 DSH**
  （目前没有公开可装的发布）、② **Windows**（安装器用 PowerShell / `mklink` / `taskkill`）、
  ③ 一个**浏览器**。少了第 ① 条，runner 上大部分套件只能跳过 ——
  那样交出来的是一盏**永远绿但没测东西**的灯，比没有 CI 更坏。
  等 DSH 有公开发布之后再加。发布前的人工核对清单见 [docs/发布清单.md](docs/发布清单.md)。

## 独立评审与加固记录

版本变更见 [CHANGELOG.md](CHANGELOG.md)。

**这个插件被一次独立评审挑过，报告原文收录在 [docs/评审报告.md](docs/评审报告.md)**
（评审者自建 183 项测试台：独立重写的真值机 + 18000 组叉乘 + 真启动 + HTTP 实测）。
它抓出的问题里，这几条是真缺陷并已修复、各自补了回归测试：

| 发现 | 修法 |
|---|---|
| 默认账本路径在设置自定义 `auditFile` 后失守 | 两个路径恒常一并保护 |
| 判定耗时随规则条数**线性劣化**（6400 条 → 3.4 ms，732×） | 按规则对象身份缓存聚合值；实测 3000 条 → **1.04×** |
| 插件自开的路由**不在** GUI 鉴权层后面（无 cookie 即可拿到全部工作区路径与窗口 id） | 服务端接上 `connection.requestRejection`；拿不到服务时降级为只给计数，**写操作一律 401** |
| `storages` 本目录未归类 | 归入 projcache 类 |
| `/status` 报的版本是硬编码字面量 | 从自身 `package.json` 读 |

评审报告里那条「挂了 2 个监听器」的怀疑**复现不出后果**（启动日志只有 1 行 `已挂载`、账本零重复行），
已在报告的现状表里标明"保留观察"，未粉饰。

## 跑子代理对照实验

这个插件最初就是为了让**子代理能安全地跑对照实验**才写的。但要说清一件事：

> **装了它，你的对照实验并不会自动变可信。**
> 它只解决四类"白跑"原因里的**第 4 名（泄露）**。前两名 —— **口径漂移**和**答案键落在被试的搜索邻域** ——
> 是你的实验设计问题，插件天生管不了。而且这两条**事后查不出来**（泄露会留账本，它们不留痕迹）。

- 概念解释（通俗版）：[说明书 → 拿到可信结果的两条纪律](docs/说明书.md)
- 独立验证报告（**真子代理对撞的逐字证据**）：[docs/独立验证报告.md](docs/独立验证报告.md)
- **日常直接抄的提示词**：[docs/提示词模板.md](docs/提示词模板.md)
- 照着跑的执行书：**[docs/对照实验协议.md](docs/对照实验协议.md)**
  —— 实验前检查清单、护盾状态必记项、每臂产物目录怎么挂、父侧审计命令、停手线

三个最容易漏的动作：

1. **实验前扫一遍搜索邻域**：被试够得着的地方有没有真值/答案/上一轮产物
2. **实验前把口径写成逐字稿**，两臂同一份；有条件就**交换名字盲评**
3. **记下护盾的 `enabled / scope / mode`** —— 漏了这一步，事后无法判断那次到底有没有被拦

`scope` 请固定 `subagents`，不要用 `all`：那会连**父会话的审计通道**一起挡住，
而父侧审计是判"谁污染了谁"的唯一权威手段 —— 等于自断眼睛。

## 移植到别的 Agent 宿主

这个插件是**给 DSH 写的**，只在 **DSH + Windows** 上验证过。但真正跟 DSH 绑死的只有一层薄薄的适配层 ——
**判定语义、配置模型、审计账本、验证方法都是通用的**。

**[porting/](porting/README.md)** 写清楚了换宿主需要什么：

- [porting/README.md](porting/README.md) —— 能搬什么 / 不能搬什么、**宿主能力契约**（逐项确认，缺哪项要降级）、
  移植步骤、9 个我踩过的坑、明确不承诺的事
- [porting/spec.md](porting/spec.md) —— 判定语义规格（纯函数，可整段照搬）：路径归一、分类、
  策略优先级、归属三判据、拒绝文案、账本字段
- [porting/adapter.md](porting/adapter.md) —— 适配层要实现的 6 个接口，每个都写了
  DSH 参考实现与**拿不到时怎么降级**
- [porting/verify.md](porting/verify.md) —— **移植后怎么验证**：控制组 + 真子代理对撞 +
  零泄露检索 + 父侧审计，以及 7 种"假绿"

一句话：**要重写的是"怎么挂上去、怎么认出调用者"；能整段搬走的是"怎么判、怎么记、怎么验"。**

## 反馈与支持

欢迎开 Issue 报 bug，但**不承诺响应时间，也不承诺修复** —— 这是一个自用工具，被公开出来而已。

报 bug 请附上：DSH 版本、本插件版本（`/dsh-subagent-shield/status` 里的 `version`）、复现步骤，
以及你期望发生什么、实际发生了什么。

两件事**请直接开公开 Issue**，别私信：

- **绕过隔断的方法**。命令族本来就是文本启发式、可绕（见「它做不到什么」），
  这属于**已声明的残余风险**，公开讨论比私下留着有价值。
- 文档错误、设计质疑、以及"你这条边界写错了"。

> 唯一的例外是**泄露了真实凭据**的 bug —— 那种请先自己吊销 key，再开 Issue 只描述机制，别贴内容。

## 许可证

[MIT](LICENSE)。
