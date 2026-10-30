export type DemoRole = 'employee' | 'operator'
export type RequestStatus = 'open' | 'in_progress' | 'resolved'
type CoverageStatus = 'covered' | 'uncovered' | 'unknown'

export const demoUsers = {
  employee: { id: 'employee-01', name: '佐藤 美咲', roleLabel: '社員' },
  operator: { id: 'operator-01', name: '山田 花子', roleLabel: '担当者' },
}

export const mockLoginExamples = [
  { loginId: 'operator', password: 'Mock-Operator-2026!', role: 'operator', mustChangePassword: false },
  { loginId: 'employee', password: 'Mock-Temporary-2026!', role: 'employee', mustChangePassword: true },
] satisfies MockAccount[]

type MockAccount = { loginId: string; password: string; role: DemoRole; mustChangePassword: boolean }
export type MockAuth = { accounts: MockAccount[]; sessionLoginId: string | null; notice: string }
export type MockAuthErrors = Partial<Record<'loginId' | 'password' | 'currentPassword' | 'newPassword' | 'confirmation' | 'form', string>>
export type MockSessionEnd = 'logout' | 'expired'

export function createMockAuth(): MockAuth {
  return { accounts: mockLoginExamples.map(account => ({ ...account })), sessionLoginId: null, notice: '' }
}

export function getMockSession(auth: MockAuth) {
  return auth.accounts.find(account => account.loginId === auth.sessionLoginId) ?? null
}

export function loginMock(auth: MockAuth, loginId: string, password: string): { auth: MockAuth; errors: MockAuthErrors } {
  const errors: MockAuthErrors = {}
  if (!loginId.trim()) errors.loginId = 'ログインIDを入力してください。'
  if (!password.trim()) errors.password = 'パスワードを入力してください。'
  if (Object.keys(errors).length) return { auth, errors }
  const account = auth.accounts.find(item => item.loginId === loginId && item.password === password)
  if (!account) return { auth, errors: { form: 'ログインIDまたはパスワードが正しくありません。もう一度入力してください。' } }
  return { auth: { ...auth, sessionLoginId: account.loginId, notice: 'ログイン成功（モック）。このタブ内のログイン状態を開始しました。' }, errors }
}

export function endMockSession(auth: MockAuth, reason: MockSessionEnd): MockAuth {
  return { ...auth, sessionLoginId: null, notice: reason === 'expired'
    ? 'セッションの有効期限が切れました（モック）。もう一度ログインしてください。入力中の内容は保存されません。'
    : 'ログアウトしました（モック）。このタブのログイン状態を終了しました。' }
}

export function changeMockPassword(auth: MockAuth, currentPassword: string, newPassword: string, confirmation: string): { auth: MockAuth; errors: MockAuthErrors } {
  const account = getMockSession(auth)
  if (!account) return { auth, errors: { form: 'ログイン状態を確認できません。もう一度ログインしてください。' } }
  const errors: MockAuthErrors = {}
  if (!currentPassword.trim()) errors.currentPassword = '現在または仮パスワードを入力してください。'
  else if (currentPassword !== account.password) errors.currentPassword = '現在または仮パスワードが正しくありません。'
  if (!newPassword.trim()) errors.newPassword = '新しいパスワードを入力してください。'
  else if (newPassword === account.password) errors.newPassword = '現在のパスワードとは異なる値を入力してください。'
  if (!confirmation.trim()) errors.confirmation = '確認用のパスワードを入力してください。'
  else if (newPassword !== confirmation) errors.confirmation = '新しいパスワードと確認用の入力が一致しません。'
  if (Object.keys(errors).length) return { auth, errors }
  return { auth: {
    ...auth,
    accounts: auth.accounts.map(item => item.loginId === account.loginId ? { ...item, password: newPassword, mustChangePassword: false } : item),
    sessionLoginId: null,
    notice: 'パスワード変更が完了しました（モック）。ログイン状態を終了しました。新しいパスワードでログインしてください。',
  }, errors }
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

export function getDashboardData(role: DemoRole, scenario: 'normal' | 'empty' = 'normal', source = mockRequests, knowledge = mockKnowledge) {
  const requests = scenario === 'empty' ? [] : source
  const user = demoUsers[role]
  const visible = getVisibleRequests(requests, role)
  const counts: Record<RequestStatus, number> = { open: 0, in_progress: 0, resolved: 0 }
  for (const request of visible) counts[request.status] += 1
  const assigned = visible.filter(request => request.assigneeId === user.id)

  return {
    asOf: latestMockTimestamp(requests, scenario === 'empty' ? [] : knowledge),
    counts,
    total: visible.length,
    recentRequests: [...(role === 'operator' ? assigned : visible)]
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)).slice(0, 5),
    unassignedCount: visible.filter(request => request.assigneeId === null && request.status !== 'resolved').length,
    ownOpenCount: assigned.filter(request => request.status !== 'resolved').length,
    reviews: scenario !== 'empty' ? getKnowledgeReviews(knowledge, role).filter(item => item.status === 'draft') : [],
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

function latestMockTimestamp(requests: MockRequest[], knowledge: KnowledgeVersion[] = []) {
  return new Date(Math.max(Date.parse(demoAsOf), ...requests.map(request => Date.parse(request.updatedAt)), ...knowledge.map(item => Date.parse(item.updatedAt)))).toISOString()
}

export function nextMockTimestamp(requests: MockRequest[], knowledge: KnowledgeVersion[] = []) {
  return new Date(Date.parse(latestMockTimestamp(requests, knowledge)) + 60_000).toISOString()
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

export type KnowledgeInput = { title: string; audience: string; department: string; body: string }
export type KnowledgeSource = { requestId: string; title: string; body: string; resolution: string; updatedAt: string; resolvedAt: string }
export type KnowledgeVersion = KnowledgeInput & {
  id: string
  version: number
  status: 'draft' | 'approved' | 'rejected'
  updatedAt: string
  sources: KnowledgeSource[]
  events: { at: string; description: string }[]
}
export const knowledgeStatusLabels = { draft: '下書き', approved: '承認済み', rejected: '差し戻し' }
export const emptyKnowledgeInput: KnowledgeInput = { title: '', audience: '', department: '', body: '' }

function snapshotResolution(request: MockRequest): KnowledgeSource {
  if (request.status !== 'resolved' || !request.resolution.trim() || !request.resolvedAt) {
    throw new Error('解決内容が記録された問い合わせのみ根拠にできます。')
  }
  return { requestId: request.id, title: request.title, body: request.body, resolution: request.resolution, updatedAt: request.updatedAt, resolvedAt: request.resolvedAt }
}

export const mockKnowledge: KnowledgeVersion[] = [
  { id: 'KB-0001', version: 1, status: 'approved', title: 'VPNの基本接続手順', audience: '社外から貸与PCで接続する社員', department: 'IT',
    body: '対象の症状\n社外から社内システムを利用する際の基本手順です。\n\n接続手順\n1. 貸与PCをインターネットに接続します。\n2. VPNアプリを開き、社内アカウントを入力します。\n3. 登録済み端末で追加認証を行います。\n4. 業務終了後はVPNから切断します。\n\n注意事項\n私物PCからは接続しないでください。認証端末を交換した場合の再設定はこの文書の対象外です。接続できない場合はIT担当へ問い合わせてください。', updatedAt: '2026-10-20T10:00:00+09:00', sources: [], events: [] },
  { id: 'KB-0002', version: 1, status: 'approved', title: '経費精算を申請する前の確認事項', audience: '交通費・出張費を申請する社員', department: '経理',
    body: '対象\n業務で立て替えた交通費・出張費の申請です。\n\n申請手順\n1. 利用日・目的・金額を入力します。\n2. 領収書と申請金額を照合します。\n3. 承認者を確認して申請します。\n\n注意事項\n差し戻しの場合は理由を読み、不明点を経理担当へ確認してください。', updatedAt: '2026-10-21T11:00:00+09:00', sources: [], events: [] },
  { id: 'KB-0003', version: 2, status: 'approved', title: '会議室の予約と利用後の確認', audience: '会議室を予約する全社員', department: '総務',
    body: '予約手順\n1. 社内カレンダーで空き時間を確認します。\n2. 利用人数と設備を確認して予約します。\n3. 終了後に設備の電源と忘れ物を確認します。\n\n予約が重複した場合\n予約者同士で利用目的を確認し、調整が難しい場合は総務担当へ連絡してください。', updatedAt: '2026-10-22T09:30:00+09:00', sources: [], events: [] },
  { id: 'KB-0016', version: 1, status: 'draft', title: 'MFA端末変更後のVPN認証手順', audience: '業務用認証端末を交換した社員', department: 'IT',
    body: '対象の症状\n端末交換後、VPNの追加認証コードが受け付けられない場合。\n\n対応手順\n1. IT担当へ端末変更を連絡します。\n2. 担当者の本人確認を受けます。\n3. 旧端末の登録解除と新端末の再登録を担当者と行います。\n4. 新端末のコードで接続できることを確認します。\n\n注意事項\n認証コードは問い合わせ本文に記載しないでください。登録解除を自己判断で行わないでください。',
    updatedAt: '2026-10-29T17:00:00+09:00', sources: [snapshotResolution(mockRequests.find(item => item.id === 'REQ-0003')!)], events: [{ at: '2026-10-29T17:00:00+09:00', description: '山田 花子が下書きを保存しました（合成資料）。' }] },
  { id: 'KB-0017', version: 1, status: 'draft', title: '貸与PCの返却前に確認すること', audience: '貸与PCを返却する社員', department: 'IT',
    body: '返却手順\n1. 業務資料を所定の共有領域へ移します。\n2. IT窓口に返却日を確認します。\n3. 貸与品をそろえ、受領確認を受けます。\n\n注意事項\n端末の初期化は自己判断で行わず、担当者の案内に従ってください。',
    updatedAt: '2026-10-23T17:00:00+09:00', sources: [snapshotResolution(mockRequests.find(item => item.id === 'REQ-0011')!)], events: [] },
  { id: 'KB-0018', version: 1, status: 'rejected', title: '年末調整の書類提出先', audience: '年末調整を行う社員', department: '人事', body: '電子申請と原本の提出先を確認します。詳細は人事へ連絡してください。',
    updatedAt: '2026-10-28T10:00:00+09:00', sources: [snapshotResolution(mockRequests.find(item => item.id === 'REQ-0006')!)], events: [{ at: '2026-10-28T10:00:00+09:00', description: '鈴木 健太が差し戻しました。理由：原本が必要な書類と提出窓口の説明が不足しています。' }] },
]

export function getPublishedKnowledge(knowledge: KnowledgeVersion[]) {
  const latest = new Map<string, KnowledgeVersion>()
  for (const item of knowledge) {
    if (item.status === 'approved' && item.version > (latest.get(item.id)?.version ?? 0)) latest.set(item.id, item)
  }
  return [...latest.values()].map(({ id, version, title, audience, department, body, updatedAt }) => ({ id, version, title, audience, department, body, updatedAt }))
}

export function getKnowledgeFilters(params: URLSearchParams) {
  const department = params.get('department') ?? ''
  return { query: (params.get('q') ?? '').normalize('NFKC').trim().toLocaleLowerCase('ja'), department: departments.includes(department) ? department : '' }
}

export function getKnowledgeList(knowledge: KnowledgeVersion[], params: URLSearchParams) {
  const published = getPublishedKnowledge(knowledge)
  const { query, department } = getKnowledgeFilters(params)
  const rows = published.filter(item => {
    const text = `${item.id} ${item.title} ${item.audience} ${item.body}`.normalize('NFKC').toLocaleLowerCase('ja')
    return query.split(/\s+/).every(word => text.includes(word)) && (!department || item.department === department)
  }).sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
  return { total: published.length, count: rows.length, rows }
}

export function getKnowledgeReviews(knowledge: KnowledgeVersion[], role: DemoRole, status = '') {
  if (role !== 'operator') return []
  return knowledge.filter(item => item.status !== 'approved' && (!['draft', 'rejected'].includes(status) || item.status === status))
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
}

export function validateKnowledge(input: KnowledgeInput) {
  return {
    title: !input.title.trim() || input.title.trim().length > 120 ? '件名を1〜120文字で入力してください。' : '',
    audience: !input.audience.trim() || input.audience.trim().length > 300 ? '適用対象を1〜300文字で入力してください。' : '',
    department: !departments.includes(input.department) ? '担当部署を選択してください。' : '',
    body: !input.body.trim() || input.body.trim().length > 20000 ? '本文を1〜20000文字で入力してください。症状・手順・注意事項を記載します。' : '',
  }
}

export function getKnowledgeSourceIssue(sources: KnowledgeSource[], requests: MockRequest[]) {
  return sources.some(source => {
    const current = requests.find(request => request.id === source.requestId)
    return !current || current.status !== 'resolved' || current.updatedAt !== source.updatedAt || current.body !== source.body || current.resolution !== source.resolution || current.resolvedAt !== source.resolvedAt
  }) ? '元の解決記録が変更されたか、参照できません。根拠の再確認が必要なため承認できません。' : ''
}

export function prepareKnowledgeDraft(knowledge: KnowledgeVersion[], requests: MockRequest[], role: DemoRole, sourceId: string | null, documentId: string | null) {
  requireOperator(role)
  if (sourceId && documentId) throw new Error('問い合わせからの作成と改訂版の作成は同時に指定できません。')
  if (documentId) {
    const published = getPublishedKnowledge(knowledge).find(item => item.id === documentId)
    if (!published) throw new Error('改訂元の承認済み文書が見つかりません。')
    if (knowledge.some(item => item.id === documentId && item.status !== 'approved')) throw new Error('この文書には未承認の版があります。レビュー一覧で確認してください。')
    const original = knowledge.find(item => item.id === documentId && item.version === published.version)!
    return { input: { title: published.title, audience: published.audience, department: published.department, body: published.body }, sources: original.sources }
  }
  if (sourceId) {
    const request = requests.find(item => item.id === sourceId)
    if (!request) throw new Error('元の問い合わせが見つかりません。')
    return { input: { ...emptyKnowledgeInput, title: request.title, department: request.department }, sources: [snapshotResolution(request)] }
  }
  return { input: { ...emptyKnowledgeInput }, sources: [] }
}

function requireOperator(role: DemoRole) {
  if (role !== 'operator') throw new Error('この操作は担当者のみ利用できます。')
}

export function saveKnowledgeDraft(knowledge: KnowledgeVersion[], role: DemoRole, input: KnowledgeInput, sources: KnowledgeSource[], at: string, target?: { id: string; version: number }, documentId?: string) {
  requireOperator(role)
  if (Object.values(validateKnowledge(input)).some(Boolean)) throw new Error('入力内容を確認してください。')
  const existing = target && knowledge.find(item => item.id === target.id && item.version === target.version)
  if (target && (!existing || existing.status !== 'draft')) throw new Error('編集できる下書きが見つかりません。')
  if (documentId) {
    if (!getPublishedKnowledge(knowledge).some(item => item.id === documentId)) throw new Error('改訂元の承認済み文書が見つかりません。')
    if (knowledge.some(item => item.id === documentId && item.status !== 'approved')) throw new Error('この文書には未承認の版があります。')
  }
  const id = existing ? existing.id : documentId ?? `KB-${String(Math.max(0, ...knowledge.map(item => Number(item.id.slice(3)))) + 1).padStart(4, '0')}`
  const version = existing ? existing.version : Math.max(0, ...knowledge.filter(item => item.id === id).map(item => item.version)) + 1
  const saved: KnowledgeVersion = {
    title: input.title.trim(), audience: input.audience.trim(), department: input.department, body: input.body.trim(),
    id, version, status: 'draft', updatedAt: at, sources: structuredClone(existing ? existing.sources : sources),
    events: [...(existing ? existing.events : []), { at, description: '山田 花子が下書きを保存しました。まだ公開されていません。' }],
  }
  return { knowledge: existing ? knowledge.map(item => item === existing ? saved : item) : [...knowledge, saved], saved }
}

export function reviewKnowledge(knowledge: KnowledgeVersion[], requests: MockRequest[], role: DemoRole, target: { id: string; version: number }, action: 'approve' | 'reject', reason: string, at: string) {
  requireOperator(role)
  const draft = knowledge.find(item => item.id === target.id && item.version === target.version)
  if (!draft || draft.status !== 'draft') throw new Error('確認待ちの下書きが見つかりません。')
  if (action === 'reject' && (!reason.trim() || reason.trim().length > 1000)) throw new Error('差し戻しの理由を1〜1000文字で入力してください。')
  if (action === 'approve') {
    if (Object.values(validateKnowledge(draft)).some(Boolean)) throw new Error('保存済みの入力内容を確認してください。')
    const issue = getKnowledgeSourceIssue(draft.sources, requests)
    if (issue) throw new Error(issue)
  }
  return knowledge.map(item => item === draft ? {
    ...item, status: action === 'approve' ? 'approved' as const : 'rejected' as const, updatedAt: at,
    events: [...item.events, { at, description: action === 'approve' ? '山田 花子が承認し、社員全員の検索に公開しました。' : `山田 花子が差し戻しました。理由：${reason.trim()}` }],
  } : item)
}
