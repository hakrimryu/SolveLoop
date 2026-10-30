import assert from 'node:assert/strict'
import test from 'node:test'
import { ApiError, SessionApi, StaleSession, errorMessage, validateAuth, validateAccount } from '../src/lib/api.ts'

const user = (id = '11111111-1111-4111-8111-111111111111', extra = {}) => ({ id, display_name: '検証 管理者', role: 'employee', department: null, can_manage_accounts: true, must_change_password: false, ...extra })
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
function fixture() {
  const calls = []
  let current = user(), csrf = 'test-csrf', response = null
  const api = new SessionApi(async (url, options) => {
    calls.push({ url, options })
    if (url.endsWith('/auth/me')) return json(current)
    if (url.endsWith('/auth/csrf')) return json({ csrf_token: csrf })
    if (url.endsWith('/auth/login')) return json({ user: current, csrf_token: csrf })
    return response ? await response() : json({ items: [], total: 0 })
  })
  return { api, calls, setUser: value => { current = value }, setCsrf: value => { csrf = value }, setResponse: value => { response = value } }
}

test('業務PATCH・登録キーにも実CSRFを送り、失敗で自動再送しない', async () => {
  const f = fixture()
  await f.api.verify()
  await f.api.request('/tickets/ticket', { body: '本文', expected_version: 2 }, { method: 'PATCH', business: true })
  assert.equal(f.calls.at(-1).options.method, 'PATCH')
  assert.equal(f.calls.at(-1).options.headers['X-CSRF-Token'], 'test-csrf')
  await f.api.request('/knowledge/drafts', { title: '題' }, { idempotencyKey: 'fixed-request-key', business: true })
  assert.equal(f.calls.at(-1).options.headers['Idempotency-Key'], 'fixed-request-key')
  const generation = f.api.snapshot().generation
  f.setResponse(() => json({ code: 'SERVICE_UNAVAILABLE', message: '保存結果を確認してください。' }, 503))
  await assert.rejects(f.api.request('/tickets/ticket', { body: '保持する入力', expected_version: 2 }, { method: 'PATCH', business: true }), ApiError)
  assert.equal(f.api.snapshot().generation, generation)
  assert.equal(f.api.snapshot().status, 'ready')
  assert.equal(f.calls.filter(c => c.options.method === 'PATCH').length, 2)
})

test('業務画面の離脱で中断し、abortを無視した同世代応答も破棄する', async () => {
  const f = fixture()
  await f.api.verify()
  let complete
  f.setResponse(() => new Promise(resolve => { complete = resolve }))
  const scope = new AbortController()
  const pending = f.api.request('/tickets', undefined, { signal: scope.signal, business: true })
  scope.abort()
  complete(json({ items: [{ title: '離脱後の古い内容' }] }))
  await assert.rejects(pending, StaleSession)
  assert.equal(f.api.snapshot().status, 'ready')
})

test('認証入力はUnicodeの文字数・空白保持・制御文字・公開値・確認欄を検証する', () => {
  const values = { currentPassword: '現在の値', newPassword: '界'.repeat(15), confirmation: '界'.repeat(15) }
  assert.deepEqual(validateAuth(values, true), {})
  assert.deepEqual(validateAuth({ ...values, newPassword: '😀'.repeat(15), confirmation: '😀'.repeat(15) }, true), {})
  for (const value of ['短い', ' '.repeat(15), 'x'.repeat(257), 'Mock-Manager-2026!', 'a'.repeat(15) + '\n']) assert.ok(validateAuth({ ...values, newPassword: value }, true).newPassword)
  assert.ok(validateAuth({ ...values, confirmation: '別の値' }, true).confirmation)
  assert.deepEqual(validateAuth({ loginId: 'Case.ID_1', password: ' ' }, false), {})
  assert.ok(validateAuth({ loginId: ' ID', password: 'x' }, false).loginId)
  assert.deepEqual(validateAccount({ display_name: '森 結衣', login_id: 'Mori', department_id: 'd', role: 'employee' }, [{ id: 'd', code: 'HR', name: '人事' }]), {})
})

test('共通fetchはno-store・cookie・CSRFとallowlist本文を送信する', async () => {
  const f = fixture()
  await f.api.verify()
  await f.api.request('/accounts', { expected_version: 3 })
  const call = f.calls.at(-1)
  assert.equal(call.options.credentials, 'include')
  assert.equal(call.options.cache, 'no-store')
  assert.equal(call.options.headers['X-CSRF-Token'], 'test-csrf')
  assert.deepEqual(JSON.parse(call.options.body), { expected_version: 3 })
})

test('同じroleの別UUID・権限・制限変更と同じユーザーの新ログインで世代を更新する', async () => {
  const f = fixture()
  await f.api.verify()
  for (const change of [user('22222222-2222-4222-8222-222222222222'), user(undefined, { can_manage_accounts: false }), user(undefined, { must_change_password: true })]) {
    const before = f.api.snapshot().generation
    f.setUser(change)
    await f.api.verify()
    assert.ok(f.api.snapshot().generation > before)
    assert.equal(f.api.snapshot().issued, null)
  }
  const before = f.api.snapshot().generation
  await f.api.login('fixture', 'fixture-password')
  await f.api.login('fixture', 'fixture-password')
  assert.equal(f.api.snapshot().generation, before + 2)
})

test('同じUUIDでも共有cookieが変わった場合は書きを中止しPOSTを自動再送しない', async () => {
  const f = fixture()
  await f.api.verify()
  f.setCsrf('new-session')
  await assert.rejects(f.api.request('/accounts', {}), StaleSession)
  assert.equal(f.calls.filter(call => call.options.method === 'POST').length, 0)
})

test('世代変更で進行中fetchを中断し、abortを無視して届いた本文も破棄する', async () => {
  const f = fixture()
  await f.api.verify()
  let complete
  f.setResponse(() => new Promise(resolve => { complete = resolve }))
  const pending = f.api.request('/accounts')
  const signal = f.calls.at(-1).options.signal
  f.api.invalidate()
  assert.ok(signal.aborted)
  complete(json({ items: [{ display_name: '前の利用者' }] }))
  await assert.rejects(pending, StaleSession)
  assert.equal(f.api.snapshot().user, null)
})

test('本文検査後でも、ログイン・取得・終了の最終反映前に変わった世代を拒否する', async () => {
  for (const operation of ['login', 'request', 'logout', 'password-change']) {
    let api, invalidated = false, broadcasts = 0
    const fetcher = async url => {
      if (url.endsWith('/auth/me')) return json(user())
      if (url.endsWith('/auth/csrf')) return json({ csrf_token: 'test-csrf' })
      const response = json({ user: user(), csrf_token: 'test-csrf', items: [] })
      response.json = () => Promise.resolve().then(() => {
        const invalidate = () => { invalidated = true; api.invalidate(true) }
        queueMicrotask(() => queueMicrotask(() => {
          if (operation === 'logout' || operation === 'password-change') queueMicrotask(invalidate)
          else invalidate()
        }))
        return { user: user(), csrf_token: 'test-csrf', items: [] }
      })
      return response
    }
    api = new SessionApi(fetcher, () => { broadcasts++ })
    await api.verify()
    const pending = operation === 'login' ? api.login('fixture', 'test-only-password')
      : operation === 'request' ? api.request('/accounts')
      : api.end(operation === 'logout' ? '/auth/logout' : '/auth/password/change')
    await assert.rejects(pending, StaleSession, operation)
    assert.equal(invalidated, true, operation)
    assert.equal(api.snapshot().status, 'hidden', operation)
    assert.equal(api.snapshot().user, null, operation)
    assert.equal(broadcasts, 0, operation)
  }
})

test('本文検査後の旧世代エラーは新しい非表示状態を上書きしない', async () => {
  for (const operation of ['verify', 'request']) {
    for (const status of [401, 403, 503]) {
      let api
      api = new SessionApi(async () => {
        const response = json({}, status)
        response.json = () => Promise.resolve().then(() => {
          queueMicrotask(() => queueMicrotask(() => api.invalidate(true)))
          return { code: 'TEST_ERROR', message: '検証エラー' }
        })
        return response
      })
      await assert.rejects(operation === 'verify' ? api.verify() : api.request('/accounts'), StaleSession)
      assert.equal(api.snapshot().status, 'hidden')
      assert.equal(api.snapshot().user, null)
    }
  }
})

test('発行結果の取得後に世代が変わった場合も一回値を表示しない', async () => {
  for (const self of [false, true]) {
    const f = fixture()
    await f.api.verify()
    const generation = f.api.snapshot().generation
    const result = { account: { ...user(), login_id: 'test' }, temporary_password: 'memory-only' }
    f.api.invalidate(true)
    assert.throws(() => f.api.issued(result, self, generation), StaleSession)
    assert.equal(f.api.snapshot().issued, null)
    assert.equal(f.api.snapshot().status, 'hidden')
  }
})

test('401は資料を除去し、通信障害・503は認証切れと断定しない', async () => {
  for (const failure of [() => json({ code: 'AUTHENTICATION_REQUIRED', message: '再ログインしてください。' }, 401), () => json({ code: 'SERVICE_UNAVAILABLE', message: '接続できません。' }, 503), () => { throw new TypeError('network') }]) {
    const f = fixture()
    await f.api.verify()
    f.api.issued({ account: { ...user(), login_id: 'test' }, temporary_password: 'memory-only' }, false, f.api.snapshot().generation)
    f.setResponse(failure)
    await assert.rejects(f.api.request('/accounts'))
    assert.equal(f.api.snapshot().user, null)
    assert.equal(f.api.snapshot().issued, null)
    assert.ok(['ready', 'error'].includes(f.api.snapshot().status))
  }
})

test('403は資料を捨て再確認、404/409/422は元の契約で返し自動POST再試行しない', async () => {
  for (const status of [403, 404, 409, 422, 503]) {
    const f = fixture()
    await f.api.verify()
    const before = f.api.snapshot().generation
    f.setResponse(() => json({ code: 'TEST_ERROR', message: '検証エラー', request_id: 'safe-id' }, status))
    await assert.rejects(f.api.request('/accounts', { expected_version: 1 }), error => error instanceof ApiError && error.status === status)
    assert.equal(f.calls.filter(call => call.options.method === 'POST').length, 1)
    if (status === 403) assert.ok(f.api.snapshot().generation > before)
  }
})

test('自己再発行成功だけはログイン画面用に一回値を保持し、閉じる・無効化・新ログインで除去する', async () => {
  const f = fixture()
  await f.api.verify()
  const issued = { account: { ...user(), login_id: 'self' }, temporary_password: 'ephemeral' }
  f.api.issued(issued, true, f.api.snapshot().generation)
  assert.equal(f.api.snapshot().user, null)
  assert.equal(f.api.snapshot().issued, issued)
  f.api.closeIssued()
  assert.equal(f.api.snapshot().issued, null)
  f.api.issued(issued, true, f.api.snapshot().generation)
  f.api.invalidate(true)
  assert.equal(f.api.snapshot().status, 'hidden')
  assert.equal(f.api.snapshot().issued, null)
  f.api.issued(issued, true, f.api.snapshot().generation)
  await f.api.login('self', 'fixture-password')
  assert.equal(f.api.snapshot().issued, null)
})

test('競合と結果不明の説明を分け、秘密をエラーへ追加しない', () => {
  assert.match(errorMessage(new ApiError(409, 'VERSION_CONFLICT', '競合', 'id'), true), /競合/)
  assert.match(errorMessage(new ApiError(503, 'SERVICE_UNAVAILABLE', '停止'), true), /処理結果は未確認/)
  assert.match(errorMessage(new TypeError(), true), /自動再送はしません/)
})

test('ブラウザーのfetchをサービス自身のthisで呼ばない', async () => {
  const api = new SessionApi(function (url) {
    assert.equal(this, undefined)
    return Promise.resolve(json(url.endsWith('/auth/me') ? user() : { csrf_token: 'test' }))
  })
  await api.verify()
  assert.ok(api.snapshot().user)
})

test('非表示タブと別タブ通知では資料を先に除去し、通知のユーザーを認証根拠にしない', async () => {
  const saved = { fetch: globalThis.fetch, document: globalThis.document, window: globalThis.window, BroadcastChannel: globalThis.BroadcastChannel }
  const document = Object.assign(new EventTarget(), { hidden: true })
  const window = new EventTarget()
  let latest
  class Channel {
    constructor() { latest = this }
    close() {}
    postMessage(value) { assert.equal(value, 'invalidate') }
  }
  globalThis.document = document
  globalThis.window = window
  globalThis.BroadcastChannel = Channel
  globalThis.fetch = async url => json(url.endsWith('/auth/me') ? user() : { csrf_token: 'test-csrf' })
  let stop
  try {
    const module = await import('../src/lib/api.ts?visibility-test')
    stop = module.watchSession()
    assert.equal(module.api.snapshot().status, 'hidden')
    assert.equal(module.api.snapshot().user, null)
    document.hidden = false
    document.dispatchEvent(new Event('visibilitychange'))
    await module.api.verify()
    const before = module.api.snapshot().generation
    document.hidden = true
    document.dispatchEvent(new Event('visibilitychange'))
    assert.equal(module.api.snapshot().status, 'hidden')
    assert.equal(module.api.snapshot().user, null)
    assert.ok(module.api.snapshot().generation > before)
    document.hidden = false
    latest.onmessage({ data: { user: { id: 'forged', can_manage_accounts: true } } })
    assert.equal(module.api.snapshot().user, null)
    await module.api.verify()
    assert.equal(module.api.snapshot().user.id, user().id)
  } finally { stop?.(); Object.assign(globalThis, saved) }
})
