import { act, createElement as h } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter, Route, Routes } from 'react-router'
import RequestDetail from '../src/features/requests/RequestDetail'
import RequestDialog from '../src/features/requests/RequestDialog'
import KnowledgeReview from '../src/features/knowledge/KnowledgeReview'
import KnowledgeList, { KnowledgeDetail } from '../src/features/knowledge/Knowledge'
import Radar from '../src/features/dashboard/Radar'
import Improvements from '../src/features/dashboard/Improvements'
import EmployeeGuidance from '../src/features/knowledge/EmployeeGuidance'
import Accounts from '../src/features/accounts/Accounts'
import AppLayout from '../src/components/AppLayout'
import { clearGuidance } from '../src/lib/guidanceState'
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
async function openGenerationTool() {
  const summary = [...fixture.querySelectorAll('summary')].find(node => node.textContent === '解決記録からAI下書き案を生成')
  if (summary && !summary.parentElement.open) await click(summary)
}
let root, dirty
async function mount(Component, path, request, role = 'operator') {
  dirty = false
  api.request = Component === EmployeeGuidance ? (path, body, options) => path.startsWith('/knowledge/guidance/history') ? Promise.resolve({ items: [] }) : request(path, body, options) : request
  root = createRoot(fixture)
  const props = { role, departments: [dept], operators: [user, other], onDirtyChange: value => { dirty = value }, onClose() {} }
  const route = Component === RequestDetail ? '/requests/:requestId' : Component === KnowledgeDetail ? '/knowledge/:documentId' : Component === KnowledgeReview && path.includes('/versions/') ? '/knowledge/reviews/:documentId/versions/:version' : '*'
  await act(async () => root.render(h(MemoryRouter, { initialEntries: [path] }, h(Routes, null, h(Route, { path: route, element: h(Component, props) }), (Component === KnowledgeReview && route !== '*' || Component === KnowledgeDetail) ? h(Route, { path: '/knowledge/reviews', element: h(KnowledgeList, { ...props, review: true }) }) : null))))
}
const cases = []
async function check(name, run) {
  try { await run(); cases.push(`PASS ${name}`) }
  catch (error) { cases.push(`FAIL ${name}: ${error.message}`) }
  finally { if (root) await act(async () => root.unmount()); root = null; api.request = originalRequest; clearGuidance(); results.textContent = cases.join('\n') }
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
  await fill(field('困っていること・探したい内容'), 'スマホを替えたら入れない')
  await click(button('関連する文書を探す'))
  assert(fixture.textContent.includes('入力内容に関連する文書を探しています') && field('困っていること・探したい内容').matches(':disabled'), '待機を表示していません。')
  await act(async () => failSearch())
  assert(field('困っていること・探したい内容').value === 'スマホを替えたら入れない', '質問を失いました。')
  assert(fixture.textContent.includes('文書を検索できませんでした') && !fixture.textContent.includes('0箇所'), 'AI失敗を0件に見せています。')
  empty = true
  await click(button('同じ条件で再検索'))
  assert(writes.length === 2 && JSON.stringify(writes[0]) === JSON.stringify(writes[1]) && fixture.textContent.includes('0箇所'), '同じ条件の空結果を表示できません。')
})

await check('S15 経路を離れた後の遅い検索応答を破棄', async () => {
  let resolveSearch
  await mount(KnowledgeList, '/knowledge?mode=semantic&q=認証', async (path, body) => body ? new Promise(resolve => { resolveSearch = resolve }) : page([]))
  await click([...fixture.querySelectorAll('a')].find(item => item.textContent === 'キーワードで探す'))
  await act(async () => resolveSearch({ items: [{ ...reviewOf(), chunk_id: 'late', text: '遅い応答の秘密', cosine_distance: 0 }], top_k: 5, profile_id: 'test', as_of: now }))
  assert(!fixture.textContent.includes('遅い応答の秘密') && fixture.querySelector('nav[aria-label="文書の検索方法"] a[aria-current="page"]')?.textContent === 'キーワードで探す', '離脱後の結果が混ざりました。')
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


const aiClassification = () => ({ ticket_version: 1, generated_at: now, generation: { model: 'qwen3:8b', attempts: 1 }, result: { department_code: 'IT', department: dept, reason: '認証の問い合わせです。', needs_review: true }, sources: [] })
const aiAnswer = () => ({ ticket_version: 1, generated_at: now, generation: { model: 'qwen3:8b', attempts: 1 }, result: { status: 'answered', summary: '認証の登録を確認します。', steps: [{ text: '本人確認後に登録を更新してください。', citation_ids: ['chunk-fixture'] }], missing_information: ['端末の状況'] }, sources: [{ id: 'chunk-fixture', kind: 'knowledge', number: 'KB-0001', title: '認証の手順', version_no: 1, version_id: 'version-fixture', text: '本人確認後に登録を更新します。', href: '/knowledge/document-fixture?match_version=1&start=0&end=16#search-passage' }] })

await check('S16 分類は提案だけ・担当入力と解決入力を保持', async () => {
  const saved = ticketOf(), writes = []
  await mount(RequestDetail, `/requests/${saved.id}`, async (path, body) => {
    if (body) { writes.push({ path, body }); return aiClassification() }
    return saved
  })
  await fill(field('解決内容'), '消さない解決入力')
  await fill(field('担当者を割り当てる'), other.id)
  await click(button('担当部署を提案'))
  assert(fixture.textContent.includes('担当部署の提案：IT'), '実APIの分類結果を表示しません。')
  assert(field('担当者を割り当てる').value === other.id && field('解決内容').value === '消さない解決入力', '提案で入力を変更しました。')
  assert(writes.length === 1 && writes[0].path.endsWith('/analysis') && writes[0].body.task === 'classification' && writes[0].body.expected_version === 1, '契約外の書込みを行いました。')
})

await check('S16 回答案に段階別の実根拠IDと原文リンク', async () => {
  const saved = ticketOf()
  await mount(RequestDetail, `/requests/${saved.id}`, async (path, body) => body ? aiAnswer() : saved)
  await click(button('根拠付き回答案を生成'))
  assert(fixture.textContent.includes('回答案（未確認）') && fixture.textContent.includes('chunk-fixture'), '回答・根拠IDがありません。')
  assert(fixture.querySelector('a[href="/knowledge/document-fixture?match_version=1&start=0&end=16#search-passage"]'), 'サーバーの原文リンクがありません。')
  assert(!fixture.querySelector('button').textContent.includes('自動反映'), '自動処理を追加しました。')
})

await check('S16 根拠不足を回答成功と区別', async () => {
  const saved = ticketOf()
  await mount(RequestDetail, `/requests/${saved.id}`, async (path, body) => body ? { ...aiAnswer(), generation: null, result: { status: 'insufficient_evidence', summary: '根拠となる情報が不足しています。', steps: [], missing_information: ['参照できる手順が必要です。'] }, sources: [] } : saved)
  await click(button('根拠付き回答案を生成'))
  assert(fixture.textContent.includes('根拠不足・回答案は作成していません') && fixture.textContent.includes('検索のみ・文章生成なし') && !fixture.textContent.includes('回答案（未確認）'), '不足を成功と表示しました。')
})

await check('S16 AI障害中も入力と手動業務を保持・自動再送なし', async () => {
  const saved = ticketOf(); let calls = 0
  await mount(RequestDetail, `/requests/${saved.id}`, async (path, body) => {
    if (body) { calls++; throw new ApiError(504, 'AI_TIMEOUT', 'Ollamaの応答が制限時間内に届きませんでした。') }
    return saved
  })
  await fill(field('解決内容'), '障害でも消さない')
  await click(button('根拠付き回答案を生成'))
  assert(fixture.querySelector('[role="alert"]').textContent.includes('制限時間') && calls === 1, '障害を隠したか自動再送しました。')
  assert(field('解決内容').value === '障害でも消さない' && !button('解決内容を記録して解決').disabled, 'AI障害で手動業務を止めました。')
})

await check('S16 本文保存中の旧提案を破棄・未保存本文では実行しない', async () => {
  let saved = ticketOf(), release
  await mount(RequestDetail, `/requests/${saved.id}`, async (path, body) => {
    if (path.endsWith('/analysis')) return new Promise(resolve => { release = () => resolve(aiClassification()) })
    if (body) saved = { ...saved, body: body.body, version: 2 }
    return structuredClone(saved)
  })
  await click(button('担当部署を提案'))
  await click(button('内容を編集'))
  assert(button('根拠付き回答案を生成').disabled, '未保存の本文で生成できます。')
  await fill(field('内容'), '変更後の本文')
  await click(button('内容を保存'))
  await act(async () => release())
  assert(!fixture.textContent.includes('担当部署の提案：IT') && fixture.textContent.includes('古い提案を破棄'), '更新前の提案を表示しました。')
})

await check('S16 社員にはAI操作と解決事例を表示しない', async () => {
  const saved = ticketOf()
  await mount(RequestDetail, `/requests/${saved.id}`, async () => saved, 'employee')
  assert(!fixture.textContent.includes('AI提案・担当者') && !fixture.textContent.includes('根拠付き回答案を生成'), '社員に担当者のAI操作を表示しました。')
})

const generatedOf = ticket => ({
  generation_id: '00000000-0000-0000-0000-000000000777', generated_at: now, expires_at: now,
  draft: { title: '生成された接続手順', audience: '対象は要確認', body: '症状\n接続不可\n\n解決手順\n登録を確認' },
  result: { symptoms: ['接続不可'], steps: ['登録を確認'], cautions: [], missing_information: ['端末の範囲'], source_ticket_ids: [ticket.id] },
  sources: [{ ticket_id: ticket.id, ticket_number: ticket.number, ticket_version: ticket.version, title: ticket.title, body: ticket.body, resolution: ticket.resolution, department: dept, resolved_at: now, updated_at: now, content_hash: 'a'.repeat(64) }],
  trace: { model: 'qwen3:8b', digest: 'a'.repeat(64), prompt_version: 'knowledge-draft-v1', request_id: 'synthetic-generation' },
})

await check('S17 生成・再生成は入力を保持し、反映は明示確認・保存は別操作', async () => {
  const ticket = { ...ticketOf(), status: 'resolved', resolution: '登録を更新', resolved_at: now }
  const writes = []
  await mount(KnowledgeReview, `/knowledge/reviews/new?source=${ticket.id}`, async (path, body) => {
    if (body) { writes.push({ path, body: structuredClone(body) }); return generatedOf(ticket) }
    return ticket
  })
  await fill(field('適用対象'), '途中の対象')
  await fill(field('本文'), '人が書いた未保存本文')
  await openGenerationTool()
  await click(button('選択した根拠からAI案を生成'))
  assert(field('本文').value === '人が書いた未保存本文' && writes.length === 1, '生成が入力を上書き・保存しました。')
  assert(Object.keys(writes[0].body).join() === 'source_refs', '生成に未保存本文を送信しました。')
  await click(button('生成案を確認して編集欄へ反映'))
  assert(document.activeElement.textContent === '入力を保持して戻る', '反映確認の初期焦点が取消ではありません。')
  await click(button('入力を保持して戻る'))
  assert(field('適用対象').value === '途中の対象', '反映取消で入力が変わりました。')
  await click(button('生成案を確認して編集欄へ反映'))
  await click(button('置き換えて編集を続ける'))
  assert(field('件名').value === '生成された接続手順' && field('本文').value.startsWith('症状'), '明示反映ができません。')
  await fill(field('本文'), '人が修正した本文')
  await click(button('選択した根拠から再生成'))
  assert(field('本文').value === '人が修正した本文' && writes.length === 2 && !writes.some(w => w.path === '/knowledge/drafts'), '再生成が編集を上書き・保存しました。')
})

await check('S17 生成失敗後も手動本文を保持して保存可能', async () => {
  const ticket = { ...ticketOf(), status: 'resolved', resolution: '登録を更新', resolved_at: now }
  let attempts = 0
  await mount(KnowledgeReview, `/knowledge/reviews/new?source=${ticket.id}`, async (path, body) => {
    if (body) { attempts++; throw new ApiError(504, 'AI_TIMEOUT', '生成の時間切れ', 'synthetic') }
    return ticket
  })
  await fill(field('本文'), '障害時にも残る本文')
  await openGenerationTool()
  await click(button('選択した根拠からAI案を生成'))
  assert(attempts === 1 && field('本文').value === '障害時にも残る本文' && !button('下書きを保存').disabled && fixture.textContent.includes('生成の時間切れ'), '障害時の入力・手動保存境界が違います。')
})

await check('S17 受取中止後の遅延結果を破棄し入力を保持', async () => {
  const ticket = { ...ticketOf(), status: 'resolved', resolution: '登録を更新', resolved_at: now }
  let release
  await mount(KnowledgeReview, `/knowledge/reviews/new?source=${ticket.id}`, async (path, body) => body ? new Promise(resolve => { release = () => resolve(generatedOf(ticket)) }) : ticket)
  await fill(field('本文'), '中止時に保持する本文')
  await openGenerationTool()
  await click(button('選択した根拠からAI案を生成'))
  await click(button('生成結果の受け取りを中止'))
  await act(async () => release())
  assert(field('本文').value === '中止時に保持する本文' && !fixture.textContent.includes('未確認の生成案：'), '中止後の結果を反映しました。')
})

await check('S17 AI反映後の編集保存に生成IDと実根拠版を渡す', async () => {
  const saved = reviewOf(), ticket = { ...ticketOf(), status: 'resolved', resolution: '登録を更新', resolved_at: now }
  saved.sources = generatedOf(ticket).sources
  let received
  await mount(KnowledgeReview, `/knowledge/reviews/${saved.document_id}/versions/1`, async (path, body) => {
    if (path === '/knowledge/generations') return generatedOf(ticket)
    if (body) { received = structuredClone(body); return { ...saved, ...body, row_version: 2 } }
    return saved
  })
  await openGenerationTool()
  await click(button('選択した根拠からAI案を生成'))
  await click(button('生成案を確認して編集欄へ反映')); await click(button('置き換えて編集を続ける'))
  await fill(field('本文'), 'AI案を人が修正')
  await click(button('下書きを保存'))
  assert(received.generation_id === generatedOf(ticket).generation_id && received.body === 'AI案を人が修正' && received.source_refs[0].expected_ticket_version === ticket.version, 'AI案の由来・編集・根拠版が保存されません。')
})

const radarRunOf = () => {
  const members = Array.from({ length: 5 }, (_, index) => ({ id: `00000000-0000-0000-0000-00000000030${index + 1}`, number: `REQ-000${index + 1}`, title: `端末交換後のMFA ${index + 1}`, version: 3, status: index < 2 ? 'resolved' : 'open', can_generate: index < 2 }))
  return { id: 'run-1', as_of: now, created_at: now, input_count: 5, input_snapshot_hash: 'fixed-input-hash', candidate_count: 1, current: true, status: 'complete', request_key: 'fixed-request', parameters: { days: 30, threshold: .92, ticket_profile_id: 'ticket-profile', group_rule: 'all-pairs' }, candidates: [{ id: 'candidate-1', ticket_ids: members.map(item => item.id), minimum_similarity: .94, overlap: true, members, pairs: [{ left: members[0].id, right: members[1].id, similarity: .96 }] }], coverages: [], reviews: [], review_context: { hash: 'a'.repeat(64), documents: [{ document_id: 'doc-1', version_id: 'version-1', version_no: 1, number: 'KB-0001', title: 'MFA再登録', href: '/knowledge/doc-1', content_hash: 'b'.repeat(64) }] } }
}
const radarCoverageOf = run => ({ id: 'coverage-1', run_id: run.id, candidate_id: 'candidate-1', created_at: now, current: true, corpus_hash: 'corpus-v1', search_profile_id: 'public-profile', policy: { prompt_version: 'coverage-v1', top_k: 3 }, summary: { total: 5, analyzed: 3, covered: 1, uncovered: 1, unknown: 1, unanalyzed: 2, rates: { covered: .2, uncovered: .2, unknown: .2 }, coverage_on_analyzed: 1/3, gap_status: 'pending' }, judgments: { [run.candidates[0].members[0].id]: { status: 'covered', rationale: '手順の原文を確認', missing_information: [], citations: [{ id: 'chunk-1', document_id: 'doc-1', version_id: 'version-1', version_no: 1, title: 'MFA再登録', number: 'KB-0001', chunk_id: 'chunk-1', quote: '本人確認後に再登録する。', quote_start: 0, quote_end: 13, href: '/knowledge/doc-1' }], trace: { mode: 'live', model: 'qwen3:8b', prompt_version: 'coverage-v1' } }, [run.candidates[0].members[1].id]: { status: 'uncovered', rationale: '再登録手順が不足', missing_information: ['本人確認手順'], citations: [] }, [run.candidates[0].members[2].id]: { status: 'unknown', rationale: '通信失敗', missing_information: ['再実行'], citations: [], error_code: 'AI_TIMEOUT' } }, unanalyzed_ids: run.candidates[0].ticket_ids.slice(3), batches: [{ request_key: 'batch-1', ticket_ids: run.candidates[0].ticket_ids.slice(0,3), status: 'complete', processed_ids: run.candidates[0].ticket_ids.slice(0,3) }] })

await check('S18 候補の実件数・重複・全対比較と明示的な解決根拠選択', async () => {
  const run = radarRunOf()
  const writes = []
  await mount(Radar, '/dashboard?radar=run-1', async (path, body) => { if (body) writes.push({path,body}); return path === '/radar/runs' ? {items:[run]} : run })
  await click(button('構成・判定を確認'))
  const boxes = [...fixture.querySelectorAll('ul input[type=checkbox]')]
  assert(boxes.length === 5 && boxes.filter(item => !item.disabled).length === 2, '未解決の問い合わせが生成根拠として選択可能です。')
  await click(boxes[0]); await click(boxes[1])
  const link = [...fixture.querySelectorAll('a')].find(item => item.textContent.includes('選択した解決記録2件'))
  const url = new URL(link.href)
  assert(url.searchParams.getAll('source').length === 2 && url.searchParams.getAll('source_version').join(',') === '3,3', '明示選択のID・版を失いました。')
  assert(writes.length === 0 && fixture.textContent.includes('他候補と重複あり'), '選択だけでAIや保存を実行しました。')
})

await check('S19 部分分析・unknown・未分析の分母と公開原文リンクを区別', async () => {
  const run = radarRunOf(); run.coverages = [radarCoverageOf(run)]
  await mount(Radar, '/dashboard?radar=run-1', async path => path === '/radar/runs' ? {items:[run]} : run)
  await click(button('構成・判定を確認'))
  assert(fixture.textContent.includes('判断不能 1件 / 全5件') && fixture.textContent.includes('未分析 2件 / 全5件') && fixture.textContent.includes('一部未分析'), '部分判定を全体の対応可否として表示しました。')
  const details = [...fixture.querySelectorAll('details')].find(item => item.querySelector('summary')?.textContent.includes('REQ-0001 · 対応可能'))
  await click(details.querySelector('summary'))
  assert(details.textContent.includes('本人確認後に再登録する。') && details.querySelector('a').getAttribute('href') === '/knowledge/doc-1', '実根拠へのリンク・引用がありません。')
})

await check('S19 古い公開根拠を隠し再分析を要求、全員への自動解決なし', async () => {
  const run = radarRunOf(); const coverage = radarCoverageOf(run); coverage.current = false
  coverage.judgments = Object.fromEntries(Object.entries(coverage.judgments).map(([id,value]) => [id,{ status:value.status, historical:true }]))
  run.coverages = [coverage]
  await mount(Radar, '/dashboard?radar=run-1', async path => path === '/radar/runs' ? {items:[run]} : run)
  await click(button('構成・判定を確認'))
  assert(button('次の未分析2件を明示分析').disabled && fixture.textContent.includes('理由と引用の再表示を停止'), '古い公開資料で分析を続行できます。')
  assert(!fixture.textContent.includes('本人確認後に再登録する。'), '停止した根拠の引用を再表示しました。')
})

await check('S18 結果未確認の再送で同じ要求キー・条件を維持', async () => {
  const received = []
  await mount(Radar, '/dashboard', async (path, body) => { if (!body) return { items:[] }; received.push(structuredClone(body)); throw unavailable() })
  await click(button('繰り返しを検出'))
  assert(field('基準日時').disabled && fixture.textContent.includes('結果未確認'), '未確認要求の条件を変更できます。')
  await click(button('同じ要求で結果を確認'))
  assert(received.length === 2 && JSON.stringify(received[0]) === JSON.stringify(received[1]), '結果未確認の要求を別条件・別キーで実行しました。')
})

await check('S19 Radarで選んだ複数の解決根拠と版をS17で再検査', async () => {
  const first = { ...ticketOf(), status:'resolved', resolution:'本人確認後に再登録しました。', resolved_at:now, version:3 }
  const second = { ...first, id:'00000000-0000-0000-0000-000000000302', number:'REQ-0002' }
  let received
  await mount(KnowledgeReview, `/knowledge/reviews/new?source=${first.id}&source=${second.id}&source_version=3&source_version=3`, async (path, body) => { if (body) { received = body; return { ...generatedOf(first), sources:[generatedOf(first).sources[0], {...generatedOf(second).sources[0], ticket_id:second.id}] } } return path.endsWith(second.id) ? second : first })
  await openGenerationTool()
  await click(button('選択した根拠からAI案を生成'))
  assert(received.source_refs.length === 2 && received.source_refs.every(item => item.expected_ticket_version === 3), '選択済み根拠を切り捨てました。')
})

await check('F02 正常な根拠不足と生成障害を区別し、質問・手動問い合わせを保持', async () => {
  let failure = false
  await mount(EmployeeGuidance, '/knowledge?mode=guidance', async () => {
    if (failure) throw new ApiError(503, 'AI_INVALID_OUTPUT', '出力を検証できません。', 'fixed')
    return { query:'未知の質問', generated_at:now, prompt_version:'employee-guidance-v1', request_id:'fixed', sources:[], result:{status:'insufficient_evidence',summary:'根拠となる情報が不足しています。',steps:[],missing_information:['担当者へ確認']} }
  })
  await fill(field('質問・困っていること'), '未知の質問')
  await act(async () => button('AIに質問する').form.requestSubmit())
  assert(fixture.textContent.includes('根拠となる情報が不足しています') && button('担当者に問い合わせ'), '根拠不足・手動経路がありません。')
  failure = true
  await click(button('質問を修正して再実行'))
  await act(async () => button('AIに質問する').form.requestSubmit())
  assert(fixture.textContent.includes('出力を検証できません。') && !fixture.querySelector('section[aria-label="AI案内の結果"]') && field('質問・困っていること').value === '未知の質問', '障害を根拠不足に置換したか入力を失いました。')
})

await check('F02 原文へ移動しても質問と表示版を問い合わせへ引き継ぐ', async () => {
  const source = {id:'chunk',document_id:'doc-1',version_no:2,number:'KB-0001',title:'公開手順',audience:'社員',text:'手順',href:'/knowledge/doc-1?match_version=2&start=0&end=2#search-passage'}
  await mount(EmployeeGuidance, '/knowledge?mode=guidance', async () => ({query:'元の質問',generated_at:now,prompt_version:'employee-guidance-v1',request_id:'fixed',sources:[source],result:{status:'answered',summary:'案内',steps:[{text:'手順',citation_ids:['chunk']}],missing_information:[]}}))
  await fill(field('質問・困っていること'), '元の質問')
  await act(async () => button('AIに質問する').form.requestSubmit())
  const link = [...fixture.querySelectorAll('a')].find(item => item.textContent.includes('v2 の原文'))
  const url = new URL(link.href)
  assert(url.searchParams.get('q') === '元の質問' && url.searchParams.get('match_version') === '2' && url.hash === '#search-passage', '原文リンクで質問か表示位置を失いました。')
})

await check('F03 全原本の確認・文書版・理由を保存しAI判定を変えない、編集中の切替を保護', async () => {
  const run = radarRunOf(); let received
  await mount(Radar, '/dashboard?radar=run-1', async (path, body) => {
    if (body) { received = structuredClone(body); return {id:'review-1'} }
    return path === '/radar/runs' ? {items:[run]} : run
  })
  await click(button('構成・判定を確認'))
  const area = fixture.querySelector('section[aria-label="担当者による文書検討"]')
  assert(button('人の確認記録を保存').disabled, '未確認のまま保存可能です。')
  for (const box of area.querySelectorAll('input[type=checkbox]')) await click(box)
  await fill(field('適用条件・不足・判断理由'), '対象と手順を原文で照合')
  await fill(field('人による判断'), 'linked')
  assert(dirty && button('繰り返しを検出').disabled && button('構成・判定を確認').disabled, '検討入力を切替から保護していません。')
  await act(async () => button('人の確認記録を保存').form.requestSubmit())
  assert(received.ticket_ids.length === 5 && received.documents[0].version_id === 'version-1' && received.decision === 'linked' && !('status' in received), '人の検討とAI出力が混ざりました。')
  assert(!dirty && fixture.textContent.includes('AIの判定・件数は変更していません'), '保存後も未保存扱いです。')
})

const guidanceOf = query => ({ guidance_id: 'guidance-result', feedback_version: 1, query, generated_at: now, mode: 'live', prompt_version: 'employee-guidance-v1', request_id: query, sources: [], result: { status: 'answered', summary: `案内：${query}`, steps: [], missing_information: [] } })

await check('D34 結果は一件ずつ・明示的な質問修正と新規入力', async () => {
  const writes = []
  await mount(EmployeeGuidance, '/ask', async (path, body) => { if (body) writes.push({ path, body }); return guidanceOf(body.query) })
  await fill(field('質問・困っていること'), '最初の質問')
  const composing = new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true })
  await act(async () => field('質問・困っていること').dispatchEvent(composing))
  assert(composing.defaultPrevented && writes.length === 0, '日本語の変換確定Enterで送信しました。')
  await act(async () => button('AIに質問する').form.requestSubmit())
  const result = fixture.querySelector('section[aria-label="AI案内の結果"]')
  assert(result && !fixture.querySelector('#employee-question'), '結果に質問の常設入力欄があります。')
  assert(result.contains(button('担当者に問い合わせ')), '問い合わせが結果の外にあります。')
  await click(button('質問を修正して再実行'))
  assert(writes.length === 1 && field('質問・困っていること').value === '最初の質問', '修正ボタンで自動実行したか質問を失いました。')
  assert(!fixture.querySelector('section[aria-label="AI案内の結果"]'), '編集中の質問と前の結果が混ざっています。')
  await fill(field('質問・困っていること'), '修正した質問')
  await act(async () => button('AIに質問する').form.requestSubmit())
  assert(fixture.querySelectorAll('section[aria-label="AI案内の結果"]').length === 1, '結果が大きな会話として累積しました。')
  assert(!fixture.querySelector('section[aria-label="AI案内の結果"]').textContent.includes('案内：最初の質問'), '古い案内が残っています。')
  await click(button('別の質問をする'))
  assert(field('質問・困っていること').value === '' && writes.length === 2, '新規質問が空でないか、自動で送信しました。')
  await fill(field('質問・困っていること'), '別の質問')
  await act(async () => button('AIに質問する').form.requestSubmit())
  assert(JSON.stringify(writes[2].body) === JSON.stringify({ query: '別の質問' }), '以前の会話や引き継ぎ内容を送信しました。')
})

await check('D34 受信中止後の遅い応答を次の質問へ反映しない', async () => {
  let finish
  await mount(EmployeeGuidance, '/ask', async (path, body) => body.query === '中止する質問' ? new Promise(resolve => { finish = resolve }) : guidanceOf(body.query))
  await fill(field('質問・困っていること'), '中止する質問')
  await act(async () => { button('AIに質問する').form.requestSubmit() })
  await click(button('結果の受信を中止'))
  assert(field('質問・困っていること').value === '中止する質問', '中止で入力を失いました。')
  await fill(field('質問・困っていること'), '次の質問')
  await act(async () => button('AIに質問する').form.requestSubmit())
  await act(async () => finish(guidanceOf('中止する質問')))
  assert(fixture.querySelector('section[aria-label="AI案内の結果"]').textContent.includes('案内：次の質問'), '中止済みの応答で新しい結果を上書きしました。')
  assert(!fixture.querySelector('#employee-question'), '古いfinallyで入力状態へ戻りました。')
})

await check('D34 解決確認と任意の引き継ぎ入力を区別し、結果を復元', async () => {
  let response = guidanceOf('保持する質問'), feedbackBody
  const request = async (path, body) => {
    if (path.endsWith('/feedback')) { feedbackBody = body; response = { ...response, outcome: body.outcome, feedback_version: 2 }; return { version: 2 } }
    if (!body) return { response, version: 2, outcome: response.outcome, requester: { id: 'requester' } }
    return response
  }
  await mount(EmployeeGuidance, '/ask', request)
  await fill(field('質問・困っていること'), response.query)
  await act(async () => button('AIに質問する').form.requestSubmit())
  await click(button('解決しない'))
  const note = [...fixture.querySelectorAll('details')].find(item => item.querySelector('summary')?.textContent === '担当者に伝える内容（任意）')
  assert(note.open && feedbackBody.outcome === 'unresolved', '未解決後の引き継ぎ用入力がありません。')
  await fill(field('試したこと・解決しない理由'), '再接続を試しました')
  await act(async () => root.unmount()); root = null
  await mount(EmployeeGuidance, '/ask', request)
  assert(!fixture.querySelector('#employee-question') && fixture.querySelector('section[aria-label="AI案内の結果"]'), '再表示で結果をチャット入力へ変えてしまいました。')
})

await check('D34 Radar確認の編集中は表示切替で入力を隠さない', async () => {
  const run = radarRunOf()
  await mount(Improvements, '/improvements?view=radar&radar=run-1', async path => {
    if (path.startsWith('/knowledge/guidance/history')) return { items: [] }
    if (path === '/knowledge/guidance/metrics') return { total: 0, states: {}, outcomes: {}, unconfirmed: 0, median_processing_ms: null, tickets: 0, escalated: 0, first_reply_samples: 0, mean_first_reply_seconds: null }
    return path === '/radar/runs' ? { items: [run] } : run
  })
  await click(button('構成・判定を確認'))
  await fill(field('適用条件・不足・判断理由'), '比較途中の理由')
  assert(button('未解決のAI質問').disabled && button('利用状況').disabled && dirty, '編集中でも表示を切り替えられます。')
  await click(button('利用状況'))
  assert(field('適用条件・不足・判断理由').value === '比較途中の理由' && !field('適用条件・不足・判断理由').closest('[hidden]'), '編集中の確認を隠すか消しました。')
})

globalThis.fetch = originalFetch
results.textContent += `\n${cases.filter(item => item.startsWith('PASS')).length}/${cases.length} 通過`
document.title = cases.some(item => item.startsWith('FAIL')) ? 'FAIL 業務画面の回帰検証' : 'PASS 業務画面の回帰検証'

if (new URLSearchParams(location.search).has('preview')) {
  const preview = new URLSearchParams(location.search).get('preview')
  for (const node of document.body.children) if (node.id !== 'fixture' && node.tagName !== 'SCRIPT') node.hidden = true
  globalThis.fetch = async () => { throw new Error('検証中の実通信は禁止です。') }
  if (preview === 'accounts') {
    const manager = { ...user, login_id: 'fixture-manager', role: 'operator', department: dept, can_manage_accounts: true, must_change_password: false, active: true, row_version: 1 }
    const employee = { ...other, display_name: '確認用の社員', login_id: 'fixture-employee', role: 'employee', department: dept, can_manage_accounts: false, must_change_password: false, active: true, row_version: 1 }
    const renderAccounts = () => h(AppLayout, { session: manager, notice: '', onSessionEnd() {} }, h('p', { className: 'sampleLabel' }, '表示確認用の固定応答 · 実APIには接続しません'), h(Accounts, { user: manager, departments: [dept], onDirtyChange() {} }))
    await mount(renderAccounts, '/settings/accounts', async (path, body) => {
      if (body) throw new Error('表示確認ではアカウントを変更しません。')
      return path === '/accounts' ? { items: [manager, employee], total: 2 } : { items: [], total: 0, page: 1, page_count: 1 }
    })
    await click(button('確認用の社員'))
  } else if (preview === 'radar') {
    const run = radarRunOf(); run.coverages = [radarCoverageOf(run)]
    const operator = { ...user, role: 'operator', department: dept, can_manage_accounts: false, must_change_password: false }
    const renderRadar = () => h(AppLayout, { session: operator, notice: '', onSessionEnd() {} }, h('p', { className: 'sampleLabel' }, '表示確認用の固定応答 · 実APIには接続しません'), h(Radar, { onDirtyChange() {} }))
    await mount(renderRadar, '/improvements?radar=run-1', async (path, body) => {
      if (body) throw new Error('表示確認では分析・検討記録を変更しません。')
      return path === '/radar/runs' ? { items: [run] } : run
    })
    await click(button('構成・判定を確認'))
  } else {
    const saved = { ...reviewOf(), status: 'approved', approved_at: now, published_version_no: 1, draft_version_no: null }
    await mount(KnowledgeDetail, `/knowledge/${saved.document_id}`, async () => structuredClone(saved))
    if (preview === 'delete') await click(button('文書を削除…'))
  }
  globalThis.IS_REACT_ACT_ENVIRONMENT = false
}
