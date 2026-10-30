export type Role = 'employee' | 'operator'
export type Department = { id: string; code: string; name: string }
export type User = { id: string; display_name: string; role: Role; department: Department | null; can_manage_accounts: boolean; must_change_password: boolean }
export type ReferenceData = { departments: Department[]; operators?: { id: string; display_name: string }[] }
export type Account = User & { login_id: string; active: boolean; row_version: number }
export type AccountInput = { display_name: string; login_id: string; department_id: string; role: Role | '' }
export type AccountAction = 'create' | 'deactivate' | 'reactivate' | 'reissue' | 'password_change' | 'management_granted'
export type AccountEvent = { id: string; actor: { id: string; display_name: string } | null; target_user_id: string; action: AccountAction; occurred_at: string; request_id: string }
export type EventList = { items: AccountEvent[]; page: number; page_size: number; page_count: number; total: number }
export type IssuedPassword = { account: Account; temporary_password: string }
export type FormErrors = Partial<Record<string, string>>
export type SessionState = { generation: number; status: 'checking' | 'ready' | 'error' | 'hidden'; user: User | null; notice: string; issued: IssuedPassword | null }

export class ApiError extends Error {
  status: number
  code: string
  requestId: string
  constructor(status: number, code: string, message: string, requestId = '') {
    super(message)
    this.status = status
    this.code = code
    this.requestId = requestId
  }
}

export class StaleSession extends Error {}
export type RequestOptions = { method?: 'POST' | 'PATCH'; idempotencyKey?: string; signal?: AbortSignal; business?: boolean }
export const isStale = (error: unknown) => error instanceof StaleSession

export function errorMessage(error: unknown, write = false) {
  if (isStale(error)) return '接続状態が変わりました。画面を確認してから操作してください。'
  const message = error instanceof ApiError ? error.message : 'サーバーに接続できません。接続を確認してください。'
  const uncertain = write && (!(error instanceof ApiError) || error.status >= 500)
  return `${message}${uncertain ? ' 処理結果は未確認です。自動再送はしません。一覧・履歴、または再ログインで結果を確認してから操作してください。' : ''}${error instanceof ApiError && error.requestId ? ` 問い合わせ番号：${error.requestId}` : ''}`
}

const publicPasswords = new Set(['SolveLoop-Demo-2026!', 'Mock-Operator-2026!', 'Mock-Temporary-2026!', 'Mock-Manager-2026!'])
const length = (value: string) => [...value].length
export function validateAuth(values: Record<string, string>, change: boolean): FormErrors {
  const errors: FormErrors = {}
  if (!change) {
    if (!/^[a-zA-Z0-9._-]{1,100}$/.test(values.loginId ?? '')) errors.loginId = 'IDは半角英数字・ピリオド・ハイフン・アンダースコアの1〜100文字で入力してください。'
    if (!values.password || length(values.password) > 256) errors.password = 'パスワードを1〜256文字で入力してください。'
    return errors
  }
  if (!values.currentPassword || length(values.currentPassword) > 256) errors.currentPassword = '現在または仮パスワードを1〜256文字で入力してください。'
  const next = values.newPassword ?? ''
  if (length(next) < 15 || length(next) > 256 || !next.trim() || /\p{Cc}/u.test(next) || publicPasswords.has(next) || next === values.currentPassword) errors.newPassword = '15〜256文字で、現在の値・公開デモ用の値・制御文字を避けてください。'
  if (!values.confirmation || values.confirmation !== next) errors.confirmation = '新しいパスワードと確認用の入力を一致させてください。'
  return errors
}

export function validateAccount(input: AccountInput, departments: Department[]): FormErrors {
  const errors: FormErrors = {}
  if (!input.display_name.trim() || length(input.display_name.trim()) > 100 || /\p{Cc}/u.test(input.display_name)) errors.display_name = '氏名は制御文字を含めず1〜100文字で入力してください。'
  if (!/^[a-zA-Z0-9._-]{1,100}$/.test(input.login_id)) errors.login_id = 'IDは半角英数字・ピリオド・ハイフン・アンダースコアの1〜100文字で入力してください。'
  if (!departments.some(item => item.id === input.department_id)) errors.department_id = '所属を選択してください。'
  if (!['employee', 'operator'].includes(input.role)) errors.role = '業務上の役割を選択してください。'
  return errors
}

export class SessionApi {
  private state: SessionState = { generation: 0, status: 'checking', user: null, notice: '', issued: null }
  private csrf = ''
  private controllers = new Set<AbortController>()
  private listeners = new Set<() => void>()
  private checking: Promise<User | null> | null = null
  private broadcast: () => void
  private fetcher: typeof fetch

  constructor(fetcher: typeof fetch = fetch, broadcast: () => void = () => {}) {
    this.fetcher = (...args) => fetcher(...args)
    this.broadcast = broadcast
  }

  snapshot = () => this.state
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private publish(patch: Partial<SessionState>) {
    this.state = { ...this.state, ...patch }
    this.listeners.forEach(listener => listener())
  }
  private reset(status: SessionState['status'], notice = '', user: User | null = null, issued: IssuedPassword | null = null) {
    this.controllers.forEach(controller => controller.abort())
    this.controllers.clear()
    this.csrf = ''
    this.checking = null
    this.publish({ generation: this.state.generation + 1, status, user, notice, issued })
  }
  invalidate(hidden = false) { this.reset(hidden ? 'hidden' : 'checking') }
  closeIssued = () => this.publish({ issued: null })
  assertCurrent(generation: number) {
    if (generation !== this.state.generation) throw new StaleSession()
  }

  private async raw<T>(path: string, body?: unknown, login = false, options: RequestOptions = {}): Promise<T> {
    const generation = this.state.generation
    const controller = new AbortController()
    this.controllers.add(controller)
    const abort = () => controller.abort()
    options.signal?.addEventListener('abort', abort, { once: true })
    if (options.signal?.aborted) controller.abort()
    try {
      const response = await this.fetcher(`/api/v1${path}`, {
        method: body === undefined ? 'GET' : options.method ?? 'POST', credentials: 'include', cache: 'no-store', signal: controller.signal,
        headers: body === undefined ? {} : { 'Content-Type': 'application/json', ...(!login ? { 'X-CSRF-Token': this.csrf } : {}), ...(options.idempotencyKey ? { 'Idempotency-Key': options.idempotencyKey } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
      if (generation !== this.state.generation || controller.signal.aborted) throw new StaleSession()
      const data = response.status === 204 ? undefined : await response.json()
      if (generation !== this.state.generation || controller.signal.aborted) throw new StaleSession()
      if (!response.ok) throw new ApiError(response.status, data.code ?? 'HTTP_ERROR', data.message ?? '処理に失敗しました。', data.request_id ?? '')
      return data as T
    } catch (error) {
      if (generation !== this.state.generation || controller.signal.aborted) throw new StaleSession()
      throw error
    } finally { this.controllers.delete(controller); options.signal?.removeEventListener('abort', abort) }
  }

  async verify(): Promise<User | null> {
    if (this.checking) return this.checking
    if (this.state.status === 'error') this.publish({ status: 'checking' })
    const generation = this.state.generation
    const pending = (async () => {
      try {
        const user = await this.raw<User>('/auth/me')
        this.assertCurrent(generation)
        const { csrf_token } = await this.raw<{ csrf_token: string }>('/auth/csrf')
        if (generation !== this.state.generation) throw new StaleSession()
        if (this.state.user && (JSON.stringify(user) !== JSON.stringify(this.state.user) || (this.csrf && this.csrf !== csrf_token))) {
          this.reset('ready', 'アカウントの状態が変わったため、表示内容を初期化しました。', user)
        }
        this.csrf = csrf_token
        this.publish({ user, status: 'ready' })
        return user
      } catch (error) {
        this.assertCurrent(generation)
        if (isStale(error)) throw error
        if (error instanceof ApiError && error.status === 401) {
          this.reset('ready', 'ログインしてください。')
          return null
        }
        this.reset('error', errorMessage(error))
        throw error
      } finally { if (generation === this.state.generation) this.checking = null }
    })()
    this.checking = pending
    return pending
  }

  async request<T>(path: string, body?: unknown, options: RequestOptions = {}): Promise<T> {
    const generation = this.state.generation
    if (options.signal?.aborted) throw new StaleSession()
    if (body !== undefined) {
      const user = await this.verify()
      if (!user || generation !== this.state.generation || options.signal?.aborted) throw new StaleSession()
    }
    try {
      const result = await this.raw<T>(path, body, false, options)
      this.assertCurrent(generation)
      if (options.signal?.aborted) throw new StaleSession()
      return result
    }
    catch (error) {
      this.assertCurrent(generation)
      if (isStale(error)) throw error
      if (error instanceof ApiError && error.status === 401) {
        this.reset('ready', '接続が終了しました。もう一度ログインしてください。')
        this.broadcast()
      } else if (error instanceof ApiError && error.status === 403) {
        this.reset('checking', errorMessage(error))
        try { await this.verify() } catch { /* 再確認画面で接続エラーを表示する。 */ }
      } else if (!options.business && (!(error instanceof ApiError) || error.status >= 500)) {
        this.reset('error', errorMessage(error, body !== undefined))
      }
      throw error
    }
  }

  async login(login_id: string, password: string) {
    this.closeIssued()
    const generation = this.state.generation
    const result = await this.raw<{ user: User; csrf_token: string }>('/auth/login', { login_id, password }, true)
    this.assertCurrent(generation)
    this.reset('ready', '', result.user)
    this.csrf = result.csrf_token
    this.broadcast()
  }

  async end(path: '/auth/logout' | '/auth/password/change', body: unknown = {}) {
    const generation = this.state.generation
    await this.request<void>(path, body)
    this.assertCurrent(generation)
    this.reset('ready', path === '/auth/logout' ? 'ログアウトしました。' : 'パスワードを変更しました。新しい値でログインしてください。')
    this.broadcast()
  }

  issued(result: IssuedPassword, self: boolean, generation: number) {
    this.assertCurrent(generation)
    if (self) {
      this.reset('ready', '本人の仮パスワードを再発行し、すべての接続を終了しました。', null, result)
      this.broadcast()
    } else this.publish({ issued: result })
  }
}

let channel: BroadcastChannel | undefined
export const api = new SessionApi(fetch, () => channel?.postMessage('invalidate'))
export function watchSession() {
  channel = new BroadcastChannel('solveloop-auth')
  const refresh = () => {
    api.invalidate(document.hidden)
    if (!document.hidden) void api.verify().catch(() => {})
  }
  channel.onmessage = refresh
  document.addEventListener('visibilitychange', refresh)
  window.addEventListener('focus', refresh)
  window.addEventListener('pageshow', refresh)
  refresh()
  return () => {
    channel?.close()
    channel = undefined
    document.removeEventListener('visibilitychange', refresh)
    window.removeEventListener('focus', refresh)
    window.removeEventListener('pageshow', refresh)
    api.invalidate()
  }
}
