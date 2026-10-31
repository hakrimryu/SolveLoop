import { useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import SearchInquiry from '../../components/SearchInquiry'
import { errorMessage, isStale } from '../../lib/api'
import { formatDate } from '../../lib/business'
import { useBusinessCall } from '../../lib/useBusiness'
import common from '../requests/Requests.module.css'

type GuidanceSource = {
  id: string; document_id: string; version_no: number; number: string; title: string
  audience: string; text: string; href: string
}
type Guidance = {
  query: string; generated_at: string; mode: 'live'; prompt_version: string; request_id: string
  result: { status: 'answered' | 'insufficient_evidence'; summary: string
    steps: { text: string; citation_ids: string[] }[]; missing_information: string[] }
  sources: GuidanceSource[]
}

export default function EmployeeGuidance() {
  const [params] = useSearchParams()
  const [query, setQuery] = useState(params.get('q') ?? '')
  const [result, setResult] = useState<Guidance>()
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const pending = useRef<AbortController | null>(null)
  const errorRef = useRef<HTMLDivElement>(null)
  const call = useBusinessCall()
  useEffect(() => () => pending.current?.abort(), [])
  async function ask() {
    if (busy || !query.trim()) return
    const controller = new AbortController()
    pending.current = controller
    setBusy(true); setError(''); setResult(undefined)
    try {
      const value = await call<Guidance>('/knowledge/guidance', { query: query.trim() }, { signal: controller.signal })
      if (!controller.signal.aborted) setResult(value)
    } catch (cause) {
      if (!controller.signal.aborted && !isStale(cause)) {
        setError(errorMessage(cause)); requestAnimationFrame(() => errorRef.current?.focus())
      }
    } finally { if (pending.current === controller) { setBusy(false); pending.current = null } }
  }
  const current = result?.query === query.trim() ? result : undefined
  const documents = Array.from(new Map(current?.sources.map(source => [source.document_id, source])).values())
  function sourceHref(source: GuidanceSource) {
    const url = new URL(source.href, window.location.origin)
    url.searchParams.set('q', current!.query)
    return url.pathname + url.search + url.hash
  }
  return <>
    <div className={common.heading}><div><p className="eyebrow">社員全員に公開された文書だけを参照</p><h1 tabIndex={-1}>AI案内</h1><p>質問を一つ入力すると、現在の承認・公開文書を検索して短く案内します。</p><p><Link to="/knowledge">キーワード検索</Link> · <Link to="/knowledge?mode=semantic">意味検索</Link></p></div></div>
    <section className={common.section} aria-label="公開文書に基づくAI案内">
      <p>ローカルOllamaによる実推論です。案内は解決の確定ではありません。対象・条件・注意はリンク先の全文と照合してください。未承認文書・内部メモ・担当者向け解決事例は使いません。</p>
      <form onSubmit={event => { event.preventDefault(); void ask() }} onKeyDown={event => { if (event.key === 'Enter' && event.nativeEvent.isComposing) event.preventDefault() }}>
        <label className={common.field}>質問・困っていること<textarea value={query} maxLength={500} required rows={3} disabled={busy} onChange={event => { setQuery(event.target.value); setError('') }} /></label>
        <button className="button buttonPrimary" disabled={busy || !query.trim()}>{busy ? '公開文書を確認して案内中…' : '公開文書からAI案内を作成'}</button>
      </form>
      {busy && <p role="status">公開文書を検索し、ローカルAIで案内を作成しています。問い合わせ登録は待たずに利用できます。<button className="button" onClick={() => { pending.current?.abort(); setBusy(false) }}>結果の受信を中止</button></p>}
      {error && <div ref={errorRef} role="alert" tabIndex={-1} className={common.errorBanner}><p>{error}</p><p>案内の作成に失敗しました。正常な「根拠不足」とは異なります。入力は保持しています。下の問い合わせ登録を利用できます。</p><button className="button" disabled={busy} onClick={() => { void ask() }}>同じ質問で再実行</button></div>}
      {current && <div aria-live="polite"><h2>{current.result.status === 'answered' ? '公開文書に基づく案内' : '根拠となる情報が不足しています'}</h2><p>{current.result.summary}</p>
        <ol>{current.result.steps.map((step, index) => <li key={index}>{step.text}<ul>{step.citation_ids.map(id => { const source = current.sources.find(item => item.id === id)!; return <li key={id}><Link to={sourceHref(source)}>{source.number} {source.title} v{source.version_no} の原文</Link></li> })}</ul></li>)}</ol>
        {!!current.result.missing_information.length && <><h3>確認が必要なこと</h3><ul>{current.result.missing_information.map(text => <li key={text}>{text}</li>)}</ul></>}
        <h3>検索で参照した公開文書</h3>{current.sources.map(source => <details key={source.id}><summary>{source.number} {source.title} v{source.version_no}</summary><p>適用対象：{source.audience}</p><blockquote className={common.body}>{source.text}</blockquote><Link to={sourceHref(source)}>現在の公開原文を読む</Link></details>)}
        <p className={common.help}>実推論 · {current.prompt_version} · {formatDate(current.generated_at)} JST · 要求番号 {current.request_id}。作成時点の公開版です。文書は更新・公開停止される場合があります。</p>
      </div>}
      <SearchInquiry query={query} references={documents.map(doc => ({ number: doc.number, title: doc.title, version_no: doc.version_no, url: new URL(`/knowledge/${doc.document_id}`, window.location.origin).href }))} />
    </section>
  </>
}
