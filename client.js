window.__ModuleLoader__.load({
  id: 'dsh-memory-nebula-bridge',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const API = 'http://127.0.0.1:6183'
    const NS = 'memory-nebula'

    const DICT = {
      zh: {
        open: '记忆星云',
        openHint: '打开记忆星云：浏览、检索与修订记忆',
        starting: '记忆星云正在启动…',
        failed: '记忆星云没起来',
        unconfigured: '没找到记忆星云项目目录',
        retry: '重试',
        close: '关闭',
        detail: '数据目录',
        search: '搜索记忆正文…',
        loading: '读取记忆…',
        empty: '没有匹配的记忆。',
        total: '条记忆',
        fullGraph: '打开完整星云',
        pick: '从左边选一条记忆。',
        importance: '重要度',
        pinned: '永久',
        faded: '已遗忘',
        active: '生效中',
        opImportant: '提高重要度',
        opLess: '降低重要度',
        opPin: '设为永久',
        opUnpin: '取消永久',
        opForget: '忘掉',
        opRestore: '恢复',
        opEdit: '编辑正文',
        save: '保存',
        cancel: '取消',
        saved: '已保存，图已重建',
      },
      en: {
        open: 'Memory Nebula',
        openHint: 'Open Memory Nebula: browse, search and curate memories',
        starting: 'Memory Nebula is starting…',
        failed: 'Memory Nebula did not start',
        unconfigured: 'Memory Nebula project directory not found',
        retry: 'Retry',
        close: 'Close',
        detail: 'Data directory',
        search: 'Search memory text…',
        loading: 'Loading memories…',
        empty: 'No matching memories.',
        total: 'memories',
        fullGraph: 'Open full nebula',
        pick: 'Pick a memory on the left.',
        importance: 'Importance',
        pinned: 'Pinned',
        faded: 'Faded',
        active: 'Active',
        opImportant: 'Raise importance',
        opLess: 'Lower importance',
        opPin: 'Pin',
        opUnpin: 'Unpin',
        opForget: 'Forget',
        opRestore: 'Restore',
        opEdit: 'Edit text',
        save: 'Save',
        cancel: 'Cancel',
        saved: 'Saved and rebuilt',
      },
    }

    const COLORS = {
      border: 'var(--dsw-alias-border-l2)',
      layer1: 'var(--dsw-alias-bg-layer-1)',
      layer2: 'var(--dsw-alias-bg-layer-2)',
      text: 'var(--dsw-alias-label-primary)',
      sub: 'var(--dsw-alias-label-secondary)',
      faint: 'var(--dsw-alias-label-tertiary)',
    }

    function Icon() {
      return h(
        'svg',
        { width: 18, height: 18, viewBox: '0 0 24 24', 'aria-hidden': true, focusable: 'false' },
        h('circle', { cx: 12, cy: 12, r: 2.2, fill: 'currentColor' }),
        h('ellipse', {
          cx: 12, cy: 12, rx: 9.4, ry: 4.1,
          fill: 'none', stroke: 'currentColor', strokeWidth: 1.3, opacity: 0.75,
          transform: 'rotate(-24 12 12)',
        }),
        h('ellipse', {
          cx: 12, cy: 12, rx: 9.4, ry: 4.1,
          fill: 'none', stroke: 'currentColor', strokeWidth: 1.1, opacity: 0.45,
          transform: 'rotate(38 12 12)',
        }),
        h('circle', { cx: 20.1, cy: 8.4, r: 1.25, fill: 'currentColor', opacity: 0.9 }),
        h('circle', { cx: 6.2, cy: 16.4, r: 0.95, fill: 'currentColor', opacity: 0.7 }),
      )
    }

    function buttonStyle(primary) {
      return {
        padding: '4px 10px',
        borderRadius: 8,
        border: '1px solid ' + COLORS.border,
        background: primary ? COLORS.layer2 : 'transparent',
        color: primary ? COLORS.text : COLORS.sub,
        fontSize: 12,
        lineHeight: '18px',
        cursor: 'pointer',
      }
    }

    async function fetchState() {
      const res = await fetch(API + '/state', { cache: 'no-store' })
      if (!res.ok) throw new Error('bad status ' + res.status)
      return res.json()
    }

    const short = (text, n) => {
      const flat = String(text || '').replace(/\s+/g, ' ').trim()
      return flat.length > n ? flat.slice(0, n) + '…' : flat
    }

    // 星云本身没起来时的说明面板（保留原有行为）
    function StatusPanel(props) {
      const { state, t, onRetry, onClose, busy } = props
      const unconfigured = state?.phase === 'unconfigured'
      const message = state?.error || (state?.phase === 'starting' ? t('starting') : t('failed'))
      return h(
        'div',
        {
          role: 'dialog',
          'aria-modal': 'true',
          onKeyDown: (event) => { if (event.key === 'Escape') onClose() },
          style: {
            position: 'fixed', right: 16, bottom: 64, zIndex: 60, width: 300,
            padding: '14px 16px', borderRadius: 12,
            border: '1px solid ' + COLORS.border, background: COLORS.layer1,
            color: COLORS.text, boxShadow: '0 12px 32px rgba(0,0,0,0.28)',
            fontSize: 13, lineHeight: 1.55,
          },
        },
        h('div', { style: { fontWeight: 600, marginBottom: 6 } }, unconfigured ? t('unconfigured') : t('failed')),
        h('div', { style: { color: COLORS.sub, wordBreak: 'break-word' } }, message),
        state?.dataDir
          ? h('div', { style: { color: COLORS.faint, marginTop: 6, fontSize: 12, wordBreak: 'break-all' } }, t('detail') + '：' + state.dataDir)
          : null,
        h(
          'div',
          { style: { display: 'flex', gap: 8, marginTop: 12, justifyContent: 'flex-end' } },
          h('button', { type: 'button', onClick: onClose, style: buttonStyle(false) }, t('close')),
          h('button', { type: 'button', disabled: busy, onClick: onRetry, style: buttonStyle(true) }, t('retry')),
        ),
      )
    }

    // 页面内记忆面板：搜索 + 列表 + 详情 + 常用操作
    function MemoryPanel(props) {
      const { t, url, onClose } = props
      const [tick, setTick] = React.useState(0)
      const [loading, setLoading] = React.useState(true)
      const [error, setError] = React.useState('')
      const [nodes, setNodes] = React.useState([])
      const [query, setQuery] = React.useState('')
      const [selectedId, setSelectedId] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [saved, setSaved] = React.useState(false)
      const [draft, setDraft] = React.useState(null)

      React.useEffect(() => {
        let alive = true
        ;(async () => {
          try {
            const res = await fetch(API + '/graph', { cache: 'no-store' })
            const body = await res.json()
            if (!res.ok) throw new Error(body?.error || 'HTTP ' + res.status)
            const list = (Array.isArray(body?.nodes) ? body.nodes : []).filter((n) => n && n.type === 'memory')
            list.sort((a, b) => (Number(b.pinned || 0) - Number(a.pinned || 0)) || (Number(b.importance || 0) - Number(a.importance || 0)))
            if (!alive) return
            setNodes(list)
            setError('')
          } catch (err) {
            if (alive) setError(String(err?.message || err))
          } finally {
            if (alive) setLoading(false)
          }
        })()
        return () => { alive = false }
      }, [tick])

      const act = async (node, op, text) => {
        const parts = String(node.id || '').split(':')
        try {
          setBusy(true)
          setError('')
          setSaved(false)
          const payload = { store: parts[1], id: Number(parts[2]), op }
          if (text !== undefined) payload.text = text
          const res = await fetch(API + '/memory', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          })
          const body = await res.json()
          if (!res.ok || body?.ok === false) throw new Error(body?.error || 'HTTP ' + res.status)
          setSaved(true)
          setTick((n) => n + 1)
          return true
        } catch (err) {
          setError(String(err?.message || err))
          return false
        } finally {
          setBusy(false)
        }
      }

      const needle = query.trim().toLowerCase()
      const shown = needle
        ? nodes.filter((n) => String(n.text || n.label || '').toLowerCase().includes(needle))
        : nodes
      const selected = nodes.find((n) => n.id === selectedId) || null

      return h(
        'div',
        {
          style: {
            position: 'fixed', inset: 0, zIndex: 70,
            background: 'rgba(0,0,0,0.36)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          },
          onMouseDown: (event) => { if (event.target === event.currentTarget) onClose() },
        },
        h(
          'div',
          {
            role: 'dialog',
            'aria-modal': 'true',
            onKeyDown: (event) => { if (event.key === 'Escape') onClose() },
            style: {
              width: 620, maxWidth: 'calc(100vw - 48px)', height: '72vh', maxHeight: 640,
              display: 'flex', flexDirection: 'column',
              borderRadius: 14, border: '1px solid ' + COLORS.border,
              background: COLORS.layer1, color: COLORS.text,
              boxShadow: '0 24px 64px rgba(0,0,0,0.4)', overflow: 'hidden',
            },
          },
          h(
            'div',
            {
              style: {
                display: 'flex', alignItems: 'center', gap: 10,
                padding: '10px 14px', borderBottom: '1px solid ' + COLORS.border,
              },
            },
            h('span', { style: { display: 'flex', color: COLORS.sub } }, h(Icon, null)),
            h('span', { style: { fontWeight: 600, fontSize: 13 } }, t('open')),
            h('span', { style: { color: COLORS.faint, fontSize: 12 } }, nodes.length + ' ' + t('total')),
            h('span', { style: { flex: 1 } }),
            h(
              'a',
              {
                href: url,
                target: '_blank',
                rel: 'noopener',
                style: { color: COLORS.sub, fontSize: 12, textDecoration: 'none' },
              },
              t('fullGraph') + ' ↗',
            ),
            h('button', { type: 'button', onClick: onClose, style: buttonStyle(false) }, t('close')),
          ),
          h(
            'div',
            { style: { display: 'flex', gap: 8, padding: '8px 14px', borderBottom: '1px solid ' + COLORS.border } },
            h('input', {
              value: query,
              placeholder: t('search'),
              onChange: (event) => setQuery(event.target.value),
              style: {
                flex: 1, height: 30, padding: '0 10px', borderRadius: 8,
                border: '1px solid ' + COLORS.border, background: COLORS.layer2,
                color: COLORS.text, fontSize: 12, outline: 'none',
              },
            }),
          ),
          error
            ? h('div', { style: { padding: '6px 14px', fontSize: 12, color: '#e5484d' } }, error)
            : null,
          saved && !error
            ? h('div', { style: { padding: '6px 14px', fontSize: 12, color: COLORS.faint } }, t('saved'))
            : null,
          h(
            'div',
            { style: { flex: 1, display: 'flex', minHeight: 0 } },
            h(
              'div',
              { style: { width: '46%', borderRight: '1px solid ' + COLORS.border, overflowY: 'auto' } },
              loading
                ? h('div', { style: { padding: 14, fontSize: 12, color: COLORS.faint } }, t('loading'))
                : shown.length === 0
                  ? h('div', { style: { padding: 14, fontSize: 12, color: COLORS.faint } }, t('empty'))
                  : shown.map((node) =>
                      h(
                        'div',
                        {
                          key: node.id,
                          onClick: () => { setSelectedId(node.id); setDraft(null) },
                          style: {
                            padding: '8px 12px', cursor: 'pointer',
                            borderBottom: '1px solid ' + COLORS.border,
                            background: node.id === selectedId ? COLORS.layer2 : 'transparent',
                          },
                        },
                        h('div', { style: { fontSize: 12, lineHeight: 1.45 } }, short(node.text || node.label, 90)),
                        h(
                          'div',
                          { style: { marginTop: 3, fontSize: 11, color: COLORS.faint, display: 'flex', gap: 8 } },
                          h('span', null, (node.pinned ? '📌 ' : '') + node.status),
                          h('span', null, Math.round(Number(node.importance || 0) * 100) + '%'),
                        ),
                      ),
                    ),
            ),
            h(
              'div',
              { style: { flex: 1, padding: '12px 14px', overflowY: 'auto' } },
              selected
                ? h(
                    'div',
                    null,
                    draft === null
                      ? h('div', { style: { fontSize: 13, lineHeight: 1.6, whiteSpace: 'pre-wrap' } }, selected.text || selected.label || '')
                      : h('textarea', {
                          value: draft,
                          onChange: (event) => setDraft(event.target.value),
                          style: {
                            width: '100%', boxSizing: 'border-box', minHeight: 140, resize: 'vertical',
                            padding: '8px 10px', borderRadius: 8, fontSize: 13, lineHeight: 1.6,
                            border: '1px solid ' + COLORS.border, background: COLORS.layer2,
                            color: COLORS.text, outline: 'none',
                          },
                        }),
                    h(
                      'div',
                      { style: { marginTop: 10, fontSize: 11, color: COLORS.faint } },
                      t('importance') + ' ' + Math.round(Number(selected.importance || 0) * 100) + '% · ' +
                        (selected.pinned ? t('pinned') : '') + (selected.status === 'faded' ? ' ' + t('faded') : ' ' + t('active')),
                    ),
                    draft === null
                      ? h(
                          'div',
                          { style: { display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 12 } },
                          h('button', { type: 'button', disabled: busy, onClick: () => act(selected, 'important'), style: buttonStyle(false) }, t('opImportant')),
                          h('button', { type: 'button', disabled: busy, onClick: () => act(selected, 'less'), style: buttonStyle(false) }, t('opLess')),
                          h('button', { type: 'button', disabled: busy, onClick: () => act(selected, selected.pinned ? 'unpin' : 'pin'), style: buttonStyle(false) }, selected.pinned ? t('opUnpin') : t('opPin')),
                          h('button', { type: 'button', disabled: busy, onClick: () => act(selected, selected.status === 'faded' ? 'restore' : 'forget'), style: buttonStyle(false) }, selected.status === 'faded' ? t('opRestore') : t('opForget')),
                          h('button', { type: 'button', disabled: busy, onClick: () => setDraft(String(selected.text || selected.label || '')), style: buttonStyle(true) }, t('opEdit')),
                        )
                      : h(
                          'div',
                          { style: { display: 'flex', gap: 6, marginTop: 12, justifyContent: 'flex-end' } },
                          h('button', { type: 'button', disabled: busy, onClick: () => setDraft(null), style: buttonStyle(false) }, t('cancel')),
                          h(
                            'button',
                            {
                              type: 'button',
                              disabled: busy,
                              onClick: async () => {
                                if (await act(selected, 'edit', draft)) setDraft(null)
                              },
                              style: buttonStyle(true),
                            },
                            t('save'),
                          ),
                        ),
                  )
                : h('div', { style: { fontSize: 12, color: COLORS.faint } }, t('pick')),
            ),
          ),
        ),
      )
    }

    function FooterAction(props) {
      const { wide, t } = props
      const [state, setState] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [showStatus, setShowStatus] = React.useState(false)
      const [showMemory, setShowMemory] = React.useState(false)

      const open = async () => {
        try {
          setBusy(true)
          const next = await fetchState()
          setState(next)
          if (next.phase === 'running' && next.url) {
            // 新宿主带 /graph 能力 → 页面内面板；旧宿主 → 退化成新标签页
            if (next.capabilities && next.capabilities.graph) {
              setShowMemory(true)
              setShowStatus(false)
            } else {
              window.open(next.url, '_blank', 'noopener')
              setShowMemory(false)
              setShowStatus(false)
            }
            return
          }
          setShowStatus(true)
        } catch (error) {
          setState({ phase: 'failed', error: '连不上记忆星云插件：' + String(error?.message || error) })
          setShowStatus(true)
        } finally {
          setBusy(false)
        }
      }

      const retry = async () => {
        try {
          setBusy(true)
          await fetch(API + '/restart', { method: 'POST' })
          const next = await fetchState()
          setState(next)
          if (next.phase === 'running' && next.url) {
            setShowStatus(false)
            if (next.capabilities && next.capabilities.graph) setShowMemory(true)
            else window.open(next.url, '_blank', 'noopener')
          }
        } catch (error) {
          setState({ phase: 'failed', error: String(error?.message || error) })
        } finally {
          setBusy(false)
        }
      }

      return h(
        'div',
        { style: { display: 'contents' } },
        showStatus
          ? h(StatusPanel, { state, t, busy, onRetry: retry, onClose: () => setShowStatus(false) })
          : null,
        showMemory && state?.url
          ? h(MemoryPanel, { t, url: state.url, onClose: () => setShowMemory(false) })
          : null,
        h(
          'button',
          {
            type: 'button',
            onClick: open,
            title: t('openHint'),
            'aria-label': t('open'),
            disabled: busy,
            style: {
              display: 'flex', alignItems: 'center', gap: 8,
              width: wide ? 'auto' : 32, height: 32,
              padding: wide ? '0 10px' : 0,
              justifyContent: wide ? 'flex-start' : 'center',
              borderRadius: 8, border: '1px solid transparent', background: 'transparent',
              color: COLORS.sub, fontSize: 13,
              cursor: busy ? 'progress' : 'pointer', opacity: busy ? 0.6 : 1,
            },
            onMouseEnter: (event) => {
              event.currentTarget.style.background = COLORS.layer2
            },
            onMouseLeave: (event) => {
              event.currentTarget.style.background = 'transparent'
            },
          },
          h(Icon, null),
          wide ? h('span', null, t('open')) : null,
        ),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        let t = (key) => DICT.zh[key] || key
        try {
          if (ctx.locale) {
            ctx.effect(() => ctx.locale.register(NS, 'zh', DICT.zh))
            ctx.effect(() => ctx.locale.register(NS, 'en', DICT.en))
            const bound = ctx.locale.bind(NS)
            t = (key) => bound(key) || DICT.zh[key] || key
          }
        } catch {
          t = (key) => DICT.zh[key] || key
        }

        ctx.slots.inject('sidebar.footer.action', () =>
          ctx.slots.register(
            { name: 'sidebar.footer.action', id: 'memory-nebula', order: 20, label: () => t('open') },
            (props) => h(FooterAction, { ...props, t }),
          ),
        )
      },
    }
  },
})