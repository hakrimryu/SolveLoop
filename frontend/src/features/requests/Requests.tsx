import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { Link, useLocation, useSearchParams } from 'react-router'
import { apiQuery, formatDate, statusLabels } from '../../lib/business'
import type { BusinessProps, Page, TicketItem, UserRef } from '../../lib/business'
import { useLoad } from '../../lib/useBusiness'
import { LoadState, Pagination } from '../../components/BusinessState'
import RequestDialog from './RequestDialog'
import styles from './Requests.module.css'

export type RequestProps = BusinessProps & { operators: UserRef[] }
// 詳細から戻る位置だけを保持し、認証世代が変わったら呼び出し側で破棄する。
// [ko] 상세에서 돌아올 위치만 유지하고 인증 세대가 바뀌면 호출 측에서 폐기한다.
// [en] Retain list return position only within an auth generation; callers clear it on auth changes.
let listPosition: { url: string; y: number; id: string } | undefined
export function clearRequestPosition() { listPosition = undefined }

export default function Requests(props: RequestProps) {
  const [params, setParams] = useSearchParams()
  const location = useLocation()
  const searchQuery = params.get('q') ?? ''
  const [query, setQuery] = useState(searchQuery)
  const registerRef = useRef<HTMLButtonElement>(null)
  const headingRef = useRef<HTMLHeadingElement>(null)
  const allowed = ['q', 'status', 'department_id', 'page', 'page_size', 'sort', ...(props.role === 'operator' ? ['assignee'] : [])]
  const resource = useLoad<Page<TicketItem>>(`/tickets?${apiQuery(params, allowed)}`)
  const data = resource.data
  useEffect(() => setQuery(searchQuery), [searchQuery])
  useLayoutEffect(() => {
    if (!data || listPosition?.url !== location.pathname + location.search) return
    const position = listPosition
    const frame = requestAnimationFrame(() => { document.getElementById(position.id)?.focus({ preventScroll: true }); window.scrollTo({ top: position.y }) })
    return () => cancelAnimationFrame(frame)
  }, [data, location.pathname, location.search])
  function filter(name: string, value: string) {
    const next = new URLSearchParams(params)
    if (value) next.set(name, value); else next.delete(name)
    if (!['new', 'page'].includes(name)) next.delete('page')
    setParams(next)
  }
  function search(event: FormEvent) { event.preventDefault(); filter('q', query.trim()) }
  function close() { const next = new URLSearchParams(params); next.delete('new'); setParams(next, { replace: true }); registerRef.current?.focus() }
  return <>
    <div className={styles.heading}><div><p className="eyebrow">{props.role === 'operator' ? '問い合わせ管理' : '自分の問い合わせ'}</p><h1 ref={headingRef} tabIndex={-1}>問い合わせ</h1><p className="muted">サーバーに保存された問い合わせと対応状況を確認します。</p></div><button ref={registerRef} className="button buttonPrimary" onClick={() => filter('new', '1')}>問い合わせを登録</button></div>
    <section className={styles.section} aria-label="問い合わせ一覧">
      <form className={styles.filters} onSubmit={search} onKeyDown={e => { if (e.key === 'Enter' && e.nativeEvent.isComposing) e.preventDefault() }}>
        <label className={styles.search}>キーワード<input type="search" maxLength={200} value={query} onChange={e => setQuery(e.target.value)} placeholder="件名・内容・問い合わせ番号" /></label>
        <label>状態<select value={params.get('status') ?? ''} onChange={e => filter('status', e.target.value)}><option value="">すべて</option><option value="unresolved">未解決</option>{Object.entries(statusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label>担当部署<select value={params.get('department_id') ?? ''} onChange={e => filter('department_id', e.target.value)}><option value="">すべて</option><option value="unassigned">未定</option>{props.departments.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}</select></label>
        {props.role === 'operator' && <label>担当者<select value={params.get('assignee') ?? ''} onChange={e => filter('assignee', e.target.value)}><option value="">すべて</option><option value="unassigned">未割り当て（未解決）</option><option value="me">自分の担当</option>{props.operators.map(o => <option key={o.id} value={o.id}>{o.display_name}</option>)}</select></label>}
        <button className="button">検索</button><button className="button" type="button" onClick={() => { setQuery(''); setParams({}) }}>条件をクリア</button>
      </form>
      <div className={styles.results}><p role="status">{data ? <><strong>{data.filtered_count}件</strong> / {props.role === 'operator' ? '全' : '自分の'}問い合わせ {data.visible_total}件</> : '件数を取得していません'}<span className={styles.sort}>更新日時順 · 日本時間</span></p><button className="button" onClick={resource.reload}>再取得</button></div>
      {!data ? <LoadState error={resource.error} reload={resource.reload} /> : data.filtered_count === 0 ? <div className={styles.empty}><h2>{data.visible_total ? '条件に一致する問い合わせはありません' : '問い合わせはまだありません'}</h2><p>{data.visible_total ? 'キーワードや絞り込み条件を変更してください。' : '「問い合わせを登録」から内容を入力できます。'}</p></div> : <>
        <p className={styles.tableHint}>表は横にスクロールできます。</p><div className={styles.tableScroll} role="region" aria-label="問い合わせ一覧・横にスクロールできます" tabIndex={0}><table><caption className="srOnly">問い合わせ一覧</caption><thead><tr><th scope="col">番号</th><th scope="col">件名</th><th scope="col">状態</th>{props.role === 'operator' && <th scope="col">申請者</th>}<th scope="col">担当者</th><th scope="col">担当部署</th><th scope="col">更新日時</th></tr></thead><tbody>{data.items.map(item => <tr key={item.id}><th scope="row" className={styles.number}>{item.number}</th><td className={styles.subject}><Link id={`request-${item.id}`} to={`/requests/${item.id}${location.search}`} onClick={() => { listPosition = { url: location.pathname + location.search, y: window.scrollY, id: `request-${item.id}` } }}>{item.title}</Link></td><td><span className={`status ${item.status}`}>{statusLabels[item.status]}</span></td>{props.role === 'operator' && <td className={styles.person}>{item.requester?.display_name}</td>}<td className={styles.person}>{item.assignee?.display_name ?? '未割り当て'}</td><td>{item.department?.name ?? '未定'}</td><td className={styles.date}>{formatDate(item.updated_at)} JST</td></tr>)}</tbody></table></div>
      </>}
      {data && <Pagination data={data} onPage={page => { filter('page', String(page)); headingRef.current?.focus(); window.scrollTo({ top: 0 }) }} />}
    </section>
    {params.get('new') === '1' && <RequestDialog {...props} onClose={close} />}
  </>
}
