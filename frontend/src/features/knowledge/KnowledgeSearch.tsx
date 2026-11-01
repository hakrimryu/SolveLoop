import { useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { errorMessage, isStale } from '../../lib/api'
import type { BusinessProps, SemanticResult } from '../../lib/business'
import { useBusinessCall } from '../../lib/useBusiness'
import common from '../requests/Requests.module.css'
import styles from './Knowledge.module.css'
import SearchInquiry from '../../components/SearchInquiry'

export function SearchMode({ semantic = false }: { semantic?: boolean }) {
  const [params] = useSearchParams()
  const next = new URLSearchParams()
  for (const key of ['q', 'department_id']) if (params.has(key)) next.set(key, params.get(key)!)
  const keyword = new URLSearchParams(next)
  next.set('mode', 'semantic')
  return <nav className="viewSwitch" aria-label="文書の検索方法"><Link aria-current={!semantic ? 'page' : undefined} to={`/knowledge?${keyword}`}>キーワードで探す</Link><Link aria-current={semantic ? 'page' : undefined} to={`/knowledge?${next}`}>文章で探す</Link></nav>
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
  return <><div className={common.heading}><div><p className="eyebrow">社員全員に公開された文書</p><h1 tabIndex={-1}>社内文書</h1><p className="muted">困っていることや探したい内容を文章で入力すると、関連する文書を探せます。</p><SearchMode semantic /></div></div>
    <section className={common.section} aria-label="文章から文書を探す">
      <form onSubmit={event => { event.preventDefault(); if (busy || !query.trim()) return; setParams({ mode: 'semantic', q: query.trim(), ...(department ? { department_id: department } : {}) }); setRevision(value => value + 1) }} onKeyDown={event => { if (event.key === 'Enter' && event.nativeEvent.isComposing) event.preventDefault() }}>
        <fieldset className={common.filters} disabled={busy}><label className={common.search}>困っていること・探したい内容<input type="search" value={query} maxLength={500} required onChange={event => setQuery(event.target.value)} placeholder="例：スマホを買い替えたら認証できない" /></label><label>担当部署<select value={department} onChange={event => setDepartment(event.target.value)}><option value="">すべて</option>{departments.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><button className="button buttonPrimary" disabled={!query.trim()}>{busy ? '検索中…' : '関連する文書を探す'}</button><button type="button" className="button" onClick={() => { setQuery(''); setDepartment(''); setParams({ mode: 'semantic' }) }}>条件をクリア</button></fieldset>
      </form>
      <p className={common.help}>承認済み文書から関連する箇所を最大5件表示します。同じ文書の複数箇所が含まれることがあります。解決に使えるかどうかは、全文の適用対象や注意事項も確認してください。</p>
      {busy && <p role="status">入力内容に関連する文書を探しています…</p>}
      {error && <div ref={errorRef} tabIndex={-1} role="alert" className={common.errorBanner}><p>{error}</p><p>文書を検索できませんでした。入力は保持しています。</p><button className="button" disabled={busy} onClick={() => setRevision(value => value + 1)}>同じ条件で再検索</button><p><Link to="/knowledge">キーワードで探す</Link></p></div>}
      {result && <><p role="status">「{submitted}」：<strong>{result.items.length}箇所</strong> · 入力内容に近い順</p>{!result.items.length ? <div className={common.empty}><h2>検索対象の承認文書はありません</h2><p>担当部署の条件を確認してください。不明点は担当者に問い合わせできます。</p></div> : <ol className={styles.searchResults}>{result.items.map(item => {
        const target = new URLSearchParams(params)
        target.set('match_version', String(item.version_no)); target.set('start', String(item.body_start)); target.set('end', String(item.body_end))
        return <li key={item.chunk_id}><h2><Link to={`/knowledge/${item.document_id}?${target}#search-passage`}>{item.title}</Link></h2><p className={common.meta}>{item.number} / 承認済み v{item.version_no} · 本文 {item.line_start}〜{item.line_end}行</p><p className={common.help}>適用対象：{item.audience}{item.context ? ` · ${item.context}` : ''}</p><p tabIndex={0} role="region" aria-label="検索箇所の抜粋・スクロールできます" className={`${common.body} ${styles.searchExcerpt}`}>{item.text}</p><Link to={`/knowledge/${item.document_id}?${target}#search-passage`}>全文で該当箇所を確認</Link></li>
      })}</ol>}</>}
      <SearchInquiry query={query} />
    </section></>
}
