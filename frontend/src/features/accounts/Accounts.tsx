import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Link } from 'react-router'
import { formatDate as formatDemoDate } from '../../lib/business'
import { api, ApiError, errorMessage, isStale, validateAccount } from '../../lib/api'
import type { Account, AccountAction, AccountInput, Department, EventList, FormErrors, IssuedPassword, User } from '../../lib/api'
import DiscardDialog, { trapDialogFocus } from '../../components/DiscardDialog'
import styles from './Accounts.module.css'

type Action = 'deactivate' | 'reactivate' | 'reissue'
type Props = { user: User; departments: Department[]; onDirtyChange: (dirty: boolean) => void }
const labels: Record<AccountAction, string> = { create: 'アカウント追加', deactivate: '無効化', reactivate: '再有効化', reissue: '仮パスワード再発行', password_change: '本人のパスワード変更', management_granted: '管理権限の初期付与' }

function AccountModal({ title, description, onClose, children }: { title: string; description: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null)
  useLayoutEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    const dialog = ref.current!
    dialog.showModal()
    dialog.querySelector<HTMLElement>('[data-initial-focus]')?.focus()
    return () => {
      dialog.close()
      if (previous?.isConnected) previous.focus()
      else document.querySelector<HTMLElement>('h1')?.focus()
    }
  }, [])
  return <dialog ref={ref} className={styles.dialog} aria-modal="true" aria-labelledby="account-dialog-heading" aria-describedby="account-dialog-description"
    onKeyDown={trapDialogFocus} onCancel={event => { event.preventDefault(); onClose() }}>
    <h2 id="account-dialog-heading">{title}</h2>
    <p id="account-dialog-description" className="muted">{description}</p>
    {children}
  </dialog>
}

export function TemporaryPasswordDialog({ issued, onClose }: { issued: IssuedPassword; onClose: () => void }) {
  return <AccountModal title="仮パスワードを発行しました" description="成功直後の1回だけ表示します。閉じると原文は再表示できません。" onClose={onClose}>
    <dl className={styles.facts}><dt>ログインID</dt><dd>{issued.account.login_id}</dd><dt>仮パスワード</dt><dd><code className={styles.secret}>{issued.temporary_password}</code></dd></dl>
    <p>対象のIDと仮パスワードでログインし、本人のパスワードを変更してください。変更後は新しい値で再ログインします。原文を失った場合は、対象を確認して明示的に再発行してください。</p>
    <p className="muted">原文はこの表示専用です。自動コピー・ダウンロードは行いません。</p>
    <div className={styles.actions}><button data-initial-focus className="button buttonPrimary" onClick={onClose}>確認して閉じる</button></div>
  </AccountModal>
}

export default function Accounts(props: Props) {
  if (!props.user.can_manage_accounts) return <>
    <h1 tabIndex={-1}>アカウント管理を表示できません</h1>
    <div className="notice"><p>アカウント管理権限が必要です。業務上の役割とは別の権限です。</p><Link to="/dashboard">ダッシュボードに戻る</Link></div>
  </>
  return <AccountList {...props} />
}

function AccountList({ user, departments, onDirtyChange }: Props) {
  const [accounts, setAccounts] = useState<Account[]>([])
  const [selectedId, setSelectedId] = useState('')
  const [adding, setAdding] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [revision, setRevision] = useState(0)
  const detailRef = useRef<HTMLHeadingElement>(null)
  const loadSequence = useRef(0)
  const selected = accounts.find(account => account.id === selectedId)

  async function load() {
    const sequence = ++loadSequence.current
    setLoading(true)
    setError('')
    try {
      const result = await api.request<{ items: Account[]; total: number }>('/accounts')
      if (sequence === loadSequence.current) setAccounts(result.items)
    } catch (error) { if (!isStale(error) && sequence === loadSequence.current) { setAccounts([]); setError(errorMessage(error)) } }
    finally { if (sequence === loadSequence.current) setLoading(false) }
  }
  useEffect(() => { void load(); return () => { loadSequence.current++ } }, [])
  async function changed() { setRevision(previous => previous + 1); await load() }

  return <>
    <div className={styles.heading}><div><p className="eyebrow">設定 · 実API</p><h1 tabIndex={-1}>アカウント管理</h1><p className="muted">利用者の追加・利用停止と、アカウントごとの変更履歴を確認します。</p></div></div>
    <p className={styles.disclosure}>管理権限は社員・担当者の業務上の役割とは別です。この画面で管理権限の付与・変更はできません。</p>
    {message && <p className={styles.success} role="status">{message}</p>}
    <div className={styles.toolbar}><h2>アカウント一覧{!loading && !error ? ` · ${accounts.length}件` : ''}</h2><div className={styles.actions}><button className="button" disabled={loading} onClick={() => { void changed() }}>一覧・履歴を再取得</button><button className="button buttonPrimary" disabled={loading || !!error} onClick={() => { api.closeIssued(); setAdding(true) }}>アカウントを追加</button></div></div>
    {loading ? <div className="notice" aria-busy="true"><p role="status">読み込み中…</p></div> : error ? <div className="notice"><p role="alert">{error}</p><button className="button" onClick={() => { void load() }}>再試行</button></div> : !accounts.length ? <div className="notice"><p>アカウントがありません。</p></div> : <>
      <div className={styles.tableScroll} role="region" aria-label="アカウント一覧・横にスクロールできます" tabIndex={0}>
        <table><caption className="srOnly">氏名を選ぶと同じ画面の下部に状態と履歴を表示します。</caption><thead><tr><th scope="col">氏名 / 詳細・履歴</th><th scope="col">ログインID</th><th scope="col">所属</th><th scope="col">業務上の役割</th><th scope="col">有効状態</th><th scope="col">管理権限</th></tr></thead>
          <tbody>{accounts.map(account => <tr key={account.id} className={account.id === selectedId ? styles.selected : ''}>
            <th scope="row"><button className={styles.nameButton} aria-expanded={account.id === selectedId} aria-controls="account-detail" onClick={() => { api.closeIssued(); setSelectedId(account.id); requestAnimationFrame(() => detailRef.current?.focus()) }}>{account.display_name}</button>{account.id === user.id && <span className={styles.self}>自分</span>}</th>
            <td><code>{account.login_id}</code></td><td>{account.department?.name ?? '未設定'}</td><td>{account.role === 'operator' ? '担当者' : '社員'} <small>({account.role})</small></td><td><span className={`status ${account.active ? 'resolved' : 'open'}`}>{account.active ? '有効' : '無効'}</span></td><td>{account.can_manage_accounts ? 'あり' : 'なし'}</td>
          </tr>)}</tbody>
        </table>
      </div>
      <section id="account-detail" className={styles.detail} aria-labelledby="account-detail-heading">
        <h2 id="account-detail-heading" tabIndex={-1} ref={detailRef}>{selected ? `${selected.display_name} · 詳細と変更履歴` : '詳細と変更履歴'}</h2>
        {selected ? <AccountDetail key={`${selected.id}:${revision}`} user={user} account={selected} onChanged={changed} onMessage={setMessage} /> : <p className="muted">一覧の氏名を選ぶと、有効状態の操作・仮パスワード再発行・最小限の履歴を確認できます。</p>}
      </section>
    </>}
    {adding && <AddAccount departments={departments} onDirtyChange={onDirtyChange} onClose={() => setAdding(false)} onCreated={(result, generation) => {
      setAdding(false)
      setSelectedId(result.account.id)
      setMessage('アカウントを追加しました。管理権限は付与していません。')
      api.issued(result, false, generation)
      void changed()
    }} />}
  </>
}

function AccountDetail({ user, account, onChanged, onMessage }: { user: User; account: Account; onChanged: () => Promise<void>; onMessage: (value: string) => void }) {
  const [action, setAction] = useState<Action | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const submitting = useRef(false)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const [events, setEvents] = useState<EventList | null>(null)
  const [historyError, setHistoryError] = useState('')
  const [needsRefresh, setNeedsRefresh] = useState(false)
  const [loading, setLoading] = useState(true)
  const [page, setPage] = useState(1)
  const [reload, setReload] = useState(0)
  const self = user.id === account.id
  const descriptions: Record<Action, string> = {
    deactivate: '対象のすべての接続を終了し、再ログインを拒否します。過去の問い合わせと履歴は残ります。',
    reactivate: '既存のパスワードと変更必要状態を保ちます。無効化前の接続は復活しません。新しいログインが必要です。',
    reissue: '以前のパスワードとすべての接続を無効にし、本人変更が必要な状態にします。原文は成功直後に1回だけ表示します。自分への再発行は現在のログイン状態も終了します。',
  }
  useEffect(() => {
    let current = true
    setLoading(true)
    setEvents(null)
    setHistoryError('')
    void api.request<EventList>(`/accounts/${account.id}/events?page=${page}&page_size=20`).then(result => { if (current) setEvents(result) }).catch(error => { if (current && !isStale(error)) setHistoryError(errorMessage(error)) }).finally(() => { if (current) setLoading(false) })
    return () => { current = false }
  }, [account.id, page, reload])

  async function apply() {
    if (!action || submitting.current) return
    submitting.current = true
    setBusy(true)
    setError('')
    try {
      const generation = api.snapshot().generation
      const result = await api.request<Account | IssuedPassword>(`/accounts/${account.id}/${action === 'reissue' ? 'temporary-password' : action}`, { expected_version: account.row_version })
      api.assertCurrent(generation)
      if (!mounted.current) return
      setAction(null)
      onMessage('アカウントの操作を反映しました。')
      if ('temporary_password' in result) api.issued(result, self, generation)
      if (!(self && action === 'reissue')) await onChanged()
    } catch (error) {
      if (error instanceof ApiError && [404, 409].includes(error.status)) setNeedsRefresh(true)
      if (!isStale(error)) setError(`${errorMessage(error, true)}${error instanceof ApiError && error.status === 409 ? ' 一覧・履歴を再取得し、最新の内容を確認してから改めて操作してください。' : ''}`)
      setAction(null)
    } finally { submitting.current = false; setBusy(false) }
  }
  return <>
    <dl className={styles.facts}><dt>ログインID</dt><dd>{account.login_id}</dd><dt>パスワードの状態</dt><dd>{account.must_change_password ? '本人の変更が必要' : '本人変更の要求なし'}（原文の再照会なし）</dd></dl>
    {error && <p role="alert" className={styles.error}>{error}</p>}
    <div className={styles.operations}>
      <button className="button" disabled={busy || needsRefresh || (self && account.active)} aria-describedby={self ? 'self-protection' : undefined} onClick={() => setAction(account.active ? 'deactivate' : 'reactivate')}>{account.active ? '無効化' : '再有効化'}</button>
      {account.active && <button className="button" disabled={busy || needsRefresh} onClick={() => setAction('reissue')}>仮パスワードを再発行</button>}
    </div>
    {self && <p id="self-protection" className="muted">自分のアカウントは無効化できません。</p>}
    {!account.active && <p className="muted">無効アカウントには仮パスワードを再発行できません。必要なら再有効化後に再発行します。</p>}
    <h3 className={styles.historyHeading}>変更履歴{events ? ` · ${events.total}件` : ''}</h3>
    <p className="muted">パスワード原文は履歴に含みません。時刻はサーバー記録の日本時間表示です。</p>
    {loading ? <p role="status" aria-busy="true">履歴を読み込み中…</p> : historyError ? <><p role="alert">{historyError}</p><button className="button" onClick={() => setReload(value => value + 1)}>履歴を再取得</button></> : events && <>
      {events.items.length ? <ol className={styles.history}>{events.items.map(event => <li key={event.id}><strong>{labels[event.action]}</strong><span>操作：{event.actor?.display_name ?? 'ローカル管理コマンド'} · 対象：{account.display_name}</span><time dateTime={event.occurred_at}>{formatDemoDate(event.occurred_at)} JST</time><small>問い合わせ番号：{event.request_id}</small></li>)}</ol> : <p className={styles.empty}>変更履歴はまだありません。初期アカウントの過去の操作は作成しません。</p>}
      <nav aria-label="変更履歴のページ" className={styles.actions}><button className="button" disabled={events.page <= 1} onClick={() => setPage(events.page - 1)}>前へ</button><span role="status">{events.page} / {events.page_count}ページ</span><button className="button" disabled={events.page >= events.page_count} onClick={() => setPage(events.page + 1)}>次へ</button></nav>
    </>}
    {action && <AccountModal title={`${labels[action]}の確認`} description={descriptions[action]} onClose={() => { if (!busy) setAction(null) }}><p><strong>{account.display_name}</strong>（{account.login_id}）を対象に操作します。</p><div className={styles.actions}><button data-initial-focus className="button" disabled={busy} onClick={() => setAction(null)}>キャンセル</button><button className="button buttonPrimary" disabled={busy} onClick={() => { void apply() }}>{busy ? '送信中…' : `${labels[action]}する`}</button></div></AccountModal>}
  </>
}

function AddAccount({ departments, onDirtyChange, onClose, onCreated }: { departments: Department[]; onDirtyChange: (dirty: boolean) => void; onClose: () => void; onCreated: (result: IssuedPassword, generation: number) => void }) {
  const [input, setInput] = useState<AccountInput>({ display_name: '', login_id: '', department_id: '', role: '' })
  const [errors, setErrors] = useState<FormErrors>({})
  const [confirmClose, setConfirmClose] = useState(false)
  const [busy, setBusy] = useState(false)
  const [uncertain, setUncertain] = useState(false)
  const submitting = useRef(false)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const errorRef = useRef<HTMLDivElement>(null)
  const dirty = Object.values(input).some(Boolean)
  useEffect(() => { onDirtyChange(dirty); return () => onDirtyChange(false) }, [dirty, onDirtyChange])
  function close() { if (busy) return; if (dirty) setConfirmClose(true); else onClose() }
  function update(field: keyof AccountInput, value: string) { setInput(previous => ({ ...previous, [field]: value })); setErrors(previous => ({ ...previous, [field]: undefined, form: undefined })) }
  async function submit() {
    if (submitting.current || uncertain) return
    const validation = validateAccount(input, departments)
    setErrors(validation)
    if (Object.keys(validation).length) { requestAnimationFrame(() => errorRef.current?.focus()); return }
    submitting.current = true
    setBusy(true)
    try {
      const generation = api.snapshot().generation
      const result = await api.request<IssuedPassword>('/accounts', input)
      api.assertCurrent(generation)
      if (!mounted.current) return
      onDirtyChange(false)
      onCreated(result, generation)
    } catch (error) {
      if (isStale(error)) return
      if (!(error instanceof ApiError) || error.status >= 500) setUncertain(true)
      setErrors({ ...(error instanceof ApiError && error.code === 'LOGIN_ID_TAKEN' ? { login_id: 'このIDは使用済みです。別のIDを指定してください。' } : {}), form: errorMessage(error, true) })
      requestAnimationFrame(() => errorRef.current?.focus())
    } finally { submitting.current = false; setBusy(false) }
  }
  return <>
    <AccountModal title="アカウントを追加" description="既存の部署と業務上の役割を指定します。管理権限は付与しません。" onClose={close}>
      <form noValidate onKeyDown={event => { if (event.key === 'Enter' && event.nativeEvent.isComposing) event.preventDefault() }} onSubmit={event => { event.preventDefault(); void submit() }}>
        {Object.values(errors).some(Boolean) && <div className={styles.errorSummary} role="alert" tabIndex={-1} ref={errorRef}><strong>入力内容を確認してください。</strong>{Object.entries(errors).map(([key, error]) => error && <p key={key}>{error}</p>)}</div>}
        {(['display_name', 'login_id', 'department_id', 'role'] as const).map(field => <div className={styles.field} key={field}>
          <label htmlFor={`account-${field}`}>{{ display_name: '氏名', login_id: 'ログインID', department_id: '所属', role: '業務上の役割' }[field]} <span>必須</span></label>
          {field === 'display_name' || field === 'login_id' ? <input data-initial-focus={field === 'display_name' ? true : undefined} id={`account-${field}`} value={input[field]} required disabled={busy} autoComplete="off" autoCapitalize="none" spellCheck={false} aria-invalid={!!errors[field]} aria-describedby={`account-${field}-help account-${field}-error`} onChange={event => update(field, event.target.value)} /> : <select id={`account-${field}`} value={input[field]} required disabled={busy} aria-invalid={!!errors[field]} aria-describedby={`account-${field}-help account-${field}-error`} onChange={event => update(field, event.target.value)}><option value="">選択してください</option>{field === 'department_id' ? departments.map(department => <option key={department.id} value={department.id}>{department.name}</option>) : <><option value="employee">社員（employee）</option><option value="operator">担当者（operator）</option></>}</select>}
          <p id={`account-${field}-help`} className={styles.help}>{{ display_name: '氏名は1〜100文字。改行・制御文字は使用できません。', login_id: '半角英数字・ピリオド・ハイフン・アンダースコアの1〜100文字。大文字・小文字を区別します。', department_id: 'サーバーの既存部署を選びます。', role: '担当者を選んでも管理権限は付きません。' }[field]}</p>
          <p id={`account-${field}-error`} className={styles.error}>{errors[field]}</p>
        </div>)}
        {uncertain && <p role="alert">閉じて一覧・履歴を確認してください。発行済みなら追加を繰り返さず、対象を確認して再発行します。</p>}
        <div className={styles.actions}><button className="button" type="button" disabled={busy} onClick={close}>キャンセル</button><button className="button buttonPrimary" type="submit" disabled={busy || uncertain}>{busy ? '送信中…' : '追加して仮パスワードを表示'}</button></div>
      </form>
    </AccountModal>
    {confirmClose && <DiscardDialog onCancel={() => setConfirmClose(false)} onDiscard={() => { onDirtyChange(false); onClose() }} />}
  </>
}
