import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Link } from 'react-router'
import { accountActionLabels, canManageMockAccounts, captureMockConnection, createMockAccount, departments, formatDemoDate, getMockAccountEvents, getMockAccounts, getMockConnectionStatus, getMockSession, manageMockAccount } from '../../lib/mockData'
import type { MockAccountAction, MockAccountErrors, MockAccountInput, MockAccountView, MockAuth, MockConnection } from '../../lib/mockData'
import DiscardDialog, { trapDialogFocus } from '../../components/DiscardDialog'
import { DisplayControl } from '../requests/Requests'
import type { DisplayMode } from '../requests/Requests'
import styles from './Accounts.module.css'

type Action = Exclude<MockAccountAction, 'create' | 'password_change'>
type Props = { auth: MockAuth; getNextTimestamp: () => string; onCommit: (auth: MockAuth, issued?: { loginId: string; password: string }) => void; onDirtyChange: (dirty: boolean) => void }

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

export function TemporaryPasswordDialog({ issued, onClose }: { issued: { loginId: string; password: string }; onClose: () => void }) {
  return <AccountModal title="仮パスワードを発行しました（モック）" description="成功直後の1回だけ表示します。閉じると原文は再表示できません。" onClose={onClose}>
    <dl className={styles.facts}><dt>ログインID</dt><dd>{issued.loginId}</dd><dt>合成の仮パスワード</dt><dd><code className={styles.secret}>{issued.password}</code></dd></dl>
    <p>このタブでログアウトし、対象のIDと仮パスワードでログインしてください。本人変更後は新しい値で再ログインします。値を失った場合は、管理権限のあるアカウントで明示的に再発行してください。</p>
    <p className="muted">実際の認証情報ではありません。サーバー保存・他タブのセッション破棄は行いません。</p>
    <div className={styles.actions}><button data-initial-focus className="button buttonPrimary" onClick={onClose}>確認して閉じる</button></div>
  </AccountModal>
}

export default function Accounts(props: Props) {
  if (!canManageMockAccounts(props.auth)) return <>
    <h1 tabIndex={-1}>アカウント管理を表示できません</h1>
    <div className="notice"><p>アカウント管理権限が必要です。業務上の役割とは別の権限です。</p><p>これは表示制御のモックです。サーバーの権限検査ではありません。</p><Link to="/dashboard">ダッシュボードに戻る</Link></div>
  </>
  return <AccountList {...props} />
}

function AccountList({ auth, getNextTimestamp, onCommit, onDirtyChange }: Props) {
  const [selectedId, setSelectedId] = useState('')
  const [adding, setAdding] = useState(false)
  const [mode, setMode] = useState<DisplayMode>('normal')
  const [message, setMessage] = useState('')
  const accounts = getMockAccounts(auth)
  const selected = accounts.find(account => account.id === selectedId)
  const headingRef = useRef<HTMLHeadingElement>(null)
  const detailRef = useRef<HTMLHeadingElement>(null)

  function selectAccount(id: string) {
    setSelectedId(id)
    requestAnimationFrame(() => detailRef.current?.focus())
  }

  return <>
    <div className={styles.heading}><div><p className="eyebrow">設定 · 合成データ</p><h1 tabIndex={-1} ref={headingRef}>アカウント管理</h1><p className="muted">利用者の追加・利用停止と、アカウントごとの変更履歴を確認します。</p></div><DisplayControl mode={mode} onChange={setMode} /></div>
    <p className={styles.disclosure}>管理権限は社員・担当者の業務上の役割とは別です。この画面で管理権限の付与・変更はできません。操作はこのタブ内のシミュレーションです。</p>
    {message && <p className={styles.success} role="status">{message}</p>}
    <div className={styles.toolbar}><h2>アカウント一覧{mode === 'normal' ? ` · ${accounts.length}件` : ''}</h2><button className="button buttonPrimary" disabled={mode !== 'normal'} onClick={() => setAdding(true)}>アカウントを追加</button></div>
    {mode === 'loading' ? <div className="notice" aria-busy="true"><p role="status">読み込み中…（表示確認用）</p></div> : mode === 'error' ? <div className="notice"><p role="alert">一覧を読み込めませんでした（表示確認用）。資料は保持されています。</p><button className="button" onClick={() => { setMode('normal'); headingRef.current?.focus() }}>再試行</button></div> : mode === 'empty' ? <div className="notice"><p>アカウントがありません（表示確認用）。操作済みの資料は削除しません。</p></div> : <>
      <div className={styles.tableScroll} role="region" aria-label="アカウント一覧・横にスクロールできます" tabIndex={0}>
        <table><caption className="srOnly">合成アカウント。氏名を選ぶと同じ画面の下部に状態と履歴を表示します。</caption><thead><tr><th scope="col">氏名 / 詳細・履歴</th><th scope="col">ログインID</th><th scope="col">所属</th><th scope="col">業務上の役割</th><th scope="col">有効状態</th><th scope="col">管理権限</th></tr></thead>
          <tbody>{accounts.map(account => <tr key={account.id} className={account.id === selectedId ? styles.selected : ''}>
            <th scope="row"><button className={styles.nameButton} aria-expanded={account.id === selectedId} aria-controls="account-detail" onClick={() => selectAccount(account.id)}>{account.name}</button>{account.id === getMockSession(auth)?.id && <span className={styles.self}>自分</span>}</th>
            <td><code>{account.loginId}</code></td><td>{account.department}</td><td>{account.role === 'operator' ? '担当者' : '社員'} <small>({account.role})</small></td><td><span className={`status ${account.active ? 'resolved' : 'open'}`}>{account.active ? '有効' : '無効'}</span></td><td>{account.canManageAccounts ? 'あり' : 'なし'}</td>
          </tr>)}</tbody>
        </table>
      </div>
      <section id="account-detail" className={styles.detail} aria-labelledby="account-detail-heading">
        <h2 id="account-detail-heading" tabIndex={-1} ref={detailRef}>{selected ? `${selected.name} · 詳細と変更履歴` : '詳細と変更履歴'}</h2>
        {selected ? <AccountDetail key={selected.id} auth={auth} account={selected} getNextTimestamp={getNextTimestamp} onCommit={(next, issued) => { setMessage('アカウントの操作を反映しました（このタブ内のみ）。'); onCommit(next, issued) }} /> : <p className="muted">一覧の氏名を選ぶと、有効状態の操作・仮パスワード再発行・最小限の履歴を確認できます。</p>}
      </section>
    </>}
    {adding && <AddAccount auth={auth} getNextTimestamp={getNextTimestamp} onDirtyChange={onDirtyChange} onClose={() => setAdding(false)} onCommit={(next, issued) => {
      setAdding(false)
      setSelectedId(next.accounts.at(-1)!.id)
      setMessage('アカウントを追加しました（モック）。管理権限は付与していません。')
      onCommit(next, issued)
    }} />}
  </>
}

function AccountDetail({ auth, account, getNextTimestamp, onCommit }: { auth: MockAuth; account: MockAccountView; getNextTimestamp: () => string; onCommit: Props['onCommit'] }) {
  const [action, setAction] = useState<Action | null>(null)
  const [error, setError] = useState('')
  const [connection, setConnection] = useState<MockConnection | null>(null)
  const events = getMockAccountEvents(auth, account.id)
  const self = getMockSession(auth)?.id === account.id
  const descriptions: Record<Action, string> = {
    deactivate: 'このタブの再ログインと、控えた接続状態を接続不可にします。過去の問い合わせと履歴は残ります。実際のサーバー・他タブのセッションは変更しません。',
    reactivate: '既存のパスワードと変更必要状態を保ちます。無効化前の接続状態は復活しません。新しいログインが必要です（モック）。',
    reissue: '以前のパスワードと控えた接続状態を無効にし、本人変更が必要な状態にします。合成の仮パスワードは成功直後に1回だけ表示します。自分への再発行はこのタブのログイン状態も終了します。',
  }
  function apply() {
    if (!action) return
    const result = manageMockAccount(auth, account.id, action, getNextTimestamp())
    if (result.errors.form) { setError(result.errors.form); return }
    setAction(null)
    setError('')
    onCommit(result.auth, result.temporaryPassword ? { loginId: account.loginId, password: result.temporaryPassword } : undefined)
  }
  return <>
    <dl className={styles.facts}><dt>ログインID</dt><dd>{account.loginId}</dd><dt>パスワードの状態</dt><dd>{account.mustChangePassword ? '本人の変更が必要' : '本人変更の要求なし'}（原文の再照会なし）</dd></dl>
    <div className={styles.operations}>
      <button className="button" disabled={self && account.active} aria-describedby={self ? 'self-protection' : undefined} onClick={() => setAction(account.active ? 'deactivate' : 'reactivate')}>{account.active ? '無効化' : '再有効化'}</button>
      {account.active && <button className="button" onClick={() => setAction('reissue')}>仮パスワードを再発行</button>}
    </div>
    {self && <p id="self-protection" className="muted">自分のアカウントは無効化できません。</p>}
    {!account.active && <p className="muted">無効アカウントには仮パスワードを再発行できません。必要なら再有効化後に再発行します。</p>}
    <details className={styles.probe}><summary>接続状態の表示を確認（デモ用）</summary><p>対象が接続中だった場合を、このタブ内の状態だけで再現します。実際のログインや別タブのセッションは作成・破棄しません。</p><button className="button" disabled={!account.active} onClick={() => setConnection(captureMockConnection(auth, account.id))}>現在の接続状態を控える</button>{connection && <p role="status">控えた状態：<strong>{getMockConnectionStatus(auth, connection)}</strong></p>}</details>
    <h3 className={styles.historyHeading}>変更履歴 · {events.length}件</h3>
    <p className="muted">このタブでの追加・有効状態変更・再発行・本人変更だけを記録します。パスワード原文は記録しません。</p>
    {events.length ? <ol className={styles.history}>{events.map(event => <li key={event.id}><strong>{accountActionLabels[event.action]}</strong><span>操作：{event.actorName} · 対象：{account.name}</span><time dateTime={event.at}>{formatDemoDate(event.at)} JST</time><small>操作番号（モック）：{event.id}</small></li>)}</ol> : <p className={styles.empty}>このタブでの変更履歴はまだありません。初期合成アカウントの過去の操作は作成しません。</p>}
    {action && <AccountModal title={`${accountActionLabels[action]}の確認`} description={descriptions[action]} onClose={() => { setAction(null); setError('') }}><p><strong>{account.name}</strong>（{account.loginId}）を対象に操作します。</p>{error && <p role="alert" className={styles.error}>{error}</p>}<div className={styles.actions}><button data-initial-focus className="button" onClick={() => { setAction(null); setError('') }}>キャンセル</button><button className="button buttonPrimary" onClick={apply}>{accountActionLabels[action]}する（モック）</button></div></AccountModal>}
  </>
}

function AddAccount({ auth, getNextTimestamp, onCommit, onDirtyChange, onClose }: Props & { onClose: () => void }) {
  const [input, setInput] = useState<MockAccountInput>({ name: '', loginId: '', department: '', role: '' })
  const [errors, setErrors] = useState<MockAccountErrors>({})
  const [confirmClose, setConfirmClose] = useState(false)
  const [failSave, setFailSave] = useState(false)
  const errorRef = useRef<HTMLDivElement>(null)
  const dirty = Object.values(input).some(Boolean)
  useEffect(() => { onDirtyChange(dirty); return () => onDirtyChange(false) }, [dirty, onDirtyChange])
  function close() { if (dirty) setConfirmClose(true); else onClose() }
  function update(field: keyof MockAccountInput, value: string) { setInput(previous => ({ ...previous, [field]: value })); setErrors(previous => ({ ...previous, [field]: undefined, form: undefined })) }
  return <>
    <AccountModal title="アカウントを追加" description="合成データの追加です。既存の部署と業務上の役割を指定します。管理権限は付与しません。" onClose={close}>
      <form noValidate onKeyDown={event => { if (event.key === 'Enter' && event.nativeEvent.isComposing) event.preventDefault() }} onSubmit={event => {
        event.preventDefault()
        const result = createMockAccount(auth, input, getNextTimestamp())
        const nextErrors = Object.keys(result.errors).length ? result.errors : failSave ? { form: '追加に失敗しました（デモ用）。入力は保持されています。再試行してください。' } : {}
        setErrors(nextErrors)
        if (Object.keys(nextErrors).length) { if (!Object.keys(result.errors).length) setFailSave(false); requestAnimationFrame(() => errorRef.current?.focus()); return }
        onDirtyChange(false)
        onCommit(result.auth, { loginId: input.loginId, password: result.temporaryPassword! })
      }}>
        {Object.values(errors).some(Boolean) && <div className={styles.errorSummary} role="alert" tabIndex={-1} ref={errorRef}><strong>入力内容を確認してください。</strong>{Object.entries(errors).map(([key, error]) => error && <p key={key}>{error}</p>)}</div>}
        {(['name', 'loginId', 'department', 'role'] as const).map(field => <div className={styles.field} key={field}>
          <label htmlFor={`account-${field}`}>{{ name: '氏名', loginId: 'ログインID', department: '所属', role: '業務上の役割' }[field]} <span>必須</span></label>
          {field === 'name' || field === 'loginId' ? <input data-initial-focus={field === 'name' ? true : undefined} id={`account-${field}`} value={input[field]} required autoComplete="off" autoCapitalize="none" spellCheck={false} aria-invalid={!!errors[field]} aria-describedby={`account-${field}-help account-${field}-error`} onChange={event => update(field, event.target.value)} /> : <select id={`account-${field}`} value={input[field]} required aria-invalid={!!errors[field]} aria-describedby={`account-${field}-help account-${field}-error`} onChange={event => update(field, event.target.value)}><option value="">選択してください</option>{field === 'department' ? departments.map(department => <option key={department}>{department}</option>) : <><option value="employee">社員（employee）</option><option value="operator">担当者（operator）</option></>}</select>}
          <p id={`account-${field}-help`} className={styles.help}>{{ name: '架空の氏名を入力してください。', loginId: '未使用のIDを入力します。モックでは大文字・小文字を区別します。', department: '既存の所属部署を選びます。部署の追加は行いません。', role: '担当者を選んでも管理権限は付きません。' }[field]}</p>
          <p id={`account-${field}-error`} className={styles.error}>{errors[field]}</p>
        </div>)}
        <label className={styles.demoCheck}><input type="checkbox" checked={failSave} onChange={event => setFailSave(event.target.checked)} />次の追加を失敗させる（デモ用）</label>
        <div className={styles.actions}><button className="button" type="button" onClick={close}>キャンセル</button><button className="button buttonPrimary" type="submit">追加して仮パスワードを表示</button></div>
      </form>
    </AccountModal>
    {confirmClose && <DiscardDialog onCancel={() => setConfirmClose(false)} onDiscard={() => { onDirtyChange(false); onClose() }} />}
  </>
}
