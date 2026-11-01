import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { Link } from 'react-router'
import { validateAuth } from '../../lib/api'
import type { FormErrors } from '../../lib/api'
import styles from './AuthScreen.module.css'

type Props = {
  changePassword?: boolean
  requiredChange?: boolean
  loginId?: string
  onSubmit: (values: Record<string, string>) => Promise<FormErrors>
  onDirtyChange: (dirty: boolean) => void
}

export default function AuthScreen({ changePassword = false, requiredChange = false, loginId, onSubmit, onDirtyChange }: Props) {
  const [values, setValues] = useState<Record<string, string>>({})
  const [errors, setErrors] = useState<FormErrors>({})
  const [pending, setPending] = useState(false)
  const submitting = useRef(false)
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

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (submitting.current) return
    const validation = validateAuth(values, changePassword)
    if (Object.keys(validation).length) { setErrors(validation); requestAnimationFrame(() => errorRef.current?.focus()); return }
    submitting.current = true
    setPending(true)
    try {
      const nextErrors = await onSubmit(values)
      // 認証要求の完了後は入力原文を消し、失敗時にもパスワードを残さない。
      // [ko] 인증 요청이 완료되면 입력 원문을 지워 실패한 경우에도 비밀번호를 남기지 않는다.
      // [en] Clear raw credentials after authentication requests, including failed authentication.
      setValues({})
      setShowPasswords(false)
      onDirtyChange(false)
      setErrors(nextErrors)
      if (Object.values(nextErrors).some(Boolean)) requestAnimationFrame(() => errorRef.current?.focus())
    } finally { submitting.current = false; setPending(false) }
  }

  return <div className={styles.screen}>
    <p className="eyebrow">株式会社 柳 · ローカル認証</p>
    <h1 tabIndex={-1}>{changePassword ? 'パスワード変更' : 'ログイン'}</h1>
    <p className="muted">{changePassword ? '変更後はログイン状態を終了し、新しいパスワードでログインし直します。' : 'ログインIDとパスワードを入力してください。'}</p>
    <p className={styles.disclosure}>認証はローカルAPIに接続します。アカウントの発行・再発行は管理権限のある利用者に依頼してください。</p>
    {changePassword && <div className={styles.guidance}>
      <p>対象：<strong>{loginId}</strong></p>
      {requiredChange && <p><strong>初回・仮パスワードでのログインです。</strong>変更が完了するまで業務画面は利用できません。</p>}
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
          disabled={pending} value={values[field.name] ?? ''} onChange={event => {
            setValues(previous => ({ ...previous, [field.name]: event.target.value }))
            setErrors(previous => ({ ...previous, [field.name]: undefined, form: undefined }))
          }}
          aria-invalid={!!errors[field.name] || !!errors.form}
          aria-describedby={[errors.form ? 'auth-errors' : '', errors[field.name] ? `${field.name}-error` : '', changePassword && field.name !== 'currentPassword' ? 'password-help' : ''].filter(Boolean).join(' ') || undefined}
        />
        {errors[field.name] && <p id={`${field.name}-error`} className={styles.error}>{errors[field.name]}</p>}
      </div>)}
      {changePassword && <p id="password-help" className={styles.help}>15〜256文字。現在と同じ値、公開デモ用の値、空白だけの値、改行などの制御文字は使えません。Unicode・空白は変換しません。確認欄にも同じ新しい値を入力します。</p>}
      <label className={styles.visibility}><input type="checkbox" checked={showPasswords} onChange={event => setShowPasswords(event.target.checked)} />パスワードを表示</label>
      <div className={styles.actions}><button type="submit" disabled={pending} className="button buttonPrimary">{pending ? '送信中…' : changePassword ? '変更して再ログインへ' : 'ログイン'}</button>
        {changePassword && !requiredChange && <Link to="/">変更せずに戻る</Link>}
      </div>
    </form>

  </div>
}
