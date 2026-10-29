import { useCallback, useRef, useState } from 'react'
import { Link, Navigate, Route, Routes, useBeforeUnload, useBlocker, useLocation } from 'react-router'
import AppLayout from './components/AppLayout'
import Dashboard from './features/dashboard/Dashboard'
import { mockRequests } from './lib/mockData'
import type { DemoRole } from './lib/mockData'
import Requests from './features/requests/Requests'
import RequestDetail from './features/requests/RequestDetail'
import DiscardDialog from './components/DiscardDialog'

function PendingScreen({ title, restricted = false }: { title: string; restricted?: boolean }) {
  const location = useLocation()

  return (
    <>
      <p className="eyebrow">画面モック・移動先の確認</p>
      <h1 tabIndex={-1}>{title}</h1>
      <div className="notice">
        <p>{restricted ? 'この情報を表示する権限がありません。' : 'この画面は準備中です。業務操作はまだ利用できません。'}</p>
        {!restricted && <p>移動先：<code>{location.pathname}{location.search}</code></p>}
        <Link to="/dashboard">ダッシュボードに戻る</Link>
      </div>
    </>
  )
}

export default function App() {
  const [role, setRole] = useState<DemoRole>('operator')
  const [requests, setRequests] = useState(mockRequests)
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

  const requestProps = { role, requests, onRequestsChange: setRequests, onDirtyChange }

  return (
    <AppLayout role={role} onRoleChange={changeRole}>
      <Routes>
        <Route path="/" element={<Navigate to="/dashboard" replace />} />
        <Route path="/dashboard" element={<Dashboard key={role} role={role} requests={requests} />} />
        <Route path="/requests" element={<Requests key={role} {...requestProps} />} />
        <Route path="/requests/:requestId" element={<RequestDetail key={role} {...requestProps} />} />
        <Route
          path="/knowledge/reviews/*"
          element={<PendingScreen title="ナレッジレビュー" restricted={role === 'employee'} />}
        />
        <Route path="/knowledge/*" element={<PendingScreen title="ナレッジ" />} />
        <Route path="/login" element={<PendingScreen title="ログイン" />} />
        <Route path="*" element={<PendingScreen title="ページが見つかりません" />} />
      </Routes>
      {blocker.state === 'blocked' && <DiscardDialog onCancel={() => blocker.reset()} onDiscard={discardAndNavigate} />}
      {pendingRole && <DiscardDialog onCancel={() => setPendingRole(null)} onDiscard={discardAndChangeRole} />}
    </AppLayout>
  )
}
