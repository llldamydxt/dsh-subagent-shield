/**
 * dsh-subagent-shield —— 浏览器半区：**独立设置分区**（皮肤市场那种）
 *
 * 契约全部照真实包抄（不臆想）：
 *   槽      `settings.section`  参数 { name, id, order, label, locale, inject } + 组件
 *           —— 见 dsh-client-ui-settings-plugins / dsh-skin-market 的真实注册
 *   服务名  `slots` / `locale` / `configForms`
 *           —— locale 由 dsh-client-ui-settings-plugins 等 inject；configForms 由
 *              dsh-client-ui-settings 提供（`super(ctx, "configForms")`）
 *   配置    `ctx.configForms.get(NS)` → SettingsFormScope：
 *           getSnapshot() / subscribe() / mutate([{op,path,value}], revision)
 *
 * 数据来源分两条：
 *   · 全局开关（enabled/scope/mode/逐项保护/账本）→ configForms（写回 Cordis patch）
 *   · 保护对象（工作区 / 窗口）→ 本插件自己的 HTTP 接口 /dsh-subagent-shield/rules
 *     （GET 读、POST 写；同源 + GUI cookie 鉴权）
 */

window.__ModuleLoader__.load({
  id: 'dsh-subagent-shield',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const react = require('react')
    const h = react.createElement

    /** = 包名 = profile 条目 id = 设置命名空间 */
    const NS = 'dsh-subagent-shield'
    const API = '/dsh-subagent-shield/status'
    const API_RULES = '/dsh-subagent-shield/rules'
    const WIDGET_KEY = 'dsh-subagent-shield:widget'

    const C = {
      fg: 'var(--dsw-alias-label-primary)',
      muted: 'var(--dsw-alias-label-tertiary)',
      border: 'var(--dsw-alias-border-l4)',
      bg: 'var(--dsw-alias-bg-layer-3)',
      err: 'var(--dsw-alias-label-error)',
    }

    const fmtTime = (ms) => {
      try { return new Date(ms).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) } catch { return '' }
    }

    /** 生成"当前零拦截"横幅文案；一切正常时返回 null。抽成纯函数便于单测。 */
    const bannerFor = (eff) => {
      if (!eff || eff.active) return null
      const why = (eff.reasons || []).join('；')
      return `⚠ 当前没有任何拦截生效${why ? '：' + why : ''}`
    }

    // ── 全开 / 全清 的纯逻辑（导出以便单测）
    /** 是否已经"全开"（空列表不算，按钮应显示"全开"） */
    const allChecked = (items) => Array.isArray(items) && items.length > 0 && items.every((x) => x.protected === true)
    /** 生成"把这一组整体置为 target"的补丁；key 取 key 或 id */
    const selectAllPatch = (bucket, items, target) => {
      const map = {}
      for (const it of (Array.isArray(items) ? items : [])) {
        const k = it && (it.key || it.id)
        if (k) map[k] = Boolean(target)
      }
      return { [bucket]: map }
    }

    function apply(ctx) {
      // 全局配置作用域（写回 Cordis patch）。拿不到就优雅降级：只显示、不崩。
      let scope = null
      try { scope = ctx.configForms.get(NS) } catch { scope = null }

      function useConfig() {
        if (!scope) return { status: 'unavailable', value: {}, writable: false, revision: undefined }
        if (typeof react.useSyncExternalStore === 'function') {
          return react.useSyncExternalStore((cb) => scope.subscribe(cb), () => scope.getSnapshot())
        }
        const [snap, setSnap] = react.useState(() => scope.getSnapshot())
        react.useEffect(() => scope.subscribe(() => setSnap(scope.getSnapshot())), [])
        return snap
      }

      const writeCfg = (key, value, revision) => {
        if (!scope) return
        try { void scope.mutate([{ op: 'set', path: [key], value }], revision) } catch { }
      }

      // ── 小组件
      const Row = (children, key) => h('div', { key, style: { display: 'flex', alignItems: 'center', gap: '10px', padding: '7px 0', borderBottom: `0.5px solid ${C.border}` } }, children)
      const Text = (t, style) => h('span', { style: { fontSize: '13px', color: C.fg, ...(style || {}) } }, t)
      const Hint = (t) => h('span', { style: { fontSize: '12px', color: C.muted } }, t)

      function Toggle(checked, disabled, onChange, label) {
        return h('label', { style: { display: 'flex', alignItems: 'center', gap: '8px', cursor: disabled ? 'default' : 'pointer' } },
          h('input', { type: 'checkbox', checked: Boolean(checked), disabled, onChange: (e) => onChange(e.target.checked) }),
          label ? Text(label) : null,
        )
      }

      function Section(title, children, right) {
        return h('div', { style: { padding: '6px 0 18px' } },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', padding: '10px 0 4px' } },
            h('div', { style: { fontSize: '13px', fontWeight: 600, color: C.fg } }, title),
            h('div', { style: { flex: 1 } }),
            right || null,
          ),
          children,
        )
      }

      function Btn(text, onClick, disabled) {
        return h('button', {
          type: 'button', onClick, disabled: Boolean(disabled),
          style: {
            font: 'inherit', fontSize: '12px', padding: '5px 11px', borderRadius: '8px',
            cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.45 : 1,
            color: C.fg, background: C.bg, border: `0.5px solid ${C.border}`,
          },
        }, text)
      }

      // ── 主页面
      function ShieldSection() {
        const snap = useConfig()
        const cfg = snap.value || {}
        const dis = !snap.writable || snap.status === 'unavailable'

        const [data, setData] = react.useState(null)
        const [err, setErr] = react.useState('')
        const [busy, setBusy] = react.useState(false)
        const [widgetOn, setWidgetOn] = react.useState(() => {
          try { return window.localStorage.getItem(WIDGET_KEY) !== 'off' } catch { return true }
        })
        // 自定义拦住目录是"文本输入"，不能每敲一个字就提交 → 用草稿态，按「保存」才落盘
        const [pathDraft, setPathDraft] = react.useState(null)

        const refresh = react.useCallback(() => {
          fetch(API, { credentials: 'same-origin', cache: 'no-store' })
            .then((r) => (r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status))))
            .then((j) => { setData(j); setErr('') })
            .catch((e) => setErr(String(e.message || e)))
        }, [])

        react.useEffect(() => { refresh() }, [refresh])

        const postRules = react.useCallback((patch) => {
          setBusy(true)
          fetch(API_RULES, {
            method: 'POST', credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(patch),
          })
            .then((r) => (r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status))))
            .then((j) => { if (j && j.rules) setData((d) => ({ ...(d || {}), ...j })); setErr('') })
            .catch((e) => setErr(String(e.message || e)))
            .then(() => setBusy(false))
        }, [])

        const rules = (data && data.rules) || { defaultPolicy: 'protect', workspaces: {}, windows: {}, protectedPaths: [] }
        // 服务端为准；有草稿则显示草稿（用户正在编辑）
        const pPaths = pathDraft ?? (Array.isArray(rules.protectedPaths) ? rules.protectedPaths : [])
        const own = (data && data.own) || null
        const dflt = rules.defaultPolicy !== 'allow'
        const workspaces = (data && data.workspaces) || []
        const windows = (data && data.windows) || []
        const denied = (data && data.denied) || { total: 0, windows: 0 }
        const recent = (data && data.recent) || []
        const cfgBrk = (data && data.config) || {}
        const eff = (data && data.effective) || null
        const banner = bannerFor(eff)

        // 全开 / 全清：已全开 → 点了全清；否则 → 点了全开
        const wsAll = allChecked(workspaces)
        const winAll = allChecked(windows)
        const wsOn = workspaces.filter((w) => w.protected).length
        const winOn = windows.filter((w) => w.protected).length
        const toggleAllWs = () => { if (workspaces.length) postRules(selectAllPatch('workspaces', workspaces, !wsAll)) }
        const toggleAllWin = () => { if (windows.length) postRules(selectAllPatch('windows', windows, !winAll)) }

        const toggleWidget = () => {
          const next = !widgetOn
          setWidgetOn(next)
          try { window.localStorage.setItem(WIDGET_KEY, next ? 'on' : 'off') } catch { }
        }

        return h('div', { style: { maxWidth: '860px', padding: '4px 2px 40px' } },

          h('div', { style: { display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' } },
            Text('信息隔断', { fontSize: '16px', fontWeight: 600 }),
            Hint(dis ? '（配置不可写，仅显示）' : `修订 ${snap.revision === undefined ? '-' : snap.revision}`),
            h('div', { style: { flex: 1 } }),
            Btn(busy ? '刷新中…' : '刷新', refresh),
          ),

          // ★★ 边界声明放最上面：使用者必须知道"这层是什么"，否则会把它当安全边界用。
          //    独立对抗性验证（对照实验 01）实测：子代理自己写代码读盘 + 解 zstd，
          //    能把兄弟臂的私密串从落盘记录里偷出来，而且工具层拦不住。
          h('div', {
            style: {
              margin: '10px 0 4px', padding: '10px 12px', borderRadius: '6px',
              background: C.errBg || 'rgba(220,38,38,0.08)', border: `1px solid ${C.err || '#dc2626'}`,
              fontSize: '12.5px', lineHeight: 1.75, color: C.fg,
            },
          },
            h('div', { style: { fontWeight: 600, paddingBottom: '4px' } },
              '⚠️ 这是「工具层策略围栏」，不是内核边界'),
            h('div', null,
              '它能挡住子代理**顺手**去翻别人的记录（精确拦截 + 逐条落账）；'
              + '但挡不住**有心**：子代理自己写十几行代码读盘、解码会话记录就能绕过 —— '
              + '命令族只是文本启发式，而且**绕过不留账本痕迹**。'),
            h('div', { style: { paddingTop: '4px' } },
              '要真隔离，只能靠宿主层手段：**不同 OS 账户 / 容器 / 另一台机器 + 各自独立的 DSH_HOME**。'
              + 'Host 自身的文件沙箱只限制「写」（Windows 用 WRITE_RESTRICTED 令牌），不限制「读」。'),
            h('div', { style: { paddingTop: '6px', fontWeight: 600 } },
              '⚠️ 改动本插件或其配置（开关 / scope / 规则 / 调关键词）**之前，先告诉使用者**。'
              + '配置一旦变动会被记进账本（action=warn, kind=config-changed），/status 的 configDrift 也会显示。'),
          ),
          h('div', { style: { fontSize: '12px', color: C.muted, lineHeight: 1.7, paddingBottom: '6px' } },
            '拦住子代理读取父会话/兄弟会话的落盘记录、投影缓存与宿主凭据。父会话默认不受限，你仍能做审计。'),
          err ? h('div', { style: { fontSize: '12px', color: C.err, paddingBottom: '8px' } }, `接口读取失败：${err}`) : null,

          // ★ 零拦截红字横幅：三层开关能互相静默抵消，必须显式报警
          banner ? h('div', {
            style: {
              fontSize: '13px', fontWeight: 600, color: C.err, lineHeight: 1.7,
              border: `1px solid ${C.err}`, borderRadius: '8px', padding: '10px 12px', margin: '4px 0 10px',
              background: 'rgba(255,107,107,.08)',
            },
          }, banner) : null,
          (eff && eff.active && (eff.reasons || []).length > 0)
            ? h('div', { style: { fontSize: '12px', color: C.muted, paddingBottom: '8px' } }, '注意：' + eff.reasons.join('；'))
            : null,

          Section('总开关', h('div', { style: { display: 'flex', gap: '22px', flexWrap: 'wrap' } },
            Toggle(cfg.enabled, dis, (x) => writeCfg('enabled', x, snap.revision), '启用隔断'),
            Toggle(cfg.guardShellText, dis, (x) => writeCfg('guardShellText', x, snap.revision), '命令行文本启发式（可被拼接绕过）'),
          )),

          Section('隔断范围 / 模式', h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
            h('div', { style: { display: 'flex', gap: '20px', flexWrap: 'wrap' } },
              Toggle(cfg.scope === 'subagents', dis, () => writeCfg('scope', 'subagents', snap.revision), 'subagents（只挡子代理）'),
              Toggle(cfg.scope === 'all', dis, () => writeCfg('scope', 'all', snap.revision), 'all（父会话也一起挡）'),
            ),
            cfg.scope === 'all' ? h('div', { style: { fontSize: '12px', color: C.err, fontWeight: 500 } },
              '⚠ 当前 all：父会话自己读会话记录也会被拒，审计只能靠账本，或在本窗口执行 /shield off。') : null,
            h('div', { style: { display: 'flex', gap: '20px', flexWrap: 'wrap' } },
              Toggle(cfg.mode !== 'window', dis, () => writeCfg('mode', 'all', snap.revision), 'all（所有窗口的子代理都检查 —— 推荐）'),
              Toggle(cfg.mode === 'window', dis, () => writeCfg('mode', 'window', snap.revision), 'window（只有被 /shield on 点名的窗口检查，其余全部放行）'),
            ),
            cfg.mode === 'window' ? h('div', { style: { fontSize: '12px', color: C.err, fontWeight: 500 } },
              '⚠ window 模式下，没被点名的窗口**完全不检查**。想恢复：改成 all，或在那些窗口执行 /shield on。') : null,
          )),

          Section('拦住谁 / 拦住什么（默认策略）', h('div', null,
            h('div', { style: { display: 'flex', gap: '20px', flexWrap: 'wrap', paddingBottom: '4px' } },
              Toggle(dflt, false, () => postRules({ defaultPolicy: 'protect' }), '默认把全部拦住'),
              Toggle(!dflt, false, () => postRules({ defaultPolicy: 'allow' }), '默认全部放行，只拦住下面勾选的'),
            ),
            Hint('下面每个对象旁边的字就是它当前的处置：**拦住** = 子代理读不到它；**放行** = 子代理可以读。优先级：单个窗口 > 单个工作区 > 这里的默认。'),
          )),

          Section(`按工作区（${wsOn}/${workspaces.length} 个被拦住）`,
            workspaces.length === 0
              ? Hint('还没发现会话目录（%DSH_HOME%\\sessions 为空）。')
              : h('div', null, ...workspaces.map((w) => Row([
                h('input', {
                  key: 'c', type: 'checkbox', checked: Boolean(w.protected), disabled: busy,
                  onChange: (e) => postRules({ workspaces: { [w.key]: e.target.checked } }),
                }),
                Text(w.protected ? '拦住' : '放行', { key: 's', fontSize: '11.5px', width: '32px', flexShrink: 0, color: w.protected ? C.fg : C.muted }),
                h('div', { key: 't', style: { display: 'flex', flexDirection: 'column', minWidth: 0 } },
                  Text(w.label || w.key, { fontSize: '12.5px' }),
                  Hint(`${w.sessions} 个窗口 · 最近 ${fmtTime(w.latest)}`),
                ),
              ], w.key))),
            Btn(wsAll ? '全清空' : '全开', toggleAllWs, workspaces.length === 0),
          ),

          Section(`按窗口（${winOn}/${windows.length} 个被拦住）`,
            windows.length === 0
              ? Hint('还没发现窗口。')
              : h('div', null, ...windows.map((w) => Row([
                h('input', {
                  key: 'c', type: 'checkbox', checked: Boolean(w.protected), disabled: busy,
                  onChange: (e) => postRules({ windows: { [w.id]: e.target.checked } }),
                }),
                Text(w.protected ? '拦住' : '放行', { key: 's', fontSize: '11.5px', width: '32px', flexShrink: 0, color: w.protected ? C.fg : C.muted }),
                h('div', { key: 't', style: { display: 'flex', flexDirection: 'column', minWidth: 0 } },
                  Text(w.id, { fontSize: '12.5px' }),
                  Hint(`${w.label || w.workspace} · ${fmtTime(w.latest)}`),
                ),
              ], w.id))),
            Btn(winAll ? '全清空' : '全开', toggleAllWin, windows.length === 0),
          ),

          Section('臂间隔离（自定义拦住目录）',
            h('div', null,
              Hint('把某个目录挂进来，它就只对「归属窗口」开放 —— 其它窗口与其子代理一律拦。'
                + '跑对照实验时用它把各臂的产物隔开：臂A 写自己的目录、但读不到臂B 的。'),
              h('div', { style: { height: '8px' } }),
              pPaths.length === 0
                ? Hint('还没配置。')
                : h('div', null, ...pPaths.map((e, i) => h('div', {
                  key: 'pp' + i,
                  style: { display: 'flex', gap: '8px', alignItems: 'center', padding: '4px 0', flexWrap: 'wrap' },
                },
                  h('input', {
                    type: 'text', value: e.path || '', disabled: busy,
                    placeholder: '要拦住的目录，例如 C:\\lab\\armB',
                    style: { flex: '2 1 260px', minWidth: '200px', padding: '4px 6px', fontSize: '12px' },
                    onChange: (ev) => setPathDraft(pPaths.map((x, k) => (k === i ? { ...x, path: ev.target.value } : x))),
                  }),
                  h('input', {
                    type: 'text', value: e.owner || '', disabled: busy,
                    placeholder: '归属窗口 id（留空 = 对所有人拦住）',
                    style: { flex: '2 1 240px', minWidth: '180px', padding: '4px 6px', fontSize: '12px' },
                    onChange: (ev) => setPathDraft(pPaths.map((x, k) => (k === i ? { ...x, owner: ev.target.value } : x))),
                  }),
                  h('input', {
                    type: 'text', value: e.label || '', disabled: busy,
                    placeholder: '归属标签（派子代理时填的 description，例如 臂A）',
                    style: { flex: '2 1 240px', minWidth: '180px', padding: '4px 6px', fontSize: '12px' },
                    onChange: (ev) => setPathDraft(pPaths.map((x, k) => (k === i ? { ...x, label: ev.target.value } : x))),
                  }),
                  Btn('保存', () => { setPathDraft(null); postRules({ protectedPaths: pPaths }) }, busy),
                  Btn('删除', () => { setPathDraft(null); postRules({ protectedPaths: pPaths.filter((_, k) => k !== i) }) }, busy),
                ))),
              h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', paddingTop: '8px', flexWrap: 'wrap' } },
                Btn('添加一条', () => setPathDraft([...pPaths, { path: '', owner: '', label: '' }]), busy),
                Hint('三种归属任选一种：窗口 id = 一臂一窗口；'
                  + '标签 = 一个窗口开多个子代理时区分它们（填派子代理时的 description）；'
                  + '两个都留空 = 对所有人拦住。'),
              ),
            )),

          Section('逐项保护', h('div', { style: { display: 'flex', gap: '22px', flexWrap: 'wrap' } },
            Toggle(cfg.protectSessions, dis, (x) => writeCfg('protectSessions', x, snap.revision), '会话落盘记录'),
            Toggle(cfg.protectProjcache, dis, (x) => writeCfg('protectProjcache', x, snap.revision), '投影缓存'),
            Toggle(cfg.protectCredentials, dis, (x) => writeCfg('protectCredentials', x, snap.revision), '宿主凭据文件'),
          )),

          // ★ 自动臂间隔离：子代理写出的文件自动归它，别的子代理读不了。
          //   这是"随手建个文件夹、开个窗口、派两个子代理就跑对照实验"的那个开关。
          Section('谁写的谁拥有（自动臂间隔离）',
            h('div', null,
              Toggle(cfg.autoOwnWrites, dis, (x) => writeCfg('autoOwnWrites', x, snap.revision),
                '子代理写出的文件自动归它，别的子代理读不了'),
              h('div', { style: { fontSize: '12px', color: C.muted, lineHeight: 1.7, paddingTop: '6px' } },
                '子代理新建/改动的文件会登记到它名下；另一个子代理去读、去列目录时会被拦住并记账。'
                + '它自己读写照常；你这个窗口照常（审计通道）。',
              ),
              own && own.total > 0
                ? h('div', { style: { fontSize: '12px', color: C.muted, paddingTop: '6px' } },
                  `当前已登记 ${own.total} 个产物` + (own.shared && own.shared.length ? `，手动放行 ${own.shared.length} 条` : ''))
                : null,
              h('div', { style: { fontSize: '12px', color: C.muted, lineHeight: 1.7, paddingTop: '6px' } },
                '⚠️ 它拦住的是"工具管线里的写入"（write / edit）—— 子代理用命令写出来的文件登记不到。'
                + '另外：你这个窗口写的文件不登记（任务书就是它写的），所以**答案键仍要自己放对地方**。',
              ),
              h('div', { style: { fontSize: '12px', color: C.muted, lineHeight: 1.7, paddingTop: '6px' } },
                '要临时放行某个文件/目录：在窗口里敲 /shield 放行 <路径>（收回用 /shield 收回 <路径>）。'
                + '整个窗口都不要管：在下面「按窗口」里把该窗口设成「放行」。',
              ),
              h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', paddingTop: '8px', flexWrap: 'wrap' } },
                Text('复核者豁免（标签含任一关键词即不受本项管辖）：', { fontSize: '12px' }),
                h('input', {
                  type: 'text', disabled: dis,
                  value: cfg.ownerExemptLabels === undefined ? '' : cfg.ownerExemptLabels,
                  placeholder: '复核,审计,评审,独立,复算,对抗,验证,verify,review,audit,recompute,adversarial',
                  style: { flex: '1 1 420px', minWidth: '260px', padding: '4px 6px', fontSize: '12px' },
                  onChange: (ev) => writeCfg('ownerExemptLabels', ev.target.value, snap.revision),
                }),
              ),
              h('div', { style: { fontSize: '12px', color: C.muted, paddingTop: '6px' } },
                '⚠️ 只豁免本项：复核者仍然读不到 %DSH_HOME%（会话记录/缓存/凭据照旧拦）。',
              ),
            )),
          Section('事后账本', h('div', null,
            Toggle(cfg.auditEnabled, dis, (x) => writeCfg('auditEnabled', x, snap.revision), '记录每次拒绝'),
            h('div', { style: { fontSize: '12px', color: C.muted, paddingTop: '6px', wordBreak: 'break-all' } },
              cfgBrk.auditFile || cfg.auditFile || '（默认 <DSH_HOME>\\subagent-shield-audit.jsonl）'),
          )),

          Section(`统计与最近拒绝（共 ${denied.total} 次 · 涉及 ${denied.windows} 个窗口）`,
            recent.length === 0
              ? Hint('还没有拒绝记录。')
              : h('div', null, ...recent.slice().reverse().map((r, i) => Row([
                Text(String(r.tool || '?'), { fontSize: '12.5px', width: '70px', flexShrink: 0 }),
                Text(String(r.kind || ''), { fontSize: '12px', color: C.muted, width: '90px', flexShrink: 0 }),
                Text(String(r.target || '').slice(0, 90), { fontSize: '12px', color: C.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }),
              ], 'r' + i))),
          ),

          Section('状态小窗', h('div', { style: { display: 'flex', alignItems: 'center', gap: '12px' } },
            Btn(widgetOn ? '关闭状态小窗' : '打开状态小窗', toggleWidget),
            Hint('页面上一个可拖动、可收起的小浮窗；改完刷新页面生效。'),
          )),
        )
      }

      // 注册为独立设置分区（皮肤市场同款）
      const register = () => ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: NS,
        order: 50,
        label: () => '信息隔断',
        locale: NS,
        inject: () => ({}),
      }, ShieldSection))

      try { ctx.effect(() => ctx.locale.register(NS, { zh: { nav: '信息隔断' }, en: { nav: 'Subagent Shield' } })) } catch { }
      ctx.effect(register)
    }

    exports.name = NS
    // ★ 三个服务名都在真实包里出现过（locale / configForms 均有真实提供者）
    exports.inject = ['slots', 'locale', 'configForms']
    exports.apply = apply
    // 给离线单测用的纯逻辑（不参与运行时契约）
    exports.__helpers = { allChecked, selectAllPatch, bannerFor }
    return module.exports
  },
})
