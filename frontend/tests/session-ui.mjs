import { act, createElement as h, useSyncExternalStore } from 'react'
import { createRoot } from 'react-dom/client'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { SessionView } from '../src/App'
import { api, watchSession } from '../src/lib/api'
import '../src/index.css'

globalThis.IS_REACT_ACT_ENVIRONMENT = true
const fixture = document.querySelector('#fixture'), output = document.querySelector('#results')
const originalFetch = api.fetcher, originalGlobalFetch = globalThis.fetch
const dept = { id: '00000000-0000-0000-0000-000000000101', code: 'IT', name: 'IT' }
const operator = { id: '00000000-0000-0000-0000-000000000202', display_name: '検証担当者', role: 'operator', department: dept, can_manage_accounts: false, must_change_password: false }
let current, csrf, offline, root, router, stopWatch, releaseMe, holdMe = false
const cases = []
const json = data => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } })
// 認証クライアントの通信だけを差し替え、実DB・Cookieへ検証資料を送らない。
// [ko] 인증 클라이언트의 통신만 대체해 실제 DB·쿠키에 시험 자료를 전송하지 않는다.
// [en] Replace only transport so the test never sends fixtures to real DB sessions or cookies.
globalThis.fetch = async () => { throw new Error('実通信は禁止です。') }
api.fetcher = async url => {
  if (offline) throw new TypeError('検証用の通信障害')
  if (url.endsWith('/auth/login')) return json({ user: current, csrf_token: csrf })
  if (url.endsWith('/auth/me')) return holdMe ? new Promise(resolve => { releaseMe = () => resolve(json(current)) }) : json(current)
  if (url.endsWith('/auth/csrf')) return json({ csrf_token: csrf })
  if (url.endsWith('/reference-data')) return json({ departments: [dept], operators: [operator] })
  if (url.startsWith('/api/v1/tickets?')) return json({ items: [], total: 0, visible_total: 0, filtered_count: 0, page: 1, page_size: 20, page_count: 1 })
  throw new Error(`想定外の通信：${url}`)
}
const assert = (value, message) => { if (!value) throw new Error(message) }
function View() { return h(SessionView, { state: useSyncExternalStore(api.subscribe, api.snapshot) }) }
async function settled() {
  for (let attempt = 0; attempt < 20; attempt++) {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
    if (fixture.querySelector('#knowledge-body, dialog input[name="title"]')) return
  }
}
async function mount(path = '/knowledge/reviews/new') {
  current = { ...operator }; csrf = 'fixed-test-session'; offline = false
  await act(async () => { api.invalidate(); await api.login('fixture', 'fixture-only') })
  root = createRoot(fixture)
  router = createMemoryRouter([{ path: '*', element: h(View) }], { initialEntries: [path] })
  await act(async () => root.render(h(RouterProvider, { router })))
  await settled()
}
async function fill(selector, value) {
  const node = fixture.querySelector(selector)
  assert(node, `入力欄がありません：${selector}`)
  await act(async () => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(node), 'value').set.call(node, value)
    node.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
async function resume() { await act(async () => { api.suspend('checking'); await api.verify() }); await settled() }
async function check(name, run) {
  try { await run(); cases.push(`PASS ${name}`) }
  catch (error) { cases.push(`FAIL ${name}: ${error.message}`) }
  finally {
    if (root) await act(async () => root.unmount())
    stopWatch?.(); stopWatch = null; holdMe = false; releaseMe?.(); releaseMe = null
    router?.dispose(); root = null
    output.textContent = cases.join('\n')
  }
}

await check('下書きの入力を同じ資格の復帰後に復元し、未確認中は隠す', async () => {
  await mount()
  await fill('#knowledge-title', '保持する件名')
  await fill('#knowledge-audience', '保持する対象')
  await fill('#knowledge-body', '保存前の本文😀')
  const identity = api.snapshot().identityGeneration
  await act(async () => api.suspend('hidden'))
  assert(!fixture.querySelector('#knowledge-body').checkVisibility(), '未確認の本文が見えます。')
  assert(!fixture.innerText.includes('保持する件名'), '非表示の内容が表示されています。')
  await resume()
  assert(api.snapshot().identityGeneration === identity, '同一資格でも画面を破棄しました。')
  assert(fixture.querySelector('#knowledge-title').value === '保持する件名' && fixture.querySelector('#knowledge-audience').value === '保持する対象' && fixture.querySelector('#knowledge-body').value === '保存前の本文😀', '入力を失いました。')
  assert(fixture.innerText.includes('未保存の変更あり'), '未保存の保護を失いました。')
})

await check('再確認の通信障害中は本文を隠し、同一資格の回復後は保持', async () => {
  await mount(); await fill('#knowledge-body', '障害を越えて保持する入力')
  await act(async () => { api.suspend('hidden'); offline = true; try { await api.verify() } catch {} })
  assert(api.snapshot().status === 'error' && !fixture.querySelector('#knowledge-body').checkVisibility(), '未確認の画面を公開しました。')
  offline = false
  await act(async () => api.verify())
  assert(fixture.querySelector('#knowledge-body').value === '障害を越えて保持する入力', '回復後に入力を失いました。')
})

for (const change of ['user', 'session']) await check(`別の${change === 'user' ? '利用者' : 'セッション'}には前の入力を渡さない`, async () => {
  await mount(); await fill('#knowledge-body', '前の資格だけの入力')
  await act(async () => api.suspend('hidden'))
  if (change === 'user') current = { ...operator, id: '00000000-0000-0000-0000-000000000302' }
  else csrf = 'different-test-session'
  await resume()
  assert(fixture.querySelector('#knowledge-body').value === '' && !fixture.textContent.includes('前の資格だけの入力'), '前の資格の入力が残りました。')
})

await check('問い合わせdialogも隠して閉じ、同一資格なら入力付きで復元', async () => {
  await mount('/requests?new=1')
  const inputs = [...fixture.querySelectorAll('dialog input')]
  const title = inputs.find(input => input.type !== 'checkbox')
  assert(title, '問い合わせdialogがありません。')
  await fill('dialog input[name="title"]', 'タブ移動しても保持する件名')
  const dialog = fixture.querySelector('dialog[open]')
  await act(async () => api.suspend('hidden'))
  assert(!dialog.open && !dialog.checkVisibility(), '非表示中もmodalが残っています。')
  await resume()
  assert(dialog.open && dialog.querySelector('input').value === 'タブ移動しても保持する件名', 'dialogの入力を失いました。')
})

await check('仮パスワードの一回表示は非表示で破棄し復元しない', async () => {
  await mount()
  await act(async () => api.issued({ account: { ...operator, login_id: 'fixture' }, temporary_password: 'only-once-test-value' }, false, api.snapshot().generation))
  assert(fixture.textContent.includes('only-once-test-value'), '一回表示がありません。')
  await act(async () => api.suspend('hidden'))
  await resume()
  assert(api.snapshot().issued === null && !fixture.textContent.includes('only-once-test-value'), '一回値が復元されました。')
})

for (const path of ['/knowledge/reviews/new', '/requests?new=1']) await check(`タブ復帰で${path.includes('requests') ? 'dialog' : '本文'}・スクロール・選択範囲を動かさない`, async () => {
  await mount(path)
  const selector = path.includes('requests') ? 'dialog textarea' : '#knowledge-body'
  await fill(selector, '背景で再確認しても、そのまま残す入力')
  const originalHidden = Object.getOwnPropertyDescriptor(document, 'hidden')
  let hidden = false
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden })
  const spacer = document.createElement('div'); spacer.style.height = '2000px'; document.body.append(spacer)
  try {
    await act(async () => { stopWatch = watchSession(); await api.verify() })
    const input = fixture.querySelector(selector), dialog = fixture.querySelector('dialog')
    input.focus({ preventScroll: true }); input.setSelectionRange(3, 10)
    window.scrollTo(0, 300)
    await act(async () => { await new Promise(requestAnimationFrame) })
    const top = window.scrollY, generation = api.snapshot().generation
    holdMe = true
    await act(async () => {
      hidden = true; document.dispatchEvent(new Event('visibilitychange'))
      hidden = false; document.dispatchEvent(new Event('visibilitychange')); window.dispatchEvent(new Event('focus')); window.dispatchEvent(new Event('pageshow'))
    })
    assert(releaseMe && api.snapshot().status === 'ready', '再確認の度に画面を隠しました。')
    assert(fixture.querySelector(selector) === input && input.checkVisibility() && (!dialog || dialog.open), '画面またはdialogが入れ替わりました。')
    assert(window.scrollY === top && document.activeElement === input && input.selectionStart === 3 && input.selectionEnd === 10, '確認中に位置・フォーカス・選択を動かしました。')
    await act(async () => { holdMe = false; releaseMe(); await api.verify(); await new Promise(requestAnimationFrame) })
    assert(api.snapshot().generation === generation && window.scrollY === top && document.activeElement === input && input.selectionStart === 3 && input.selectionEnd === 10, '同じ資格の確認後に位置や選択を動かしました。')
    assert(input.value === '背景で再確認しても、そのまま残す入力', '入力を失いました。')
  } finally {
    if (originalHidden) Object.defineProperty(document, 'hidden', originalHidden)
    else delete document.hidden
    spacer.remove(); window.scrollTo(0, 0)
  }
})

api.fetcher = originalFetch; globalThis.fetch = originalGlobalFetch; api.invalidate()
output.textContent += `\n${cases.filter(value => value.startsWith('PASS')).length}/${cases.length} 通過`
document.title = cases.some(value => value.startsWith('FAIL')) ? 'FAIL 再確認と入力保持' : 'PASS 再確認と入力保持'
