import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { Link, useLocation, useParams } from 'react-router'
import { formatDemoDate, getVisibleRequests, personName, statusLabels, updateRequest } from '../../lib/mockData'
import type { MockRequest, RequestAction } from '../../lib/mockData'
import { DisplayControl } from './Requests'
import type { DisplayMode, RequestProps } from './Requests'
import styles from './Requests.module.css'
import DiscardDialog from '../../components/DiscardDialog'

export default function RequestDetail(props: RequestProps) {
  const { requestId } = useParams()
  const location = useLocation()
  const request = getVisibleRequests(props.requests, props.role, props.userId).find(item => item.id === requestId)
  if (request) return <Detail key={`${props.role}-${request.id}`} {...props} request={request} />

  return (
    <>
      <h1 tabIndex={-1}>問い合わせを表示できません</h1>
      <div className="notice">
        <p>この情報を表示する権限がないか、問い合わせが見つかりません。</p>
        <Link to={`/requests${location.search}`}>問い合わせ一覧へ戻る</Link>
      </div>
    </>
  )
}

function Detail({ role, userId, people, operatorOptions, requests, request, onRequestsChange, onDirtyChange, getNextTimestamp }: RequestProps & { request: MockRequest }) {
  const location = useLocation()
  const [mode, setMode] = useState<DisplayMode>('normal')
  const [assignee, setAssignee] = useState(request.assigneeId ?? '')
  const [resolution, setResolution] = useState('')
  const [body, setBody] = useState(request.body)
  const [editing, setEditing] = useState(false)
  const [confirmCancel, setConfirmCancel] = useState(false)
  const [failSave, setFailSave] = useState(false)
  const [error, setError] = useState('')
  const [resolutionError, setResolutionError] = useState('')
  const [bodyError, setBodyError] = useState('')
  const [message, setMessage] = useState('')
  const headingRef = useRef<HTMLHeadingElement>(null)
  const resolutionRef = useRef<HTMLTextAreaElement>(null)
  const bodyRef = useRef<HTMLTextAreaElement>(null)
  const editButtonRef = useRef<HTMLButtonElement>(null)
  const assigneeRef = useRef<HTMLSelectElement>(null)
  const isOperator = role === 'operator'
  const unresolved = request.status !== 'resolved'
  const dirty = (editing && body !== request.body) || Boolean(resolution) || assignee !== (request.assigneeId ?? '')

  useEffect(() => {
    onDirtyChange(dirty)
    return () => onDirtyChange(false)
  }, [dirty, onDirtyChange])
  useEffect(() => {
    if (editing) bodyRef.current?.focus()
  }, [editing])

  function apply(action: RequestAction) {
    setMessage('')
    setError('')
    if (failSave) {
      setFailSave(false)
      setError('保存に失敗しました（デモ用）。入力は保持されています。同じ操作で再試行してください。')
      return
    }
    try {
      onRequestsChange(updateRequest(requests, role, request.id, action, getNextTimestamp(), userId, operatorOptions))
      if (action.type === 'resolve') {
        setResolution('')
        headingRef.current?.focus()
      }
      if (action.type === 'edit') {
        setEditing(false)
        requestAnimationFrame(() => editButtonRef.current?.focus())
      }
      if (action.type === 'assign') assigneeRef.current?.focus()
      if (action.type === 'start') requestAnimationFrame(() => resolutionRef.current?.focus())
      setMessage('変更を反映しました（このタブ内のシミュレーション）。')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '操作を完了できませんでした。')
    }
  }

  function resolve(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (editing || assignee !== (request.assigneeId ?? '')) {
      setError('先に内容の編集と担当者の変更を保存するか、キャンセルしてください。')
      return
    }
    if (!resolution.trim()) {
      setResolutionError('解決内容を入力してください。空白のみでは解決できません。')
      resolutionRef.current?.focus()
      return
    }
    setResolutionError('')
    apply({ type: 'resolve', resolution })
  }

  function saveBody(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!body.trim()) {
      setBodyError('内容を入力してください。')
      bodyRef.current?.focus()
      return
    }
    setBodyError('')
    apply({ type: 'edit', body })
  }

  function cancelEdit() {
    if (body !== request.body) setConfirmCancel(true)
    else discardEdit()
  }

  function discardEdit() {
    setConfirmCancel(false)
    setBody(request.body)
    setBodyError('')
    setEditing(false)
    requestAnimationFrame(() => editButtonRef.current?.focus())
  }

  function assign(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    apply({ type: 'assign', assigneeId: assignee })
  }

  function retry() {
    setMode('normal')
    headingRef.current?.focus()
  }

  const backParams = new URLSearchParams(location.search)
  backParams.delete('new')
  const backTo = `/requests${backParams.size ? `?${backParams}` : ''}`

  return (
    <>
      {confirmCancel && <DiscardDialog onCancel={() => setConfirmCancel(false)} onDiscard={discardEdit} />}
      <Link to={backTo} className={styles.back}>← 問い合わせ一覧へ戻る（条件を保持）</Link>
      <div className={styles.heading}>
        <div>
          <p className="eyebrow">{request.id} · 問い合わせ詳細</p>
          <h1 ref={headingRef} tabIndex={-1}>{request.title}</h1>
          <span className={`status ${request.status}`}>{statusLabels[request.status]}</span>
        </div>
        <DisplayControl mode={mode} onChange={setMode} />
      </div>
      <p role="status" className={styles.success}>{message}</p>
      {error && <p role="alert" className={styles.errorBanner}>{error}</p>}
      {mode === 'loading' ? (
        <div className="notice" aria-busy="true">
          <p role="status">読み込み中… 表示確認用のシミュレーションです。</p>
        </div>
      ) : mode === 'error' ? (
        <div className="notice">
          <p role="alert">問い合わせを読み込めませんでした。表示確認用のエラーです。編集中の入力は保持されています。</p>
          <button className="button" onClick={retry}>再試行</button>
        </div>
      ) : mode === 'empty' ? (
        <div className="notice">
          <p>問い合わせが見つかりません（表示確認用）。編集中の入力は保持されています。</p>
          <button className="button" onClick={retry}>通常表示に戻る</button>
        </div>
      ) : (
        <div className={styles.detailGrid}>
          <div className={styles.reading}>
            <section className={styles.section} aria-labelledby="body-heading">
              <div className={styles.sectionHeading}>
                <h2 id="body-heading">問い合わせ内容</h2>
                {unresolved && !editing && (
                  <button ref={editButtonRef} className="button" onClick={() => setEditing(true)}>内容を編集</button>
                )}
              </div>
              <p className={styles.meta}>
                申請者 {personName(request.requesterId, people)} · 登録 <time dateTime={request.createdAt}>{formatDemoDate(request.createdAt)} JST</time>
              </p>
              {editing ? (
                <form onSubmit={saveBody} noValidate onKeyDown={event => {
                  if (event.key === 'Enter' && event.nativeEvent.isComposing) event.preventDefault()
                }}>
                  <label className={styles.field}>内容 <span className={styles.required}>必須</span>
                    <textarea
                      ref={bodyRef} value={body} maxLength={5000} required
                      aria-invalid={Boolean(bodyError)} aria-describedby="edit-help edit-error"
                      onChange={event => setBody(event.target.value)}
                    />
                  </label>
                  <p id="edit-help" className={styles.help}>5000文字以内。保存するまで変更は反映されません。</p>
                  <p id="edit-error" className={styles.error}>{bodyError}</p>
                  <div className={styles.actions}>
                    <button type="button" className="button" onClick={cancelEdit}>編集をキャンセル</button>
                    <button className="button buttonPrimary" type="submit">内容を保存</button>
                  </div>
                </form>
              ) : <p className={styles.body}>{request.body}</p>}
            </section>
            {request.status === 'resolved' && (
              <section className={styles.section} aria-labelledby="resolution-heading">
                <h2 id="resolution-heading">解決内容</h2>
                <p className={styles.meta}>解決 <time dateTime={request.resolvedAt!}>{formatDemoDate(request.resolvedAt!)} JST</time></p>
                <p className={styles.body}>{request.resolution}</p>
                {isOperator && (
                  <div className={styles.nextStep}>
                    <h3>解決記録をナレッジへ</h3>
                    <p>問い合わせ番号と解決内容を確認し、手動で下書きを作成します。保存した後に、人が内容を確認して承認します。</p>
                    <Link className="button" to={`/knowledge/reviews/new?source=${request.id}`}>ナレッジの下書きを作成</Link>
                  </div>
                )}
              </section>
            )}
            <section className={styles.section} aria-labelledby="history-heading">
              <h2 id="history-heading">変更履歴</h2>
              <p className={styles.help}>古い順 · 合成データとこのタブ内の操作記録です。</p>
              <ol className={styles.history}>
                {request.events.map((event, index) => (
                  <li key={index}>
                    <div>
                      <strong>{personName(event.actorId, people)}</strong>
                      <time dateTime={event.at}>{formatDemoDate(event.at)} JST</time>
                    </div>
                    <p>{event.description}</p>
                  </li>
                ))}
              </ol>
            </section>
          </div>
          <aside className={styles.side} aria-label="問い合わせの属性と操作">
            <section className={styles.section}>
              <h2>問い合わせ情報</h2>
              <dl className={styles.metadata}>
                <dt>申請者</dt><dd>{personName(request.requesterId, people)}</dd>
                <dt>担当部署</dt><dd>{request.department}</dd>
                <dt>担当者</dt><dd>{personName(request.assigneeId)}</dd>
                <dt>状態</dt><dd>{statusLabels[request.status]}</dd>
                <dt>登録日時</dt><dd>{formatDemoDate(request.createdAt)} JST</dd>
                <dt>更新日時</dt><dd>{formatDemoDate(request.updatedAt)} JST</dd>
              </dl>
            </section>
            {isOperator && unresolved && (
              <section className={styles.section} aria-labelledby="action-heading">
                <h2 id="action-heading">担当者の操作</h2>
                <form onSubmit={assign}>
                  <label className={styles.field}>担当者を割り当てる
                    <select ref={assigneeRef} value={assignee} onChange={event => setAssignee(event.target.value)}>
                      <option value="">選択してください</option>
                      {operatorOptions.map(operator => <option key={operator.id} value={operator.id}>{operator.name}</option>)}
                    </select>
                  </label>
                  <button className="button" type="submit" disabled={!assignee || assignee === request.assigneeId}>割り当てを反映</button>
                </form>
                {request.status === 'open' && (
                  <div className={styles.start}>
                    <p className={styles.help}>担当者を割り当ててから、対応を開始します。</p>
                    <button className="button buttonPrimary" disabled={!request.assigneeId} onClick={() => apply({ type: 'start' })}>対応を開始</button>
                  </div>
                )}
                {request.status === 'in_progress' && (
                  <form className={styles.resolve} onSubmit={resolve} noValidate onKeyDown={event => {
                    if (event.key === 'Enter' && event.nativeEvent.isComposing) event.preventDefault()
                  }}>
                    <label className={styles.field}>解決内容 <span className={styles.required}>必須</span>
                      <textarea
                        ref={resolutionRef} value={resolution} maxLength={5000} required
                        aria-invalid={Boolean(resolutionError)} aria-describedby="resolve-help resolve-error"
                        onChange={event => setResolution(event.target.value)}
                      />
                    </label>
                    <p id="resolve-help" className={styles.help}>確認した原因・手順・結果を5000文字以内で記録します。</p>
                    <p id="resolve-error" className={styles.error}>{resolutionError}</p>
                    <button className="button buttonPrimary" type="submit">解決内容を記録して解決</button>
                  </form>
                )}
              </section>
            )}
            {unresolved && (
              <label className={styles.demoCheck}>
                <input type="checkbox" checked={failSave} onChange={event => setFailSave(event.target.checked)} />
                次の保存を失敗させる（デモ用）
              </label>
            )}
          </aside>
        </div>
      )}
    </>
  )
}
