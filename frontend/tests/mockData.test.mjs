import assert from 'node:assert/strict'
import test from 'node:test'
import {
  demoUsers,
  formatDemoDate,
  getCoverageCounts,
  getDashboardData,
  mockRequests,
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
