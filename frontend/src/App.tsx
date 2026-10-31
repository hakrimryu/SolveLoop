import { Activity, useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Link, Navigate, Outlet, Route, Routes, useBeforeUnload, useBlocker, useLocation } from 'react-router'
import AppLayout from './components/AppLayout'
import Dashboard from './features/dashboard/Dashboard'
import { api, errorMessage, isStale, watchSession } from './lib/api'
import type { ReferenceData, SessionState } from './lib/api'
import Requests, { clearRequestPosition } from './features/requests/Requests'
import RequestDetail from './features/requests/RequestDetail'
import DiscardDialog from './components/DiscardDialog'
import KnowledgeList, { clearKnowledgePosition, KnowledgeDetail } from './features/knowledge/Knowledge'
import KnowledgeReview from './features/knowledge/KnowledgeReview'
import AuthScreen from './features/auth/AuthScreen'
import Accounts, { TemporaryPasswordDialog } from './features/accounts/Accounts'
import { clearSearchInquiry } from './lib/searchInquiry'

function subscribeSession(listener: () => void) {
  let generation = api.snapshot().identityGeneration
  return api.subscribe(() => {
    if (generation !== api.snapshot().identityGeneration) {
      clearRequestPosition()
      clearKnowledgePosition()
      clearSearchInquiry()
      document.title = 'SolveLoop'
      generation = api.snapshot().identityGeneration
    }
    listener()
  })
}

export default function App() {
  const state = useSyncExternalStore(subscribeSession, api.snapshot)
  useEffect(watchSession, [])
  useLayoutEffect(() => {
    document.title = 'SolveLoop'
    clearRequestPosition()
    clearKnowledgePosition()
    clearSearchInquiry()
    // 別の認証世代へ、前の画面の復帰メッセージを渡さない。
    // [ko] 다른 인증 세대로 이전 화면의 복귀 메시지를 넘기지 않는다.
    // [en] Do not carry previous navigation messages into a different auth generation.
    window.history.replaceState({ ...window.history.state, usr: null }, '', window.location.pathname + window.location.search)
  }, [state.identityGeneration])
  return <SessionView state={state} />
}

export function SessionView({ state }: { state: SessionState }) {
  const retained = useRef<SessionState | null>(null)
  if (retained.current?.identityGeneration !== state.identityGeneration) retained.current = null
  if (state.status === 'ready') retained.current = state
  else if (retained.current) retained.current = { ...retained.current, issued: null }
  // Activityは入力を保持したままEffectを片付け、非表示のdialogも閉じる。
  // [ko] Activity는 입력을 유지하며 Effect를 정리해 숨긴 dialog도 닫는다.
  // [en] Activity preserves inputs while cleaning up Effects, including open dialogs.
  return <>
    <Activity mode={state.status === 'ready' ? 'visible' : 'hidden'}>
      {retained.current && <Workspace key={`${retained.current.identityGeneration}:${retained.current.user?.id ?? 'anonymous'}`} state={retained.current} />}
    </Activity>
    {state.status !== 'ready' && <AppLayout session={null} notice="" onSessionEnd={() => {}} unverified>
    <h1 tabIndex={-1}>接続状態の確認</h1>
    {state.status === 'error' ? <div className="notice"><p role="alert">{state.notice}</p><p>表示を停止しました。ログアウトとは判定していません。</p><button className="button" onClick={() => { void api.verify().catch(() => {}) }}>再確認</button></div> : <p role="status">{state.status === 'hidden' ? '再表示時に接続状態を確認します。' : '確認中…'}</p>}
    </AppLayout>}
  </>
}

function Workspace({ state }: { state: SessionState }) {
  const location = useLocation()
  const session = state.user
  const role = session?.role ?? 'employee'
  const [references, setReferences] = useState<ReferenceData>({ departments: [] })
  const [checkedPath, setCheckedPath] = useState('')
  const [checkError, setCheckError] = useState('')
  const [checking, setChecking] = useState(false)
  const [logoutError, setLogoutError] = useState('')
  const [loggingOut, setLoggingOut] = useState(false)
  const dirtyRef = useRef(false)
  const onDirtyChange = useCallback((dirty: boolean) => { dirtyRef.current = dirty }, [])
  // 未保存確認は同じ有効セッションに限り、失効による資料除去を止めない。
  // [ko] 미저장 확인은 같은 유효 세션에서만 적용해 세션 만료에 따른 자료 제거를 막지 않는다.
  // [en] Block navigation only within the active session; never block clearing revoked-session data.
  const blocker = useBlocker(() => dirtyRef.current && api.snapshot().generation === state.generation && api.snapshot().status === 'ready')
  useBeforeUnload(useCallback((event: BeforeUnloadEvent) => {
    if (dirtyRef.current && api.snapshot().generation === state.generation) { event.preventDefault(); event.returnValue = '' }
  }, [state.generation]))
  const sensitive = location.pathname !== '/login'
  const routeCheck = useRef({ sequence: 0, controller: new AbortController() })

  // 経路確認にも要求の識別と中断を使い、前の画面の応答を捨てる。
  // [ko] 경로 확인에도 요청 식별과 취소를 적용해 이전 화면의 응답을 버린다.
  // [en] Identify and cancel route checks so responses for earlier screens are discarded.
  const checkRoute = useCallback(async () => {
    routeCheck.current.controller.abort()
    const check = { sequence: routeCheck.current.sequence + 1, controller: new AbortController() }
    routeCheck.current = check
    setChecking(true)
    setCheckError('')
    try {
      const user = await api.verify()
      if (!user || api.snapshot().generation !== state.generation || routeCheck.current !== check || check.controller.signal.aborted) return
      if (!user.must_change_password) {
        const data = await api.request<ReferenceData>('/reference-data', undefined, { signal: check.controller.signal })
        api.assertCurrent(state.generation)
        if (routeCheck.current !== check || check.controller.signal.aborted) return
        setReferences(data)
      }
      setCheckedPath(location.pathname)
    } catch (error) { if (routeCheck.current === check && !check.controller.signal.aborted && !isStale(error)) setCheckError(errorMessage(error)) }
    finally { if (routeCheck.current === check) setChecking(false) }
  }, [location.pathname, state.generation])

  useEffect(() => { if (session) void checkRoute(); return () => routeCheck.current.controller.abort() }, [!!session, checkRoute])
  const previousPath = useRef(location.pathname)
  useEffect(() => {
    if (previousPath.current !== location.pathname && !(!session && state.issued && location.pathname === '/login')) api.closeIssued()
    previousPath.current = location.pathname
  }, [location.pathname])

  async function logout() {
    if (loggingOut) return
    setLoggingOut(true)
    try { await api.end('/auth/logout') }
    catch (error) { if (!isStale(error)) setLogoutError(errorMessage(error, true)) }
    finally { setLoggingOut(false) }
  }

  const businessProps = { role, departments: references.departments, onDirtyChange }
  const requestProps = { ...businessProps, operators: references.operators ?? [] }

  return <AppLayout session={session} notice={state.notice} onSessionEnd={() => { void logout() }} busy={loggingOut}>
    {logoutError && <p role="alert">{logoutError}</p>}
    <Routes>
      <Route path="/login" element={session ? <Navigate to={session.must_change_password ? '/password/change' : '/dashboard'} replace state={null} /> : <AuthScreen onDirtyChange={onDirtyChange} onSubmit={async values => {
        try { await api.login(values.loginId, values.password); return {} }
        catch (error) { return { form: errorMessage(error, true) } }
      }} />} />
      <Route element={!session ? <Navigate to="/login" replace state={null} /> : session.must_change_password && location.pathname !== '/password/change' ? <Navigate to="/password/change" replace state={null} /> : sensitive && checkedPath !== location.pathname ? <><h1 tabIndex={-1}>接続状態の確認</h1>{checkError ? <><p role="alert">{checkError}</p><button className="button" disabled={checking} onClick={() => { void checkRoute() }}>再確認</button></> : <p role="status">確認中…</p>}</> : <Outlet />}>
        <Route path="/password/change" element={<AuthScreen changePassword requiredChange={session?.must_change_password} loginId={session?.display_name} onDirtyChange={onDirtyChange} onSubmit={async values => {
          try { await api.end('/auth/password/change', { current_password: values.currentPassword, new_password: values.newPassword }); return {} }
          catch (error) { return { form: errorMessage(error, true) } }
        }} />} />
        <Route path="/" element={<Navigate to="/dashboard" replace />} />
        <Route path="/dashboard" element={<Dashboard role={role} />} />
        <Route path="/requests" element={<Requests {...requestProps} />} />
        <Route path="/requests/:requestId" element={<RequestDetail {...requestProps} />} />
        <Route path="/settings/accounts" element={<Accounts user={session!} departments={references.departments} onDirtyChange={onDirtyChange} />} />
        <Route path="/knowledge/reviews" element={<KnowledgeList {...businessProps} review />} />
        <Route path="/knowledge/reviews/new" element={<KnowledgeReview {...businessProps} />} />
        <Route path="/knowledge/reviews/:documentId/versions/:version" element={<KnowledgeReview {...businessProps} />} />
        <Route path="/knowledge/reviews/*" element={<KnowledgeList {...businessProps} review />} />
        <Route path="/knowledge" element={<KnowledgeList {...businessProps} />} />
        <Route path="/knowledge/:documentId" element={<KnowledgeDetail key={location.pathname} {...businessProps} />} />
        <Route path="*" element={<><h1 tabIndex={-1}>ページが見つかりません</h1><Link to="/dashboard">ダッシュボードに戻る</Link></>} />
      </Route>
    </Routes>
    {state.issued && <TemporaryPasswordDialog issued={state.issued} onClose={api.closeIssued} />}
    {blocker.state === 'blocked' && <DiscardDialog onCancel={() => blocker.reset()} onDiscard={() => { dirtyRef.current = false; blocker.proceed() }} />}
  </AppLayout>
}
