import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { Link, useLocation, useSearchParams } from 'react-router'
import { departments, getRequestFilters, getRequestList, operators, personName, formatDemoDate, statusLabels } from '../../lib/mockData'
import type { DemoRole, MockRequest } from '../../lib/mockData'
import RequestDialog from './RequestDialog'
import styles from './Requests.module.css'

export type RequestProps = {
  role: DemoRole
  requests: MockRequest[]
  onRequestsChange: (requests: MockRequest[]) => void
  onDirtyChange: (dirty: boolean) => void
  getNextTimestamp: () => string
}
export type DisplayMode = 'normal' | 'empty' | 'loading' | 'error'

export function DisplayControl({ mode, onChange }: { mode: DisplayMode; onChange: (mode: DisplayMode) => void }) {
  return (
    <details className={styles.displayControl}>
      <summary>表示を確認</summary>
      <label>表示確認（デモ用）
        <select value={mode} onChange={event => onChange(event.target.value as DisplayMode)}>
          <option value="normal">通常</option><option value="empty">データなし</option>
          <option value="loading">読み込み中</option><option value="error">読み込みエラー</option>
        </select>
      </label>
      <p className="muted">表示だけを切り替えます。操作済みの資料は保持されます。</p>
    </details>
  )
}

let listPosition: { url: string; y: number; id: string } | undefined

export default function Requests(props: RequestProps) {
  const { role, requests } = props
  const [params, setParams] = useSearchParams()
  const location = useLocation()
  const searchQuery = params.get('q') ?? ''
  const [mode, setMode] = useState<DisplayMode>('normal')
  const [query, setQuery] = useState(searchQuery)
  const registerRef = useRef<HTMLButtonElement>(null)
  const headingRef = useRef<HTMLHeadingElement>(null)
  const showDialog = params.get('new') === '1'
  const data = getRequestList(mode === 'empty' ? [] : requests, role, params)
  const filters = getRequestFilters(params)

  useEffect(() => { setQuery(searchQuery) }, [searchQuery])
  useLayoutEffect(() => {
    if (listPosition?.url !== location.pathname + location.search) return
    const position = listPosition
    const frame = requestAnimationFrame(() => {
      document.getElementById(position.id)?.focus({ preventScroll: true })
      window.scrollTo({ top: position.y })
    })
    return () => cancelAnimationFrame(frame)
  }, [location.pathname, location.search])

  function changeFilter(name: string, value: string) {
    const next = new URLSearchParams(params)
    if (value) next.set(name, value)
    else next.delete(name)
    if (name !== 'new') next.delete('page')
    setParams(next)
  }

  function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    changeFilter('q', query.trim())
  }

  function closeDialog() {
    const next = new URLSearchParams(params)
    next.delete('new')
    setParams(next, { replace: true })
    registerRef.current?.focus()
  }

  function changePage(page: number) {
    const next = new URLSearchParams(params)
    next.set('page', String(page))
    setParams(next)
    headingRef.current?.focus()
    window.scrollTo({ top: 0 })
  }

  function clearFilters() {
    setQuery('')
    setParams({})
  }

  function retry() {
    setMode('normal')
    headingRef.current?.focus()
  }

  function rememberPosition(id: string) {
    listPosition = { url: location.pathname + location.search, y: window.scrollY, id: `request-${id}` }
  }

  return (
    <>
      <div className={styles.heading}>
        <div>
          <p className="eyebrow">{role === 'operator' ? '問い合わせ管理' : '自分の問い合わせ'}</p>
          <h1 ref={headingRef} tabIndex={-1}>問い合わせ</h1>
          <p className="muted">{role === 'operator' ? '対応状況を確認し、担当の割り当てと解決記録へ進みます。' : '自分が登録した問い合わせの内容と対応状況を確認できます。'}</p>
        </div>
        <button ref={registerRef} className="button buttonPrimary" onClick={() => changeFilter('new', '1')}>問い合わせを登録</button>
      </div>
      <section className={styles.section} aria-label="問い合わせ一覧">
        <form className={styles.filters} onSubmit={search} onKeyDown={event => {
          if (event.key === 'Enter' && event.nativeEvent.isComposing) event.preventDefault()
        }}>
          <label className={styles.search}>キーワード
            <input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="件名・内容・問い合わせ番号" />
          </label>
          <label>状態
            <select value={filters.status} onChange={event => changeFilter('status', event.target.value)}>
              <option value="">すべて</option><option value="unresolved">未解決</option>
              {Object.entries(statusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </label>
          <label>担当部署
            <select value={filters.department} onChange={event => changeFilter('department', event.target.value)}>
              <option value="">すべて</option>
              {departments.map(department => <option key={department}>{department}</option>)}
            </select>
          </label>
          {role === 'operator' && (
            <label>担当者
              <select value={filters.assignee} onChange={event => changeFilter('assignee', event.target.value)}>
                <option value="">すべて</option><option value="unassigned">未割り当て（未解決）</option><option value="me">自分の担当</option>
                {operators.map(operator => <option key={operator.id} value={operator.id}>{operator.name}</option>)}
              </select>
            </label>
          )}
          <button className="button" type="submit">検索</button>
          <button className="button" type="button" onClick={clearFilters}>条件をクリア</button>
        </form>
        <div className={styles.results}>
          <p role="status">
            {mode === 'normal' || mode === 'empty' ? (
              <><strong>{data.count}件</strong> / {role === 'operator' ? '全' : '自分の'}問い合わせ {data.total}件</>
            ) : '件数を取得していません'}
            <span className={styles.sort}>更新日時の新しい順 · 日本時間</span>
          </p>
          <DisplayControl mode={mode} onChange={setMode} />
        </div>
        {mode === 'loading' ? (
          <p className={styles.empty} role="status" aria-busy="true">読み込み中… 表示確認用のシミュレーションです。</p>
        ) : mode === 'error' ? (
          <div className={styles.empty}>
            <p role="alert">問い合わせを読み込めませんでした。表示確認用のエラーです。</p>
            <button className="button" onClick={retry}>再試行</button>
          </div>
        ) : data.count === 0 ? (
            <div className={styles.empty}>
              <h2>{data.total === 0 ? '問い合わせはまだありません' : '条件に一致する問い合わせはありません'}</h2>
              <p>{data.total === 0 ? '「問い合わせを登録」から内容を入力できます。データなし表示中の登録も、通常表示の資料に追加されます。' : 'キーワードや絞り込み条件を変更してください。「条件をクリア」で一覧に戻れます。'}</p>
            </div>
          ) : (
            <>
              <p className={styles.tableHint}>表は横にスクロールできます。</p>
              <div className={styles.tableScroll} role="region" aria-label="問い合わせ一覧・横にスクロールできます" tabIndex={0}>
                <table>
                  <caption className="srOnly">問い合わせ一覧。更新日時の新しい順、1ページ20件。</caption>
                  <thead>
                    <tr>
                      <th scope="col">番号</th><th scope="col">件名</th><th scope="col">状態</th>
                      {role === 'operator' && <th scope="col">申請者</th>}
                      <th scope="col">担当者</th><th scope="col">担当部署</th><th scope="col">更新日時</th>
                    </tr>
                  </thead>
                  <tbody>{data.rows.map(request => (
                    <tr key={request.id}>
                      <th scope="row" className={styles.number}>{request.id}</th>
                      <td className={styles.subject}>
                        <Link
                          id={`request-${request.id}`} to={`/requests/${request.id}${location.search}`}
                          onClick={() => rememberPosition(request.id)}
                        >
                          {request.title}
                        </Link>
                      </td>
                      <td><span className={`status ${request.status}`}>{statusLabels[request.status]}</span></td>
                      {role === 'operator' && <td className={styles.person}>{personName(request.requesterId)}</td>}
                      <td className={styles.person}>{personName(request.assigneeId)}</td><td>{request.department}</td>
                      <td className={styles.date}><time dateTime={request.updatedAt}>{formatDemoDate(request.updatedAt)}</time></td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
              <nav className={styles.pagination} aria-label="問い合わせ一覧のページ">
                <span>{(data.page - 1) * 20 + 1}–{Math.min(data.page * 20, data.count)} / {data.count}件</span>
                <button className="button" disabled={data.page === 1} onClick={() => changePage(data.page - 1)}>前へ</button>
                <span>{data.page} / {data.pageCount}ページ</span>
                <button className="button" disabled={data.page === data.pageCount} onClick={() => changePage(data.page + 1)}>次へ</button>
              </nav>
            </>
          )}
      </section>
      {showDialog && <RequestDialog {...props} onClose={closeDialog} />}
    </>
  )
}
