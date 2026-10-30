import { useRef, useState } from 'react'
import type { ChangeEvent, FocusEvent } from 'react'
import { Link, useSearchParams } from 'react-router'
import { formatDemoDate, getDashboardData, statusLabels } from '../../lib/mockData'
import type { DemoRole, KnowledgeVersion, MockRequest, RequestStatus } from '../../lib/mockData'
import RadarPanel from './RadarPanel'
import styles from './Dashboard.module.css'

type DisplayMode = 'normal' | 'empty' | 'loading' | 'error'
const statuses: RequestStatus[] = ['open', 'in_progress', 'resolved']

export default function Dashboard({ role, userId, requests, knowledge }: { role: DemoRole; userId: string; requests: MockRequest[]; knowledge: KnowledgeVersion[] }) {
  const [mode, setMode] = useState<DisplayMode>('normal')
  const [searchParams, setSearchParams] = useSearchParams()
  const titleRef = useRef<HTMLHeadingElement>(null)
  const radarLinkRef = useRef<HTMLAnchorElement>(null)
  const data = getDashboardData(role, mode === 'empty' ? 'empty' : 'normal', requests, knowledge, userId)
  const isOperator = role === 'operator'
  const selectedCandidate = searchParams.get('radar')
  const showRadar = isOperator && mode === 'normal' && selectedCandidate !== null

  function closeRadar() {
    setSearchParams({}, { replace: true })
    radarLinkRef.current?.focus()
  }

  function handleDisplayChange(event: ChangeEvent<HTMLSelectElement>) {
    setMode(event.target.value as DisplayMode)
    setSearchParams({}, { replace: true })
  }

  function handleDisplayControlBlur(event: FocusEvent<HTMLDetailsElement>) {
    if (!event.currentTarget.contains(event.relatedTarget)) {
      event.currentTarget.open = false
    }
  }

  function handleRetry() {
    setMode('normal')
    titleRef.current?.focus()
  }

  return (
    <div className={`${styles.dashboard} ${showRadar ? styles.withRadar : ''}`}>
      <div>
        <div className={styles.heading}>
          <div>
            <p className="eyebrow">{isOperator ? '担当者のワークスペース' : '自分の問い合わせとナレッジ'}</p>
            <h1 ref={titleRef} tabIndex={-1}>ダッシュボード</h1>
            <p className="muted">{isOperator ? '対応する問い合わせと、確認待ちのナレッジを確認します。' : '自分の問い合わせの状況と、承認済みナレッジへの入口です。'}</p>
          </div>
          <details className={styles.displayControl} onBlur={handleDisplayControlBlur}>
            <summary>表示を確認</summary>
            <div>
              <label htmlFor="demo-display">表示確認（デモ用）</label>
              <select id="demo-display" value={mode} onChange={handleDisplayChange}>
                <option value="normal">通常</option>
                <option value="empty">データなし</option>
                <option value="loading">読み込み中</option>
                <option value="error">読み込みエラー</option>
              </select>
              <p>画面の状態を再現するための設定です。</p>
            </div>
          </details>
        </div>
        <div className={styles.asOf}>
          <span>{isOperator ? '全問い合わせ' : '自分の問い合わせ'} <strong>{data.total}件</strong> · 合成データ</span>
          <span>集計基準日時 <time dateTime={data.asOf}>{formatDemoDate(data.asOf)} JST</time></span>
        </div>
        {mode === 'loading' ? (
          <section className="notice" aria-busy="true" aria-label="ダッシュボードの読み込み">
            <p role="status">読み込み中… 表示確認用のシミュレーションです。</p>
            <div className={styles.skeleton} aria-hidden="true" />
            <div className={styles.skeleton} aria-hidden="true" />
          </section>
        ) : mode === 'error' ? (
          <section className="notice">
            <p role="alert">ダッシュボードを読み込めませんでした。表示確認用のエラーです。</p>
            <button className="button" type="button" onClick={handleRetry}>再試行</button>
          </section>
        ) : (
          <>
            <section aria-label="問い合わせの状態別件数" className={styles.summary}>
              {statuses.map(status => (
                <Link
                  key={status}
                  to={`/requests?status=${status}`}
                  className={styles.count}
                  data-status={status}
                >
                  <span>{statusLabels[status]}</span>
                  <strong>{data.counts[status]}<small>件</small></strong>
                  <span aria-hidden="true">→</span>
                </Link>
              ))}
            </section>
            {isOperator && (
              <div className={styles.shortcuts}>
                <Link to="/requests?assignee=unassigned">
                  未割り当て <strong>{data.unassignedCount}件</strong>
                </Link>
                <Link to="/requests?assignee=me&status=unresolved">
                  自分の担当（未解決） <strong>{data.ownOpenCount}件</strong>
                </Link>
                <Link to="/knowledge/reviews?status=draft">
                  確認待ち <strong>{data.reviews.length}件</strong>
                </Link>
              </div>
            )}
            <section className={styles.section} aria-labelledby="recent-heading">
              <div className={styles.sectionHeading}>
                <h2 id="recent-heading">{isOperator ? '自分の担当問い合わせ' : '最近の自分の問い合わせ'}</h2>
                <Link to={isOperator ? '/requests?assignee=me' : '/requests'}>すべて表示 →</Link>
              </div>
              <p className={styles.scrollHint}>表は横にスクロールできます。</p>
              <div
                className={styles.tableScroll}
                role="region"
                aria-label="問い合わせ一覧・横にスクロールできます"
                tabIndex={0}
              >
                <table>
                  <caption className="srOnly">更新が新しい問い合わせ（最大5件）。日時は日本時間です。</caption>
                  <thead>
                    <tr>
                      <th scope="col">番号</th>
                      <th scope="col">件名</th>
                      <th scope="col">状態</th>
                      <th scope="col">担当部署</th>
                      <th scope="col">更新日時</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.recentRequests.length ? data.recentRequests.map(request => (
                      <tr key={request.id}>
                        <th scope="row" className={styles.number}>{request.id}</th>
                        <td className={styles.subject}>
                          <Link to={`/requests/${request.id}`}>{request.title}</Link>
                        </td>
                        <td>
                          <span className={`status ${request.status}`}>{statusLabels[request.status]}</span>
                        </td>
                        <td>{request.department}</td>
                        <td className={styles.date}>
                          <time dateTime={request.updatedAt}>{formatDemoDate(request.updatedAt)}</time>
                        </td>
                      </tr>
                    )) : (
                      <tr>
                        <td colSpan={5} className={styles.empty}>
                          {isOperator ? '担当する問い合わせはありません。' : '問い合わせはまだありません。'}{' '}
                          <Link to={isOperator ? '/requests?assignee=unassigned' : '/requests?new=1'}>
                            {isOperator ? '未割り当てを確認' : '問い合わせを登録'}
                          </Link>
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
              <p className={styles.tableNote}>日時は日本時間 · {isOperator ? '自分の担当分を表示' : `自分の問い合わせ ${data.total}件`} · このタブ内の操作結果を反映します。</p>
            </section>
            {isOperator ? (
              <div className={styles.workQueue}>
                <section className={styles.section} aria-labelledby="review-heading">
                  <div className={styles.sectionHeading}>
                    <h2 id="review-heading">
                      確認待ちの下書き <span className={styles.smallCount}>{data.reviews.length}件</span>
                    </h2>
                    <Link to="/knowledge/reviews?status=draft">レビューへ →</Link>
                  </div>
                  {data.reviews.length ? (
                    <ul className={styles.reviewList}>
                      {data.reviews.map(review => (
                        <li key={review.id}>
                          <div>
                            <Link to={`/knowledge/reviews/${review.id}/versions/${review.version}`}>
                              {review.title}
                            </Link>
                            <p className="muted">
                              {review.id} · 下書き v{review.version} · {review.sources.length ? `元の問い合わせ ${review.sources.map(source => source.requestId).join('・')}` : '手動作成'}
                            </p>
                          </div>
                          <span className="status open">未承認</span>
                          <time className={styles.date} dateTime={review.updatedAt}>
                            {formatDemoDate(review.updatedAt)}
                          </time>
                        </li>
                      ))}
                    </ul>
                  ) : <p className={styles.empty}>確認待ちの下書きはありません。</p>}
                </section>
                <section className={styles.section} aria-labelledby="radar-heading">
                  <div className={styles.sectionHeading}>
                    <h2 id="radar-heading">
                      ナレッジ不足の候補 <span className={styles.smallCount}>Radar</span>
                    </h2>
                    <span className="sampleLabel">分析結果のサンプル</span>
                  </div>
                  <p className={styles.sampleNote}>初期資料に基づく固定サンプルです。操作後も判定・候補は再計算されません。実際の分析は行っていません。</p>
                  {data.radar ? (
                    <div className={styles.radarCandidate}>
                      <div>
                        <h3>{data.radar.title}</h3>
                        <p>{data.radar.summary}</p>
                        <dl className={styles.radarMetrics}>
                          <div>
                            <dt>繰り返し</dt>
                            <dd>{data.radar.requests.length}<small>件</small></dd>
                          </div>
                          <div>
                            <dt>対応文書なし</dt>
                            <dd>{data.radar.coverageCounts.uncovered}<small>件</small></dd>
                          </div>
                          <div>
                            <dt>未判定</dt>
                            <dd>{data.radar.coverageCounts.unknown}<small>件</small></dd>
                          </div>
                        </dl>
                      </div>
                      <Link
                        ref={radarLinkRef}
                        className="button buttonPrimary"
                        to={`/dashboard?radar=${data.radar.id}`}
                        aria-expanded={showRadar}
                        aria-controls={showRadar ? 'radar-panel' : undefined}
                      >
                        根拠を確認 <span aria-hidden="true">→</span>
                        <span className="srOnly">：{data.radar.title}</span>
                      </Link>
                    </div>
                  ) : <p className={styles.empty}>分析結果はありません。</p>}
                </section>
              </div>
            ) : (
              <section className={styles.section} aria-labelledby="knowledge-heading">
                <h2 id="knowledge-heading">問い合わせの前に</h2>
                <p>承認済みの手順から、解決方法を探せます。</p>
                <div className={styles.entryLinks}>
                  <Link className="button buttonPrimary" to="/knowledge">承認済みナレッジを探す</Link>
                  <Link to="/requests?new=1">問い合わせを登録 →</Link>
                </div>
                <p className="muted">ナレッジ検索は準備中です。問い合わせは登録をシミュレーションできます。</p>
              </section>
            )}
          </>
        )}
      </div>
      {showRadar && (
        data.radar?.id === selectedCandidate ? (
          <RadarPanel candidate={data.radar} onClose={closeRadar} />
        ) : (
          <aside id="radar-panel" className="notice" aria-label="Radar候補">
            <p>指定された候補は見つかりません。</p>
            <button className="button" type="button" onClick={closeRadar}>閉じる</button>
          </aside>
        )
      )}
    </div>
  )
}
