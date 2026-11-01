import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Link } from 'react-router'
import { errorMessage, isStale } from '../../lib/api'
import type { KnowledgeInput, Source, SourceRef } from '../../lib/business'
import { formatDate } from '../../lib/business'
import { useBusinessCall } from '../../lib/useBusiness'
import { trapDialogFocus } from '../../components/DiscardDialog'
import common from '../requests/Requests.module.css'
import styles from './Knowledge.module.css'

export type GeneratedDraft = {
  generation_id: string; generated_at: string; expires_at: string
  draft: Omit<KnowledgeInput, 'department_id'>; sources: Source[]
  result: { symptoms: string[]; steps: string[]; cautions: string[]; missing_information: string[]; source_ticket_ids: string[] }
  trace: { model: string; digest: string; prompt_version: string; request_id: string }
}

export default function KnowledgeAI({ refs, disabled, applied, onApply, onBusy }: {
  refs: SourceRef[]; disabled: boolean; applied: string | null
  onApply: (value: GeneratedDraft) => void; onBusy: (busy: boolean) => void
}) {
  const [proposal, setProposal] = useState<GeneratedDraft | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [confirm, setConfirm] = useState(false)
  const pending = useRef<AbortController | null>(null)
  const dialog = useRef<HTMLDialogElement>(null)
  const cancel = useRef<HTMLButtonElement>(null)
  const call = useBusinessCall()
  useEffect(() => () => pending.current?.abort(), [])
  useLayoutEffect(() => {
    if (!confirm) return
    const previous = document.activeElement as HTMLElement | null
    const node = dialog.current!
    node.showModal(); cancel.current?.focus()
    return () => { node.close(); if (previous?.isConnected) previous.focus() }
  }, [confirm])
  async function generate() {
    if (busy || disabled || refs.length < 1 || refs.length > 5) return
    const controller = new AbortController()
    pending.current = controller
    setBusy(true); onBusy(true); setError(''); setMessage('選択した保存版から生成中です。編集中の入力は保持します。')
    try {
      const result = await call<GeneratedDraft>('/knowledge/generations', { source_refs: refs }, { signal: controller.signal })
      if (!controller.signal.aborted) { setProposal(result); setMessage('生成案を取得しました。まだ編集欄への反映・下書き保存・承認は行っていません。') }
    } catch (cause) { if (!controller.signal.aborted && !isStale(cause)) { setError(errorMessage(cause)); setMessage('生成に失敗しました。編集入力と前回の生成案は保持しています。') } }
    finally { if (pending.current === controller) { pending.current = null; setBusy(false); onBusy(false) } }
  }
  return <section className={`${common.section} ${styles.generation}`} aria-label="解決記録からのAI下書き案">
    <h2>解決記録からAI下書き案を生成</h2>
    <p>根拠欄で解決記録を選択してから生成します（1〜5件）。AIが原文を抜粋・構成した案です。事実・条件・実施順を原本と照合し、業務向けの表現に編集してください。生成・反映だけでは保存・解決・承認・公開しません。</p>
    <p className={common.help}>現在の選択：{refs.length}件。全文が入力上限を超える場合はエラーになります。生成案の保存期限は生成後1時間・同じログイン中です。</p>
    <button type="button" className="button" disabled={disabled || busy || refs.length < 1 || refs.length > 5} onClick={() => { void generate() }}>{busy ? '知識案を生成中…' : proposal ? '選択した根拠から再生成' : '選択した根拠からAI案を生成'}</button>
    {busy && <button type="button" className="button" onClick={() => { pending.current?.abort(); setMessage('結果の受け取りを中止しました。入力は保持しています。サーバー側の推論停止は保証しません。') }}>生成結果の受け取りを中止</button>}
    {message && <p role="status">{proposal && applied === proposal.generation_id && !busy && !error ? '生成案を編集欄へ反映しました。内容を確認・編集して保存してください。検索準備と承認は別操作です。' : message}</p>}{error && <p role="alert" className={common.error}>{error}</p>}
    {proposal && <div>
      <h3>未確認の生成案：{proposal.draft.title}</h3><p>適用対象：{proposal.draft.audience}</p>
      <p className={common.body}>{proposal.draft.body}</p>
      <p className={common.meta}>実推論 · {proposal.trace.model} · {proposal.trace.prompt_version} · {formatDate(proposal.generated_at)} JST</p>
      <details><summary>生成の詳細</summary><p className={common.help}>要求番号：{proposal.trace.request_id}</p></details>
      <h3>生成に使用した問い合わせ</h3>
      {proposal.sources.map(source => <details key={source.ticket_id}><summary>{source.ticket_number} の解決原文・追跡情報</summary><Link target="_blank" rel="noopener noreferrer" to={`/requests/${source.ticket_id}`}>{source.ticket_number} {source.title}</Link><p className={common.help}>版 {source.ticket_version} · ID {source.ticket_id}<br />SHA-256 {source.content_hash}</p><p className={common.body}>{source.resolution}</p></details>)}
      <button type="button" className="button" disabled={busy || disabled || applied === proposal.generation_id} onClick={() => setConfirm(true)}>生成案を確認して編集欄へ反映</button>
    </div>}
    {confirm && proposal && <dialog ref={dialog} className={common.dialog} aria-modal="true" aria-labelledby="apply-ai-heading" onKeyDown={trapDialogFocus} onCancel={e => { e.preventDefault(); setConfirm(false) }}>
      <h2 id="apply-ai-heading">編集中の件名・適用対象・本文を生成案に置き換えますか？</h2>
      <p>未保存の入力がある場合も置き換わります。担当部署は保持し、根拠は生成時のサーバーの写しを使います。反映後に編集・保存し、検索準備と承認を別途行ってください。</p>
      <div className={common.actions}><button ref={cancel} className="button" onClick={() => setConfirm(false)}>入力を保持して戻る</button><button className="button buttonPrimary" onClick={() => { onApply(proposal); setConfirm(false) }}>置き換えて編集を続ける</button></div>
    </dialog>}
  </section>
}
