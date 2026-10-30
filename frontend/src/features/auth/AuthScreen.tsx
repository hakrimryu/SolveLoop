import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { Link } from 'react-router'
import { mockLoginExamples } from '../../lib/mockData'
import type { MockAuthErrors } from '../../lib/mockData'
import styles from './AuthScreen.module.css'

type Props = {
  changePassword?: boolean
  requiredChange?: boolean
  loginId?: string
  onSubmit: (values: Record<string, string>) => MockAuthErrors
  onDirtyChange: (dirty: boolean) => void
}

export default function AuthScreen({ changePassword = false, requiredChange = false, loginId, onSubmit, onDirtyChange }: Props) {
  const [values, setValues] = useState<Record<string, string>>({})
  const [errors, setErrors] = useState<MockAuthErrors>({})
  const [showPasswords, setShowPasswords] = useState(false)
  const errorRef = useRef<HTMLDivElement>(null)
  const fields = changePassword ? [
    { name: 'currentPassword', label: '現在または仮パスワード', autoComplete: 'current-password' },
    { name: 'newPassword', label: '新しいパスワード', autoComplete: 'new-password' },
    { name: 'confirmation', label: '新しいパスワード（確認）', autoComplete: 'new-password' },
  ] as const : [
    { name: 'loginId', label: 'ログインID', autoComplete: 'username' },
    { name: 'password', label: 'パスワード', autoComplete: 'current-password' },
  ] as const

  useEffect(() => {
    onDirtyChange(changePassword && Object.values(values).some(Boolean))
    return () => onDirtyChange(false)
  }, [changePassword, values, onDirtyChange])

  function submit(event: FormEvent) {
    event.preventDefault()
    const nextErrors = onSubmit(values)
    setErrors(nextErrors)
    if (Object.values(nextErrors).some(Boolean)) requestAnimationFrame(() => errorRef.current?.focus())
    else onDirtyChange(false)
  }

  return <div className={styles.screen}>
    <p className="eyebrow">株式会社 柳 · ローカルの画面モック</p>
    <h1 tabIndex={-1}>{changePassword ? 'パスワード変更' : 'ログイン'}</h1>
    <p className="muted">{changePassword ? '変更後はログイン状態を終了し、新しいパスワードでログインし直します。' : 'ログインIDとパスワードを入力してください。'}</p>
    <p className={styles.disclosure}>合成データ専用です。実際の認証・サーバー保存・権限検査は行いません。普段お使いのパスワードは入力しないでください。</p>
    {changePassword && <div className={styles.guidance}>
      <p>対象：<strong>{loginId}</strong></p>
      {requiredChange && <p><strong>初回・仮パスワードでのログインです。</strong>変更が完了するまで業務画面は利用できません（表示のシミュレーション）。</p>}
    </div>}
    <form className={styles.form} noValidate onSubmit={submit} onKeyDown={event => {
      if (event.key === 'Enter' && event.nativeEvent.isComposing) event.preventDefault()
    }}>
      {Object.values(errors).some(Boolean) && <div id="auth-errors" className={styles.errorSummary} role="alert" tabIndex={-1} ref={errorRef}>
        <strong>入力内容を確認してください。</strong>
        {errors.form && <p>{errors.form}</p>}
        {fields.filter(field => errors[field.name]).map(field => <p key={field.name}><a href={`#${field.name}`}>{errors[field.name]}</a></p>)}
      </div>}
      {fields.map(field => <div className={styles.field} key={field.name}>
        <label htmlFor={field.name}>{field.label}<span>必須</span></label>
        <input id={field.name} name={field.name} required
          type={field.name === 'loginId' || showPasswords ? 'text' : 'password'}
          autoComplete={field.autoComplete} autoCapitalize="none" spellCheck={false}
          value={values[field.name] ?? ''} onChange={event => {
            setValues(previous => ({ ...previous, [field.name]: event.target.value }))
            setErrors(previous => ({ ...previous, [field.name]: undefined, form: undefined }))
          }}
          aria-invalid={!!errors[field.name] || !!errors.form}
          aria-describedby={[errors.form ? 'auth-errors' : '', errors[field.name] ? `${field.name}-error` : '', changePassword && field.name !== 'currentPassword' ? 'password-help' : ''].filter(Boolean).join(' ') || undefined}
        />
        {errors[field.name] && <p id={`${field.name}-error`} className={styles.error}>{errors[field.name]}</p>}
      </div>)}
      {changePassword && <p id="password-help" className={styles.help}>モックでは現在と異なる値を入力してください。確認欄にも同じ新しい値を入力します。</p>}
      <label className={styles.visibility}><input type="checkbox" checked={showPasswords} onChange={event => setShowPasswords(event.target.checked)} />パスワードを表示</label>
      <div className={styles.actions}><button type="submit" className="button buttonPrimary">{changePassword ? '変更して再ログインへ' : 'ログイン'}</button>
        {changePassword && !requiredChange && <Link to="/dashboard">変更せずに戻る</Link>}
      </div>
    </form>
    {!changePassword && <details className={styles.examples} open>
      <summary>入力例（合成データ・モック専用）</summary>
      <p className={styles.help}>役割は入力例のアカウントに対応します。実際の認証APIのアカウント・パスワードとは別です。</p>
      <dl>{mockLoginExamples.map(account => <div key={account.loginId}>
        <dt>{account.name}（{account.role === 'operator' ? '担当者' : '社員'}・管理権限{account.canManageAccounts ? 'あり' : 'なし'}） · {account.mustChangePassword ? '初回・仮パスワード' : '通常ログイン'}</dt>
        <dd>ID：<code>{account.loginId}</code><br />パスワード：<code>{account.password}</code></dd>
      </div>)}</dl>
      <p className={styles.help}>変更後はこのタブで入力した新しい値を使います。再読み込みすると初期値に戻ります。</p>
    </details>}
  </div>
}
