import { act, createElement as h } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter, Route, Routes } from 'react-router'
import RequestDetail from '../src/features/requests/RequestDetail'
import RequestDialog from '../src/features/requests/RequestDialog'
import KnowledgeReview from '../src/features/knowledge/KnowledgeReview'
import KnowledgeList, { KnowledgeDetail } from '../src/features/knowledge/Knowledge'
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
async function mount(Component, path, request, role = 'operator') {
  dirty = false
  api.request = request
  root = createRoot(fixture)
  const props = { role, departments: [dept], operators: [user, other], onDirtyChange: value => { dirty = value }, onClose() {} }
  const route = Component === RequestDetail ? '/requests/:requestId' : Component === KnowledgeDetail ? '/knowledge/:documentId' : Component === KnowledgeReview && path.includes('/versions/') ? '/knowledge/reviews/:documentId/versions/:version' : '*'
  await act(async () => root.render(h(MemoryRouter, { initialEntries: [path] }, h(Routes, null, h(Route, { path: route, element: h(Component, props) }), (Component === KnowledgeReview && route !== '*' || Component === KnowledgeDetail) ? h(Route, { path: '/knowledge/reviews', element: h(KnowledgeList, { ...props, review: true }) }) : null))))
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

const reviewOf = () => ({ document_id: '00000000-0000-0000-0000-000000000401', number: 'KB-0001', version_id: '00000000-0000-0000-0000-000000000402', version_no: 1, status: 'draft', publication_suspended: false, title: '端末の認証設定', audience: '全社員', body: '保存した手順', department: dept, row_version: 1, document_row_version: 1, latest_version_no: 1, draft_version_no: 1, published_version_no: null, base_version_no: null, created_by: user, created_at: now, updated_at: now, reviewed_by: null, reviewed_at: null, sources: [], source_issues: [], events: [], search_preparation: { status: 'required', profile_id: 'test-profile', chunk_count: 0 } })

await check('S15 検索準備の失敗・完了と人の承認を分離', async () => {
  let saved = reviewOf(), failPrepare, fail = true
  const writes = []
  await mount(KnowledgeReview, `/knowledge/reviews/${saved.document_id}/versions/1`, async (path, body) => {
    if (!body) return structuredClone(saved)
    writes.push({ path, body })
    if (path.endsWith('/prepare-search')) {
      if (fail) return new Promise((resolve, reject) => { failPrepare = () => reject(new ApiError(503, 'AI_UNAVAILABLE', 'ローカルAIに接続できません。')) })
      saved = { ...saved, search_preparation: { ...saved.search_preparation, status: 'ready', chunk_count: 1 } }
    } else if (path.endsWith('/approve')) saved = { ...saved, status: 'approved', row_version: 2, document_row_version: 2, published_version_no: 1, draft_version_no: null }
    else throw new Error('想定外の更新です。')
    return structuredClone(saved)
  })
  assert(button('承認して公開').disabled, '未準備でも承認できます。')
  await click(button('保存した版の検索準備'))
  assert(field('本文').matches(':disabled') && button('承認して公開').disabled, '準備中に本文か承認を変更できます。')
  await act(async () => failPrepare())
  assert(field('本文').value === saved.body && !field('本文').matches(':disabled'), '準備失敗で本文を失いました。')
  assert(!button('理由を入力して差し戻す').disabled && button('承認して公開').disabled, 'AI障害が差し戻しを妨げるか承認を許可しています。')
  fail = false
  await click(button('保存した版の検索準備'))
  assert(!button('承認して公開').disabled && writes.length === 2 && writes.every(item => item.path.endsWith('/prepare-search')), '準備だけで自動承認されました。')
  await fill(field('本文'), '未保存の変更')
  assert(button('承認して公開').disabled && button('保存した版の検索準備').disabled, '未保存の編集を承認できます。')
  await fill(field('本文'), saved.body)
  await click(button('承認して公開'))
  await click(button('この版を承認して公開'))
  assert(writes.length === 3 && writes[2].path.endsWith('/approve'), '人の確認後の承認が送られていません。')
})

await check('S15 意味検索の待機・AI失敗・再検索・空結果を区別し入力保持', async () => {
  let failSearch, empty = false
  const writes = []
  await mount(KnowledgeList, '/knowledge?mode=semantic', async (path, body) => {
    assert(path === '/knowledge/search', '意味検索を別のAPIで代替しました。')
    writes.push(structuredClone(body))
    if (!empty) return new Promise((resolve, reject) => { failSearch = () => reject(new ApiError(504, 'AI_TIMEOUT', 'ローカルAIの時間切れです。')) })
    return { items: [], top_k: 5, profile_id: 'test', as_of: now }
  })
  await fill(field('質問・探したい内容'), 'スマホを替えたら入れない')
  await click(button('意味検索する'))
  assert(fixture.textContent.includes('ローカルAIで質問を変換') && field('質問・探したい内容').matches(':disabled'), '待機を表示していません。')
  await act(async () => failSearch())
  assert(field('質問・探したい内容').value === 'スマホを替えたら入れない', '質問を失いました。')
  assert(fixture.textContent.includes('意味検索は完了していません') && !fixture.textContent.includes('0箇所'), 'AI失敗を0件に見せています。')
  empty = true
  await click(button('同じ条件で再検索'))
  assert(writes.length === 2 && JSON.stringify(writes[0]) === JSON.stringify(writes[1]) && fixture.textContent.includes('0箇所'), '同じ条件の空結果を表示できません。')
})

await check('S15 経路を離れた後の遅い検索応答を破棄', async () => {
  let resolveSearch
  await mount(KnowledgeList, '/knowledge?mode=semantic&q=認証', async (path, body) => body ? new Promise(resolve => { resolveSearch = resolve }) : page([]))
  await click([...fixture.querySelectorAll('a')].find(item => item.textContent === 'キーワード検索へ'))
  await act(async () => resolveSearch({ items: [{ ...reviewOf(), chunk_id: 'late', text: '遅い応答の秘密', cosine_distance: 0 }], top_k: 5, profile_id: 'test', as_of: now }))
  assert(!fixture.textContent.includes('遅い応答の秘密') && fixture.textContent.includes('キーワード検索を使用中'), '離脱後の結果が混ざりました。')
})

for (const currentVersion of [1, 2]) await check(`S15 原文位置のUnicode表示・公開版${currentVersion === 1 ? '一致' : '更新'}`, async () => {
  const saved = { ...reviewOf(), version_no: currentVersion, body: '前😀対象の手順。後', approved_at: now }
  await mount(KnowledgeDetail, `/knowledge/${saved.document_id}?mode=semantic&q=認証&match_version=1&start=2&end=8#search-passage`, async path => path.includes('/versions/') ? { ...saved, status: 'approved' } : saved)
  const marked = fixture.querySelector('mark')
  assert(currentVersion === 1 ? marked?.textContent === '対象の手順。' : !marked && fixture.textContent.includes('検索時から公開版が更新'), '該当箇所か改訂の表示が一致しません。')
})

await check('文書削除は公開版と改訂版の範囲を確認し、成功後に一覧へ戻る', async () => {
  const saved = { ...reviewOf(), status: 'approved', approved_at: now, published_version_no: 1, latest_version_no: 2, draft_version_no: 2 }
  const writes = []
  let resolveDelete
  await mount(KnowledgeDetail, `/knowledge/${saved.document_id}`, async (path, body) => {
    if (body) { writes.push({ path, body }); return new Promise(resolve => { resolveDelete = resolve }) }
    return path.startsWith('/knowledge/reviews?') ? page([]) : structuredClone(saved)
  })
  await click(button('文書を削除…'))
  assert(fixture.textContent.includes('全2版') && fixture.textContent.includes('元に戻せません') && button('文書全体を完全に削除').disabled && writes.length === 0, '削除対象と確認が不足しています。')
  await click(button('キャンセル'))
  assert(!fixture.querySelector('dialog') && writes.length === 0, '取消で削除しました。')
  await click(button('文書を削除…'))
  await fill(fixture.querySelector('dialog input'), 'KB-9999')
  assert(button('文書全体を完全に削除').disabled, '異なる番号で削除できます。')
  await fill(fixture.querySelector('dialog input'), saved.number)
  await click(button('文書全体を完全に削除'))
  assert(writes.length === 1 && writes[0].path.endsWith('/delete-document') && writes[0].body.expected_document_version === 1 && writes[0].body.confirmation_number === saved.number && button('処理中…').disabled, '二重送信か版確認に問題があります。')
  await act(async () => resolveDelete({ document_id: saved.document_id, number: saved.number }))
  assert(!fixture.querySelector('dialog') && fixture.textContent.includes('KB-0001 を削除しました'), '成功後もdialogが残るか完了が見えません。')
})

for (const status of [409, 503]) await check(`文書削除${status}では入力を保持し自動再送せず、最新確認を求める`, async () => {
  const saved = reviewOf(), writes = []
  await mount(KnowledgeReview, `/knowledge/reviews/${saved.document_id}/versions/1`, async (path, body) => {
    if (!body) return structuredClone(saved)
    writes.push({ path, body }); throw new ApiError(status, 'DELETE_TEST', '削除結果を確認してください。')
  })
  await fill(field('本文'), '削除に失敗しても残す入力')
  await click(button('文書を削除…'))
  await fill(fixture.querySelector('dialog input'), saved.number)
  await click(button('文書全体を完全に削除'))
  assert(writes.length === 1 && field('本文').value === '削除に失敗しても残す入力' && button('文書全体を完全に削除').disabled && fixture.querySelector('dialog [role="alert"]'), '削除失敗を成功にするか入力を失いました。')
  await click(button('キャンセル'))
  assert(fixture.textContent.includes('再確認してください'), '再確認を案内していません。')
})

await check('公開画面から停止・再公開を別々に確認し、公開状態と保存版を反映', async () => {
  let saved = { ...reviewOf(), status: 'approved', approved_at: now, published_version_no: 1, draft_version_no: null }
  const writes = []
  await mount(KnowledgeDetail, `/knowledge/${saved.document_id}`, async (path, body) => {
    if (body) {
      writes.push({ path, body })
      saved = { ...saved, row_version: saved.row_version + 1, document_row_version: saved.document_row_version + 1, publication_suspended: path.endsWith('/stop-publication') }
    }
    return structuredClone(saved)
  })
  assert(fixture.querySelector('[aria-label="文書の管理"]') && !fixture.textContent.includes('テスト文書'), '公開画面の管理入口か文言が不適切です。')
  await click(button('公開を停止…'))
  assert(writes.length === 0 && fixture.querySelector('dialog').textContent.includes('あとから再公開'), '確認前に停止するか影響説明がありません。')
  await click(button('公開を停止'))
  assert(writes.length === 1 && !fixture.querySelector('dialog') && fixture.textContent.includes('公開停止中 · 担当者のみ閲覧可能'), '停止完了が画面に反映されません。')
  await click(button('再公開…'))
  assert(writes.length === 1 && fixture.querySelector('dialog').textContent.includes('作成中の下書きは公開しません'), '確認前に再公開しました。')
  await click(button('再公開する'))
  assert(writes.length === 2 && writes[1].body.expected_version === 2 && !fixture.querySelector('dialog') && fixture.textContent.includes('社員全員に公開'), '再公開が最新の保存版で行われません。')
})

await check('社員の公開画面には文書管理の操作・担当者資料を表示しない', async () => {
  const saved = { ...reviewOf(), status: 'approved', approved_at: now }
  await mount(KnowledgeDetail, `/knowledge/${saved.document_id}`, async path => {
    assert(!path.includes('/versions/'), '社員が担当者用APIを取得しました。')
    return saved
  }, 'employee')
  assert(!fixture.querySelector('[aria-label="文書の管理"]') && !fixture.textContent.includes('文書を削除'), '社員に削除を表示しました。')
})

await check('停止の競合では成功表示せず、最新確認まで操作を止める', async () => {
  const saved = { ...reviewOf(), status: 'approved', approved_at: now, published_version_no: 1 }
  await mount(KnowledgeDetail, `/knowledge/${saved.document_id}`, async (path, body) => {
    if (body) throw new ApiError(409, 'VERSION_CONFLICT', '最新版を確認してください。')
    return saved
  })
  await click(button('公開を停止…')); await click(button('公開を停止'))
  assert(fixture.querySelector('dialog [role="alert"]') && button('公開を停止').disabled && !fixture.textContent.includes('公開を停止しました'), '停止失敗を成功に見せました。')
  await click(button('キャンセル')); await click(button('最新の保存内容を確認'))
  assert(!button('公開を停止…').disabled, '明示確認後も操作を再開できません。')
})

globalThis.fetch = originalFetch
results.textContent += `\n${cases.filter(item => item.startsWith('PASS')).length}/${cases.length} 通過`
document.title = cases.some(item => item.startsWith('FAIL')) ? 'FAIL 業務画面の回帰検証' : 'PASS 業務画面の回帰検証'

if (new URLSearchParams(location.search).has('preview')) {
  for (const node of document.body.children) if (node.id !== 'fixture' && node.tagName !== 'SCRIPT') node.hidden = true
  globalThis.fetch = async () => { throw new Error('検証中の実通信は禁止です。') }
  const saved = { ...reviewOf(), status: 'approved', approved_at: now, published_version_no: 1, draft_version_no: null }
  await mount(KnowledgeDetail, `/knowledge/${saved.document_id}`, async () => structuredClone(saved))
  if (new URLSearchParams(location.search).get('preview') === 'delete') await click(button('文書を削除…'))
  globalThis.IS_REACT_ACT_ENVIRONMENT = false
}
