import { useCallback, useRef, useState } from 'react'
import { Link, Navigate, Outlet, Route, Routes, useBeforeUnload, useBlocker, useLocation, useNavigate } from 'react-router'
import AppLayout from './components/AppLayout'
import Dashboard from './features/dashboard/Dashboard'
import { changeMockPassword, createMockAuth, endMockSession, getMockPeople, getMockSession, loginMock, mockKnowledge, mockRequests, nextMockTimestamp } from './lib/mockData'
import type { MockSessionEnd } from './lib/mockData'
import Requests from './features/requests/Requests'
import RequestDetail from './features/requests/RequestDetail'
import DiscardDialog from './components/DiscardDialog'
import KnowledgeList, { KnowledgeDetail } from './features/knowledge/Knowledge'
import KnowledgeReview from './features/knowledge/KnowledgeReview'
import AuthScreen from './features/auth/AuthScreen'
import Accounts, { TemporaryPasswordDialog } from './features/accounts/Accounts'

function PendingScreen({ title }: { title: string }) {
  const location = useLocation()

  return (
    <>
      <p className="eyebrow">画面モック・移動先の確認</p>
      <h1 tabIndex={-1}>{title}</h1>
      <div className="notice">
        <p>指定されたページが見つかりません。</p>
        <p>移動先：<code>{location.pathname}{location.search}</code></p>
        <Link to="/dashboard">ダッシュボードに戻る</Link>
      </div>
    </>
  )
}

export default function App() {
  const location = useLocation()
  const navigate = useNavigate()
  const [auth, setAuth] = useState(createMockAuth)
  const [issued, setIssued] = useState<{ loginId: string; password: string } | null>(null)
  const session = getMockSession(auth)
  const role = session?.role ?? 'operator'
  const [requests, setRequests] = useState(mockRequests)
  const [knowledge, setKnowledge] = useState(mockKnowledge)
  const [pendingExit, setPendingExit] = useState<MockSessionEnd | null>(null)
  const dirtyRef = useRef(false)
  const onDirtyChange = useCallback((dirty: boolean) => { dirtyRef.current = dirty }, [])
  const blocker = useBlocker(() => dirtyRef.current)
  useBeforeUnload(useCallback((event: BeforeUnloadEvent) => {
    if (dirtyRef.current) {
      event.preventDefault()
      event.returnValue = ''
    }
  }, []))

  function exitSession(reason: MockSessionEnd) {
    if (dirtyRef.current) { setPendingExit(reason); return }
    setAuth(previous => endMockSession(previous, reason))
    navigate('/login', { replace: true })
  }

  function discardAndNavigate() {
    if (blocker.state !== 'blocked') return
    dirtyRef.current = false
    blocker.proceed()
  }

  function discardAndExit() {
    if (!pendingExit) return
    dirtyRef.current = false
    exitSession(pendingExit)
    setPendingExit(null)
  }

  const getNextTimestamp = () => nextMockTimestamp(requests, knowledge, auth.events)
  const userId = session?.id ?? ''
  const requestProps = { role, userId, people: getMockPeople(auth), requests, onRequestsChange: setRequests, onDirtyChange, getNextTimestamp }
  const knowledgeProps = { role, knowledge }
  const reviewProps = { ...knowledgeProps, actorName: session?.name ?? '', requests, onKnowledgeChange: setKnowledge, onDirtyChange, getNextTimestamp }

  return (
    <AppLayout session={session} notice={auth.notice} onSessionEnd={exitSession}>
      <Routes>
        <Route path="/login" element={session ? <Navigate to={session.mustChangePassword ? '/password/change' : '/dashboard'} replace /> : <AuthScreen key="login" onDirtyChange={onDirtyChange} onSubmit={values => {
          const result = loginMock(auth, values.loginId ?? '', values.password ?? '')
          setAuth(result.auth)
          return result.errors
        }} />} />
        <Route element={!session ? <Navigate to="/login" replace /> : session.mustChangePassword && location.pathname !== '/password/change' ? <Navigate to="/password/change" replace /> : <Outlet />}>
          <Route path="/password/change" element={<AuthScreen key={`password-${session?.loginId}`} changePassword requiredChange={session?.mustChangePassword} loginId={session?.loginId} onDirtyChange={onDirtyChange} onSubmit={values => {
            const result = changeMockPassword(auth, values.currentPassword ?? '', values.newPassword ?? '', values.confirmation ?? '', getNextTimestamp())
            if (!Object.keys(result.errors).length) dirtyRef.current = false
            setAuth(result.auth)
            return result.errors
          }} />} />
          <Route path="/" element={<Navigate to="/dashboard" replace />} />
          <Route path="/dashboard" element={<Dashboard key={userId} role={role} userId={userId} requests={requests} knowledge={knowledge} />} />
          <Route path="/requests" element={<Requests key={userId} {...requestProps} />} />
          <Route path="/requests/:requestId" element={<RequestDetail key={userId} {...requestProps} />} />
          <Route path="/settings/accounts" element={<Accounts key={userId} auth={auth} getNextTimestamp={getNextTimestamp} onDirtyChange={onDirtyChange} onCommit={(next, temporary) => { dirtyRef.current = false; setAuth(next); if (temporary) setIssued(temporary) }} />} />
          <Route path="/knowledge/reviews" element={<KnowledgeList key={role} {...knowledgeProps} review />} />
          <Route path="/knowledge/reviews/new" element={<KnowledgeReview key={role} {...reviewProps} />} />
          <Route path="/knowledge/reviews/:documentId/versions/:version" element={<KnowledgeReview key={role} {...reviewProps} />} />
          <Route path="/knowledge/reviews/*" element={<KnowledgeList key={role} {...knowledgeProps} review />} />
          <Route path="/knowledge" element={<KnowledgeList key={role} {...knowledgeProps} />} />
          <Route path="/knowledge/:documentId" element={<KnowledgeDetail key={`${role}-${location.pathname}`} {...knowledgeProps} />} />
          <Route path="*" element={<PendingScreen title="ページが見つかりません" />} />
        </Route>
      </Routes>
      {issued && <TemporaryPasswordDialog issued={issued} onClose={() => setIssued(null)} />}
      {blocker.state === 'blocked' && <DiscardDialog onCancel={() => blocker.reset()} onDiscard={discardAndNavigate} />}
      {pendingExit && <DiscardDialog onCancel={() => setPendingExit(null)} onDiscard={discardAndExit} />}
    </AppLayout>
  )
}
