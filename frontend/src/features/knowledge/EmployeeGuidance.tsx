import { useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import SearchInquiry from '../../components/SearchInquiry'
import { api, errorMessage, isStale } from '../../lib/api'
import { formatDate } from '../../lib/business'
import { useBusinessCall } from '../../lib/useBusiness'
import common from '../requests/Requests.module.css'
import styles from './EmployeeGuidance.module.css'
import { readGuidance, retainGuidance } from '../../lib/guidanceState'
import type { Guidance, GuidanceSource } from '../../lib/guidanceState'
import GuidanceHistory from './GuidanceHistory'

export default function EmployeeGuidance() {
  const [params] = useSearchParams()
  const retained = useRef(readGuidance()).current
  const [query, setQuery] = useState(params.get('q') ?? retained.query)
  const [result, setResult] = useState<Guidance | undefined>(retained.result?.guidance_id ? undefined : retained.result)
  const [editing, setEditing] = useState((params.has('q') && params.get('q') !== retained.query) || (retained.editing ?? !retained.result))
  const generation = useRef(api.snapshot().identityGeneration).current
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [feedbackBusy, setFeedbackBusy] = useState(false)
  const [reason, setReason] = useState(retained.reason ?? '')
  const [feedbackError, setFeedbackError] = useState('')
  const [historyKey, setHistoryKey] = useState(0)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const pending = useRef<AbortController | null>(null)
  const errorRef = useRef<HTMLDivElement>(null)
  const resultRef = useRef<HTMLHeadingElement>(null)
  useEffect(() => {
    if (editing) inputRef.current?.focus()
    else if (result) resultRef.current?.focus()
  }, [editing, result?.request_id])
  const call = useBusinessCall()
  useEffect(() => () => pending.current?.abort(), [])
  useEffect(() => {
    if (!retained.result?.guidance_id || retained.query !== query) return
    const controller = new AbortController()
    pending.current = controller
    setBusy(true)
    void call<{ response: Guidance | null; version: number; outcome: 'solved' | 'unresolved' | null; requester: { id: string }; response_restricted?: boolean }>(`/knowledge/guidance/${retained.result.guidance_id}`, undefined, { signal: controller.signal }).then(value => {
      if (controller.signal.aborted || pending.current !== controller) return
      if (value.response) setResult({ ...value.response, feedback_version: value.version, outcome: value.outcome, feedback_allowed: value.requester.id === api.snapshot().user?.id })
      else { setEditing(true); setError('以前の案内は表示できません。質問は保持しています。現在の文書で再実行するか、担当者へ問い合わせできます。') }
    }).catch(cause => { if (!controller.signal.aborted && !isStale(cause)) { setEditing(true); setError(errorMessage(cause)) } }).finally(() => { if (pending.current === controller) { setBusy(false); pending.current = null } })
    return () => controller.abort()
  }, [call, retained])
  useEffect(() => { retainGuidance(generation, { query, result, editing, reason }) }, [generation, query, result, editing, reason])
  async function ask() {
    if (busy || !query.trim()) return
    const controller = new AbortController()
    pending.current = controller
    setBusy(true); setEditing(false); setError(''); setResult(undefined); setReason(''); setFeedbackError('')
    try {
      const value = await call<Guidance>('/knowledge/guidance', { query: query.trim() }, { signal: controller.signal })
      if (!controller.signal.aborted && pending.current === controller) setResult(value)
    } catch (cause) {
      if (!controller.signal.aborted && !isStale(cause)) {
        setEditing(true); setError(errorMessage(cause)); requestAnimationFrame(() => errorRef.current?.focus())
      }
    } finally { if (pending.current === controller) { setBusy(false); pending.current = null; setHistoryKey(key => key + 1) } }
  }
  const current = !editing && result?.query === query.trim() ? result : undefined
  function openQuestion(fresh: boolean) {
    if (busy || feedbackBusy) return
    if (fresh) { setQuery(''); setResult(undefined); setReason('') }
    setError(''); setFeedbackError(''); setEditing(true)
  }
  function stopReceiving() {
    pending.current?.abort(); pending.current = null; setBusy(false); setEditing(true)
    setError('結果の受信を中止しました。入力は保持しています。サーバー側の処理は継続している場合があります。履歴で結果を確認できます。')
    setHistoryKey(key => key + 1)
  }
  async function feedback(outcome: 'solved' | 'unresolved') {
    if (!current?.guidance_id || feedbackBusy || busy) return
    setFeedbackBusy(true); setFeedbackError('')
    try {
      const value = await call<{ version: number }>(`/knowledge/guidance/${current.guidance_id}/feedback`, { outcome, reason: reason.trim() || null, expected_version: current.feedback_version ?? 1 })
      setResult({ ...current, outcome, feedback_version: value.version }); setHistoryKey(key => key + 1)
    } catch (cause) { if (!isStale(cause)) setFeedbackError(errorMessage(cause)) }
    finally { setFeedbackBusy(false) }
  }
  const cited = new Set(current?.result.steps.flatMap(step => step.citation_ids))
  const documents = Array.from(new Map(current?.sources.filter(source => cited.has(source.id)).map(source => [source.document_id, source])).values())
  function sourceHref(source: GuidanceSource) {
    const url = new URL(source.href, window.location.origin)
    url.searchParams.set('q', current!.query)
    return url.pathname + url.search + url.hash
  }
  return <div className={styles.workspace}>
    <div className={styles.intro}><p className="eyebrow">社内ヘルプ · 承認された知識から</p><h1 tabIndex={-1}>AIに質問</h1><p>{editing ? '仕事で困っていることを入力してください。社内文書をもとに解決方法を確認します。' : '質問に対する案内を確認し、解決しない場合は担当者へ引き継げます。'}</p></div>
    {editing ? <section className={styles.question} aria-label="AIへの質問"><form onSubmit={event => { event.preventDefault(); void ask() }} onKeyDown={event => { if (event.key === 'Enter' && event.nativeEvent.isComposing) event.preventDefault() }}>
        <label htmlFor="employee-question">質問・困っていること</label><textarea ref={inputRef} id="employee-question" aria-describedby="question-hint" placeholder="例：社用携帯を交換した後、認証アプリでログインできません。どうすればよいですか？" value={query} maxLength={500} required rows={4} disabled={busy || feedbackBusy} onChange={event => { setQuery(event.target.value); setError('') }} />
        <p id="question-hint" className={styles.hint}>状況や試したことを書くと、案内を確認しやすくなります。500文字まで。パスワードは入力しないでください。</p>
        <p className={styles.hint}>質問は1件ずつ確認します。前の質問や回答は自動で引き継ぎません。</p>
        <p className={styles.hint}>質問と案内は30日間保存され、本人と担当者が確認できます。</p>
        <div className={styles.tools}><button className="button buttonPrimary" disabled={busy || feedbackBusy || !query.trim()}>AIに質問する</button>{result && <button type="button" className="button" onClick={() => { setQuery(result.query); setEditing(false) }}>結果に戻る</button>}<Link to="/knowledge">社内文書を自分で探す</Link></div>
      </form></section> : <section className={styles.querySummary} aria-label="質問内容"><p className="eyebrow">質問内容</p><p>{query}</p></section>}
      {busy && <div className={styles.pending} role="status"><p>社内文書を確認しています。混雑時は順番を待つ場合があります。</p><div className={styles.tools}><button className="button" onClick={stopReceiving}>結果の受信を中止</button><Link to="/my/requests?new=1">待たずに担当者へ問い合わせ</Link></div></div>}
      {error && <div ref={errorRef} role="alert" tabIndex={-1} className={common.errorBanner}><p>{error}</p><p>入力は保持しています。案内の再実行や、下の問い合わせ登録を利用できます。</p><button className="button" disabled={busy || !query.trim()} onClick={() => { void ask() }}>同じ質問で再実行</button></div>}
      {current && <section className={styles.answer} aria-label="AI案内の結果"><div className={styles.answerHeading}><span className={styles.answerLabel}>AI案内</span><span className={styles.hint}>承認・公開された文書を参照</span></div><h2 ref={resultRef} tabIndex={-1}>{current.result.status === 'answered' ? '社内文書に基づく案内' : 'この質問に答える手順を確認できませんでした'}</h2><p className={styles.summary}>{current.result.summary}</p>{current.result.status === 'answered' ? <p className={styles.hint}>対象・条件・注意事項を原文で確認してください。AIの案内だけで解決が確定することはありません。</p> : <div className="notice"><p>公開文書に必要な情報がないか、質問の条件を特定できていません。関連する文書があっても、この質問全体の答えを裏付けるとは限りません。</p><p>使いたい機能や現在の状況を補足するか、文書の対応範囲を確認してください。確認できない内容は、下のボタンから担当者に引き継げます。</p><Link to={`/knowledge?mode=semantic&q=${encodeURIComponent(current.query)}`}>この質問に近い公開文書を確認</Link></div>}
        <ol>{current.result.steps.map((step, index) => <li key={index}>{step.text}<ul>{step.citation_ids.map(id => { const source = current.sources.find(item => item.id === id)!; return <li key={id}><Link to={sourceHref(source)}>{source.number} {source.title} v{source.version_no} の原文</Link></li> })}</ul></li>)}</ol>
        {!!current.result.missing_information.length && <><h3>確認が必要なこと</h3><ul>{current.result.missing_information.map(text => <li key={text}>{text}</li>)}</ul></>}
        {!!current.notices?.length && <section className="notice" aria-label="引用文書の適用条件と注意"><h3>原文の適用条件・注意</h3>{current.notices.map(notice => <div key={notice.document_id}><p className={styles.hint}>{notice.number} v{notice.version_no} · 適用対象：{notice.audience}</p>{notice.text ? <p className={common.body}>{notice.text}</p> : <p className={styles.hint}>注意事項の見出しがない文書です。原文の全文で条件を確認してください。</p>}</div>)}</section>}
        {documents.length > 0 && <h3>案内の根拠となる文書</h3>}{current.sources.filter(source => cited.has(source.id)).map(source => <details key={source.id}><summary>{source.number} {source.title} v{source.version_no}</summary><p>適用対象：{source.audience}</p><blockquote className={common.body}>{source.text}</blockquote><Link to={sourceHref(source)}>現在の公開原文を読む</Link></details>)}
        <p className={styles.hint}>{formatDate(current.generated_at)} JST 時点の公開文書を参照しています。</p><details><summary>AI案内の詳細</summary><p className={common.help}>ローカルAIによる実推論 · {current.prompt_version} · 要求番号 {current.request_id}。未承認文書・内部メモ・担当者用の解決事例は参照しません。</p></details>
        {current.guidance_id && current.feedback_allowed !== false && <div className={styles.feedback}><h3>この案内で解決できましたか？</h3><p className={styles.hint}>解決の確認は文書の改善に使います。回答は後から変更できます。</p><div className={styles.tools}><button className="button" aria-pressed={current.outcome === 'solved'} disabled={feedbackBusy} onClick={() => { void feedback('solved') }}>解決した</button><button className="button" aria-pressed={current.outcome === 'unresolved'} disabled={feedbackBusy} onClick={() => { void feedback('unresolved') }}>解決しない</button></div><details className={styles.handoffNote} open={current.outcome === 'unresolved'}><summary>担当者に伝える内容（任意）</summary><label className={common.field}>試したこと・解決しない理由<textarea rows={2} value={reason} maxLength={1000} disabled={feedbackBusy} onChange={event => setReason(event.target.value)} /></label><p className={styles.hint}>AIへの追加質問ではありません。問い合わせを登録するときに担当者へ引き継ぎます。</p></details>{current.outcome && <p role="status">{current.outcome === 'solved' ? '解決したことを記録しました。' : '未解決として記録しました。下のボタンから担当者に引き継げます。'}</p>}{feedbackError && <p role="alert">{feedbackError}</p>}</div>}
      <SearchInquiry query={query} guidance={current?.guidance_id && current.feedback_allowed !== false ? { id: current.guidance_id, reason } : undefined} references={documents.map(doc => ({ number: doc.number, title: doc.title, version_no: doc.version_no, url: new URL(`/knowledge/${doc.document_id}`, window.location.origin).href }))} />
      </section>}
    {current && <div className={styles.tools}><button className="button" disabled={feedbackBusy} onClick={() => openQuestion(false)}>質問を修正して再実行</button><button className="button" disabled={feedbackBusy} onClick={() => openQuestion(true)}>別の質問をする</button></div>}
    {!current && !busy && <SearchInquiry query={query} />}
    <p className={styles.fallback}>急ぎの相談や個別の判断が必要なときは、AIを使わずに<Link to="/my/requests?new=1">担当者に直接問い合わせ</Link>できます。</p>
    <GuidanceHistory disabled={busy || feedbackBusy} key={historyKey} onLoad={(value, note) => { setQuery(value.query); setResult(value); setReason(note); setError(''); setFeedbackError(''); setEditing(false) }} onRetry={(question, message) => { setQuery(question); setResult(undefined); setReason(''); setError(message); setEditing(true) }} />
  </div>
}
