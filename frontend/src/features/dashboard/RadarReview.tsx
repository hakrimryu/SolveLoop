import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router'
import DiscardDialog from '../../components/DiscardDialog'
import { errorMessage, isStale } from '../../lib/api'
import { formatDate } from '../../lib/business'
import { useBusinessCall } from '../../lib/useBusiness'
import common from '../requests/Requests.module.css'
import styles from './Radar.module.css'

type Document = { document_id: string; version_id: string; version_no: number; number: string; title: string; href: string; content_hash: string }
export type HumanReview = {
  id: string; candidate_id: string; decision: 'linked' | 'needs_supplement'; reason: string
  documents: Document[]; ticket_ids: string[]; current: boolean; coverage_id: string | null
  reviewer: { display_name: string }; created_at: string
}
export type ReviewContext = { hash: string; documents: Document[] }

export default function RadarReview({ runId, candidateId, members, context, reviews, coverageId, current, disabled, onDirtyChange, onSaved }: {
  runId: string; candidateId: string; members: { id: string; number: string; title: string }[]
  context: ReviewContext; reviews: HumanReview[]; coverageId?: string
  current: boolean; disabled: boolean; onDirtyChange: (dirty: boolean) => void; onSaved: () => Promise<unknown>
}) {
  const [decision, setDecision] = useState('needs_supplement')
  const [reason, setReason] = useState('')
  const [tickets, setTickets] = useState<string[]>([])
  const [documents, setDocuments] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [discard, setDiscard] = useState(false)
  const [pending, setPending] = useState<object | null>(null)
  const initialHash = useRef(context.hash)
  const alive = useRef(true)
  const call = useBusinessCall()
  const dirty = !!(reason || tickets.length || documents.length || pending)
  useEffect(() => { onDirtyChange(dirty || busy); return () => onDirtyChange(false) }, [dirty, busy, onDirtyChange])
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  function clear() { setReason(''); setTickets([]); setDocuments([]); setPending(null); setDecision('needs_supplement'); initialHash.current = context.hash }
  async function save() {
    if (busy) return
    const body = pending ?? {
      request_key: crypto.randomUUID(), expected_context_hash: initialHash.current, decision,
      reason, ticket_ids: tickets,
      documents: context.documents.filter(doc => documents.includes(doc.version_id)).map(doc => ({ document_id: doc.document_id, version_id: doc.version_id })),
      coverage_id: coverageId ?? null,
    }
    setPending(body); setBusy(true); setError(''); setMessage('')
    try {
      await call(`/radar/runs/${runId}/candidates/${candidateId}/reviews`, body)
      if (alive.current) { clear(); setMessage('人の確認記録を保存しました。AIの判定・件数は変更していません。'); await onSaved() }
    } catch (cause) { if (alive.current && !isStale(cause)) setError(errorMessage(cause)) }
    finally { if (alive.current) setBusy(false) }
  }
  return <section className={common.section} aria-label="担当者による文書検討">
    <h3>担当者による文書検討（AI判定とは別の記録）</h3>
    <p>構成問い合わせの本文と公開文書の対象・手順・注意を原文で照合してください。「対応文書を関連付け」は問い合わせの解決やAIの正解認定ではありません。</p>
    {!current && <p className="notice">過去の問い合わせ集合です。新しい検出で現在の原本を確認してください。</p>}
    {initialHash.current !== context.hash && <p role="alert">公開文書が変わりました。入力は保持しています。入力を明示的に破棄して現在の版を確認し直してください。</p>}
    <form className={styles.reviewForm} onSubmit={event => { event.preventDefault(); void save() }}>
      <fieldset disabled={disabled || busy || !!pending || !current || initialHash.current !== context.hash}>
        <legend>照合した原本と判断</legend>
        {members.map(member => <label key={member.id}><input type="checkbox" checked={tickets.includes(member.id)} onChange={event => setTickets(previous => event.target.checked ? [...previous, member.id] : previous.filter(id => id !== member.id))} /> <span><Link target="_blank" rel="noopener noreferrer" to={`/requests/${member.id}`}>{member.number} {member.title}（別タブ）</Link> の本文を確認した</span></label>)}
        <h4>照合した現在の公開文書（最大5件）</h4>
        {!context.documents.length && <p>現在の公開文書はありません。「文書の補強が必要」として記録できます。</p>}
        {context.documents.map(doc => <label key={doc.version_id}><input type="checkbox" checked={documents.includes(doc.version_id)} disabled={!documents.includes(doc.version_id) && documents.length >= 5} onChange={event => setDocuments(previous => event.target.checked ? [...previous, doc.version_id] : previous.filter(id => id !== doc.version_id))} /> <span><Link target="_blank" rel="noopener noreferrer" to={doc.href}>{doc.number} {doc.title} v{doc.version_no}（別タブ）</Link> の原文を照合した</span></label>)}
        <label>人による判断<select value={decision} onChange={event => setDecision(event.target.value)}><option value="needs_supplement">文書の補強が必要</option><option value="linked">対応文書を関連付け（適用条件を理由に記録）</option></select></label>
        <label>適用条件・不足・判断理由<textarea required maxLength={2000} rows={4} value={reason} onChange={event => setReason(event.target.value)} /></label>
      </fieldset>
      <p className={common.help}>全{members.length}件の原本確認が必要です。公開文書の版・内容hash、担当者、時刻、理由、参照したAI判定記録を保存します。原本・文書変更後は過去記録として再確認します。</p>
      <button className="button buttonPrimary" disabled={disabled || busy || !current || (!pending && (tickets.length !== members.length || !reason.trim() || (decision === 'linked' && !documents.length) || initialHash.current !== context.hash))}>{busy ? '確認記録を保存中…' : pending ? '同じ要求で保存結果を確認' : '人の確認記録を保存'}</button>
      {dirty && <button type="button" className="button" disabled={busy} onClick={() => setDiscard(true)}>入力を破棄して確認し直す</button>}
    </form>
    {pending && !busy && <p>保存結果が未確認の場合は同じ要求で再取得します。内容を修正する場合は入力破棄を明示してください。保存済みの記録は削除しません。</p>}
    {error && <p role="alert" className={common.error}>{error} 入力は保持しています。</p>}{message && <p role="status">{message}</p>}
    <h4>人の確認履歴（追記・過去記録を保持）</h4>
    {!reviews.length && <p>人による確認はまだありません。</p>}
    {reviews.map(review => <div key={review.id}><p><strong>{review.decision === 'linked' ? '対応文書を関連付け' : '文書の補強が必要'}</strong> · {review.reviewer.display_name} · {formatDate(review.created_at)} JST</p><p>{review.current ? '現在の原本・公開文書と一致（自動的な解決認定ではありません）' : '過去の確認です。問い合わせまたは公開文書が変更されています。現在も有効とは扱わず再確認してください。'}</p><p className={common.body}>{review.reason}</p><p>確認した問い合わせ {review.ticket_ids.length}件 · AI判定参照 {review.coverage_id ?? 'なし'}</p>{review.documents.map(doc => <p key={doc.version_id}><Link to={doc.href}>{doc.number} {doc.title}</Link> · 確認当時 v{doc.version_no} / {doc.version_id}<br />SHA-256 {doc.content_hash}（リンクは現在の公開原文）</p>)}</div>)}
    <p><Link to="/knowledge/reviews/new">手動で文書を作成</Link> · <Link to="/knowledge/reviews?status=draft">下書きの編集・検索準備・別操作の承認へ</Link>。AI下書きは上の解決済み原本を選んで作成できます。承認後は新しいAI判定と人の再確認をそれぞれ明示的に行います。</p>
    {discard && <DiscardDialog onCancel={() => setDiscard(false)} onDiscard={() => { clear(); setDiscard(false); setError('') }} />}
  </section>
}
