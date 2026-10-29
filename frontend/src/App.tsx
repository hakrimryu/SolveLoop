import { useState } from 'react'
import { Link, Navigate, Route, Routes, useLocation } from 'react-router'
import AppLayout from './components/AppLayout'
import Dashboard from './features/dashboard/Dashboard'
import type { DemoRole } from './lib/mockData'

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

  return (
    <AppLayout role={role} onRoleChange={setRole}>
      <Routes>
        <Route path="/" element={<Navigate to="/dashboard" replace />} />
        <Route path="/dashboard" element={<Dashboard key={role} role={role} />} />
        <Route path="/requests/*" element={<PendingScreen title="問い合わせ" />} />
        <Route
          path="/knowledge/reviews/*"
          element={<PendingScreen title="ナレッジレビュー" restricted={role === 'employee'} />}
        />
        <Route path="/knowledge/*" element={<PendingScreen title="ナレッジ" />} />
        <Route path="/login" element={<PendingScreen title="ログイン" />} />
        <Route path="*" element={<PendingScreen title="ページが見つかりません" />} />
      </Routes>
    </AppLayout>
  )
}
