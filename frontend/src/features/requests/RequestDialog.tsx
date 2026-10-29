import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { useLocation, useNavigate } from 'react-router'
import { departments, nextMockTimestamp, registerRequest, validateRequest } from '../../lib/mockData'
import type { RequestProps } from './Requests'
import styles from './Requests.module.css'
import DiscardDialog, { trapDialogFocus } from '../../components/DiscardDialog'

export default function RequestDialog({ role, requests, onRequestsChange, onDirtyChange, onClose }: RequestProps & { onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const titleRef = useRef<HTMLInputElement>(null)
  const formRef = useRef<HTMLFormElement>(null)
  const [input, setInput] = useState({ title: '', body: '', department: '' })
  const [errors, setErrors] = useState({ title: '', body: '', department: '' })
  const [error, setError] = useState('')
  const [failSave, setFailSave] = useState(false)
  const [confirmClose, setConfirmClose] = useState(false)
  const navigate = useNavigate()
  const location = useLocation()
  const dirty = Boolean(input.title || input.body || input.department)

  useLayoutEffect(() => {
    const dialog = dialogRef.current!
    dialog.showModal()
    titleRef.current?.focus()
    return () => dialog.close()
  }, [])
  useEffect(() => {
    onDirtyChange(dirty)
    return () => onDirtyChange(false)
  }, [dirty, onDirtyChange])

  function close() {
    if (dirty) setConfirmClose(true)
    else discardAndClose()
  }

  function discardAndClose() {
    onDirtyChange(false)
    dialogRef.current?.close()
    onClose()
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const validation = validateRequest(input)
    setErrors(validation)
    if (Object.values(validation).some(Boolean)) {
      const firstInvalid = Object.entries(validation).find(([, message]) => message)?.[0]
      formRef.current?.querySelector<HTMLElement>(`[name="${firstInvalid}"]`)?.focus()
      return
    }
    if (failSave) {
      setFailSave(false)
      setError('登録に失敗しました（デモ用）。入力は保持されています。もう一度「登録」を押してください。')
      return
    }
    const result = registerRequest(requests, role, input, nextMockTimestamp(requests))
    onRequestsChange(result.requests)
    onDirtyChange(false)
    const params = new URLSearchParams(location.search)
    params.delete('new')
    navigate(`/requests/${result.request.id}${params.size ? `?${params}` : ''}`, {
      replace: true,
      state: { message: '問い合わせを登録しました（このタブ内のシミュレーション）。' },
    })
  }

  return (
    <>
      <dialog
        ref={dialogRef} className={styles.dialog} aria-modal="true"
        aria-labelledby="register-heading" aria-describedby="register-description"
        onKeyDown={trapDialogFocus} onCancel={event => { event.preventDefault(); close() }}
      >
        <div className={styles.dialogHeading}>
          <h2 id="register-heading">問い合わせを登録</h2>
          <button type="button" className="button" onClick={close} aria-label="登録ダイアログを閉じる">閉じる</button>
        </div>
        <p id="register-description" className="muted">合成データの操作デモです。登録内容は再読み込みで初期化されます。</p>
        <form ref={formRef} onSubmit={submit} noValidate onKeyDown={event => {
          if (event.key === 'Enter' && event.nativeEvent.isComposing) event.preventDefault()
        }}>
          <label className={styles.field}>件名 <span className={styles.required}>必須</span>
            <input
              ref={titleRef} name="title" value={input.title} required maxLength={120}
              aria-invalid={Boolean(errors.title)} aria-describedby="title-help title-error"
              onChange={event => setInput({ ...input, title: event.target.value })}
            />
          </label>
          <p id="title-help" className={styles.help}>120文字以内で入力してください。</p>
          <p id="title-error" className={styles.error}>{errors.title}</p>
          <label className={styles.field}>内容 <span className={styles.required}>必須</span>
            <textarea
              name="body" value={input.body} required maxLength={5000}
              aria-invalid={Boolean(errors.body)} aria-describedby="body-help body-error"
              onChange={event => setInput({ ...input, body: event.target.value })}
            />
          </label>
          <p id="body-help" className={styles.help}>症状・試したこと・確認したいことを5000文字以内で入力してください。</p>
          <p id="body-error" className={styles.error}>{errors.body}</p>
          <label className={styles.field}>担当部署 <span className={styles.required}>必須</span>
            <select
              name="department" value={input.department} required
              aria-invalid={Boolean(errors.department)} aria-describedby="department-help department-error"
              onChange={event => setInput({ ...input, department: event.target.value })}
            >
              <option value="">選択してください</option>
              {departments.map(department => <option key={department}>{department}</option>)}
            </select>
          </label>
          <p id="department-help" className={styles.help}>申請者の所属ではなく、対応を依頼する部署です。</p>
          <p id="department-error" className={styles.error}>{errors.department}</p>
          <label className={styles.demoCheck}>
            <input type="checkbox" checked={failSave} onChange={event => setFailSave(event.target.checked)} />
            次の登録を失敗させる（デモ用）
          </label>
          {error && <p role="alert" className={styles.error}>{error}</p>}
          <div className={styles.actions}>
            <button className="button" type="button" onClick={close}>キャンセル</button>
            <button className="button buttonPrimary" type="submit">登録</button>
          </div>
        </form>
      </dialog>
      {confirmClose && <DiscardDialog onCancel={() => setConfirmClose(false)} onDiscard={discardAndClose} />}
    </>
  )
}
