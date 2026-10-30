import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Link, Navigate, Outlet, Route, Routes, useBeforeUnload, useBlocker, useLocation } from 'react-router'
import AppLayout from './components/AppLayout'
import Dashboard from './features/dashboard/Dashboard'
import { createBusinessSnapshot, nextMockTimestamp } from './lib/mockData'
import { api, errorMessage, isStale, watchSession } from './lib/api'
import type { ReferenceData, SessionState } from './lib/api'
import Requests, { clearRequestPosition } from './features/requests/Requests'
import RequestDetail from './features/requests/RequestDetail'
import DiscardDialog from './components/DiscardDialog'
import KnowledgeList, { clearKnowledgePosition, KnowledgeDetail } from './features/knowledge/Knowledge'
import KnowledgeReview from './features/knowledge/KnowledgeReview'
import AuthScreen from './features/auth/AuthScreen'
import Accounts, { TemporaryPasswordDialog } from './features/accounts/Accounts'

function subscribeSession(listener: () => void) {
  let generation = api.snapshot().generation
  return api.subscribe(() => {
    if (generation !== api.snapshot().generation) {
      clearRequestPosition()
      clearKnowledgePosition()
      document.title = 'SolveLoop'
      generation = api.snapshot().generation
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
    // 別の認証世代へ、前の画面の復帰メッセージを渡さない。
    window.history.replaceState({ ...window.history.state, usr: null }, '', window.location.pathname + window.location.search)
  }, [state.generation])
  if (state.status !== 'ready') return <AppLayout session={null} notice="" onSessionEnd={() => {}} unverified>
    <h1 tabIndex={-1}>接続状態の確認</h1>
    {state.status === 'error' ? <div className="notice"><p role="alert">{state.notice}</p><p>表示を停止しました。ログアウトとは判定していません。</p><button className="button" onClick={() => { void api.verify().catch(() => {}) }}>再確認</button></div> : <p role="status">{state.status === 'hidden' ? '再表示時に接続状態を確認します。' : '確認中…'}</p>}
  </AppLayout>
  return <Workspace key={`${state.generation}:${state.user?.id ?? 'anonymous'}`} state={state} />
}

function Workspace({ state }: { state: SessionState }) {
  const location = useLocation()
  const session = state.user
  const role = session?.role ?? 'employee'
  const userId = session?.id ?? ''
  const [snapshot] = useState(createBusinessSnapshot)
  const [requests, setRequests] = useState(snapshot.requests)
  const [knowledge, setKnowledge] = useState(snapshot.knowledge)
  const [references, setReferences] = useState<ReferenceData>({ departments: [] })
  const [checkedPath, setCheckedPath] = useState('')
  const [checkError, setCheckError] = useState('')
  const [checking, setChecking] = useState(false)
  const [logoutError, setLogoutError] = useState('')
  const [loggingOut, setLoggingOut] = useState(false)
  const dirtyRef = useRef(false)
  const onDirtyChange = useCallback((dirty: boolean) => { dirtyRef.current = dirty }, [])
  const blocker = useBlocker(() => dirtyRef.current && api.snapshot().generation === state.generation && api.snapshot().status === 'ready')
  useBeforeUnload(useCallback((event: BeforeUnloadEvent) => {
    if (dirtyRef.current && api.snapshot().generation === state.generation) { event.preventDefault(); event.returnValue = '' }
  }, [state.generation]))
  const sensitive = location.pathname === '/settings/accounts' || location.pathname === '/password/change'

  const checkRoute = useCallback(async () => {
    setChecking(true)
    setCheckError('')
    try {
      const user = await api.verify()
      if (!user || api.snapshot().generation !== state.generation) return
      if (!user.must_change_password) {
        const data = await api.request<ReferenceData>('/reference-data')
        setReferences(data)
      }
      setCheckedPath(location.key)
    } catch (error) { if (!isStale(error)) setCheckError(errorMessage(error)) }
    finally { setChecking(false) }
  }, [location.pathname, location.key, state.generation])

  useEffect(() => { if (session) void checkRoute() }, [!!session, checkRoute])
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

  const getNextTimestamp = () => nextMockTimestamp(requests, knowledge)
  const people = [...(references.operators ?? []).map(user => ({ id: user.id, name: user.display_name })), ...(session ? [{ id: session.id, name: session.display_name }] : [])]
  const operatorOptions = (references.operators ?? []).map(user => ({ id: user.id, name: user.display_name }))
  const requestProps = { role, userId, people, operatorOptions, requests, onRequestsChange: setRequests, onDirtyChange, getNextTimestamp }
  const knowledgeProps = { role, knowledge }
  const reviewProps = { ...knowledgeProps, actorName: session?.display_name ?? '', requests, onKnowledgeChange: setKnowledge, onDirtyChange, getNextTimestamp }

  return <AppLayout session={session} notice={state.notice} onSessionEnd={() => { void logout() }} busy={loggingOut}>
    {logoutError && <p role="alert">{logoutError}</p>}
    <Routes>
      <Route path="/login" element={session ? <Navigate to={session.must_change_password ? '/password/change' : '/dashboard'} replace state={null} /> : <AuthScreen onDirtyChange={onDirtyChange} onSubmit={async values => {
        try { await api.login(values.loginId, values.password); return {} }
        catch (error) { return { form: errorMessage(error, true) } }
      }} />} />
      <Route element={!session ? <Navigate to="/login" replace state={null} /> : session.must_change_password && location.pathname !== '/password/change' ? <Navigate to="/password/change" replace state={null} /> : sensitive && checkedPath !== location.key ? <><h1 tabIndex={-1}>接続状態の確認</h1>{checkError ? <><p role="alert">{checkError}</p><button className="button" disabled={checking} onClick={() => { void checkRoute() }}>再確認</button></> : <p role="status">確認中…</p>}</> : <Outlet />}>
        <Route path="/password/change" element={<AuthScreen changePassword requiredChange={session?.must_change_password} loginId={session?.display_name} onDirtyChange={onDirtyChange} onSubmit={async values => {
          try { await api.end('/auth/password/change', { current_password: values.currentPassword, new_password: values.newPassword }); return {} }
          catch (error) { return { form: errorMessage(error, true) } }
        }} />} />
        <Route path="/" element={<Navigate to="/dashboard" replace />} />
        <Route path="/dashboard" element={<Dashboard role={role} userId={userId} requests={requests} knowledge={knowledge} />} />
        <Route path="/requests" element={<Requests {...requestProps} />} />
        <Route path="/requests/:requestId" element={<RequestDetail {...requestProps} />} />
        <Route path="/settings/accounts" element={<Accounts user={session!} departments={references.departments} onDirtyChange={onDirtyChange} />} />
        <Route path="/knowledge/reviews" element={<KnowledgeList {...knowledgeProps} review />} />
        <Route path="/knowledge/reviews/new" element={<KnowledgeReview {...reviewProps} />} />
        <Route path="/knowledge/reviews/:documentId/versions/:version" element={<KnowledgeReview {...reviewProps} />} />
        <Route path="/knowledge/reviews/*" element={<KnowledgeList {...knowledgeProps} review />} />
        <Route path="/knowledge" element={<KnowledgeList {...knowledgeProps} />} />
        <Route path="/knowledge/:documentId" element={<KnowledgeDetail key={location.pathname} {...knowledgeProps} />} />
        <Route path="*" element={<><h1 tabIndex={-1}>ページが見つかりません</h1><Link to="/dashboard">ダッシュボードに戻る</Link></>} />
      </Route>
    </Routes>
    {state.issued && <TemporaryPasswordDialog issued={state.issued} onClose={api.closeIssued} />}
    {blocker.state === 'blocked' && <DiscardDialog onCancel={() => blocker.reset()} onDiscard={() => { dirtyRef.current = false; blocker.proceed() }} />}
  </AppLayout>
}
