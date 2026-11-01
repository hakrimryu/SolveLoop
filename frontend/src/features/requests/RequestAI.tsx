import { useRef, useState } from 'react'
import { Link } from 'react-router'
import { errorMessage, isStale } from '../../lib/api'
import type { Department } from '../../lib/api'
import { formatDate } from '../../lib/business'
import type { Ticket } from '../../lib/business'
import { useBusinessCall } from '../../lib/useBusiness'
import { employeeAnswerDraft } from '../../lib/answerDraft'
import styles from './Requests.module.css'

type Classification = { department_code: string | null; department: Department | null; reason: string; needs_review: boolean }
type Answer = { status: 'answered' | 'insufficient_evidence'; summary: string; steps: { text: string; citation_ids: string[] }[]; missing_information: string[] }
type Source = { id: string; kind: 'knowledge' | 'ticket'; number: string; title: string; href: string; text: string; version_no?: number; ticket_version?: number; version_id?: string }
type Proposal<T> = { ticket_version: number; generated_at: string; generation: { model: string; attempts: number } | null; result: T; sources: Source[] }

export default function RequestAI({ ticket, disabled, onUseDraft }: { ticket: Ticket; disabled: boolean; onUseDraft?: (text: string) => void }) {
  const [classification, setClassification] = useState<Proposal<Classification> | null>(null)
  const [answer, setAnswer] = useState<Proposal<Answer> | null>(null)
  const [busy, setBusy] = useState<'classification' | 'answer' | null>(null)
  const [error, setError] = useState('')
  const call = useBusinessCall()
  const currentVersion = useRef(ticket.version)
  currentVersion.current = ticket.version
  async function analyze(task: 'classification' | 'answer') {
    if (busy || disabled) return
    setBusy(task); setError('')
    if (task === 'classification') setClassification(null)
    else setAnswer(null)
    const version = ticket.version
    try {
      const result = await call<Proposal<Classification> | Proposal<Answer>>(`/tickets/${ticket.id}/analysis`, { task, expected_version: version })
      if (version !== currentVersion.current || result.ticket_version !== currentVersion.current) {
        setError('問い合わせが更新されたため、古い提案を破棄しました。最新の保存内容で再実行してください。'); return
      }
      if (task === 'classification') setClassification(result as Proposal<Classification>)
      else setAnswer(result as Proposal<Answer>)
    } catch (cause) { if (!isStale(cause)) setError(errorMessage(cause)) }
    finally { setBusy(null) }
  }
  const assigned = classification?.ticket_version === ticket.version ? classification : null
  const draft = answer?.ticket_version === ticket.version ? answer : null
  function metadata(value: Proposal<unknown>) {
    return <p className={styles.help}>保存版 {value.ticket_version} · {formatDate(value.generated_at)} JST · {value.generation ? `ローカル推論 ${value.generation.model} · ${value.generation.attempts}回` : '検索のみ・文章生成なし'}</p>
  }
  return <section className={styles.section} aria-labelledby="ai-heading" aria-busy={!!busy}>
    <h2 id="ai-heading">AI提案・担当者の確認が必要</h2>
    <p className={styles.help}>保存済みの問い合わせをローカルOllamaで分析します。割り当て・解決・ナレッジ承認は自動で行いません。提案はこの画面内だけに保持します。</p>
    <div className={styles.actions}><button className="button" disabled={disabled || !!busy} onClick={() => { void analyze('classification') }}>担当部署を提案</button><button className="button" disabled={disabled || !!busy} onClick={() => { void analyze('answer') }}>根拠付き回答案を生成</button></div>
    {disabled && <p className={styles.help}>本文の編集・保存内容の確認を完了してから実行してください。</p>}
    {busy && <p role="status">{busy === 'classification' ? '担当部署を分析中…' : '公開文書・解決事例を検索し、回答案を生成中…'} 手動の業務操作は引き続き利用できます。</p>}
    {error && <p role="alert" className={styles.errorBanner}>{error} 自動再送はしません。保存内容を確認し、必要なら再実行してください。</p>}
    {(classification || answer) && !assigned && !draft && <p role="status">保存版が変わりました。最新の問い合わせで提案を再実行してください。</p>}
    {assigned && <div className={styles.nextStep}><h3>担当部署の提案：{assigned.result.department?.name ?? '判断できません'}</h3>{metadata(assigned)}<p className={styles.body}>{assigned.result.reason}</p><p className={styles.help}>{assigned.result.needs_review ? '部署の判断には追加確認が必要です。' : '提案の理由を確認してください。'} 担当部署欄で人が選び、「割り当てを反映」で確定します。</p></div>}
    {draft && <div className={styles.nextStep}><h3>{draft.result.status === 'answered' ? '回答案（未確認）' : '根拠不足・回答案は作成していません'}</h3>{metadata(draft)}<p className={styles.body}>{draft.result.summary}</p>
      {draft.result.status === 'answered' && ticket.status !== 'resolved' && onUseDraft && <button className="button" disabled={disabled || !!busy} onClick={() => onUseDraft(employeeAnswerDraft(draft.result, draft.sources, window.location.origin))}>確認して回答欄へ渡す</button>}
      <ol>{draft.result.steps.map((step, index) => <li key={index}><p className={styles.body}>{step.text}</p><p>{step.citation_ids.map(id => { const source = draft.sources.find(item => item.id === id); return source && <a key={id} className={styles.citation} href={`#ai-source-${id}`} onClick={() => { const source = document.getElementById(`ai-source-${id}`); if (source instanceof HTMLDetailsElement) source.open = true }}>{source.number} を確認</a> })}</p></li>)}</ol>
      {draft.result.missing_information.length > 0 && <><h3>不足情報・確認事項</h3><ul>{draft.result.missing_information.map((item, index) => <li key={index}>{item}</li>)}</ul></>}
      {draft.sources.length > 0 && <><h3>回答案に使った根拠</h3><p className={styles.help}>生成時点の根拠です。原文の対象・例外と現在の公開状態を確認してください。公開文書は意味検索、解決事例は文字の組み合わせによる検索で各最大2件を参照します。</p><ul className={styles.aiSources}>{draft.sources.map(source => <li key={source.id}><details id={`ai-source-${source.id}`} tabIndex={-1}><summary>{source.number} · {source.title}</summary><Link target="_blank" rel="noopener noreferrer" to={source.href}>{source.number} · {source.title} · {source.kind === 'knowledge' ? `公開版 ${source.version_no}` : `解決記録・保存版 ${source.ticket_version}`}</Link><p className={styles.body}>{source.text}</p><details><summary>根拠の追跡情報</summary><p className={styles.help}>根拠ID：{source.id}{source.version_id && <> · 版ID：{source.version_id}</>}</p></details></details></li>)}</ul></>}
      <p className={styles.help}>引用先の存在と権限を検査しています。内容の正しさや適用可能性は保証しません。回答欄への反映後も、人が確認して送信します。</p>
    </div>}
  </section>
}
