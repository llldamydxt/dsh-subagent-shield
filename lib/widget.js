/**
 * dsh-subagent-shield —— 浮动状态小窗（被注入到 GUI 页面里的经典脚本）
 *
 * 它不是客户端模块系统的一部分：由宿主半区通过 webServer.tapIndex / webserver/index-inject
 * 以 <script defer src="/dsh-subagent-shield/widget.js"> 的形式插进页面，所以这里是
 * **纯 DOM + CSS，不依赖 React、不需要构建**（与 dsh-typing-guard / dsh-whale-widget 同一套做法）。
 *
 * 行为：
 *   · 可拖动（按住标题栏）
 *   · 可收起（标题栏 −：只留标题栏）
 *   · 可关闭（标题栏 ✕：缩成一个圆点，点圆点恢复）
 *   · 位置 / 收起 / 开关状态记在 localStorage，刷新后保持
 *   · 每 3 秒拉一次 /dsh-subagent-shield/status（同源，走 GUI 的 cookie）
 *
 * 任何异常都只 console.warn，绝不打扰页面。
 */
(() => {
  'use strict'
  try {
    const NS = 'dsh-subagent-shield'
    const K_ON = NS + ':widget'
    const K_POS = NS + ':widget:pos'
    const K_MIN = NS + ':widget:min'
    const K_ACK = NS + ':widget:ack'
    const API = '/' + NS + '/status'

    const ls = {
      get(k, d) { try { const v = window.localStorage.getItem(k); return v === null ? d : v } catch { return d } },
      set(k, v) { try { window.localStorage.setItem(k, v) } catch { } },
    }

    // 记住上次的开合状态，但**绝不能因为它是 off 就整体不挂载**：
    // 那样点一次 ✕ 之后就永久消失，连角落那个 🛡 圆点都不出现 —— 这就是 v3 的 bug。
    // 正确做法：面板可见性跟随状态，圆点始终有机会出现（点它即可恢复）。
    const wantOpen = ls.get(K_ON, 'on') !== 'off'
    if (document.getElementById(NS + '-widget')) return

    const C = {
      bg: 'var(--dsw-alias-bg-layer-3, #1f2329)',
      fg: 'var(--dsw-alias-label-primary, #e6e6e6)',
      muted: 'var(--dsw-alias-label-tertiary, #8a8f98)',
      border: 'var(--dsw-alias-border-l4, rgba(255,255,255,.16))',
      err: 'var(--dsw-alias-label-error, #ff6b6b)',
    }

    const el = (tag, style, text) => {
      const n = document.createElement(tag)
      if (style) Object.assign(n.style, style)
      if (text !== undefined) n.textContent = text
      return n
    }

    // ── 外壳 ────────────────────────────────────────────────────────────
    const root = el('div', {
      position: 'fixed', zIndex: '2147483000', width: '320px',
      background: C.bg, color: C.fg, border: '0.5px solid ' + C.border,
      borderRadius: '10px', boxShadow: '0 8px 28px rgba(0,0,0,.35)',
      font: '12px/1.55 ui-sans-serif, system-ui, "Segoe UI", sans-serif',
      userSelect: 'none', overflow: 'hidden', display: 'none',
    })
    root.id = NS + '-widget'

    let pos = { left: 0, top: 0 }
    try { const p = JSON.parse(ls.get(K_POS, '')); if (p && Number.isFinite(p.left) && Number.isFinite(p.top)) pos = p } catch { }
    if (!pos.left && !pos.top) { pos.left = Math.max(8, window.innerWidth - 336); pos.top = 80 }

    const header = el('div', {
      display: 'flex', alignItems: 'center', gap: '6px', padding: '7px 10px',
      cursor: 'move', borderBottom: '0.5px solid ' + C.border, fontWeight: '600',
    })
    header.appendChild(el('span', {}, '🛡 信息隔断'))
    // 收起时在标题行里显示一个紧凑状态。
    // 为什么必须有：原来收起后整个面板只剩标题 + "− / ✕" 两个符号，看着就是**一条空的怪横条**，
    // 使用者会以为它坏了（实测反馈："是不是不显示啊"）。现在收起也看得见关键状态。
    const headerInfo = el('span', { color: C.muted, fontWeight: '400', fontSize: '12px', marginLeft: '4px' }, '')
    header.appendChild(headerInfo)
    header.appendChild(el('span', { flex: '1' }))
    const btnMin = el('span', { cursor: 'pointer', padding: '0 6px', color: C.muted }, '⌃')
    const btnClose = el('span', { cursor: 'pointer', padding: '0 6px', color: C.muted }, '✕')
    btnMin.title = '收起'
    btnClose.title = '关闭（变成角落的 🛡 圆点，点它可恢复）'
    header.appendChild(btnMin); header.appendChild(btnClose)

    const body = el('div', { padding: '9px 10px', display: 'flex', flexDirection: 'column', gap: '7px' })
    const lineState = el('div', {})
    // ★★ 紧急告警框（红字）：有子代理试图绕过隔断 / 有人改了配置时出现
    const alertBox = el('div', {
      display: 'none', padding: '6px 8px', borderRadius: '6px',
      border: '1px solid ' + C.err, color: C.err, fontWeight: '600',
      background: 'rgba(220,38,38,.12)', whiteSpace: 'pre-wrap', fontSize: '12px',
    })
    const alertAck = el('span', {
      display: 'inline-block', marginTop: '4px', fontWeight: '400',
      textDecoration: 'underline', cursor: 'pointer', color: C.err,
    }, '知道了')
    const lineCount = el('div', { color: C.muted })
    const listBox = el('div', {
      display: 'flex', flexDirection: 'column', gap: '3px',
      maxHeight: '126px', overflow: 'auto', borderTop: '0.5px solid ' + C.border, paddingTop: '6px',
    })
    const foot = el('div', { display: 'flex', gap: '8px', borderTop: '0.5px solid ' + C.border, paddingTop: '7px' })
    const btnRefresh = el('span', {
      cursor: 'pointer', color: C.muted, textDecoration: 'underline',
    }, '刷新')
    const hint = el('span', { color: C.muted, flex: '1' }, '拖动标题栏可移动')
    foot.appendChild(btnRefresh); foot.appendChild(hint)

    body.appendChild(alertBox); body.appendChild(lineState); body.appendChild(lineCount); body.appendChild(listBox); body.appendChild(foot)
    root.appendChild(header); root.appendChild(body)

    // 关闭后残留的小圆点
    const dot = el('div', {
      position: 'fixed', zIndex: '2147483000', width: '30px', height: '30px', borderRadius: '50%',
      background: C.bg, color: C.fg, border: '0.5px solid ' + C.border,
      boxShadow: '0 6px 18px rgba(0,0,0,.35)', display: 'none',
      alignItems: 'center', justifyContent: 'center', cursor: 'pointer', fontSize: '14px',
    }, '🛡')

    const applyPos = () => {
      const w = root.offsetWidth || 320
      const h = root.offsetHeight || 120
      pos.left = Math.min(Math.max(0, pos.left), Math.max(0, window.innerWidth - w))
      pos.top = Math.min(Math.max(0, pos.top), Math.max(0, window.innerHeight - h))
      root.style.left = pos.left + 'px'
      root.style.top = pos.top + 'px'
      dot.style.left = Math.min(Math.max(0, pos.left), Math.max(0, window.innerWidth - 30)) + 'px'
      dot.style.top = Math.min(Math.max(0, pos.top), Math.max(0, window.innerHeight - 30)) + 'px'
    }

    const savePos = () => ls.set(K_POS, JSON.stringify({ left: Math.round(pos.left), top: Math.round(pos.top) }))
    let isMin = false
    const setMin = (on) => {
      isMin = Boolean(on)
      body.style.display = on ? 'none' : 'flex'
      // 箭头用**雪佛龙**（手风琴那种）：收起 → ⌄（下，点了往下展开），展开 → ⌃（上，点了收起）
      btnMin.textContent = on ? '⌄' : '⌃'
      btnMin.title = on ? '展开' : '收起'
      headerInfo.style.display = on ? '' : 'none'
      ls.set(K_MIN, on ? '1' : '0')
      requestAnimationFrame(applyPos)
    }
    const setOpen = (on) => {
      root.style.display = on ? 'block' : 'none'
      dot.style.display = on ? 'none' : 'flex'
      ls.set(K_ON, on ? 'on' : 'off')
      if (on) { applyPos(); void refresh() } else { stopPoll() }
    }

    // ── 拖动 ────────────────────────────────────────────────────────────
    let drag = null
    let dragMoved = false
    header.addEventListener('pointerdown', (e) => {
      if (e.target === btnMin || e.target === btnClose) return
      drag = { x: e.clientX - pos.left, y: e.clientY - pos.top }
      dragMoved = false
      header.setPointerCapture?.(e.pointerId)
      e.preventDefault()
    })
    header.addEventListener('pointermove', (e) => {
      if (!drag) return
      if (Math.abs(e.clientX - (drag.x + pos.left)) > 3 || Math.abs(e.clientY - (drag.y + pos.top)) > 3) dragMoved = true
      pos.left = e.clientX - drag.x
      pos.top = e.clientY - drag.y
      applyPos()
    })
    const endDrag = () => { if (drag) { drag = null; savePos() } }
    header.addEventListener('pointerup', endDrag)
    header.addEventListener('pointercancel', endDrag)
    // 点标题栏（不是拖动）也能展开/收起 —— 收起后只有一个小箭头，光靠它不好发现
    header.addEventListener('click', (e) => {
      if (e.target === btnMin || e.target === btnClose) return
      if (dragMoved) { dragMoved = false; return }
      setMin(!isMin)
    })

    btnMin.addEventListener('click', () => setMin(body.style.display !== 'none'))
    btnClose.addEventListener('click', () => setOpen(false))
    dot.addEventListener('click', () => setOpen(true))
    btnRefresh.addEventListener('click', () => void refresh())
    // ★「知道了」只记本地：新的告警时间更晚 → 会再红
    alertAck.addEventListener('click', () => {
      const A = (lastData && lastData.alert) || {}
      const ts1 = (A.bypass && A.bypass.last && A.bypass.last.ts) || ''
      const ts2 = (A.config && A.config.last && A.config.last.ts) || ''
      ls.set(K_ACK, ts1 > ts2 ? ts1 : ts2)
      void refresh()
    })
    window.addEventListener('resize', applyPos)

    // ── 数据 ────────────────────────────────────────────────────────────
    let timer = null
    /**
     * 时间戳必须按**本地时区**渲染。
     * 踩过：原来直接 `String(iso).slice(11,19)`，取的是 ISO 串里的 UTC 部分，
     * 而账本写的是 `...Z` —— 于是 UTC+8 的用户看到的时间**少 8 小时**
     * （21:46 发生的拒绝显示成 13:46），看起来像"昨天的旧数据跑到现在来了"。
     */
    let alertActive = false
    let lastData = null
    const fmtTime = (iso) => {
      const d = new Date(iso)
      if (Number.isNaN(d.getTime())) return ''
      const p = (n) => String(n).padStart(2, '0')
      return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
    }
    const KIND = { sessions: '会话', projcache: '投影', credentials: '凭据', shell: '命令文本', audit: '账本', state: '状态文件' }

    function render(data) {
      lastData = data
      // ★★ 先算告警：两类事件取「最近发生的那一条」，跟本地已读时间比
      try {
        const A = data.alert || {}
        const cands = []
        if (A.bypass && A.bypass.count > 0 && A.bypass.last && A.bypass.last.ts) cands.push(['bypass', A.bypass])
        if (A.config && A.config.count > 0 && A.config.last && A.config.last.ts) cands.push(['config', A.config])
        cands.sort((x, y) => String(y[1].last.ts).localeCompare(String(x[1].last.ts)))
        const top = cands[0]
        const acked = String(ls.get(K_ACK, ''))
        alertActive = Boolean(top) && String(top[1].last.ts) > acked
        if (alertActive) {
          const [k, v] = top
          const head = k === 'bypass' ? '⚠ 有子代理试图绕过隔断' : '⚠ 本插件配置被改动'
          alertBox.textContent = ''
          alertBox.appendChild(el('div', {}, head + '（共 ' + v.count + ' 次）'))
          alertBox.appendChild(el('div', { fontWeight: '400' }, fmtTime(v.last.ts) + '  ' + (v.last.why || '')))
          alertBox.appendChild(alertAck)
          alertBox.style.display = 'block'
        } else {
          alertBox.style.display = 'none'
        }
        // 标题栏与圆点也红（收起 / 缩成圆点时同样看得见）
        header.style.background = alertActive ? 'rgba(220,38,38,.22)' : ''
        dot.textContent = alertActive ? '⚠' : '🛡'
        dot.style.color = alertActive ? C.err : C.fg
        dot.style.borderColor = alertActive ? C.err : C.border
      } catch { }
      const c = data.config || {}
      lineState.textContent = `总开关 ${c.enabled ? '开' : '关'} · 范围 ${c.scope} · 模式 ${c.mode}`
      lineState.style.color = c.enabled ? C.fg : C.err
      const n = data.denied || { total: 0, windows: 0, historyTotal: 0, historyWindows: 0, source: 'none' }
      const now = n.total || 0
      const hist = n.historyTotal || 0
      /**
       * 文案必须把"本次会话"与"账本历史"分开。
       * 踩过：原来把账本的累计行数当成"已拒绝 N 次"直接显示，于是**每次重启都带着
       * 41 次的旧计数回来**，还配了一句"（账本未启用）"—— 有数据却说账本没开，自相矛盾。
       */
      const parts = []
      // 计数行**不要**说"还没有拒绝记录" —— 那是下面列表占位的话。
      // 踩过：两边都说同一句，展开后看到重复两行。
      parts.push(now > 0 ? `本次拒绝 ${now} 次` : '本次 0 次')
      const winCount = now > 0 ? (n.windows || 0) : (n.historyWindows || 0)
      if (now > 0 || hist > 0) parts.push(`涉及 ${winCount} 个窗口`)
      if (hist > 0) parts.push(`账本历史 ${hist} 次`)
      if (n.auditEnabled === false && hist > 0) parts.push('账本已停止写入')
      lineCount.textContent = parts.join(' · ')
      // 收起的标题栏也要看得见关键状态（否则就是一条空横条）
      headerInfo.textContent = alertActive
        ? '⚠ 试图绕过'
        : (c.enabled ? (now > 0 ? `开 · 本次 ${now} 次` : `开 · 本次 0 次`) : '已关闭')
      headerInfo.style.color = alertActive ? C.err : (c.enabled ? C.muted : C.err)
      if (isMin) headerInfo.style.display = ''
      else headerInfo.style.display = 'none'

      while (listBox.firstChild) listBox.removeChild(listBox.firstChild)
      const recent = (data.recent || []).slice(-5).reverse()
      // 明细来自账本历史时明确标注，别让人以为是刚发生的
      if (recent.length > 0 && now === 0 && hist > 0) {
        listBox.appendChild(el('div', { color: C.muted, style: { marginBottom: '2px' } }, '以下为账本历史记录：'))
      }
      if (recent.length === 0) {
        listBox.appendChild(el('div', { color: C.muted }, '还没有拒绝记录'))
      } else {
        for (const r of recent) {
          listBox.appendChild(el('div', { style: { display: 'flex', gap: '6px', color: C.muted } },
            `${fmtTime(r.ts)} ${String(r.tool || '')} ${KIND[r.kind] || r.kind || ''} ${String(r.window || '').slice(-8)}`))
        }
      }
      requestAnimationFrame(applyPos)
    }

    async function refresh() {
      try {
        const res = await fetch(API, { credentials: 'same-origin', cache: 'no-store' })
        if (!res.ok) throw new Error('HTTP ' + res.status)
        render(await res.json())
      } catch (e) {
        lineState.textContent = '读取状态失败（DSH 可能已重启）'
        lineState.style.color = C.err
      }
    }
    function stopPoll() { if (timer) { clearInterval(timer); timer = null } }
    function startPoll() { stopPoll(); timer = setInterval(() => { if (document.visibilityState !== 'hidden') void refresh() }, 3000) }

    // ── 挂载 ────────────────────────────────────────────────────────────
    // body 还没就绪时**必须重试**，不能直接放弃（defer 脚本偶尔早于 body 完成）。
    let mountTries = 0
    const mount = () => {
      if (!document.body) {
        if (mountTries++ < 75) setTimeout(mount, 200)   // 最多等 15 秒
        return
      }
      if (!document.getElementById(NS + '-widget')) { document.body.appendChild(root); document.body.appendChild(dot) }
      applyPos()
      setMin(ls.get(K_MIN, '0') === '1')
      // 面板初始可见性跟随上次状态；圆点始终按「面板隐藏时显示」的规则走
      root.style.display = wantOpen ? 'block' : 'none'
      dot.style.display = wantOpen ? 'none' : 'flex'
      if (wantOpen) { void refresh(); startPoll() }
      else { lineState.textContent = '已关闭（点角落的 🛡 可重新打开）' }
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount)
    else mount()
  } catch (e) {
    try { console.warn('[dsh-subagent-shield] widget 初始化失败：', e) } catch { }
  }
})()
