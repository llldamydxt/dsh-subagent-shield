# 适配层接口

判定逻辑（[spec.md](spec.md)）不依赖宿主；**宿主相关的只有这几件事**。
下面每个函数都给出：要什么、DSH 参考实现怎么做的、拿不到时的降级。

---

## ① `identity(exec) -> { isSubagent, window, callerId, label }`

**这是整个移植里最关键、也最容易做错的一环。**

| 字段 | 要什么 | DSH 参考实现 | 拿不到时 |
|---|---|---|---|
| `isSubagent` | 这次工具调用是不是子代理发起的 | 会话头 `origin === 'subagent'` 或 `delegationDepth > 0` 或 `parentSession` 存在 | 🔴 没有就只能全局生效（`scope` 概念消失） |
| `window` | 调用者所属的**顶层会话** id | `agent.session.header.parentSession ?? header.id` | 🟠 退化为"只能按会话自身 id 归属" |
| `callerId` | **调用者自己**的会话 id | `agent.session.header.id` | 🟠 子代理自报归属这条路没了 |
| `label` | 派发这个子代理时给的**标签/描述** | 见下方"标签怎么拿" | 🟠 一个窗口开多个子代理时**分不开** |

### id 比较要求

**归一后再比**：剥掉可选前缀（DSH 是 `session-`）、忽略大小写、去空白。
> 实测：同一会话在 `window` 字段带前缀、`caller` 字段不带；直接比字符串会让归属者被自己的目录拦住。

### 标签怎么拿（DSH 的两条路，可按你宿主替换）

派子代理时的 `description`（DSH 里是 subagent 工具的 description）会落成子会话的一条记录：

```json
{"type":"subagent/descriptor","seq":6,"data":{"mode":"one-shot","provider":"spawn","label":"臂A（基线组）"}}
```

两条取法，**先快后稳**：

1. **服务路径**：`subagents` 服务 `get(childId)` → descriptor → `label`
2. **记录路径**：直接读子会话记录文件，解析那行 descriptor
   （DSH 的会话记录是**多帧 zstd**：一次工具调用一帧。按帧魔数 `28 B5 2F FD` 切帧，
   逐帧 `zstdDecompressSync`，拼接后正则取 `label`。只解头几帧就够，结果**按会话 id 缓存**）

> 为什么必须有标签：**同一个窗口下的两个子代理 `parentSession` 完全相同**（实测），
> 只按窗口归属会把两臂一起放行/一起拦住 —— 而"父会话开两个子代理当两臂"正是最常用的跑法。
>
> 缓存细节（DSH 版）：拿到就缓存；**空结果最多重试 3 次再缓存**，
> 避免"首次调用早于 descriptor 落盘"被永久记住。

---

## ② `targets(exec) -> string[]`

**把该工具所有可能带路径的参数都吐出来**，不只是 `path`。

```
read / write / edit  → file_path, path, …
glob                 → pattern, path        ← pattern 也是路径！只查 path 会被绕过去（实测踩过）
grep                 → pattern（可能是路径）, path, glob
```

拿不到路径参数的工具（命令族）走 [spec.md](spec.md) §6 的文本启发式那条线。

---

## ③ `sensitiveRoots(home) -> [{ path, kind, label }]`

你宿主自己的"不能给子代理看"的东西。DSH 版：

| kind | DSH 的对应物 | 为什么要保护 |
|---|---|---|
| `sessions` | `<DSH_HOME>/sessions/<编码cwd>/<会话id>/session.v4.jsonl.zstd` | 会话落盘记录：父/兄弟会话的完整对话 |
| `projcache` | `<DSH_HOME>/storages/…` | 投影缓存：**明文**，含进行中的草稿（最容易被忽略） |
| `credentials` | 宿主凭据文件（如 `.credentials.yaml`） | 直接是密钥 |
| `state` | 插件自己的规则/状态/账本 | 被改掉就等于关掉护盾 |

**还要保护"插件自己的文件"** —— 这是元一级的保护，容易漏。

---

## ④ `listWorkspaces()` / `listWindows()`

给设置界面列清单、给"按工作区/窗口"策略用。至少要有：稳定 key、可读 label、会话数、最近时间。

> DSH 版是**扫会话目录的 mtime** 得到的（不依赖任何索引服务）—— 移植时可以照做，
> 好处是"护盾不依赖宿主额外服务也能工作"。

---

## ⑤ `deny(reason) -> <宿主返回值>`

宿主规定的否决形状。DSH 是：

```js
return { kind: 'deny', reason: hit.reason }
```

**注意**：`reason` 是**给模型看的**，要包含"这是策略决定，请勿重试或绕过"——
否则模型会反复换着法子重试（DSH 上观察过）。

---

## ⑥ 可选：接口鉴权与配置读写

如果你要给设置界面开 HTTP 接口（DSH 版有 `/status` 与 `/rules`）：

- 🔴 **接口必须自己加鉴权**。DSH 版是借用宿主 GUI 的 cookie 校验；
  没有宿主鉴权可用时，**至少**要绑回环地址 + 一次性 token。
- 🔴 **写操作绝不能在降级模式下放行**（DSH 版：读不到鉴权服务时，读接口只给计数、写接口直接 401）。
- 🟠 返回体里别塞**元数据**（点名了哪些工作区/窗口）—— 那本身就泄露了"哪里重要"。

---

## 附：DSH 版的模块划分（可作参考结构）

```
lib/index.js     宿主半区：判定核心（纯函数，导出可单测） + 钩子 + 接口 + 小窗注入
lib/client.js    客户端半区：设置页分区（**换宿主基本等于重写**）
lib/widget.js    浮动状态小窗（可选，纯增强）
test/*.mjs       5 套离线测试，全部在 %TEMP% 沙箱里跑，不碰正在用的宿主
tools/           安装器 + 两个审计工具（会话记录解码、会话头查看）
```
