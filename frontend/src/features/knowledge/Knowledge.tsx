import { useEffect, useLayoutEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { Link, useLocation, useParams, useSearchParams } from 'react-router'
import { departments, formatDemoDate, getKnowledgeFilters, getKnowledgeList, getKnowledgeReviews, getPublishedKnowledge, knowledgeStatusLabels } from '../../lib/mockData'
import type { DemoRole, KnowledgeInput, KnowledgeVersion } from '../../lib/mockData'
import { DisplayControl } from '../requests/Requests'
import type { DisplayMode } from '../requests/Requests'
import common from '../requests/Requests.module.css'
import styles from './Knowledge.module.css'

export type KnowledgeProps = { role: DemoRole; knowledge: KnowledgeVersion[] }

let listPosition: { url: string; role: DemoRole; y: number; id: string } | undefined

export function KnowledgeUnavailable({ restricted = false }: { restricted?: boolean }) {
  return <><h1 tabIndex={-1}>{restricted ? 'ナレッジレビューを表示できません' : '文書を表示できません'}</h1>
    <div className="notice"><p>{restricted ? 'この画面は担当者用です。担当者のモックアカウントでログインしてください。' : '公開された文書が見つかりません。'}</p>
      <Link to="/knowledge">承認済みナレッジへ</Link></div></>
}

export function KnowledgeBody({ input }: { input: KnowledgeInput }) {
  return <article className={styles.document} aria-label="文書の内容">
    <p className="eyebrow">適用対象</p><p>{input.audience || '（未入力）'}</p>
    <h2>本文</h2><p className={common.body}>{input.body || '（本文はまだ入力されていません）'}</p>
  </article>
}

export default function KnowledgeList({ role, knowledge, review = false }: KnowledgeProps & { review?: boolean }) {
  const [params, setParams] = useSearchParams()
  const location = useLocation()
  const [query, setQuery] = useState(params.get('q') ?? '')
  const [mode, setMode] = useState<DisplayMode>('normal')
  const filters = getKnowledgeFilters(params)
  const searchQuery = params.get('q') ?? ''
  useEffect(() => setQuery(searchQuery), [searchQuery])
  useLayoutEffect(() => {
    if (listPosition?.url !== location.pathname + location.search || listPosition.role !== role) return
    const position = listPosition
    const frame = requestAnimationFrame(() => {
      document.getElementById(position.id)?.focus({ preventScroll: true })
      window.scrollTo({ top: position.y })
    })
    return () => cancelAnimationFrame(frame)
  }, [location.pathname, location.search, role])
  if (review && role !== 'operator') return <KnowledgeUnavailable restricted />

  const data = getKnowledgeList(mode === 'empty' ? [] : knowledge, params)
  const reviews = getKnowledgeReviews(mode === 'empty' ? [] : knowledge, role, params.get('status') ?? '')
  const title = review ? 'ナレッジレビュー' : 'ナレッジ'
  const count = review ? reviews.length : data.count
  const total = review ? getKnowledgeReviews(mode === 'empty' ? [] : knowledge, role).length : data.total

  function rememberPosition(id: string) {
    listPosition = { url: location.pathname + location.search, role, y: window.scrollY, id }
  }

  function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const next = new URLSearchParams(params)
    if (query.trim()) next.set('q', query.trim())
    else next.delete('q')
    setParams(next)
  }

  function filter(name: string, value: string) {
    const next = new URLSearchParams(params)
    if (value) next.set(name, value)
    else next.delete(name)
    setParams(next)
  }

  return <>
    <div className={common.heading}><div><p className="eyebrow">{review ? '担当者専用 · 未承認の文書' : '社員全員に公開された文書'}</p>
      <h1 tabIndex={-1}>{title}</h1><p className="muted">{review ? '保存した下書きと解決根拠を確認して、公開する内容を判断します。' : '承認済みの最新版をキーワードで検索します。AI・意味検索は行いません。'}</p></div>
      {review && <Link className="button buttonPrimary" to="/knowledge/reviews/new">手動で下書きを作成</Link>}
    </div>
    <section className={common.section} aria-label={`${title}一覧`}>
      {review ? <div className={common.filters}><label>状態
        <select value={['draft', 'rejected'].includes(params.get('status') ?? '') ? params.get('status')! : ''} onChange={e => filter('status', e.target.value)}>
          <option value="">下書き・差し戻し</option><option value="draft">下書き</option><option value="rejected">差し戻し</option>
        </select></label><button className="button" onClick={() => setParams({})}>条件をクリア</button></div> :
        <form className={common.filters} onSubmit={search} onKeyDown={e => { if (e.key === 'Enter' && e.nativeEvent.isComposing) e.preventDefault() }}>
          <label className={common.search}>キーワード<input type="search" value={query} onChange={e => setQuery(e.target.value)} placeholder="件名・適用対象・本文・文書番号" /></label>
          <label>担当部署<select value={filters.department} onChange={e => filter('department', e.target.value)}><option value="">すべて</option>{departments.map(d => <option key={d}>{d}</option>)}</select></label>
          <button className="button buttonPrimary">検索</button><button type="button" className="button" onClick={() => { setQuery(''); setParams({}) }}>条件をクリア</button>
        </form>}
      <div className={common.results}><p role="status">{mode === 'normal' || mode === 'empty' ? <><strong>{count}件</strong>{!review && ` / 承認済み ${data.total}件`}</> : '件数を取得していません'}<span className={common.sort}>更新日時の新しい順 · 日本時間</span></p><DisplayControl mode={mode} onChange={setMode} /></div>
      {mode === 'loading' ? <div className="notice" aria-busy="true"><p role="status">読み込み中… 表示確認用のシミュレーションです。</p></div> : mode === 'error' ?
        <div className="notice"><p role="alert">一覧を読み込めませんでした（デモ用）。条件は保持されています。</p><button className="button" onClick={() => setMode('normal')}>再試行</button></div> : count === 0 ?
          <div className={common.empty}><h2>{review ? total === 0 ? '確認する文書はまだありません' : '条件に一致するレビューはありません' : data.total === 0 ? '公開されたナレッジはまだありません' : '条件に一致するナレッジはありません'}</h2>
            <p>{review ? total === 0 ? '必要に応じて手動で下書きを作成できます。' : '状態の条件を解除して確認してください。' : data.total === 0 ? '文書は担当者が承認した後に表示されます。不明点は問い合わせを登録してください。' : '別のキーワードや担当部署で検索してください。'}</p>
            <button className="button" onClick={() => { setQuery(''); setParams({}); setMode('normal') }}>条件をクリア</button>{!review && <Link className={styles.inlineLink} to="/requests?new=1">問い合わせを登録</Link>}
          </div> : <>
            <p className={common.tableHint}>表は横にスクロールできます。</p>
            <div className={`${common.tableScroll} ${styles.table}`} tabIndex={0} role="region" aria-label={`${title}一覧・横にスクロールできます`}>
              <table><caption className="srOnly">{title}一覧。更新日時の新しい順。</caption><thead><tr><th scope="col">文書番号</th><th scope="col">件名・適用対象</th><th scope="col">{review ? '状態・版' : '承認版'}</th><th scope="col">担当部署</th><th scope="col">更新日時</th></tr></thead>
                <tbody>{(review ? reviews : data.rows).map(item => <tr key={`${item.id}-${item.version}`}>
                  <td className={common.number}>{item.id}</td><th scope="row" className={common.subject}>
                    <Link id={`knowledge-${item.id}-${item.version}`} onClick={() => rememberPosition(`knowledge-${item.id}-${item.version}`)} to={review ? `/knowledge/reviews/${item.id}/versions/${item.version}${params.size ? `?${params}` : ''}` : `/knowledge/${item.id}${params.size ? `?${params}` : ''}`}>{item.title}</Link>
                    <p className={common.help}>{item.audience}</p></th><td className={styles.version}>{review ? knowledgeStatusLabels[(item as KnowledgeVersion).status] : '承認済み'} v{item.version}</td>
                  <td>{item.department}</td><td className={common.date}>{formatDemoDate(item.updatedAt)} JST</td>
                </tr>)}</tbody></table>
            </div>
          </>}
    </section>
  </>
}

export function KnowledgeDetail({ role, knowledge }: KnowledgeProps) {
  const { documentId } = useParams()
  const location = useLocation()
  const [mode, setMode] = useState<DisplayMode>('normal')
  const document = getPublishedKnowledge(knowledge).find(item => item.id === documentId)
  if (!document) return <KnowledgeUnavailable />
  const pending = role === 'operator' ? getKnowledgeReviews(knowledge, role).find(item => item.id === document.id) : undefined
  return <>
    <Link className={common.back} to={`/knowledge${location.search}`}>← ナレッジ一覧へ戻る（条件を保持）</Link>
    <div className={common.heading}><div><p className="eyebrow">{document.id} · 承認済み v{document.version}</p><h1 tabIndex={-1}>{document.title}</h1>
      <p className={common.meta}>担当部署 {document.department} · 改訂 {formatDemoDate(document.updatedAt)} JST · 社員全員に公開</p></div><DisplayControl mode={mode} onChange={setMode} /></div>
    {mode === 'loading' ? <div className="notice" aria-busy="true"><p role="status">文書を読み込み中…（デモ用）</p></div> : mode !== 'normal' ?
      <div className="notice"><p role={mode === 'error' ? 'alert' : undefined}>{mode === 'error' ? '文書を読み込めませんでした（デモ用）。' : '文書が見つかりません（表示確認用）。'}</p><button className="button" onClick={() => setMode('normal')}>再試行</button></div> :
      <div className={styles.readGrid}><section className={common.section}><KnowledgeBody input={document} /></section>
        <aside className={common.section} aria-label="公開版の情報"><h2>承認された版</h2><p className={common.meta}>{document.id} / v{document.version}</p><p className={common.help}>この内容は社員全員の検索対象です。</p>
          {role === 'operator' && <div className={common.nextStep}><h3>内容を改訂する</h3><p>承認済みの本文は直接変更しません。新しい版が承認されるまで、現在の版を公開します。</p>
            {pending ? <Link className="button" to={`/knowledge/reviews/${pending.id}/versions/${pending.version}`}>未承認の版を確認</Link> : <Link className="button" to={`/knowledge/reviews/new?document=${document.id}`}>改訂版の下書きを作成</Link>}</div>}
        </aside>
      </div>}
  </>
}
