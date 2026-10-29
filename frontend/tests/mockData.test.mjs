import assert from 'node:assert/strict'
import test from 'node:test'
import {
  demoUsers,
  formatDemoDate,
  getCoverageCounts,
  getDashboardData,
  mockRequests,
  getRequestList,
  getVisibleRequests,
  registerRequest,
  updateRequest,
  validateRequest,
  nextMockTimestamp,
} from '../src/lib/mockData.ts'

test('社員には自分の問い合わせだけを返し、下書き・Radarを含めない', () => {
  const data = getDashboardData('employee')
  assert.equal(data.total, 3)
  assert.deepEqual(data.counts, { open: 1, in_progress: 1, resolved: 1 })
  assert.ok(data.recentRequests.every(request => request.requesterId === demoUsers.employee.id))
  assert.deepEqual(data.reviews, [])
  assert.equal(data.radar, null)
})

test('全体の件数は合成資料と一致し、自分の担当分は更新順で返す', () => {
  const data = getDashboardData('operator')
  assert.equal(data.total, mockRequests.length)
  assert.equal(Object.values(data.counts).reduce((sum, value) => sum + value, 0), data.total)
  assert.deepEqual(data.counts, { open: 3, in_progress: 4, resolved: 5 })
  assert.equal(data.unassignedCount, 3)
  assert.equal(data.ownOpenCount, 2)
  assert.ok(data.recentRequests.every(request => request.assigneeId === demoUsers.operator.id))
  assert.deepEqual(data.recentRequests.map(request => request.id), ['REQ-0002', 'REQ-0008', 'REQ-0003', 'REQ-0004', 'REQ-0009'])
})

test('資料がない場合は両役割とも0件となり、過去の候補を残さない', () => {
  for (const role of ['employee', 'operator']) {
    const data = getDashboardData(role, 'empty')
    assert.equal(data.total, 0)
    assert.deepEqual(data.counts, { open: 0, in_progress: 0, resolved: 0 })
    assert.deepEqual(data.recentRequests, [])
    assert.deepEqual(data.reviews, [])
    assert.equal(data.radar, null)
  }
})

test('Radarは存在する5件を参照し、未判定を文書なしに混ぜない', () => {
  const radar = getDashboardData('operator').radar
  assert.ok(radar)
  assert.equal(new Set(radar.evidence.map(item => item.requestId)).size, 5)
  assert.equal(radar.requests.length, 5)
  assert.ok(radar.evidence.every(item => radar.requests.some(request => request.id === item.requestId)))
  assert.deepEqual(radar.coverageCounts, { covered: 0, uncovered: 3, unknown: 2 })
})

test('文書の対応状況を3区分で集計し、未判定を文書なしに含めない', () => {
  const counts = getCoverageCounts([
    { coverage: 'covered' },
    { coverage: 'uncovered' },
    { coverage: 'unknown' },
    { coverage: 'covered' },
    { coverage: 'unknown' },
    { coverage: 'unknown' },
  ])

  assert.deepEqual(counts, { covered: 2, uncovered: 1, unknown: 3 })
})

test('根拠がない場合も文書の対応状況をすべて0件で返す', () => {
  assert.deepEqual(getCoverageCounts([]), { covered: 0, uncovered: 0, unknown: 0 })
})

test('UTCの時刻も日本時間で表示する', () => {
  assert.equal(formatDemoDate('2026-10-30T00:00:00Z'), '2026/10/30 09:00')
})

const at = '2026-10-30T10:00:00+09:00'
const input = { title: '  VPN接続の確認  ', body: '新端末で認証エラーが出ます。\n再設定方法を教えてください。', department: 'IT' }

test('一覧の状態・担当者・部署・全角検索を組み合わせる', () => {
  const data = getRequestList(mockRequests, 'operator', new URLSearchParams('assignee=me&status=unresolved&department=IT&q=ＶＰＮ'))
  assert.deepEqual(data.rows.map(request => request.id), ['REQ-0008'])
  assert.equal(data.total, 12)
  assert.equal(data.count, 1)
  assert.equal(getRequestList(mockRequests, 'operator', new URLSearchParams('assignee=unassigned')).count, getDashboardData('operator').unassignedCount)
  assert.equal(getRequestList(mockRequests, 'operator', new URLSearchParams('assignee=me&status=unresolved')).count, getDashboardData('operator').ownOpenCount)
  for (const status of ['open', 'in_progress', 'resolved']) {
    assert.equal(getRequestList(mockRequests, 'operator', new URLSearchParams({ status })).count, getDashboardData('operator').counts[status])
  }
})

test('社員はURLの担当者条件にかかわらず自己の問い合わせのみを取得する', () => {
  const data = getRequestList(mockRequests, 'employee', new URLSearchParams('assignee=operator-02'))
  assert.equal(data.count, 3)
  assert.ok(data.rows.every(request => request.requesterId === demoUsers.employee.id))
  assert.equal(getVisibleRequests(mockRequests, 'employee').find(request => request.id === 'REQ-0002'), undefined)
})

test('初期資料なしと検索結果なしを区別し、不正なページ・範囲外ページを補正する', () => {
  assert.equal(getRequestList([], 'employee', new URLSearchParams()).total, 0)
  const noResults = getRequestList(mockRequests, 'operator', new URLSearchParams('q=存在しない文字列'))
  assert.equal(noResults.count, 0)
  assert.equal(noResults.total, 12)
  assert.equal(getRequestList(mockRequests, 'operator', new URLSearchParams('status=invalid&department=invalid&assignee=invalid')).count, 12)
  for (const page of ['NaN', '-1', '1.5', '9999', 'Infinity']) {
    assert.equal(getRequestList(mockRequests, 'operator', new URLSearchParams({ page })).page, 1)
  }
  const many = Array.from({ length: 25 }, (_, index) => ({ ...mockRequests[0], id: `REQ-${String(index + 1).padStart(4, '0')}` }))
  const second = getRequestList(many, 'operator', new URLSearchParams('page=2'))
  assert.equal(second.rows.length, 5)
  assert.equal(second.pageCount, 2)
  assert.equal(getRequestList(many, 'operator', new URLSearchParams('page=2&q=存在しない')).page, 1)
})

test('登録入力の空白・上限・部署を検証する', () => {
  assert.ok(Object.values(validateRequest({ title: '　 ', body: '\n', department: '' })).every(Boolean))
  assert.ok(validateRequest({ ...input, title: '題'.repeat(121) }).title)
  assert.ok(validateRequest({ ...input, body: '文'.repeat(5001) }).body)
  assert.ok(validateRequest({ ...input, department: '不明' }).department)
  assert.throws(() => registerRequest(mockRequests, 'employee', { ...input, body: ' ' }, at))
})

test('登録は初期資料を変更せず、一覧・詳細・Dashboardに同じ1件を追加する', () => {
  const result = registerRequest(mockRequests, 'employee', input, at)
  assert.equal(mockRequests.length, 12)
  assert.equal(result.request.id, 'REQ-0013')
  assert.equal(result.request.title, 'VPN接続の確認')
  assert.equal(result.request.requesterId, demoUsers.employee.id)
  assert.equal(result.request.events.length, 1)
  assert.equal(getDashboardData('employee', 'normal', result.requests).counts.open, 2)
  assert.equal(getRequestList(result.requests, 'employee', new URLSearchParams()).rows[0].id, result.request.id)
  assert.equal(registerRequest(result.requests, 'operator', input, at).request.id, 'REQ-0014')
})

test('未割り当てから対応を開始できず、社員は担当者の操作を利用できない', () => {
  assert.throws(() => updateRequest(mockRequests, 'operator', 'REQ-0001', { type: 'start' }, at), /担当者を割り当て/)
  assert.throws(() => updateRequest(mockRequests, 'employee', 'REQ-0001', { type: 'assign', assigneeId: 'operator-01' }, at), /担当者のみ/)
  assert.throws(() => updateRequest(mockRequests, 'employee', 'REQ-0001', { type: 'resolve', resolution: '解決' }, at), /担当者のみ/)
  assert.throws(() => updateRequest(mockRequests, 'operator', 'REQ-0001', { type: 'assign', assigneeId: 'employee-01' }, at), /担当者を選択/)
})

test('配属・対応開始・解決後の件数・解決内容・時刻・変更者は矛盾しない', () => {
  let requests = updateRequest(mockRequests, 'operator', 'REQ-0001', { type: 'assign', assigneeId: 'operator-01' }, at)
  assert.equal(getDashboardData('operator', 'normal', requests).unassignedCount, 2)
  assert.equal(getDashboardData('operator', 'normal', requests).ownOpenCount, 3)
  requests = updateRequest(requests, 'operator', 'REQ-0001', { type: 'start' }, at)
  assert.throws(() => updateRequest(requests, 'operator', 'REQ-0001', { type: 'start' }, at))
  for (const resolution of [' ', '　\n', '文'.repeat(5001)]) {
    assert.throws(() => updateRequest(requests, 'operator', 'REQ-0001', { type: 'resolve', resolution }, at))
  }
  requests = updateRequest(requests, 'operator', 'REQ-0001', { type: 'resolve', resolution: '  再登録後のVPN接続を確認しました。  ' }, at)
  const request = requests.find(item => item.id === 'REQ-0001')
  assert.equal(request.status, 'resolved')
  assert.equal(request.resolution, '再登録後のVPN接続を確認しました。')
  assert.equal(request.resolvedAt, at)
  assert.equal(request.updatedAt, at)
  assert.equal(request.events.length, 4)
  assert.equal(request.events.at(-1).actorId, demoUsers.operator.id)
  assert.ok(request.events.at(-1).description.includes(request.resolution))
  assert.deepEqual(getDashboardData('operator', 'normal', requests).counts, { open: 2, in_progress: 4, resolved: 6 })
  assert.equal(getDashboardData('operator', 'normal', requests).ownOpenCount, 2)
  assert.equal(getRequestList(requests, 'employee', new URLSearchParams('status=resolved')).count, 2)
  assert.equal(mockRequests[0].status, 'open')
})

test('社員の本文編集は自己の未解決分に限り、解決後の変更は拒否する', () => {
  const requests = updateRequest(mockRequests, 'employee', 'REQ-0001', { type: 'edit', body: '更新した症状です。' }, at)
  assert.equal(requests[0].body, '更新した症状です。')
  assert.equal(requests[0].events.at(-1).actorId, demoUsers.employee.id)
  assert.throws(() => updateRequest(mockRequests, 'employee', 'REQ-0002', { type: 'edit', body: '変更' }, at))
  assert.throws(() => updateRequest(mockRequests, 'employee', 'REQ-0004', { type: 'edit', body: '変更' }, at), /解決済み/)
  assert.throws(() => updateRequest(mockRequests, 'operator', 'REQ-0004', { type: 'assign', assigneeId: 'operator-02' }, at), /解決済み/)
})

test('合成資料の登録・対応・解決の時刻と解決内容が整合する', () => {
  for (const request of mockRequests) {
    assert.ok(request.body.trim())
    assert.ok(Date.parse(request.createdAt) <= Date.parse(request.updatedAt))
    assert.ok(request.events.every((event, index, events) => index === 0 || Date.parse(events[index - 1].at) <= Date.parse(event.at)))
    assert.equal(Boolean(request.resolution && request.resolvedAt), request.status === 'resolved')
  }
})

test('操作時刻は実時計に依存せず、初期基準・直前の操作より1分進む', () => {
  assert.equal(nextMockTimestamp(mockRequests), '2026-10-30T00:01:00.000Z')
  const result = registerRequest(mockRequests, 'employee', input, nextMockTimestamp(mockRequests))
  assert.equal(nextMockTimestamp(result.requests), '2026-10-30T00:02:00.000Z')
  assert.equal(getRequestList(result.requests, 'employee', new URLSearchParams()).rows[0].id, result.request.id)
})
