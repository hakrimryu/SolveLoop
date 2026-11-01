import { useState } from 'react'
import { Link } from 'react-router'
import { errorMessage, isStale } from '../../lib/api'
import type { SemanticResult } from '../../lib/business'
import { useBusinessCall } from '../../lib/useBusiness'
import common from '../requests/Requests.module.css'

export default function RelatedKnowledge({ query, disabled }: { query: string; disabled: boolean }) {
  const [data, setData] = useState<SemanticResult>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const call = useBusinessCall()
  async function search() {
    if (!query.trim() || busy) return
    setBusy(true); setError('')
    try { setData(await call<SemanticResult>('/knowledge/search', { query: query.trim().slice(0, 500), top_k: 5 })) }
    catch (cause) { if (!isStale(cause)) setError(errorMessage(cause)) }
    finally { setBusy(false) }
  }
  const documents = Array.from(new Map(data?.items.map(item => [item.document_id, item])).values())
  return <section className={common.section}><h2>新しく作る前に、既存の文書を確認</h2><p className={common.help}>同じ内容の文書があれば、公開文書から次の版を作って補足できます。近い文書が同じ問題を扱うかは人が確認してください。参照リンクは別タブで開き、編集中の内容を保持します。</p><button type="button" className="button" disabled={disabled || busy || !query.trim()} onClick={() => { void search() }}>{busy ? '関連文書を確認中…' : '件名に近い公開文書を確認'}</button>{error && <p role="alert">{error}</p>}{documents.length ? <ul>{documents.map(item => <li key={item.document_id}><Link target="_blank" rel="noopener noreferrer" to={`/knowledge/${item.document_id}`}>{item.number} {item.title} v{item.version_no}（別タブ）</Link><p className={common.help}>{item.audience}</p></li>)}</ul> : data && <p>関連する公開文書は見つかりませんでした。</p>}</section>
}
