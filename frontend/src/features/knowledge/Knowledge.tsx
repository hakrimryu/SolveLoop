import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Link, useLocation, useParams, useSearchParams } from 'react-router'
import { apiQuery, formatDate, knowledgeLabels, reviewUrl } from '../../lib/business'
import type { BusinessProps, KnowledgeInput, Page, Published, PublishedItem, Review, ReviewItem } from '../../lib/business'
import { useLoad } from '../../lib/useBusiness'
import { LoadState, Pagination } from '../../components/BusinessState'
import common from '../requests/Requests.module.css'
import styles from './Knowledge.module.css'
import KnowledgeManagement from './KnowledgeManagement'
import KnowledgeSearch, { SearchMode } from './KnowledgeSearch'
import SearchInquiry from '../../components/SearchInquiry'
import EmployeeGuidance from './EmployeeGuidance'

export type KnowledgeProps = BusinessProps
let listPosition: { url: string; y: number; id: string } | undefined
export function clearKnowledgePosition() { listPosition = undefined }
export function KnowledgeUnavailable() { return <><h1 tabIndex={-1}>ナレッジレビューを表示できません</h1><div className="notice"><p>この画面は担当者用です。</p><Link to="/knowledge">承認済みナレッジへ</Link></div></> }
export function KnowledgeBody({ input, match }: { input: Pick<KnowledgeInput, 'audience' | 'body'>; match?: { start: number; end: number } }) {
  const body = Array.from(input.body)
  return <article className={styles.document} aria-label="文書の内容"><p className="eyebrow">適用対象</p><p>{input.audience || '（未入力）'}</p><h2>本文</h2><p className={common.body}>{match ? <>{body.slice(0, match.start).join('')}<mark id="search-passage" tabIndex={-1}>{body.slice(match.start, match.end).join('')}</mark>{body.slice(match.end).join('')}</> : input.body || '（本文はまだ入力されていません）'}</p></article>
}

export default function KnowledgeList(props: KnowledgeProps & { review?: boolean }) {
  const [params] = useSearchParams()
  return props.review && props.role !== 'operator' ? <KnowledgeUnavailable /> : !props.review && params.get('mode') === 'guidance' ? <EmployeeGuidance /> : !props.review && params.get('mode') === 'semantic' ? <KnowledgeSearch {...props} /> : <List {...props} key={props.review ? 'reviews' : 'published'} />
}
function List({ role, departments, review = false }: KnowledgeProps & { review?: boolean }) {
  const [params, setParams] = useSearchParams()
  const location = useLocation()
  const heading = useRef<HTMLHeadingElement>(null)
  const [query, setQuery] = useState(params.get('q') ?? '')
  const resource = useLoad<Page<PublishedItem | ReviewItem>>(`${review ? '/knowledge/reviews' : '/knowledge'}?${apiQuery(params, ['page', 'page_size', 'sort', ...(review ? ['status'] : ['q', 'department_id'])])}`)
  const data = resource.data
  useEffect(() => setQuery(params.get('q') ?? ''), [params.get('q')])
  useLayoutEffect(() => {
    if (!data || listPosition?.url !== location.pathname + location.search) return
    const position = listPosition
    const frame = requestAnimationFrame(() => { document.getElementById(position.id)?.focus({ preventScroll: true }); window.scrollTo({ top: position.y }) })
    return () => cancelAnimationFrame(frame)
  }, [data, location.pathname, location.search, role])
  function filter(name: string, value: string) { const next = new URLSearchParams(params); if (value) next.set(name, value); else next.delete(name); if (name !== 'page') next.delete('page'); setParams(next) }
  const title = review ? 'ナレッジレビュー' : 'ナレッジ'
  return <>{typeof location.state?.message === 'string' && <p role="status" className={common.success}>{location.state.message}</p>}<div className={common.heading}><div><p className="eyebrow">{review ? '担当者専用 · レビューと公開状態' : '社員全員に公開された文書'}</p><h1 ref={heading} tabIndex={-1}>{title}</h1><p className="muted">{review ? '保存した下書きと解決根拠を確認し、公開する内容を判断します。' : '承認された現在の版をキーワードで検索します。Ollamaが停止していても利用できます。'}</p>{!review && <SearchMode />}</div>{review && <Link className="button buttonPrimary" to="/knowledge/reviews/new">手動で下書きを作成</Link>}</div>
    <section className={common.section} aria-label={`${title}一覧`}>
      {review ? <div className={common.filters}><label>状態<select value={params.get('status') ?? ''} onChange={e => filter('status', e.target.value)}><option value="">下書き・差し戻し・公開停止</option><option value="draft">下書き</option><option value="rejected">差し戻し</option><option value="suspended">公開停止</option></select></label><button className="button" onClick={() => setParams({})}>条件をクリア</button></div> : <form className={common.filters} onSubmit={e => { e.preventDefault(); filter('q', query.trim()) }} onKeyDown={e => { if (e.key === 'Enter' && e.nativeEvent.isComposing) e.preventDefault() }}><label className={common.search}>キーワード<input type="search" value={query} maxLength={200} onChange={e => setQuery(e.target.value)} placeholder="件名・適用対象・本文・文書番号" /></label><label>担当部署<select value={params.get('department_id') ?? ''} onChange={e => filter('department_id', e.target.value)}><option value="">すべて</option>{departments.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}</select></label><button className="button buttonPrimary">検索</button><button type="button" className="button" onClick={() => { setQuery(''); setParams({}) }}>条件をクリア</button></form>}
      <div className={common.results}><p role="status">{data ? <><strong>{data.filtered_count}件</strong> / {review ? 'レビュー対象' : '承認済み'} {data.visible_total}件</> : '件数を取得していません'}<span className={common.sort}>更新日時順 · 日本時間</span></p><button className="button" onClick={resource.reload}>再取得</button></div>
      {!data ? <LoadState error={resource.error} reload={resource.reload} /> : data.filtered_count === 0 ? <div className={common.empty}><h2>{data.visible_total ? '条件に一致する文書はありません' : review ? '確認する文書はまだありません' : '公開されたナレッジはまだありません'}</h2><p>{review ? '必要に応じて手動で下書きを作成できます。' : '担当者が承認した文書を表示します。不明点は問い合わせを登録してください。'}</p></div> : <><p className={common.tableHint}>表は横にスクロールできます。</p><div className={`${common.tableScroll} ${styles.table}`} tabIndex={0} role="region" aria-label={`${title}一覧・横にスクロールできます`}><table><caption className="srOnly">{title}一覧</caption><thead><tr><th scope="col">文書番号</th><th scope="col">件名・適用対象</th><th scope="col">状態・版</th><th scope="col">担当部署</th><th scope="col">更新日時</th></tr></thead><tbody>{data.items.map(item => { const id = `knowledge-${item.document_id}-${item.version_no}`; return <tr key={id}><td className={common.number}>{item.number}</td><th scope="row" className={common.subject}><Link id={id} onClick={() => { listPosition = { url: location.pathname + location.search, y: window.scrollY, id } }} to={`${review ? reviewUrl(item) : `/knowledge/${item.document_id}`}${location.search}`}>{item.title}</Link><p className={common.help}>{item.audience}</p></th><td className={styles.version}>{review ? item.publication_suspended ? '公開停止' : knowledgeLabels[(item as ReviewItem).status] : '承認済み'} v{item.version_no}</td><td>{item.department?.name ?? '未定'}</td><td className={common.date}>{formatDate(item.updated_at)} JST</td></tr> })}</tbody></table></div></>}
      {data && <Pagination data={data} onPage={page => { filter('page', String(page)); heading.current?.focus(); window.scrollTo({ top: 0 }) }} />}
      {!review && <SearchInquiry query={query} />}
    </section></>
}

export function KnowledgeDetail(props: KnowledgeProps) {
  const { documentId } = useParams()
  const location = useLocation()
  const resource = useLoad<Published>(`/knowledge/${documentId}`)
  const document = resource.data
  const [suspended, setSuspended] = useState<boolean | null>(null)
  useEffect(() => setSuspended(null), [document])
  const matchParams = new URLSearchParams(location.search)
  const start = Number(matchParams.get('start')), end = Number(matchParams.get('end'))
  const match = document && Number(matchParams.get('match_version')) === document.version_no && Number.isInteger(start) && Number.isInteger(end) && start >= 0 && end > start && end <= Array.from(document.body).length ? { start, end } : undefined
  useEffect(() => { if (match && location.hash === '#search-passage') globalThis.document.getElementById('search-passage')?.focus() }, [document, location.search, location.hash])
  return <><Link className={common.back} to={`/knowledge${location.search}`}>← ナレッジ一覧へ戻る（条件を保持）</Link>{!document ? <><h1 tabIndex={-1}>承認済みナレッジ</h1><LoadState error={resource.error} reload={resource.reload} /></> : <><div className={common.heading}><div><p className="eyebrow">{document.number} · 承認済み v{document.version_no}</p><h1 tabIndex={-1}>{document.title}</h1><p className={common.meta}>担当部署 {document.department?.name} · 承認 {formatDate(document.approved_at)} JST · {(suspended ?? document.publication_suspended) ? '公開停止中 · 担当者のみ閲覧可能' : '社員全員に公開'}</p></div><button className="button" onClick={resource.reload}>再取得</button></div><div className={styles.readGrid}><section className={common.section}>{matchParams.has('match_version') && !match && <p role="status" className={styles.warning}>検索時から公開版が更新されたか、該当位置を確認できません。現在の全文を確認し、必要なら再検索してください。</p>}<KnowledgeBody input={document} match={match} /><SearchInquiry query={matchParams.get('q') ?? ''} document={document} /></section><aside>{props.role === 'operator' ? <RevisionEntry document={document} onDirtyChange={props.onDirtyChange} onChanged={value => setSuspended(value.publication_suspended)} /> : <section className={common.section}><h2>承認された版</h2><p>{document.number} / v{document.version_no}</p></section>}</aside></div></>}</>
}
// 非公開の改訂状況は担当者だけが別途取得し、社員向けの公開DTOへ混ぜない。
// [ko] 비공개 개정 상태는 담당자만 별도로 조회하며 직원용 공개 DTO에 섞지 않는다.
// [en] Fetch private revision state separately for operators; keep it out of the public DTO.
function RevisionEntry({ document, onDirtyChange, onChanged }: { document: Published; onDirtyChange: (dirty: boolean) => void; onChanged: (review: Review) => void }) {
  const resource = useLoad<Review>(`/knowledge/${document.document_id}/versions/${document.version_no}`)
  const data = resource.data
  return <><section className={common.section}><h2>承認された版</h2><p>{document.number} / v{document.version_no}</p><div className={common.nextStep}><h3>内容の改訂</h3><p>新しい版を承認するまで本文は置き換わりません。公開停止中の文書は、再公開するまで社員には表示されません。</p>{data ? <Link className="button" to={reviewUrl({ document_id: document.document_id, version_no: data.draft_version_no ?? data.latest_version_no })}>{data.draft_version_no ? '下書きを開く' : '版の詳細・改訂'}</Link> : <LoadState error={resource.error} reload={resource.reload} />}</div></section>{data && <KnowledgeManagement initial={data} onDirtyChange={onDirtyChange} onChanged={onChanged} />}</>
}
