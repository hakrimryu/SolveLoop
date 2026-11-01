import assert from 'node:assert/strict'
import test from 'node:test'
import { employeeAnswerDraft } from '../src/lib/answerDraft.ts'

test('社員への回答欄に担当者用の解決事例番号・件名・URLを転記しない', () => {
  const sources = [
    { id: 'public', kind: 'knowledge', number: 'KB-1', title: '公開手順', href: '/knowledge/1' },
    { id: 'unused', kind: 'knowledge', number: 'KB-2', title: '未使用の文書', href: '/knowledge/2' },
    { id: 'case', kind: 'ticket', number: 'REQ-PRIVATE', title: '別社員の内部記録', href: '/requests/private' },
  ]
  const text = employeeAnswerDraft({ summary: '確認案', steps: [{ text: '手順を確認', citation_ids: ['public', 'case'] }], missing_information: [] }, sources, 'http://127.0.0.1:5174')
  assert.match(text, /KB-1 公開手順 http:\/\/127.0.0.1:5174\/knowledge\/1/)
  assert.doesNotMatch(text, /REQ-PRIVATE|別社員|requests\/private|KB-2/)
})
