export type DemoRole = 'employee' | 'operator'
export type RequestStatus = 'open' | 'in_progress' | 'resolved'
type CoverageStatus = 'covered' | 'uncovered' | 'unknown'

export const demoUsers = {
  employee: { id: 'employee-01', name: '佐藤 美咲', roleLabel: '社員' },
  operator: { id: 'operator-01', name: '山田 花子', roleLabel: '担当者' },
}

export const statusLabels: Record<RequestStatus, string> = {
  open: '未対応', in_progress: '対応中', resolved: '解決済み',
}

export const demoAsOf = '2026-10-30T09:00:00+09:00'
export const radarPeriodStart = '2026-09-30T09:00:00+09:00'

export type MockRequest = {
  id: string
  title: string
  status: RequestStatus
  requesterId: string
  assigneeId: string | null
  department: string
  updatedAt: string
}

export const mockRequests: MockRequest[] = [
  { id: 'REQ-0001', title: 'MFA端末を変更した後、VPNに接続できない', status: 'open', requesterId: 'employee-01', assigneeId: null, department: 'IT', updatedAt: '2026-10-30T08:40:00+09:00' },
  { id: 'REQ-0002', title: '経費精算の申請が差し戻された理由を確認したい', status: 'in_progress', requesterId: 'employee-02', assigneeId: 'operator-01', department: '経理', updatedAt: '2026-10-30T08:20:00+09:00' },
  { id: 'REQ-0003', title: 'スマートフォン交換後にVPNの追加認証が通らない', status: 'resolved', requesterId: 'employee-03', assigneeId: 'operator-01', department: 'IT', updatedAt: '2026-10-29T16:30:00+09:00' },
  { id: 'REQ-0004', title: '新しい端末でVPNの認証アプリを再設定したい', status: 'resolved', requesterId: 'employee-01', assigneeId: 'operator-01', department: 'IT', updatedAt: '2026-10-28T15:10:00+09:00' },
  { id: 'REQ-0005', title: '会議室の予約が重複している', status: 'in_progress', requesterId: 'employee-04', assigneeId: 'operator-02', department: '総務', updatedAt: '2026-10-28T14:00:00+09:00' },
  { id: 'REQ-0006', title: '年末調整の提出先を確認したい', status: 'resolved', requesterId: 'employee-05', assigneeId: 'operator-02', department: '人事', updatedAt: '2026-10-27T11:00:00+09:00' },
  { id: 'REQ-0007', title: '開発用ソフトウェアの利用を申請したい', status: 'open', requesterId: 'employee-02', assigneeId: null, department: 'IT', updatedAt: '2026-10-27T10:00:00+09:00' },
  { id: 'REQ-0008', title: '認証端末の変更後からVPNログインに失敗する', status: 'in_progress', requesterId: 'employee-01', assigneeId: 'operator-01', department: 'IT', updatedAt: '2026-10-29T17:45:00+09:00' },
  { id: 'REQ-0009', title: '機種変更後のVPNワンタイムコードが認識されない', status: 'resolved', requesterId: 'employee-02', assigneeId: 'operator-01', department: 'IT', updatedAt: '2026-10-24T13:00:00+09:00' },
  { id: 'REQ-0010', title: '来客用モニターの接続ケーブルを借りたい', status: 'open', requesterId: 'employee-05', assigneeId: null, department: '総務', updatedAt: '2026-10-26T09:00:00+09:00' },
  { id: 'REQ-0011', title: '貸与PCの返却手順を確認したい', status: 'resolved', requesterId: 'employee-04', assigneeId: 'operator-01', department: 'IT', updatedAt: '2026-10-23T16:00:00+09:00' },
  { id: 'REQ-0012', title: '住所変更の申請に必要な書類を確認したい', status: 'in_progress', requesterId: 'employee-06', assigneeId: 'operator-02', department: '人事', updatedAt: '2026-10-26T14:00:00+09:00' },
]

const mockReviews = [
  { id: 'KB-0016', version: 1, title: 'MFA端末変更後のVPN認証手順', sourceId: 'REQ-0003', updatedAt: '2026-10-29T17:00:00+09:00' },
  { id: 'KB-0017', version: 1, title: '貸与PCの返却前に確認すること', sourceId: 'REQ-0011', updatedAt: '2026-10-23T17:00:00+09:00' },
]

const mockRadar = {
  id: 'mfa-vpn',
  title: 'MFA端末変更後のVPN認証エラー',
  summary: '端末変更後に追加認証が通らない問い合わせが繰り返されています。',
  document: { id: 'KB-0001', title: 'VPNの基本接続手順', version: 1 },
  reason: '一般的な接続手順には、端末変更後の認証再設定が含まれていません。解決記録の確認が必要です。',
  evidence: [
    { requestId: 'REQ-0001', coverage: 'unknown' },
    { requestId: 'REQ-0003', coverage: 'uncovered' },
    { requestId: 'REQ-0004', coverage: 'uncovered' },
    { requestId: 'REQ-0008', coverage: 'unknown' },
    { requestId: 'REQ-0009', coverage: 'uncovered' },
  ] satisfies { requestId: string; coverage: CoverageStatus }[],
}

export function getCoverageCounts(evidence: readonly { coverage: CoverageStatus }[]) {
  const counts: Record<CoverageStatus, number> = { covered: 0, uncovered: 0, unknown: 0 }

  for (const item of evidence) {
    counts[item.coverage] += 1
  }

  return counts
}

export function getDashboardData(role: DemoRole, scenario: 'normal' | 'empty' = 'normal') {
  const requests = scenario === 'empty' ? [] : mockRequests
  const user = demoUsers[role]
  const visible = role === 'employee' ? requests.filter(request => request.requesterId === user.id) : requests
  const counts: Record<RequestStatus, number> = { open: 0, in_progress: 0, resolved: 0 }
  for (const request of visible) counts[request.status] += 1
  const assigned = visible.filter(request => request.assigneeId === user.id)

  return {
    counts,
    total: visible.length,
    recentRequests: [...(role === 'operator' ? assigned : visible)]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 5),
    unassignedCount: visible.filter(request => request.assigneeId === null && request.status !== 'resolved').length,
    ownOpenCount: assigned.filter(request => request.status !== 'resolved').length,
    reviews: role === 'operator' && scenario !== 'empty' ? mockReviews : [],
    radar: role === 'operator' && scenario !== 'empty' ? {
      ...mockRadar,
      coverageCounts: getCoverageCounts(mockRadar.evidence),
      requests: requests.filter(request => mockRadar.evidence.some(item => item.requestId === request.id)),
    } : null,
  }
}

export function formatDemoDate(value: string) {
  return new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(new Date(value))
}

export type DashboardData = ReturnType<typeof getDashboardData>
