import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router'
import { departments, formatDemoDate, getKnowledgeReviews, getKnowledgeSourceIssue, getPublishedKnowledge, knowledgeStatusLabels, prepareKnowledgeDraft, reviewKnowledge, saveKnowledgeDraft, validateKnowledge } from '../../lib/mockData'
import type { KnowledgeInput, KnowledgeSource, KnowledgeVersion, MockRequest } from '../../lib/mockData'
import { KnowledgeBody, KnowledgeUnavailable } from './Knowledge'
import type { KnowledgeProps } from './Knowledge'
import { DisplayControl } from '../requests/Requests'
import type { DisplayMode } from '../requests/Requests'
import DiscardDialog, { trapDialogFocus } from '../../components/DiscardDialog'
import common from '../requests/Requests.module.css'
import styles from './Knowledge.module.css'

type Props = KnowledgeProps & {
  actorName: string
  requests: MockRequest[]
  onKnowledgeChange: (knowledge: KnowledgeVersion[]) => void
  onDirtyChange: (dirty: boolean) => void
  getNextTimestamp: () => string
}

export default function KnowledgeReview(props: Props) {
  const { documentId, version } = useParams()
  const [params] = useSearchParams()
  const location = useLocation()
  if (props.role !== 'operator') return <KnowledgeUnavailable restricted />
  const saved = documentId ? getKnowledgeReviews(props.knowledge, props.role).find(item => item.id === documentId && String(item.version) === version)
    ?? props.knowledge.find(item => item.id === documentId && String(item.version) === version && item.status === 'approved') : undefined
  if (documentId && !saved) return <><h1 tabIndex={-1}>レビューを表示できません</h1><div className="notice"><p>対象の文書・版が見つかりません。</p><Link to="/knowledge/reviews">レビュー一覧へ</Link></div></>
  try {
    const prepared = saved ? { input: { title: saved.title, audience: saved.audience, department: saved.department, body: saved.body }, sources: saved.sources }
      : prepareKnowledgeDraft(props.knowledge, props.requests, props.role, params.get('source'), params.get('document'))
    return <Editor key={`${props.role}-${location.pathname}-${location.search}`} {...props} saved={saved} initial={prepared.input} sources={prepared.sources} documentId={params.get('document') ?? undefined} />
  } catch (cause) {
    return <><h1 tabIndex={-1}>下書きを作成できません</h1><div className="notice"><p>{cause instanceof Error ? cause.message : '作成元を確認してください。'}</p><Link to="/knowledge/reviews">レビュー一覧へ</Link></div></>
  }
}

function Editor({ role, actorName, knowledge, requests, onKnowledgeChange, onDirtyChange, getNextTimestamp, saved, initial, sources, documentId }: Props & { saved?: KnowledgeVersion; initial: KnowledgeInput; sources: KnowledgeSource[]; documentId?: string }) {
  const [input, setInput] = useState(initial)
  const [preview, setPreview] = useState(false)
  const [mode, setMode] = useState<DisplayMode>('normal')
  const [errors, setErrors] = useState(validateKnowledge(initial))
  const [validated, setValidated] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [failSave, setFailSave] = useState(false)
  const [confirm, setConfirm] = useState<'approve' | 'reject' | null>(null)
  const [reason, setReason] = useState('')
  const [reasonError, setReasonError] = useState('')
  const [discardReason, setDiscardReason] = useState(false)
  const [discardEdit, setDiscardEdit] = useState(false)
  const navigate = useNavigate()
  const location = useLocation()
  const errorRef = useRef<HTMLDivElement>(null)
  const formRef = useRef<HTMLFormElement>(null)
  const headingRef = useRef<HTMLHeadingElement>(null)
  const dialogRef = useRef<HTMLDialogElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const reasonRef = useRef<HTMLTextAreaElement>(null)
  const editable = !saved || saved.status === 'draft'
  const inputDirty = editable && (Object.keys(input) as (keyof KnowledgeInput)[]).some(key => input[key] !== initial[key])
  const dirty = inputDirty || Boolean(reason)
  const issue = getKnowledgeSourceIssue(sources, requests)
  const published = getPublishedKnowledge(knowledge).find(item => item.id === (saved?.id ?? documentId))

  useEffect(() => {
    onDirtyChange(dirty)
    return () => onDirtyChange(false)
  }, [dirty, onDirtyChange])
  useLayoutEffect(() => {
    if (!confirm) return
    const previous = document.activeElement as HTMLElement | null
    const dialog = dialogRef.current!
    dialog.showModal()
    cancelRef.current?.focus()
    return () => { dialog.close(); if (previous?.isConnected) previous.focus() }
  }, [confirm])

  function showError(text: string) {
    setError(text)
    requestAnimationFrame(() => errorRef.current?.focus())
  }

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const validation = validateKnowledge(input)
    setValidated(true)
    setErrors(validation)
    setMessage('')
    if (Object.values(validation).some(Boolean)) {
      showError('入力内容を確認してください。入力した内容は保持されています。')
      return
    }
    if (failSave) {
      setFailSave(false)
      showError('保存に失敗しました（デモ用）。入力は保持されています。「下書きを保存」で再試行してください。')
      return
    }
    try {
      const result = saveKnowledgeDraft(knowledge, role, input, sources, getNextTimestamp(), saved, documentId, actorName)
      onDirtyChange(false)
      onKnowledgeChange(result.knowledge)
      setInput({ title: result.saved.title, audience: result.saved.audience, department: result.saved.department, body: result.saved.body })
      setError('')
      setMessage('下書きを保存しました（このタブ内のみ）。まだ社員の検索には公開されていません。')
      if (!saved) navigate(`/knowledge/reviews/${result.saved.id}/versions/${result.saved.version}`, { replace: true, state: { saved: true } })
    } catch (cause) { showError(cause instanceof Error ? cause.message : '保存できませんでした。') }
  }

  function openConfirm(action: 'approve' | 'reject') {
    if (!saved || inputDirty) { showError('先に編集内容を保存するか、編集を取り消してください。'); return }
    setReasonError('')
    setError('')
    setConfirm(action)
  }

  function closeConfirm() {
    if (reason) setDiscardReason(true)
    else setConfirm(null)
  }

  function submitReview(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!saved || !confirm || inputDirty) return
    if (confirm === 'reject' && (!reason.trim() || reason.trim().length > 1000)) {
      setReasonError('差し戻しの理由を1〜1000文字で入力してください。')
      reasonRef.current?.focus()
      return
    }
    if (failSave) {
      setFailSave(false)
      setReasonError('操作に失敗しました（デモ用）。内容は保持されています。同じボタンで再試行してください。')
      return
    }
    try {
      const next = reviewKnowledge(knowledge, requests, role, saved, confirm, reason, getNextTimestamp(), actorName)
      onDirtyChange(false)
      onKnowledgeChange(next)
      setReason('')
      setConfirm(null)
      setMessage(confirm === 'approve' ? '承認しました。社員全員の検索に公開されています（このタブ内のみ）。' : '理由を記録して差し戻しました。一般の検索には公開されません。')
      requestAnimationFrame(() => headingRef.current?.focus())
    } catch (cause) { setReasonError(cause instanceof Error ? cause.message : '操作を完了できませんでした。') }
  }

  function resetInput() {
    setInput(initial)
    setDiscardEdit(false)
    setValidated(false)
    setError('')
  }

  return <>
    {discardEdit && <DiscardDialog onCancel={() => setDiscardEdit(false)} onDiscard={resetInput} />}
    {discardReason && <DiscardDialog onCancel={() => setDiscardReason(false)} onDiscard={() => { setReason(''); setDiscardReason(false); setConfirm(null) }} />}
    <Link className={common.back} to={`/knowledge/reviews${saved ? location.search : ''}`}>← ナレッジレビューへ戻る</Link>
    <div className={common.heading}><div><p className="eyebrow">{saved ? `${saved.id} / ${knowledgeStatusLabels[saved.status]} v${saved.version}` : documentId ? `${documentId} / 新しい改訂版（未保存）` : '手動作成 / 未保存'}</p>
      <h1 tabIndex={-1} ref={headingRef}>{saved ? saved.title : 'ナレッジの下書きを作成'}</h1>
      <p className="muted">{saved ? `保存した版 v${saved.version} · 更新 ${formatDemoDate(saved.updatedAt)} JST` : '解決根拠を確認し、社員向けの文書を手動で記載します。AI生成は行いません。'}</p></div>
      <DisplayControl mode={mode} onChange={setMode} /></div>
    {(message || location.state?.saved) && <p role="status" className={common.success}>{message || '下書きを保存しました（このタブ内のみ）。まだ社員の検索には公開されていません。'}</p>}
    {error && <div className={common.errorBanner} ref={errorRef} tabIndex={-1} role="alert"><p>{error}</p>
      {validated && <ul>{(Object.keys(errors) as (keyof KnowledgeInput)[]).filter(key => errors[key]).map(key => <li key={key}><a href={`#knowledge-${key}`} onClick={e => { e.preventDefault(); setPreview(false); requestAnimationFrame(() => formRef.current?.querySelector<HTMLElement>(`#knowledge-${key}`)?.focus()) }}>{errors[key]}</a></li>)}</ul>}</div>}
    {mode === 'loading' ? <div className="notice" aria-busy="true"><p role="status">読み込み中…（デモ用）。編集中の内容は保持されています。</p></div> : mode !== 'normal' ?
      <div className="notice"><p role={mode === 'error' ? 'alert' : undefined}>{mode === 'error' ? 'レビューを読み込めませんでした（デモ用）。' : '文書が見つかりません（表示確認用）。'}入力は保持されています。</p><button className="button" onClick={() => setMode('normal')}>再試行</button></div> : <>
        {published && editable && <p className={styles.warning}>改訂中も、社員には承認済み v{published.version} が表示されます。 <Link to={`/knowledge/${published.id}`}>現在の公開版を読む</Link></p>}
        {issue && <p role="alert" className={styles.warning}>{issue}</p>}
        {saved?.status === 'rejected' && <p className={styles.warning}>差し戻しの記録は閲覧のみです。このモックでは再編集・再申請を扱いません。再作成の運用は今後検討します。</p>}
        <div className={styles.editorGrid}>
          <section className={common.section} aria-label="文書の編集と確認">
            {editable && <div className={styles.modeBar}><button className="button" aria-pressed={!preview} onClick={() => setPreview(false)}>編集</button><button className="button" aria-pressed={preview} onClick={() => setPreview(true)}>プレビュー</button><span>{inputDirty ? '未保存の変更あり' : saved ? '保存済み · 未承認' : '未保存'}</span></div>}
            {preview || !editable ? <><h2 className={styles.previewTitle}>{input.title || '（件名は未入力）'}</h2><p className={common.help}>{editable ? saved && !inputDirty ? '保存済みの下書きのプレビューです。まだ公開されていません。' : '編集中の内容のプレビューです。この変更はまだ保存・公開されていません。' : knowledgeStatusLabels[saved!.status]}</p><KnowledgeBody input={input} /></> :
              <form ref={formRef} onSubmit={save} noValidate onKeyDown={e => { if (e.key === 'Enter' && e.nativeEvent.isComposing) e.preventDefault() }}>
                <label className={common.field} htmlFor="knowledge-title">件名 <span className={common.required}>必須</span></label>
                <input className={styles.fullWidth} id="knowledge-title" value={input.title} required maxLength={120} aria-invalid={validated && Boolean(errors.title)} aria-describedby="knowledge-title-error" onChange={e => setInput({ ...input, title: e.target.value })} />
                <p className={common.error} id="knowledge-title-error">{validated && errors.title}</p>
                <label className={common.field} htmlFor="knowledge-audience">適用対象 <span className={common.required}>必須</span></label>
                <input className={styles.fullWidth} id="knowledge-audience" value={input.audience} required maxLength={300} aria-invalid={validated && Boolean(errors.audience)} aria-describedby="knowledge-audience-error" onChange={e => setInput({ ...input, audience: e.target.value })} />
                <p className={common.error} id="knowledge-audience-error">{validated && errors.audience}</p>
                <label className={common.field} htmlFor="knowledge-department">担当部署 <span className={common.required}>必須</span></label>
                <select className={styles.fullWidth} id="knowledge-department" value={input.department} required aria-invalid={validated && Boolean(errors.department)} aria-describedby="knowledge-department-error" onChange={e => setInput({ ...input, department: e.target.value })}><option value="">選択してください</option>{departments.map(d => <option key={d}>{d}</option>)}</select>
                <p className={common.error} id="knowledge-department-error">{validated && errors.department}</p>
                <label className={common.field} htmlFor="knowledge-body">本文 <span className={common.required}>必須</span></label>
                <textarea className={`${styles.fullWidth} ${styles.editorBody}`} id="knowledge-body" value={input.body} required maxLength={20000} aria-invalid={validated && Boolean(errors.body)} aria-describedby="knowledge-body-help knowledge-body-error" onChange={e => setInput({ ...input, body: e.target.value })} />
                <p id="knowledge-body-help" className={common.help}>20000文字以内。症状・手順・例外や注意事項を記載します。改行はそのまま表示します。HTML・Markdownの実行は行いません。</p><p className={common.error} id="knowledge-body-error">{validated && errors.body}</p>
                <div className={common.actions}><button type="button" className="button" disabled={!inputDirty} onClick={() => setDiscardEdit(true)}>編集を取り消す</button><button className="button buttonPrimary">下書きを保存</button></div>
                <p className={common.help}>保存は公開ではありません。保存した内容を確認してから、承認してください。</p>
              </form>}
            {editable && preview && <p className={common.help}>保存するには「編集」に戻ってください。未保存のまま承認できません。</p>}
          </section>
          <aside className={`${common.section} ${styles.evidence}`} aria-label="担当者用の解決根拠">
            <h2>元になった解決記録</h2><p className={common.help}>担当者専用。保存時の写しは公開文書に含まれません。本文に公開する情報は別途確認してください。</p>
            {!sources.length && <p className={styles.evidenceText}>手動作成のため、問い合わせの解決根拠は関連付けられていません。</p>}
            {sources.map(source => <div key={source.requestId}><Link to={`/requests/${source.requestId}`}>{source.requestId} を開く</Link><p className={styles.evidenceText}>{source.title}</p>
              <p className={common.meta}>原本更新 {formatDemoDate(source.updatedAt)} JST<br />解決 {formatDemoDate(source.resolvedAt)} JST</p>
              <h3>問い合わせ内容の写し</h3><p className={styles.evidenceText}>{source.body}</p><h3>解決内容の写し</h3><p className={styles.evidenceText}>{source.resolution}</p>
              <p className={common.help}>{issue ? '原本の変更：要確認' : '原本の変更：なし（このタブ内の比較）'}</p></div>)}
          </aside>
        </div>
        {editable && <section className={styles.reviewActions} aria-label="保存した版のレビュー"><h2>保存した版を確認して判断</h2><p>{!saved ? '先に下書きを保存してください。' : inputDirty ? '未保存の変更があります。先に保存するか、編集を取り消してください。' : `${saved.id} / v${saved.version} の保存済み内容が対象です。承認すると社員全員の検索に公開されます。`}</p>
          <div><button className="button" disabled={!saved || inputDirty} onClick={() => openConfirm('reject')}>理由を入力して差し戻す</button><button className="button buttonPrimary" disabled={!saved || inputDirty || Boolean(issue)} onClick={() => openConfirm('approve')}>承認して公開</button></div>
          <label className={common.demoCheck}><input type="checkbox" checked={failSave} onChange={e => setFailSave(e.target.checked)} />次の保存・承認・差し戻しを失敗させる（デモ用）</label>
        </section>}
        {saved?.status === 'approved' && <div className="notice"><Link className="button buttonPrimary" to={`/knowledge/${saved.id}`}>公開したナレッジを開く</Link><Link className={styles.inlineLink} to="/knowledge">ナレッジを検索</Link><p className={common.help}>Radarは固定サンプルです。承認後も再分析は行いません。</p></div>}
        {saved && <section className={`${common.section} ${styles.historySection}`} aria-label="保存・レビューの履歴"><h2>保存・レビューの履歴</h2>{saved.events.length ? <ol className={common.history}>{saved.events.map((event, index) => <li key={index}><time>{formatDemoDate(event.at)} JST</time><p>{event.description}</p></li>)}</ol> : <p className={common.help}>追加の操作記録はありません（合成資料）。</p>}</section>}
      </>}
    {confirm && saved && <dialog ref={dialogRef} className={common.dialog} aria-modal="true" aria-labelledby="review-confirm-heading" aria-describedby="review-confirm-description" onKeyDown={trapDialogFocus} onCancel={e => { e.preventDefault(); closeConfirm() }}>
      <h2 id="review-confirm-heading">{confirm === 'approve' ? '保存した版を承認して公開しますか？' : '理由を記録して差し戻しますか？'}</h2>
      <p id="review-confirm-description" className={common.meta}>{saved.id} / v{saved.version} · {saved.title}<br />保存日時 {formatDemoDate(saved.updatedAt)} JST</p>
      <p className={styles.evidenceText}>{confirm === 'approve' ? 'この保存済みの内容が社員全員の検索に公開されます。担当者用の解決根拠は公開文書に含みません。' : '公開せずに理由を記録します。このモックでは差し戻し後の再編集は行いません。'}</p>
      <form onSubmit={submitReview} noValidate onKeyDown={e => { if (e.key === 'Enter' && e.nativeEvent.isComposing) e.preventDefault() }}>
        {confirm === 'reject' && <><label className={common.field}>差し戻しの理由 <span className={common.required}>必須</span><textarea ref={reasonRef} value={reason} required maxLength={1000} aria-invalid={Boolean(reasonError)} aria-describedby="reason-error" onChange={e => setReason(e.target.value)} /></label></>}
        <p id="reason-error" className={common.error} role={reasonError ? 'alert' : undefined}>{reasonError}</p>
        <div className={common.actions}><button ref={cancelRef} className="button" type="button" onClick={closeConfirm}>キャンセル</button><button className="button buttonPrimary">{confirm === 'approve' ? 'この版を承認して公開' : '理由を記録して差し戻す'}</button></div>
      </form>
    </dialog>}
  </>
}
