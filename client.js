/**
 * Session delete — Client half.
 *
 * Adds one `删除会话` row to a Session's "..." menu
 * (`sidebar.workspaces.session.menu.item`) and renders the confirmation as a
 * centered card on the frame-wide floating layer (`shell.overlay`), so it sits
 * above every column instead of inside the row it came from.
 *
 * The two halves share one module-scope slot: the menu row opens the dialog,
 * the overlay reads it. Both are React components registered through slots, so
 * there is no DOM poking and unmounting the plugin disposes everything.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-session-delete',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /* ------------------------------------------------------------- locale */

    /* Every user-facing string lives here, once per locale. The slot entries
     * declare `locale: NS`, which is what makes the framework hand each component
     * a `t` bound to this namespace and re-render it when the language changes;
     * `translate` is only the fallback for a composition without the locale
     * service. */

    const NS = 'session-delete'

    const DICT = {
      zh: {
        'menu.delete': '删除会话',
        'row.deleteOf': '删除会话：{title}',
        'dialog.title': '删除会话',
        'dialog.body': '「{title}」将会永久失去！',
        'dialog.note': '（连同磁盘上的会话记录一并删除，真的很久！）',
        'dialog.cancel': '取消',
        'dialog.confirm': '删除',
        'dialog.busy': '正在删除…',
        'dialog.failed': '删除失败：{error}',
        'notice.deleted': '已删除「{title}」',
        'family.turn': '进行中的回合',
        'family.subagent': '子代理',
        'family.job': '后台任务',
        'family.schedule': '定时提醒',
        'family.other': '其他工作',
        'error.running': '会话仍在运行（{reasons}），请先停止后再删除。',
        'error.notFound': '会话不存在，可能已被删除。',
        'error.archiveFailed': '暂时无法从列表中移除该会话，未执行删除。',
        'error.removeFailed': '部分目录删除失败，请稍后重试。',
        'error.registryUnavailable': '工作区注册表不可用，未执行删除。',
        'error.invalidId': '会话标识无效。',
        'error.internal': '删除过程中发生错误。',
      },
      en: {
        'menu.delete': 'Delete session',
        'row.deleteOf': 'Delete session: {title}',
        'dialog.title': 'Delete session',
        'dialog.body': '"{title}" will be lost forever!',
        'dialog.note': '(Its on-disk record is removed too — gone a really, really long time!)',
        'dialog.cancel': 'Cancel',
        'dialog.confirm': 'Delete',
        'dialog.busy': 'Deleting…',
        'dialog.failed': 'Delete failed: {error}',
        'notice.deleted': 'Deleted "{title}"',
        'family.turn': 'a turn in progress',
        'family.subagent': 'subagents',
        'family.job': 'background jobs',
        'family.schedule': 'scheduled reminders',
        'family.other': 'other work',
        'error.running': 'The session is still running ({reasons}). Stop it before deleting.',
        'error.notFound': 'Session not found; it may already be deleted.',
        'error.archiveFailed': 'The session could not be removed from the list. Nothing was deleted.',
        'error.removeFailed': 'Some directories could not be removed. Try again later.',
        'error.registryUnavailable': 'The workspace registry is unavailable. Nothing was deleted.',
        'error.invalidId': 'Invalid session id.',
        'error.internal': 'The delete failed.',
      },
    }

    /** `{name}` substitution, the same shape the locale service uses. */
    function fill(template, params) {
      if (params === undefined) return template
      return template.replace(/\{(\w+)\}/g, (match, key) => (params[key] === undefined ? match : String(params[key])))
    }

    let translate = (key, params) => fill(DICT.zh[key] ?? key, params)

    /* ---------------------------------------------------------------- shared */

    let pending = null
    const listeners = new Set()

    function setPending(next) {
      pending = next
      for (const fn of listeners) fn()
    }

    function usePending() {
      const [value, setValue] = React.useState(pending)
      React.useEffect(() => {
        const sync = () => setValue(pending)
        listeners.add(sync)
        sync()
        return () => { listeners.delete(sync) }
      }, [])
      return value
    }

    /* A one-shot notice after a successful delete. The archive row offers an
     * undo; a permanent delete cannot, so this only reports what happened. */
    let notice = null
    const noticeListeners = new Set()

    function setNotice(next) {
      notice = next
      for (const fn of noticeListeners) fn()
    }

    function useNotice() {
      const [value, setValue] = React.useState(notice)
      React.useEffect(() => {
        const sync = () => setValue(notice)
        noticeListeners.add(sync)
        sync()
        return () => { noticeListeners.delete(sync) }
      }, [])
      return value
    }

    /** The menu row runs inside the menu's open state; close it however that hook exposes. */
    function closeMenu(menuState) {
      try {
        if (typeof menuState === 'function') menuState(false)
        else if (menuState && typeof menuState.close === 'function') menuState.close()
        else if (menuState && typeof menuState.setOpen === 'function') menuState.setOpen(false)
      } catch { /* the menu closes itself on outside click anyway */ }
    }

    /* ------------------------------------------------- navigating away */

    /* The Host half deletes the files and announces the removal; the Client half
     * has to leave the Session. Archiving switches away on its own (the workspace
     * service clears an archived current selection), but a deleted Session simply
     * stops being listed, so the view would sit on a conversation whose files are
     * gone until the user clicks something else. */

    /** Client context, captured once in `apply`: the dialog needs the navigation service. */
    let pluginCtx = null

    /** The Session the main view currently shows, when that is knowable. */
    function currentMainSessionId() {
      try {
        const sessions = pluginCtx?.get?.('sessions', false)
        const snapshot = sessions?.list?.getSnapshot?.()
        const ids = snapshot?.ids ?? Object.keys(snapshot?.byId ?? {})
        for (const id of ids) {
          if ((snapshot.byId?.[id]?.retainedBy?.mainView ?? 0) > 0) return id
        }
      } catch { /* a missing service only costs the switch, never the delete */ }
      return undefined
    }

    /**
     * Other Sessions of the same Workspace in row order, nearest first: the one
     * after the target, then the one before. Captured BEFORE the delete, because
     * afterwards the target is already off the account.
     */
    function fallbackTargets(sessionId) {
      try {
        const snapshot = pluginCtx?.get?.('workspaces', false)?.list?.getSnapshot?.()
        const archived = new Set(snapshot?.archivedSessionIds ?? [])
        const usable = (id) => id !== sessionId && !archived.has(id)
        const items = snapshot?.items ?? []
        const host = items.find((item) => (item.sessionIds ?? []).includes(sessionId))
        const near = []
        if (host !== undefined) {
          const index = host.sessionIds.indexOf(sessionId)
          const after = host.sessionIds.slice(index + 1).find(usable)
          const before = [...host.sessionIds.slice(0, index)].reverse().find(usable)
          if (after !== undefined) near.push(after)
          if (before !== undefined) near.push(before)
        }
        // Nothing left in this Workspace: any other conversation beats creating a
        // new empty one, which is what startSession() would do.
        const anywhere = items
          .flatMap((item) => item.sessionIds ?? [])
          .find(usable)
        return anywhere === undefined ? near : [...near, anywhere]
      } catch {
        return []
      }
    }

    /** Leave a Session that no longer exists: the nearest neighbour, else a fresh one. */
    function leaveDeletedSession(sessionId, fallbacks) {
      if (currentMainSessionId() !== sessionId) return
      try {
        const workspace = pluginCtx?.get?.('uiWorkspace', false)
        if (fallbacks.length > 0) workspace?.openSession?.(fallbacks[0])
        else workspace?.startSession?.()
      } catch { /* the row is already gone; a failed switch only leaves the view */ }
    }

    /* ------------------------------------------------------------- menu row */

    /** Trash glyph, drawn inline so neither entry needs an asset request. */
    function TrashIcon(props = {}) {
      const size = props.size ?? 14
      return h(
        'svg',
        {
          width: size, height: size, viewBox: '0 0 16 16',
          fill: 'none', stroke: 'currentColor',
          strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round',
          'aria-hidden': true, focusable: 'false',
          style: { display: 'block', flex: 'none' },
        },
        h('path', { d: 'M2.5 4h11' }),
        h('path', { d: 'M6 4V2.6h4V4' }),
        h('path', { d: 'M4.2 4l.6 9.4h6.4L11.8 4' }),
        h('path', { d: 'M6.6 6.6v4.2M9.4 6.6v4.2' }),
      )
    }

    function DeleteMenuRow(props) {
      const t = props.t ?? translate
      const sessionId = props.sessionId
      const title = props.displayTitle || sessionId
      // Keep the hook position stable: fall back to a no-op reader instead of
      // calling it conditionally when the host does not project the hook.
      const readMenuState = props.useMenuOpenState ?? (() => undefined)
      const menuState = readMenuState()
      const [hovered, setHovered] = React.useState(false)

      const onClick = React.useCallback(() => {
        setPending({ sessionId, title })
        closeMenu(menuState)
      }, [sessionId, title, menuState])

      return h(
        'button',
        {
          type: 'button',
          role: 'menuitem',
          onClick,
          onMouseEnter: () => setHovered(true),
          onMouseLeave: () => setHovered(false),
          onFocus: () => setHovered(true),
          onBlur: () => setHovered(false),
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            width: '100%',
            boxSizing: 'border-box',
            padding: '7px 12px',
            border: 'none',
            borderRadius: 6,
            background: hovered ? 'var(--dsw-alias-bg-layer-2)' : 'transparent',
            color: hovered
              ? 'var(--dsw-alias-state-error-primary)'
              : 'var(--dsw-alias-label-primary)',
            font: 'inherit',
            fontSize: 13,
            textAlign: 'left',
            cursor: 'pointer',
            whiteSpace: 'nowrap',
            transition: 'background 120ms ease, color 120ms ease',
          },
        },
        TrashIcon({ size: 14 }),
        h('span', null, t('menu.delete')),
      )
    }

    /* ------------------------------------------------- row hover icon button */

    function DeleteRowAction(props) {
      const t = props.t ?? translate
      const sessionId = props.sessionId
      const title = props.displayTitle || sessionId
      const [hovered, setHovered] = React.useState(false)

      const onClick = React.useCallback((event) => {
        // The strip already keeps clicks off the row; stopping here keeps the
        // menu-less path explicit rather than relying on that.
        event.stopPropagation()
        setPending({ sessionId, title })
      }, [sessionId, title])

      return h(
        'button',
        {
          type: 'button',
          title: t('menu.delete'),
          'aria-label': t('row.deleteOf', { title }),
          onClick,
          onMouseEnter: () => setHovered(true),
          onMouseLeave: () => setHovered(false),
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 22,
            height: 22,
            padding: 0,
            border: 'none',
            borderRadius: 5,
            background: hovered ? 'var(--dsw-alias-bg-layer-2)' : 'transparent',
            color: hovered
              ? 'var(--dsw-alias-state-error-primary)'
              : 'var(--dsw-alias-label-secondary)',
            cursor: 'pointer',
            transition: 'background 120ms ease, color 120ms ease',
          },
        },
        TrashIcon(),
      )
    }

    /** Map a Host error payload onto this namespace's wording. */
    function errorText(t, payload, status) {
      const kinds = Array.isArray(payload?.activity) ? payload.activity : []
      const reasons = kinds.map((kind) => t(`family.${kind === undefined ? 'other' : kind}`) ?? kind).join(', ')
      switch (payload?.error) {
        case 'session-running': return t('error.running', { reasons: reasons || t('family.other') })
        case 'not-found': return t('error.notFound')
        case 'archive-failed': return t('error.archiveFailed')
        case 'remove-failed': return t('error.removeFailed')
        case 'registry-unavailable': return t('error.registryUnavailable')
        case 'invalid-session-id': return t('error.invalidId')
        case 'internal': return `${t('error.internal')} ${payload?.detail ?? ''}`.trim()
        default: return payload?.message || payload?.error || `HTTP ${status}`
      }
    }

    /* ------------------------------------------------------- confirm dialog */

    const overlayStyle = {
      position: 'fixed',
      inset: 0,
      zIndex: 10000,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: 'rgba(0, 0, 0, 0.45)',
      backdropFilter: 'blur(2px)',
      // `shell.overlay` is click-through by design; an entry must opt back in
      // or it never receives the click that lands on the scrim.
      pointerEvents: 'auto',
    }

    const cardStyle = {
      width: 'min(420px, calc(100vw - 48px))',
      boxSizing: 'border-box',
      padding: '20px 20px 16px',
      borderRadius: 12,
      background: 'var(--dsw-alias-bg-overlay)',
      color: 'var(--dsw-alias-label-primary)',
      border: '1px solid var(--dsw-alias-border-l1)',
      boxShadow: '0 18px 48px rgba(0, 0, 0, 0.32)',
      font: 'inherit',
    }

    function buttonStyle(variant) {
      const danger = variant === 'danger'
      return {
        padding: '7px 16px',
        borderRadius: 8,
        fontSize: 13,
        font: 'inherit',
        cursor: 'pointer',
        border: `1px solid ${danger ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-border-l1)'}`,
        background: danger ? 'var(--dsw-alias-state-error-primary)' : 'transparent',
        color: danger ? '#fff' : 'var(--dsw-alias-label-primary)',
      }
    }

    function ConfirmOverlay(props) {
      const t = props?.t ?? translate
      const target = usePending()
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState('')

      React.useEffect(() => {
        if (!target) return undefined
        const onKey = (event) => {
          if (event.key === 'Escape' && !busy) {
            setPending(null)
            setError('')
          }
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [target, busy])

      if (!target) return null

      const cancel = () => {
        if (busy) return
        setPending(null)
        setError('')
      }

      const confirm = async () => {
        if (busy) return
        setBusy(true)
        setError('')
        // Read before the delete: afterwards the Session is off the accounts.
        const fallbacks = fallbackTargets(target.sessionId)
        try {
          const response = await fetch('/api/dsh-session-delete/delete', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId: target.sessionId }),
          })
          const payload = await response.json().catch(() => ({}))
          if (!response.ok || payload.ok !== true) {
            throw new Error(errorText(t, payload, response.status))
          }
          setPending(null)
          leaveDeletedSession(target.sessionId, fallbacks)
          setNotice({ message: t('notice.deleted', { title: target.title }) })
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause))
        } finally {
          setBusy(false)
        }
      }

      return h(
        'div',
        { style: overlayStyle, role: 'presentation', onMouseDown: (e) => { if (e.target === e.currentTarget) cancel() } },
        h(
          'div',
          {
            role: 'dialog',
            'aria-modal': 'true',
            'aria-labelledby': 'dsh-session-delete-title',
            style: cardStyle,
          },
          h('div', {
            id: 'dsh-session-delete-title',
            style: {
              fontSize: 15,
              fontWeight: 600,
              marginBottom: 10,
              color: 'var(--dsw-alias-state-error-primary)',
            },
          }, t('dialog.title')),
          h('div', {
            style: { fontSize: 13, lineHeight: 1.7, color: 'var(--dsw-alias-label-primary)' },
          },
          t('dialog.body').split('{title}')[0],
          h('span', { style: { fontWeight: 600, wordBreak: 'break-all' } }, target.title),
          t('dialog.body').split('{title}')[1] ?? ''),
          h('div', {
            style: {
              marginTop: 6,
              fontSize: 12,
              lineHeight: 1.6,
              color: 'var(--dsw-alias-label-secondary)',
            },
          }, t('dialog.note')),
          error !== ''
            ? h('div', {
              style: {
                marginTop: 12,
                fontSize: 12,
                color: 'var(--dsw-alias-state-error-primary)',
                wordBreak: 'break-all',
              },
            }, t('dialog.failed', { error }))
            : null,
          h('div', {
            style: { display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 18 },
          },
          h('button', { type: 'button', style: buttonStyle('plain'), onClick: cancel, disabled: busy }, t('dialog.cancel')),
          h('button', { type: 'button', style: buttonStyle('danger'), onClick: confirm, disabled: busy },
            busy ? t('dialog.busy') : t('dialog.confirm')),
          ),
        ),
      )
    }

    /* --------------------------------------------------------------- notice */

    function CheckIcon() {
      return h(
        'svg',
        {
          width: 15, height: 15, viewBox: '0 0 16 16',
          fill: 'none', stroke: 'currentColor',
          strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round',
          'aria-hidden': true, focusable: 'false',
          style: { display: 'block' },
        },
        h('circle', { cx: 8, cy: 8, r: 6.3 }),
        h('path', { d: 'M5.2 8.2l2 2 3.6-3.9' }),
      )
    }

    /** Top-center pill, mirroring the shipped archive notice. No undo: the delete is final. */
    function DeleteNotice() {
      const current = useNotice()

      React.useEffect(() => {
        if (!current) return undefined
        const timer = setTimeout(() => setNotice(null), 3600)
        return () => clearTimeout(timer)
      }, [current])

      if (!current) return null

      return h(
        'div',
        {
          role: 'status',
          style: {
            position: 'fixed',
            top: 18,
            left: '50%',
            transform: 'translateX(-50%)',
            zIndex: 10001,
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            maxWidth: 'calc(100vw - 48px)',
            boxSizing: 'border-box',
            padding: '9px 16px',
            borderRadius: 999,
            background: 'var(--dsw-alias-bg-overlay)',
            border: '1px solid var(--dsw-alias-border-l1)',
            boxShadow: '0 10px 30px rgba(0, 0, 0, 0.28)',
            color: 'var(--dsw-alias-label-primary)',
            fontSize: 13,
            lineHeight: 1.4,
            pointerEvents: 'none',
          },
        },
        h('span', {
          style: { color: 'var(--dsw-alias-state-success-primary)', display: 'inline-flex', flex: 'none' },
        }, CheckIcon()),
        h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
          current.message),
      )
    }

    /* -------------------------------------------------------------- plugin */

    return {
      inject: ['slots'],
      apply(ctx) {
        pluginCtx = ctx
        // Register both dictionaries (the typed overload wants the whole set) and
        // fall back to a bound translate when a slot entry makes no `t` seat.
        const locale = ctx.get('locale', false)
        if (locale && typeof locale.register === 'function') {
          ctx.effect(() => {
            const disposers = [
              locale.register(NS, 'zh', DICT.zh),
              locale.register(NS, 'en', DICT.en),
            ]
            return () => { for (const dispose of disposers) dispose() }
          })
          const bound = locale.bind?.(NS)
          if (typeof bound === 'function') translate = bound
        }
        // Row hover strip: sits right after the shipped archive (100) and before pin (200).
        ctx.slots.inject('sidebar.workspaces.session.row.action', () => ctx.slots.register({
          name: 'sidebar.workspaces.session.row.action',
          id: 'delete-session-row',
          order: 150,
          locale: NS,
        }, DeleteRowAction))

        ctx.slots.inject('sidebar.workspaces.session.menu.item', () => ctx.slots.register({
          name: 'sidebar.workspaces.session.menu.item',
          id: 'delete-session',
          order: 500,
          locale: NS,
        }, DeleteMenuRow))

        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'session-delete-confirm',
          order: 900,
          locale: NS,
        }, ConfirmOverlay))

        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'session-delete-notice',
          order: 950,
          locale: NS,
        }, DeleteNotice))
      },
    }
  },
})
