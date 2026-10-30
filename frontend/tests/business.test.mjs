import assert from 'node:assert/strict'
import test from 'node:test'
import { apiQuery, eventText, normalizeInput, validateKnowledge, validateText } from '../src/lib/business.ts'

test('業務入力は改行とUnicode文字数を検証し、下書きの部署未定を許可する', () => {
  assert.equal(normalizeInput(' 本文\r\n次の行 '), '本文\n次の行')
  assert.equal(validateText('😀'.repeat(120), 120), '')
  assert.ok(validateText('😀'.repeat(121), 120))
  assert.ok(validateText(' \r\n ', 5000))
  assert.deepEqual(validateKnowledge({ title: '手順', audience: '全社員', body: '本文', department_id: null }), { title: '', audience: '', body: '' })
})

test('一覧APIに画面専用の新規ダイアログや復帰条件を送らない', () => {
  const params = new URLSearchParams('q=VPN&new=1&status=open&assignee=me&page=2')
  const result = new URLSearchParams(apiQuery(params, ['q', 'status', 'page']))
  assert.equal(result.get('q'), 'VPN')
  assert.equal(result.get('page'), '2')
  assert.equal(result.has('new'), false)
  assert.equal(result.has('assignee'), false)
})

test('業務履歴は保存された構造を日本語で示し、本文過去値を文章に混ぜない', () => {
  assert.equal(eventText({ event_type: 'body_updated', payload: { fields: ['body'], before: { body: '内部の過去本文' } } }), '問い合わせ内容を変更')
  assert.match(eventText({ event_type: 'reopened', payload: { previous_resolution: '以前の解決' } }), /以前の解決/)
  assert.match(eventText({ event_type: 'rejected', payload: { reason: '注意事項を追加' } }), /注意事項を追加/)
  assert.match(eventText({ event_type: 'assignment_changed', payload: { before: {}, after: { department: { name: 'IT' }, assignee: { display_name: '担当者' } } } }), /未定.*IT.*担当者/)
})
