import { useCallback, useRef, useState } from 'react'
import { Link, Navigate, Route, Routes, useBeforeUnload, useBlocker, useLocation } from 'react-router'
import AppLayout from './components/AppLayout'
import Dashboard from './features/dashboard/Dashboard'
import { mockKnowledge, mockRequests, nextMockTimestamp } from './lib/mockData'
import type { DemoRole } from './lib/mockData'
import Requests from './features/requests/Requests'
import RequestDetail from './features/requests/RequestDetail'
import DiscardDialog from './components/DiscardDialog'
import KnowledgeList, { KnowledgeDetail } from './features/knowledge/Knowledge'
import KnowledgeReview from './features/knowledge/KnowledgeReview'
import DemoLogin from './features/knowledge/DemoLogin'

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
  const [role, setRole] = useState<DemoRole>('operator')
  const [requests, setRequests] = useState(mockRequests)
  const [knowledge, setKnowledge] = useState(mockKnowledge)
  const [pendingRole, setPendingRole] = useState<DemoRole | null>(null)
  const dirtyRef = useRef(false)
  const onDirtyChange = useCallback((dirty: boolean) => { dirtyRef.current = dirty }, [])
  const blocker = useBlocker(() => dirtyRef.current)
  useBeforeUnload(useCallback((event: BeforeUnloadEvent) => {
    if (dirtyRef.current) {
      event.preventDefault()
      event.returnValue = ''
    }
  }, []))

  function changeRole(nextRole: DemoRole) {
    if (nextRole === role) return
    if (dirtyRef.current) setPendingRole(nextRole)
    else setRole(nextRole)
  }

  function discardAndNavigate() {
    if (blocker.state !== 'blocked') return
    dirtyRef.current = false
    blocker.proceed()
  }

  function discardAndChangeRole() {
    if (!pendingRole) return
    dirtyRef.current = false
    setRole(pendingRole)
    setPendingRole(null)
  }

  const getNextTimestamp = () => nextMockTimestamp(requests, knowledge)
  const requestProps = { role, requests, onRequestsChange: setRequests, onDirtyChange, getNextTimestamp }
  const knowledgeProps = { role, knowledge }
  const reviewProps = { ...knowledgeProps, requests, onKnowledgeChange: setKnowledge, onDirtyChange, getNextTimestamp }

  return (
    <AppLayout role={role} onRoleChange={changeRole}>
      <Routes>
        <Route path="/" element={<Navigate to="/dashboard" replace />} />
        <Route path="/dashboard" element={<Dashboard key={role} role={role} requests={requests} knowledge={knowledge} />} />
        <Route path="/requests" element={<Requests key={role} {...requestProps} />} />
        <Route path="/requests/:requestId" element={<RequestDetail key={role} {...requestProps} />} />
        <Route path="/knowledge/reviews" element={<KnowledgeList key={role} {...knowledgeProps} review />} />
        <Route path="/knowledge/reviews/new" element={<KnowledgeReview key={role} {...reviewProps} />} />
        <Route path="/knowledge/reviews/:documentId/versions/:version" element={<KnowledgeReview key={role} {...reviewProps} />} />
        <Route path="/knowledge/reviews/*" element={<KnowledgeList key={role} {...knowledgeProps} review />} />
        <Route path="/knowledge" element={<KnowledgeList key={role} {...knowledgeProps} />} />
        <Route path="/knowledge/:documentId" element={<KnowledgeDetail key={`${role}-${location.pathname}`} {...knowledgeProps} />} />
        <Route path="/login" element={<DemoLogin key={role} role={role} onRoleChange={changeRole} />} />
        <Route path="*" element={<PendingScreen title="ページが見つかりません" />} />
      </Routes>
      {blocker.state === 'blocked' && <DiscardDialog onCancel={() => blocker.reset()} onDiscard={discardAndNavigate} />}
      {pendingRole && <DiscardDialog onCancel={() => setPendingRole(null)} onDiscard={discardAndChangeRole} />}
    </AppLayout>
  )
}
