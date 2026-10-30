import { act, createElement as h } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter, Route, Routes } from 'react-router'
import RequestDetail from '../src/features/requests/RequestDetail'
import RequestDialog from '../src/features/requests/RequestDialog'
import KnowledgeReview from '../src/features/knowledge/KnowledgeReview'
import { api, ApiError } from '../src/lib/api'
import '../src/index.css'

globalThis.IS_REACT_ACT_ENVIRONMENT = true
const fixture = document.querySelector('#fixture'), results = document.querySelector('#results')
const originalRequest = api.request, originalFetch = globalThis.fetch
// 実コンポーネントを使っても業務APIには送信せず、隔離した応答で入力保護を検証する。
// [ko] 실제 컴포넌트를 사용해도 업무 API로 전송하지 않고 격리 응답으로 입력 보호를 검증한다.
// [en] Test real components with isolated responses while blocking requests to the business API.
globalThis.fetch = async () => { throw new Error('検証中の実通信は禁止です。') }
const dept = { id: '00000000-0000-0000-0000-000000000101', code: 'IT', name: 'IT' }
const user = { id: '00000000-0000-0000-0000-000000000201', display_name: '担当者' }
const other = { id: '00000000-0000-0000-0000-000000000202', display_name: '別の担当者' }
const now = '2026-10-30T09:00:00Z'
const ticketOf = () => ({ id: '00000000-0000-0000-0000-000000000301', number: 'REQ-0001', title: 'VPN', body: '保存済みの本文', status: 'in_progress', version: 1, department: dept, requester: user, assignee: user, created_at: now, updated_at: now, resolution: null, resolved_at: null, events: [] })
const page = items => ({ items, page: 1, page_size: 100, page_count: 1, filtered_count: items.length, visible_total: items.length, sort: 'updated_at_desc', as_of: now })
const unavailable = () => new ApiError(503, 'SERVICE_UNAVAILABLE', '登録結果を確認してください。', 'ui-test')
const assert = (condition, message) => { if (!condition) throw new Error(message) }
const button = text => { const found = [...fixture.querySelectorAll('button')].find(item => item.textContent === text); assert(found, `ボタンがありません：${text}`); return found }
const field = text => { const label = [...fixture.querySelectorAll('label')].find(item => item.textContent.trim().startsWith(text)); assert(label, `入力欄がありません：${text}`); return label.control ?? label.querySelector('input,textarea,select') }
const click = async node => { await act(async () => node.click()) }
async function fill(node, value) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(node), 'value').set.call(node, value)
    node.dispatchEvent(new Event(node.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }))
  })
}
let root, dirty
async function mount(Component, path, request) {
  dirty = false
  api.request = request
  root = createRoot(fixture)
  const props = { role: 'operator', departments: [dept], operators: [user, other], onDirtyChange: value => { dirty = value }, onClose() {} }
  await act(async () => root.render(h(MemoryRouter, { initialEntries: [path] }, h(Routes, null, h(Route, { path: Component === RequestDetail ? '/requests/:requestId' : '*', element: h(Component, props) })))))
}
const cases = []
async function check(name, run) {
  try { await run(); cases.push(`PASS ${name}`) }
  catch (error) { cases.push(`FAIL ${name}: ${error.message}`) }
  finally { if (root) await act(async () => root.unmount()); root = null; api.request = originalRequest; results.textContent = cases.join('\n') }
}

await check('R1 配属・本文の保存と再取得で他の入力を保持', async () => {
  let ticket = ticketOf()
  const writes = []
  await mount(RequestDetail, `/requests/${ticket.id}`, async (path, body) => {
    if (body) {
      writes.push(structuredClone(body))
      ticket = { ...ticket, version: ticket.version + 1, ...(path.endsWith('/assignment') ? { assignee: body.assignee_id === other.id ? other : user } : path.endsWith('/transition') ? { status: 'resolved', resolution: body.resolution, resolved_at: now } : { body: body.body }) }
    }
    return structuredClone(ticket)
  })
  await click(button('内容を編集'))
  await fill(field('内容'), '保存前の新しい本文')
  await fill(field('解決内容'), '入力途中の解決手順')
  await fill(field('担当者を割り当てる'), other.id)
  await click(button('割り当てを反映'))
  assert(field('内容').value === '保存前の新しい本文', '配属の保存が本文を消去しました。')
  assert(field('解決内容').value === '入力途中の解決手順' && dirty, '配属の保存が解決入力・未保存状態を消去しました。')
  await fill(field('担当者を割り当てる'), user.id)
  await click(button('内容を保存'))
  assert(field('担当者を割り当てる').value === user.id, '本文の保存が未保存の担当選択を消去しました。')
  assert(field('解決内容').value === '入力途中の解決手順' && dirty, '本文の保存が解決入力・未保存状態を消去しました。')
  assert(writes.length === 2 && writes[1].expected_version === 2, '保存版が一致しません。')
  await click(button('割り当てを反映'))
  await click(button('解決内容を記録して解決'))
  assert(!fixture.querySelector('textarea') && fixture.textContent.includes('入力途中の解決手順') && !dirty, '解決の保存後に入力・未保存状態が残りました。')
})

for (const found of [false, true]) await check(`R2 登録503後の明示再試行・検索結果${found ? 'あり' : 'なし'}`, async () => {
  const writes = []
  await mount(RequestDialog, '/requests', async (path, body, options) => {
    if (body) { writes.push({ body: structuredClone(body), key: options.idempotencyKey }); throw unavailable() }
    assert(path.startsWith('/tickets?'), '想定外の取得です。')
    return page(found ? [{ ...ticketOf(), title: 'VPNの過去の問い合わせ' }] : [])
  })
  await fill(field('件名'), 'VPN')
  await fill(field('内容'), '新しい問題')
  await click(button('登録'))
  assert(writes.length === 1 && field('内容').matches(':disabled'), '結果不明中に自動再送・編集が可能です。')
  await click(button('一覧で登録結果を確認'))
  const retry = button('確認済み・同じ登録キーで再試行する')
  assert(retry.matches(':disabled'), '一覧確認前に再送できます。')
  await click(fixture.querySelector('input[type=checkbox]'))
  await click(retry)
  assert(writes.length === 2 && JSON.stringify(writes[0]) === JSON.stringify(writes[1]), '再試行で登録キーか内容が変わりました。')
  assert(field('内容').matches(':disabled'), '再試行失敗後に入力を変更できます。')
})

await check('R1 保存後の再取得503でも他の入力を保持', async () => {
  let ticket = ticketOf(), saved = false
  await mount(RequestDetail, `/requests/${ticket.id}`, async (path, body) => {
    if (body) { saved = true; ticket = { ...ticket, assignee: other, version: 2 }; return ticket }
    if (saved) throw unavailable()
    return ticket
  })
  await click(button('内容を編集'))
  await fill(field('内容'), '再取得に失敗しても保持する本文')
  await fill(field('解決内容'), '保持する解決内容')
  await fill(field('担当者を割り当てる'), other.id)
  await click(button('割り当てを反映'))
  assert(field('内容').value === '再取得に失敗しても保持する本文' && field('解決内容').value === '保持する解決内容' && dirty, '再取得失敗で入力を失いました。')
  assert(fixture.textContent.includes('入力を保持しています'), '結果の確認を案内していません。')
})

await check('R3 下書き送信中・結果不明中の根拠変更を防止', async () => {
  const source = { ...ticketOf(), status: 'resolved', resolution: '解決手順', resolved_at: now }
  const writes = []
  let failSave
  await mount(KnowledgeReview, '/knowledge/reviews/new', async (path, body, options) => {
    if (body) { writes.push({ body: structuredClone(body), key: options.idempotencyKey }); return new Promise((resolve, reject) => { failSave = () => reject(unavailable()) }) }
    if (path.startsWith('/tickets?')) return page([source])
    if (path.startsWith('/tickets/')) return structuredClone(source)
    if (path.startsWith('/knowledge/reviews?')) return page([])
    throw new Error('想定外の取得です。')
  })
  await fill(field('件名'), '手順')
  await fill(field('適用対象'), '全社員')
  await fill(field('本文'), '手動で作成した本文')
  await click(button('根拠の候補を検索'))
  await click(button('解決記録を確認'))
  await click(button('下書きを保存'))
  const locked = button('内容を確認して根拠に追加').matches(':disabled')
  await act(async () => failSave())
  assert(locked, '送信中の根拠追加が可能です。')
  assert(button('内容を確認して根拠に追加').matches(':disabled') && button('根拠の候補を検索').matches(':disabled') && field('解決済み問い合わせを検索').matches(':disabled'), '結果不明中の根拠変更が可能です。')
  await click(button('下書き一覧で結果を確認'))
  await click(fixture.querySelector('input[type=checkbox]'))
  await click(button('同じ登録キーで明示的に再試行する'))
  const retried = writes.length === 2 && JSON.stringify(writes[0]) === JSON.stringify(writes[1])
  const stillLocked = button('内容を確認して根拠に追加').matches(':disabled')
  if (writes.length === 2) await act(async () => failSave())
  assert(retried && stillLocked, '明示再試行で内容が変わるか、根拠編集が再開されました。')
})

await check('R3 既存根拠の比較・再確認・除外も送信中と結果不明中は停止', async () => {
  const source = { ...ticketOf(), status: 'resolved', resolution: '保存した解決内容', resolved_at: now }
  let failSave, sent
  await mount(KnowledgeReview, `/knowledge/reviews/new?source=${source.id}`, async (path, body) => {
    if (body) { sent = structuredClone(body); return new Promise((resolve, reject) => { failSave = () => reject(unavailable()) }) }
    assert(path === `/tickets/${source.id}`, '想定外の取得です。')
    return structuredClone(source)
  })
  await fill(field('適用対象'), '全社員')
  await click(button('現在の原本と比較'))
  const actions = ['現在の原本と比較', '根拠から外す', '原本を確認済み・この版を根拠に選ぶ']
  await click(button('下書きを保存'))
  const locked = actions.every(text => button(text).matches(':disabled'))
  await act(async () => failSave())
  assert(locked && actions.every(text => button(text).matches(':disabled')), '根拠の変更操作が有効です。')
  assert(sent.source_refs.length === 1 && sent.source_refs[0].ticket_id === source.id && dirty, '根拠か未保存状態を失いました。')
})

globalThis.fetch = originalFetch
results.textContent += `\n${cases.filter(item => item.startsWith('PASS')).length}/${cases.length} 通過`
document.title = cases.some(item => item.startsWith('FAIL')) ? 'FAIL 業務画面の回帰検証' : 'PASS 業務画面の回帰検証'
