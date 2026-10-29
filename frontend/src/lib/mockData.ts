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
  createdAt: string
  body: string
  resolution: string
  resolvedAt: string | null
  events: { actorId: string; at: string; description: string }[]
}

const requestSummaries = [
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
] satisfies Omit<MockRequest, 'createdAt' | 'body' | 'resolution' | 'resolvedAt' | 'events'>[]

export const departments = ['IT', '人事', '総務', '経理']
export const operators = [demoUsers.operator, { id: 'operator-02', name: '鈴木 健太' }]
const people: Record<string, string> = {
  'employee-01': '佐藤 美咲', 'employee-02': '田中 大輔', 'employee-03': '高橋 葵',
  'employee-04': '伊藤 翔太', 'employee-05': '渡辺 真由', 'employee-06': '小林 遥',
  'operator-01': '山田 花子', 'operator-02': '鈴木 健太',
}
export function personName(id: string | null) {
  return id === null ? '未割り当て' : people[id] ?? '不明な利用者'
}

const requestBodies: Record<string, string> = {
  'REQ-0001': '業務用スマートフォンを交換してから、VPNの追加認証に失敗します。\nパスワード入力までは進みますが、新しい端末のコードが受け付けられません。\n在宅勤務で使うため、再設定の手順を教えてください。',
  'REQ-0002': '出張の交通費申請が差し戻されました。\n領収書は添付していますが、どの項目を修正すればよいか分かりません。申請画面の確認をお願いします。',
  'REQ-0003': 'スマートフォン交換後、VPNで追加認証エラーが出ます。\n認証アプリを移しましたが接続できません。旧端末は手元にあります。',
  'REQ-0004': '新しい端末へ認証アプリを設定する方法を知りたいです。\nVPNの基本接続手順には、端末を変更した場合の説明が見当たりませんでした。',
  'REQ-0005': '来週の定例会議と別部署の予約が同じ会議室・時間帯に入っています。\n予約状況を確認して調整をお願いします。',
  'REQ-0006': '年末調整の書類は、社内便と電子申請のどちらで提出すればよいでしょうか。\n原本が必要な書類も教えてください。',
  'REQ-0007': '開発用のソフトウェアを利用したいです。\n申請先と、利用目的の記載方法を確認したいです。',
  'REQ-0008': '認証端末を変更してからVPNにログインできません。\n接続手順を最初から試しましたが、追加認証の段階で止まります。',
  'REQ-0009': '機種変更後、VPNのワンタイムコードが認識されません。\n端末の時刻設定を確認しても解消しないため、再登録をお願いします。',
  'REQ-0010': '来客説明会で使うモニター用の接続ケーブルを借りたいです。\nUSB-C対応の備品の貸出方法を教えてください。',
  'REQ-0011': '貸与PCの返却に必要な作業と返却先を確認したいです。\n保存してある業務資料の扱いも教えてください。',
  'REQ-0012': '引っ越し後の住所変更を申請したいです。\n社内申請に必要な書類と提出先を確認したいです。',
}
const resolutions: Record<string, string> = {
  'REQ-0003': '本人確認後、旧端末の認証登録を解除し、新端末で再登録しました。申請者とVPN接続が完了することを確認しました。',
  'REQ-0004': '本人確認を行い、新端末の認証アプリを再登録しました。テスト接続で追加認証が通ることを申請者と確認しました。',
  'REQ-0006': '電子申請の提出先と、原本が必要な書類の社内窓口を案内しました。申請者から提出方法の確認を受けました。',
  'REQ-0009': '本人確認後、認証端末の登録を更新しました。新端末のコードでVPNに接続できることを確認しました。',
  'REQ-0011': '業務資料を所定の共有領域に移し、端末の返却窓口と受付日時を案内しました。返却の受領を確認しました。',
}

export const mockRequests: MockRequest[] = requestSummaries.map(request => {
  const createdAt = new Date(Date.parse(request.updatedAt) - 3_600_000).toISOString()
  const events = [{ actorId: request.requesterId, at: createdAt, description: '問い合わせを登録しました。' }]
  if (request.assigneeId) {
    events.push({ actorId: request.assigneeId, at: new Date(Date.parse(createdAt) + 600_000).toISOString(), description: `${personName(request.assigneeId)}を担当者に割り当てました。` })
    events.push({ actorId: request.assigneeId, at: new Date(Date.parse(createdAt) + 1_200_000).toISOString(), description: '対応を開始しました。' })
  }
  if (request.status === 'resolved') {
    events.push({ actorId: request.assigneeId!, at: request.updatedAt, description: `解決内容を記録しました。\n${resolutions[request.id]}` })
  }
  return { ...request, createdAt, body: requestBodies[request.id], resolution: resolutions[request.id] ?? '', resolvedAt: request.status === 'resolved' ? request.updatedAt : null, events }
})

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

export function getDashboardData(role: DemoRole, scenario: 'normal' | 'empty' = 'normal', source = mockRequests) {
  const requests = scenario === 'empty' ? [] : source
  const user = demoUsers[role]
  const visible = getVisibleRequests(requests, role)
  const counts: Record<RequestStatus, number> = { open: 0, in_progress: 0, resolved: 0 }
  for (const request of visible) counts[request.status] += 1
  const assigned = visible.filter(request => request.assigneeId === user.id)

  return {
    asOf: latestMockTimestamp(requests),
    counts,
    total: visible.length,
    recentRequests: [...(role === 'operator' ? assigned : visible)]
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)).slice(0, 5),
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

export function getVisibleRequests(requests: MockRequest[], role: DemoRole) {
  return role === 'employee' ? requests.filter(request => request.requesterId === demoUsers.employee.id) : requests
}

export function getRequestFilters(params: URLSearchParams) {
  const query = (params.get('q') ?? '').normalize('NFKC').trim().toLocaleLowerCase('ja')
  const status = params.get('status') ?? ''
  const assignee = params.get('assignee') ?? ''
  const department = params.get('department') ?? ''
  return {
    query,
    status: status === 'unresolved' || Object.hasOwn(statusLabels, status) ? status : '',
    assignee: ['me', 'unassigned', ...operators.map(operator => operator.id)].includes(assignee) ? assignee : '',
    department: departments.includes(department) ? department : '',
  }
}

export function getRequestList(requests: MockRequest[], role: DemoRole, params: URLSearchParams) {
  const visible = getVisibleRequests(requests, role)
  const { query, status, assignee, department } = getRequestFilters(params)
  const filtered = visible.filter(request => {
    const text = `${request.id} ${request.title} ${request.body}`.normalize('NFKC').toLocaleLowerCase('ja')
    const matchesStatus = !status || (status === 'unresolved' ? request.status !== 'resolved' : request.status === status)
    const matchesAssignee = role === 'employee' || !assignee || (assignee === 'unassigned'
      ? request.assigneeId === null && request.status !== 'resolved'
      : request.assigneeId === (assignee === 'me' ? demoUsers.operator.id : assignee))
    return text.includes(query) && matchesStatus && matchesAssignee && (!department || request.department === department)
  }).sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || b.id.localeCompare(a.id))
  const pageCount = Math.max(1, Math.ceil(filtered.length / 20))
  const requestedPage = Number(params.get('page'))
  const page = Number.isSafeInteger(requestedPage) ? Math.min(pageCount, Math.max(1, requestedPage)) : 1
  return { total: visible.length, count: filtered.length, page, pageCount, rows: filtered.slice((page - 1) * 20, page * 20) }
}

export type RequestInput = { title: string; body: string; department: string }

function latestMockTimestamp(requests: MockRequest[]) {
  return new Date(Math.max(Date.parse(demoAsOf), ...requests.map(request => Date.parse(request.updatedAt)))).toISOString()
}

export function nextMockTimestamp(requests: MockRequest[]) {
  return new Date(Date.parse(latestMockTimestamp(requests)) + 60_000).toISOString()
}

export function validateRequest(input: RequestInput) {
  return {
    title: !input.title.trim() ? '件名を入力してください。' : input.title.trim().length > 120 ? '件名は120文字以内で入力してください。' : '',
    body: !input.body.trim() ? '内容を入力してください。' : input.body.trim().length > 5000 ? '内容は5000文字以内で入力してください。' : '',
    department: !departments.includes(input.department) ? '担当部署を選択してください。' : '',
  }
}

export function registerRequest(requests: MockRequest[], role: DemoRole, input: RequestInput, at: string) {
  if (Object.values(validateRequest(input)).some(Boolean)) throw new Error('入力内容を確認してください。')
  const nextNumber = Math.max(0, ...requests.map(request => Number(request.id.slice(4)))) + 1
  const request: MockRequest = {
    id: `REQ-${String(nextNumber).padStart(4, '0')}`, title: input.title.trim(), body: input.body.trim(),
    department: input.department, requesterId: demoUsers[role].id, assigneeId: null, status: 'open',
    createdAt: at, updatedAt: at, resolution: '', resolvedAt: null,
    events: [{ actorId: demoUsers[role].id, at, description: '問い合わせを登録しました。' }],
  }
  return { requests: [request, ...requests], request }
}

export type RequestAction =
  | { type: 'assign'; assigneeId: string }
  | { type: 'start' }
  | { type: 'resolve'; resolution: string }
  | { type: 'edit'; body: string }

export function updateRequest(requests: MockRequest[], role: DemoRole, id: string, action: RequestAction, at: string) {
  const request = getVisibleRequests(requests, role).find(item => item.id === id)
  if (!request) throw new Error('この情報を表示する権限がないか、問い合わせが見つかりません。')
  if (request.status === 'resolved') throw new Error('解決済みの問い合わせは変更できません。')
  if (action.type !== 'edit' && role !== 'operator') throw new Error('この操作は担当者のみ利用できます。')
  let changes: Partial<MockRequest>
  let description: string
  switch (action.type) {
    case 'assign':
      if (!operators.some(operator => operator.id === action.assigneeId)) throw new Error('担当者を選択してください。')
      if (request.assigneeId === action.assigneeId) throw new Error('同じ担当者がすでに割り当てられています。')
      changes = { assigneeId: action.assigneeId }
      description = `担当者を${personName(request.assigneeId)}から${personName(action.assigneeId)}に変更しました。`
      break
    case 'start':
      if (request.status !== 'open' || !request.assigneeId) throw new Error('担当者を割り当ててから対応を開始してください。')
      changes = { status: 'in_progress' }
      description = '対応を開始しました。'
      break
    case 'resolve':
      if (request.status !== 'in_progress' || !request.assigneeId) throw new Error('担当者を割り当て、対応を開始してから解決してください。')
      if (!action.resolution.trim() || action.resolution.trim().length > 5000) throw new Error('解決内容を1〜5000文字で入力してください。')
      changes = { status: 'resolved', resolution: action.resolution.trim(), resolvedAt: at }
      description = `解決内容を記録しました。\n${action.resolution.trim()}`
      break
    case 'edit':
      if (role === 'employee' && request.requesterId !== demoUsers.employee.id) throw new Error('自分の問い合わせのみ編集できます。')
      if (!action.body.trim() || action.body.trim().length > 5000) throw new Error('内容を1〜5000文字で入力してください。')
      changes = { body: action.body.trim() }
      description = '問い合わせ内容を更新しました。'
      break
  }
  return requests.map(item => item.id === id ? {
    ...item, ...changes, updatedAt: at,
    events: [...item.events, { actorId: demoUsers[role].id, at, description }],
  } : item)
}
