import assert from 'node:assert/strict'
import test from 'node:test'
import { clearSearchInquiry, prepareSearchInquiry, readSearchInquiry } from '../src/lib/searchInquiry.ts'

test('AI案内で参照した複数文書の表示版を確認可能な本文へ引き継ぐ', () => {
  const refs = [1, 2].map(number => ({ number: `KB-${number}`, title: `公開文書${number}`, version_no: number, url: `http://127.0.0.1:5174/knowledge/${number}` }))
  const input = readSearchInquiry(prepareSearchInquiry('質問', refs))
  assert.ok(input.body.includes('KB-1 公開文書1 / v1'))
  assert.ok(input.body.includes('KB-2 公開文書2 / v2'))
  assert.equal(input.department_id, '')
  clearSearchInquiry()
})

test('長い検索内容を本文へ保持し、件名だけをUnicode文字単位で短くする', () => {
  const query = '😀'.repeat(500)
  const id = prepareSearchInquiry(query)
  const input = readSearchInquiry(id)
  assert.equal([...input.title].length, 120)
  assert.ok(input.body.includes(query))
  assert.equal(input.department_id, '')
  assert.ok([...input.body].length < 5000)
  clearSearchInquiry()
})

test('選択した公開文書の番号・表示版・参照先だけを問い合わせ本文へ渡す', () => {
  const id = prepareSearchInquiry('認証ができない', { number: 'KB-0001', title: '認証の手順', version_no: 2, url: 'http://127.0.0.1:5174/knowledge/example' })
  const input = readSearchInquiry(id)
  assert.match(input.body, /KB-0001 認証の手順 \/ v2/)
  assert.match(input.body, /http:\/\/127\.0\.0\.1:5174\/knowledge\/example/)
  input.body = '編集した内容'
  assert.notEqual(readSearchInquiry(id).body, input.body)
  assert.deepEqual(readSearchInquiry(id), readSearchInquiry(id))
  clearSearchInquiry()
})

test('前の引き継ぎ・別の識別子・認証変更や画面終了後の引き継ぎを再利用しない', () => {
  const old = prepareSearchInquiry('前の利用者の検索')
  const current = prepareSearchInquiry('現在の検索')
  assert.equal(readSearchInquiry(old), undefined)
  assert.equal(readSearchInquiry({ searchInquiryId: current }), undefined)
  assert.ok(readSearchInquiry(current))
  clearSearchInquiry()
  assert.equal(readSearchInquiry(current), undefined)
})

test('検索語のない通常登録は空欄にし、文書からの登録には文書名を提案する', () => {
  assert.deepEqual(readSearchInquiry(prepareSearchInquiry('  ')), { title: '', body: '', department_id: '' })
  const input = readSearchInquiry(prepareSearchInquiry('', { number: 'KB-0002', title: 'VPN設定', version_no: 1, url: '/knowledge/example' }))
  assert.equal(input.title, 'VPN設定について')
  assert.match(input.body, /KB-0002/)
  clearSearchInquiry()
})

test('編集できる問い合わせ本文とサーバーのAI案内参照を別に引き継ぐ', () => {
  const id = prepareSearchInquiry('端末の登録', [], { id: 'synthetic-guidance', reason: '  試したが未解決  ' })
  const input = readSearchInquiry(id)
  assert.equal(input.guidance_id, 'synthetic-guidance')
  assert.equal(input.handoff_reason, '試したが未解決')
  input.body = '社員が編集した説明'
  assert.equal(readSearchInquiry(id).guidance_id, 'synthetic-guidance')
  clearSearchInquiry()
  assert.equal(readSearchInquiry(id), undefined)
})
