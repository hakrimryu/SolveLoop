import assert from 'node:assert/strict'
import test from 'node:test'
import { groupGuidanceSignals } from '../src/lib/guidanceSignals.ts'

test('同じ表現の未解決を集計し、処理エラーと未確認の成功を文書不足に混ぜない', () => {
  const item = { id:'a', query:'ＶＰＮ 接続', state:'insufficient_evidence', outcome:null, created_at:'2026-11-01T01:00:00Z' }
  const groups = groupGuidanceSignals([
    item, {...item, id:'b', query:'vpn  接続', created_at:'2026-11-01T02:00:00Z'},
    {...item, id:'error', state:'error', outcome:'unresolved'},
    {...item, id:'unknown', state:'answered'},
    {...item, id:'solved', outcome:'solved'},
    {...item, id:'other', query:'印刷', state:'answered', outcome:'unresolved'},
  ])
  assert.equal(groups.length, 2)
  assert.equal(groups[0].count, 2)
  assert.equal(groups[0].item.id, 'b')
  assert.equal(groups[1].item.id, 'other')
})
