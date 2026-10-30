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
  mockKnowledge,
  getPublishedKnowledge,
  getKnowledgeList,
  getKnowledgeReviews,
  prepareKnowledgeDraft,
  saveKnowledgeDraft,
  reviewKnowledge,
  validateKnowledge,
  getKnowledgeSourceIssue,
} from '../src/lib/mockData.ts'
const knowledgeInput = { title: '新端末の認証手順', audience: '端末を交換した社員', department: 'IT', body: '本人確認を受け、担当者と登録を更新します。接続結果を確認します。' }
const draftTarget = { id: 'KB-0016', version: 1 }

test('一般検索は最新の承認版のみ返し、根拠・履歴を公開しない', () => {
  const published = getPublishedKnowledge(mockKnowledge)
  assert.equal(published.length, 3)
  assert.ok(published.every(item => !('sources' in item) && !('events' in item) && !('status' in item)))
  assert.equal(getKnowledgeList(mockKnowledge, new URLSearchParams('q=MFA端末変更')).count, 0)
  assert.equal(getKnowledgeList(mockKnowledge, new URLSearchParams('q=年末調整')).count, 0)
  assert.deepEqual(getKnowledgeReviews(mockKnowledge, 'employee'), [])
  assert.equal(getKnowledgeReviews(mockKnowledge, 'operator', 'draft').length, 2)
  assert.equal(getKnowledgeReviews(mockKnowledge, 'operator', 'rejected').length, 1)
})

test('知識検索は全角・本文・複数語と部署条件を使い、初期0件と不一致を区別する', () => {
  assert.equal(getKnowledgeList(mockKnowledge, new URLSearchParams('q=ＶＰＮ 接続&department=IT')).count, 1)
  assert.equal(getKnowledgeList(mockKnowledge, new URLSearchParams('q=ＶＰＮ&department=経理')).count, 0)
  assert.equal(getKnowledgeList(mockKnowledge, new URLSearchParams('q=存在しない')).total, 3)
  assert.equal(getKnowledgeList([], new URLSearchParams()).total, 0)
  assert.equal(getKnowledgeList(mockKnowledge, new URLSearchParams('department=不明')).count, 3)
})

test('知識の必須項目・空白・上限・部署を資料境界で検証する', () => {
  assert.ok(Object.values(validateKnowledge({ title: ' ', audience: '', department: '不明', body: '\n' })).every(Boolean))
  assert.ok(validateKnowledge({ ...knowledgeInput, title: 'あ'.repeat(121) }).title)
  assert.ok(validateKnowledge({ ...knowledgeInput, audience: 'あ'.repeat(301) }).audience)
  assert.ok(validateKnowledge({ ...knowledgeInput, body: 'あ'.repeat(20001) }).body)
  assert.ok(Object.values(validateKnowledge(knowledgeInput)).every(value => value === ''))
  assert.throws(() => saveKnowledgeDraft(mockKnowledge, 'operator', { ...knowledgeInput, body: '' }, [], nextMockTimestamp(mockRequests)), /入力内容/)
})

test('解決した問い合わせのみを根拠にし、手動本文を自動生成しない', () => {
  assert.throws(() => prepareKnowledgeDraft(mockKnowledge, mockRequests, 'operator', 'REQ-0001', null), /解決内容/)
  assert.throws(() => prepareKnowledgeDraft(mockKnowledge, mockRequests, 'operator', 'REQ-9999', null), /見つかりません/)
  const prepared = prepareKnowledgeDraft(mockKnowledge, mockRequests, 'operator', 'REQ-0003', null)
  assert.equal(prepared.input.body, '')
  assert.equal(prepared.sources[0].requestId, 'REQ-0003')
  assert.equal(prepared.sources[0].resolution, mockRequests.find(item => item.id === 'REQ-0003').resolution)
  assert.throws(() => prepareKnowledgeDraft(mockKnowledge, mockRequests, 'operator', 'REQ-0003', 'KB-0001'), /同時/)
})

test('下書き保存は公開せず、元資料を変更せずにDashboardの確認待ちへ加える', () => {
  const before = structuredClone(mockKnowledge)
  const prepared = prepareKnowledgeDraft(mockKnowledge, mockRequests, 'operator', 'REQ-0003', null)
  const result = saveKnowledgeDraft(mockKnowledge, 'operator', knowledgeInput, prepared.sources, nextMockTimestamp(mockRequests, mockKnowledge))
  assert.equal(result.saved.status, 'draft')
  assert.equal(getPublishedKnowledge(result.knowledge).length, 3)
  assert.equal(getKnowledgeList(result.knowledge, new URLSearchParams('q=新端末の認証手順')).count, 0)
  assert.equal(getDashboardData('operator', 'normal', mockRequests, result.knowledge).reviews.length, 3)
  assert.deepEqual(mockKnowledge, before)
  assert.notEqual(result.saved.sources, prepared.sources)
})

test('承認した保存版のみ検索に反映し、Dashboardの確認待ちを減らしてRadarの固定結果を保つ', () => {
  const before = getDashboardData('operator')
  const approved = reviewKnowledge(mockKnowledge, mockRequests, 'operator', draftTarget, 'approve', '', nextMockTimestamp(mockRequests, mockKnowledge))
  assert.equal(getKnowledgeList(approved, new URLSearchParams('q=MFA端末変更')).count, 1)
  assert.equal(getDashboardData('operator', 'normal', mockRequests, approved).reviews.length, 1)
  assert.deepEqual(getDashboardData('operator', 'normal', mockRequests, approved).radar, before.radar)
  assert.throws(() => reviewKnowledge(approved, mockRequests, 'operator', draftTarget, 'approve', '', nextMockTimestamp(mockRequests, approved)), /下書き/)
})

test('編集バッファは保存版を変更せず、再保存後に承認した内容だけが公開される', () => {
  const original = mockKnowledge.find(item => item.id === draftTarget.id)
  const buffer = { ...original, body: '更新した公開手順' }
  const firstApproved = reviewKnowledge(mockKnowledge, mockRequests, 'operator', draftTarget, 'approve', '', nextMockTimestamp(mockRequests))
  assert.equal(getPublishedKnowledge(firstApproved).find(item => item.id === draftTarget.id).body, original.body)
  const saved = saveKnowledgeDraft(mockKnowledge, 'operator', buffer, original.sources, nextMockTimestamp(mockRequests), draftTarget)
  const secondApproved = reviewKnowledge(saved.knowledge, mockRequests, 'operator', draftTarget, 'approve', '', nextMockTimestamp(mockRequests, saved.knowledge))
  assert.equal(getPublishedKnowledge(secondApproved).find(item => item.id === draftTarget.id).body, buffer.body)
})

test('改訂版の保存中・差し戻し後は既存承認版を維持し、再編集・重複版を作らない', () => {
  const prepared = prepareKnowledgeDraft(mockKnowledge, mockRequests, 'operator', null, 'KB-0001')
  const saved = saveKnowledgeDraft(mockKnowledge, 'operator', { ...prepared.input, title: '改訂したVPN手順' }, prepared.sources, nextMockTimestamp(mockRequests), undefined, 'KB-0001')
  assert.equal(saved.saved.version, 2)
  assert.equal(getPublishedKnowledge(saved.knowledge).find(item => item.id === 'KB-0001').version, 1)
  assert.throws(() => prepareKnowledgeDraft(saved.knowledge, mockRequests, 'operator', null, 'KB-0001'), /未承認/)
  const rejected = reviewKnowledge(saved.knowledge, mockRequests, 'operator', saved.saved, 'reject', '手順の対象を確認してください。', nextMockTimestamp(mockRequests, saved.knowledge))
  assert.equal(getPublishedKnowledge(rejected).find(item => item.id === 'KB-0001').version, 1)
  assert.throws(() => saveKnowledgeDraft(rejected, 'operator', knowledgeInput, [], nextMockTimestamp(mockRequests), saved.saved), /下書き/)
  assert.throws(() => saveKnowledgeDraft(rejected, 'operator', knowledgeInput, [], nextMockTimestamp(mockRequests), undefined, 'KB-0001'), /未承認/)
})

test('新しい改訂版の承認で最新公開版を1件に切り替え、旧版は変更しない', () => {
  const prepared = prepareKnowledgeDraft(mockKnowledge, mockRequests, 'operator', null, 'KB-0001')
  const result = saveKnowledgeDraft(mockKnowledge, 'operator', { ...prepared.input, body: '改訂された手順' }, prepared.sources, nextMockTimestamp(mockRequests), undefined, 'KB-0001')
  const approved = reviewKnowledge(result.knowledge, mockRequests, 'operator', result.saved, 'approve', '', nextMockTimestamp(mockRequests, result.knowledge))
  assert.equal(getPublishedKnowledge(approved).filter(item => item.id === 'KB-0001').length, 1)
  assert.equal(getPublishedKnowledge(approved).find(item => item.id === 'KB-0001').version, 2)
  assert.deepEqual(approved.find(item => item.id === 'KB-0001' && item.version === 1), mockKnowledge.find(item => item.id === 'KB-0001'))
  assert.throws(() => saveKnowledgeDraft(approved, 'operator', knowledgeInput, [], nextMockTimestamp(mockRequests), { id: 'KB-0001', version: 2 }), /下書き/)
})

test('差し戻しには空白以外の理由が必須で、理由と時刻を履歴に残す', () => {
  assert.throws(() => reviewKnowledge(mockKnowledge, mockRequests, 'operator', draftTarget, 'reject', ' \n', nextMockTimestamp(mockRequests)), /理由/)
  assert.throws(() => reviewKnowledge(mockKnowledge, mockRequests, 'operator', draftTarget, 'reject', 'あ'.repeat(1001), nextMockTimestamp(mockRequests)), /理由/)
  const rejected = reviewKnowledge(mockKnowledge, mockRequests, 'operator', draftTarget, 'reject', '本人確認の担当窓口を記載してください。', nextMockTimestamp(mockRequests))
  const item = rejected.find(item => item.id === draftTarget.id)
  assert.equal(item.status, 'rejected')
  assert.match(item.events.at(-1).description, /本人確認の担当窓口/)
  assert.equal(getKnowledgeList(rejected, new URLSearchParams('q=MFA端末変更')).count, 0)
  assert.equal(getDashboardData('operator', 'normal', mockRequests, rejected).reviews.length, 1)
})

test('元の解決記録が変わった・未解決・消失した場合は承認を拒否する', () => {
  const original = mockKnowledge.find(item => item.id === draftTarget.id)
  for (const changed of [
    mockRequests.filter(item => item.id !== 'REQ-0003'),
    mockRequests.map(item => item.id === 'REQ-0003' ? { ...item, status: 'in_progress' } : item),
    mockRequests.map(item => item.id === 'REQ-0003' ? { ...item, resolution: '別の解決内容' } : item),
  ]) {
    assert.ok(getKnowledgeSourceIssue(original.sources, changed))
    assert.throws(() => reviewKnowledge(mockKnowledge, changed, 'operator', draftTarget, 'approve', '', nextMockTimestamp(mockRequests)), /再確認/)
  }
})

test('社員は下書きの準備・保存・承認・差し戻しを利用できない', () => {
  assert.throws(() => prepareKnowledgeDraft(mockKnowledge, mockRequests, 'employee', null, null), /担当者/)
  assert.throws(() => saveKnowledgeDraft(mockKnowledge, 'employee', knowledgeInput, [], nextMockTimestamp(mockRequests)), /担当者/)
  for (const action of ['approve', 'reject']) assert.throws(() => reviewKnowledge(mockKnowledge, mockRequests, 'employee', draftTarget, action, '理由', nextMockTimestamp(mockRequests)), /担当者/)
})

test('問い合わせと知識の操作は同じ合成時刻を共有し、端末時刻に依存しない', () => {
  const saved = saveKnowledgeDraft(mockKnowledge, 'operator', knowledgeInput, [], nextMockTimestamp(mockRequests, mockKnowledge))
  const next = nextMockTimestamp(mockRequests, saved.knowledge)
  assert.equal(Date.parse(next) - Date.parse(saved.saved.updatedAt), 60000)
  const result = registerRequest(mockRequests, 'operator', { title: '確認', body: '入力', department: 'IT' }, next)
  assert.equal(Date.parse(nextMockTimestamp(result.requests, saved.knowledge)) - Date.parse(next), 60000)
})

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

test('新しいUUIDは自己問い合わせ0件から始め、合成登録と履歴のactorもそのUUIDを使う', () => {
  const id = '7b128ed8-1ceb-4b88-a50c-fc5eb9c6f551'
  assert.equal(getVisibleRequests(mockRequests, 'employee', id).length, 0)
  const result = registerRequest(mockRequests, 'employee', { title: '新規', body: '確認', department: 'IT' }, nextMockTimestamp(mockRequests), id)
  assert.equal(result.request.requesterId, id)
  assert.equal(result.request.events[0].actorId, id)
  assert.equal(getVisibleRequests(result.requests, 'employee', 'other-uuid').length, 0)
})

test('認証世代別の合成snapshotは配列・履歴・知識本文を共有しない', async () => {
  const { createBusinessSnapshot } = await import('../src/lib/mockData.ts')
  const first = createBusinessSnapshot()
  first.requests[0].body = '前の世代の本文'
  first.requests[0].events[0].description = '前の世代の変更'
  first.knowledge[0].body = '前の利用者の文書'
  const second = createBusinessSnapshot()
  assert.deepEqual(second.requests, mockRequests)
  assert.deepEqual(second.knowledge, mockKnowledge)
  assert.notEqual(first.requests, second.requests)
})

test('実際の参照UUIDによる担当割り当てと一覧条件を合成IDに置き換えない', async () => {
  const { getRequestFilters } = await import('../src/lib/mockData.ts')
  const operator = { id: 'e5b01153-380c-4941-90e0-6e1528f28c80', name: '検証担当者' }
  const choices = [operator]
  const params = new URLSearchParams({ assignee: operator.id })
  assert.equal(getRequestFilters(params, choices).assignee, operator.id)
  assert.equal(getRequestFilters(new URLSearchParams('assignee=operator-01'), choices).assignee, '')
  const source = updateRequest(mockRequests, 'operator', 'REQ-0001', { type: 'assign', assigneeId: operator.id }, nextMockTimestamp(mockRequests), operator.id, choices)
  const data = getRequestList(source, 'operator', params, operator.id, choices)
  assert.equal(data.count, 1)
  assert.equal(data.rows[0].id, 'REQ-0001')
  assert.equal(data.rows[0].assigneeId, operator.id)
  assert.equal(data.rows[0].events.at(-1).actorId, operator.id)
})
