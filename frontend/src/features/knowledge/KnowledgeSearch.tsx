import { useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { errorMessage, isStale } from '../../lib/api'
import type { BusinessProps, SemanticResult } from '../../lib/business'
import { useBusinessCall } from '../../lib/useBusiness'
import common from '../requests/Requests.module.css'
import styles from './Knowledge.module.css'

export function SearchMode({ semantic = false }: { semantic?: boolean }) {
  const [params] = useSearchParams()
  const next = new URLSearchParams()
  for (const key of ['q', 'department_id']) if (params.has(key)) next.set(key, params.get(key)!)
  if (!semantic) next.set('mode', 'semantic')
  return <p className={common.help}>{semantic ? '意味検索' : 'キーワード検索'}を使用中 · <Link to={`/knowledge?${next}`}>{semantic ? 'キーワード検索へ' : '意味検索へ'}</Link></p>
}

export default function KnowledgeSearch({ departments }: BusinessProps) {
  const [params, setParams] = useSearchParams()
  const [query, setQuery] = useState(params.get('q') ?? '')
  const [department, setDepartment] = useState(params.get('department_id') ?? '')
  const [result, setResult] = useState<SemanticResult>()
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [revision, setRevision] = useState(0)
  const errorRef = useRef<HTMLDivElement>(null)
  const call = useBusinessCall()
  const submitted = params.get('q') ?? ''
  const submittedDepartment = params.get('department_id') ?? ''
  useEffect(() => { setQuery(submitted); setDepartment(submittedDepartment) }, [submitted, submittedDepartment])
  useEffect(() => {
    setResult(undefined); setError('')
    if (!submitted.trim()) { setBusy(false); return }
    const controller = new AbortController()
    setBusy(true)
    void call<SemanticResult>('/knowledge/search', { query: submitted, top_k: 5, department_id: submittedDepartment || null }, { signal: controller.signal }).then(value => {
      if (!controller.signal.aborted) setResult(value)
    }).catch(cause => {
      if (!controller.signal.aborted && !isStale(cause)) { setError(errorMessage(cause)); requestAnimationFrame(() => errorRef.current?.focus()) }
    }).finally(() => { if (!controller.signal.aborted) setBusy(false) })
    return () => controller.abort()
  }, [submitted, submittedDepartment, revision, call])
  return <><div className={common.heading}><div><p className="eyebrow">社員全員に公開された文書</p><h1 tabIndex={-1}>ナレッジ</h1><p className="muted">質問と意味が近い、現在の承認版の箇所を検索します。</p><SearchMode semantic /></div></div>
    <section className={common.section} aria-label="意味検索">
      <form onSubmit={event => { event.preventDefault(); if (busy || !query.trim()) return; setParams({ mode: 'semantic', q: query.trim(), ...(department ? { department_id: department } : {}) }); setRevision(value => value + 1) }} onKeyDown={event => { if (event.key === 'Enter' && event.nativeEvent.isComposing) event.preventDefault() }}>
        <fieldset className={common.filters} disabled={busy}><label className={common.search}>質問・探したい内容<input type="search" value={query} maxLength={500} required onChange={event => setQuery(event.target.value)} placeholder="例：スマホを買い替えたら認証できない" /></label><label>担当部署<select value={department} onChange={event => setDepartment(event.target.value)}><option value="">すべて</option>{departments.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><button className="button buttonPrimary" disabled={!query.trim()}>{busy ? '意味検索中…' : '意味検索する'}</button><button type="button" className="button" onClick={() => { setQuery(''); setDepartment(''); setParams({ mode: 'semantic' }) }}>条件をクリア</button></fieldset>
      </form>
      <p className={common.help}>関連する箇所を最大5件表示します。同じ文書の複数箇所が含まれることがあります。距離は意味の近さの比較値で、正答率や解決可能性ではありません。適用対象・例外は全文で確認してください。</p>
      {busy && <p role="status">ローカルAIで質問を変換し、承認版を検索しています…</p>}
      {error && <div ref={errorRef} tabIndex={-1} role="alert" className={common.errorBanner}><p>{error}</p><p>意味検索は完了していません。入力は保持しています。</p><button className="button" disabled={busy} onClick={() => setRevision(value => value + 1)}>同じ条件で再検索</button><p><Link to="/knowledge">キーワード検索を利用する</Link></p></div>}
      {!busy && !error && !submitted && <p>探したい内容を入力してください。意味検索にはローカルOllamaを使用します。</p>}
      {result && <><p role="status">「{submitted}」：<strong>{result.items.length}箇所</strong>を取得 · 距離が小さい順</p>{!result.items.length ? <div className={common.empty}><h2>検索対象の承認文書はありません</h2><p>担当部署の条件を確認してください。不明点は問い合わせを登録できます。</p><Link to="/requests?new=1">問い合わせを登録</Link></div> : <ol className={styles.searchResults}>{result.items.map(item => {
        const target = new URLSearchParams(params)
        target.set('match_version', String(item.version_no)); target.set('start', String(item.body_start)); target.set('end', String(item.body_end))
        return <li key={item.chunk_id}><h2><Link to={`/knowledge/${item.document_id}?${target}#search-passage`}>{item.title}</Link></h2><p className={common.meta}>{item.number} / 承認済み v{item.version_no} · 本文 {item.line_start}〜{item.line_end}行 · 距離 {item.cosine_distance.toFixed(4)}</p><p className={common.help}>適用対象：{item.audience}{item.context ? ` · ${item.context}` : ''}</p><p tabIndex={0} role="region" aria-label="検索箇所の抜粋・スクロールできます" className={`${common.body} ${styles.searchExcerpt}`}>{item.text}</p><Link to={`/knowledge/${item.document_id}?${target}#search-passage`}>全文で該当箇所を確認</Link></li>
      })}</ol>}</>}
    </section></>
}
