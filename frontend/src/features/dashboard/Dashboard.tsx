import { Link } from 'react-router'
import { formatDate, statusLabels, reviewUrl } from '../../lib/business'
import type { DashboardData } from '../../lib/business'
import type { Role } from '../../lib/api'
import { useLoad } from '../../lib/useBusiness'
import { LoadState } from '../../components/BusinessState'
import styles from './Dashboard.module.css'
import Radar from './Radar'

export default function Dashboard({ role, onDirtyChange }: { role: Role; onDirtyChange: (dirty: boolean) => void }) {
  const resource = useLoad<DashboardData>('/dashboard')
  const data = resource.data
  const operator = role === 'operator'
  return <div className={styles.dashboard}><div><div className={styles.heading}><div><p className="eyebrow">{operator ? '担当者のワークスペース' : '自分の問い合わせとナレッジ'}</p><h1 tabIndex={-1}>ダッシュボード</h1><p className="muted">{operator ? '対応する問い合わせと確認待ちの下書きを確認します。' : '自分の問い合わせの状況と承認済みナレッジへの入口です。'}</p></div><button className="button" onClick={resource.reload}>再取得</button></div>
    {!data ? <LoadState error={resource.error} reload={resource.reload} /> : <>
      <div className={styles.asOf}><span>{operator ? '全問い合わせ' : '自分の問い合わせ'} <strong>{data.total}件</strong> · 実DB集計</span><span>集計基準日時 {formatDate(data.as_of)} JST</span></div>
      <section aria-label="問い合わせの状態別件数" className={styles.summary}>{(['open', 'in_progress', 'resolved'] as const).map(status => <Link key={status} to={`/requests?status=${status}`} className={styles.count} data-status={status}><span>{statusLabels[status]}</span><strong>{data.counts[status]}<small>件</small></strong><span aria-hidden="true">→</span></Link>)}</section>
      {operator && <div className={styles.shortcuts}><Link to="/requests?assignee=unassigned">未割り当て <strong>{data.unassigned_count}件</strong></Link><Link to="/requests?assignee=me&status=unresolved">自分の担当（未解決） <strong>{data.own_unresolved_count}件</strong></Link><Link to="/knowledge/reviews?status=draft">確認待ち <strong>{data.review_pending_count}件</strong></Link></div>}
      <section className={styles.section} aria-labelledby="recent-heading"><div className={styles.sectionHeading}><h2 id="recent-heading">{operator ? '自分の担当問い合わせ' : '最近の自分の問い合わせ'}</h2><Link to={operator ? '/requests?assignee=me' : '/requests'}>すべて表示 →</Link></div><p className={styles.scrollHint}>表は横にスクロールできます。</p><div className={styles.tableScroll} role="region" aria-label="最近の問い合わせ・横にスクロールできます" tabIndex={0}><table><caption className="srOnly">更新が新しい問い合わせ（最大5件）</caption><thead><tr><th scope="col">番号</th><th scope="col">件名</th><th scope="col">状態</th><th scope="col">担当部署</th><th scope="col">更新日時</th></tr></thead><tbody>{data.recent_tickets.length ? data.recent_tickets.map(item => <tr key={item.id}><th scope="row" className={styles.number}>{item.number}</th><td className={styles.subject}><Link to={`/requests/${item.id}`}>{item.title}</Link></td><td><span className={`status ${item.status}`}>{statusLabels[item.status]}</span></td><td>{item.department?.name ?? '未定'}</td><td className={styles.date}>{formatDate(item.updated_at)} JST</td></tr>) : <tr><td colSpan={5} className={styles.empty}>{operator ? '担当する問い合わせはありません。' : '問い合わせはまだありません。'} <Link to={operator ? '/requests?assignee=unassigned' : '/requests?new=1'}>{operator ? '未割り当てを確認' : '問い合わせを登録'}</Link></td></tr>}</tbody></table></div></section>
      {operator ? <div className={styles.workQueue}><section className={styles.section}><div className={styles.sectionHeading}><h2>確認待ちの下書き <span className={styles.smallCount}>{data.review_pending_count}件</span></h2><Link to="/knowledge/reviews?status=draft">レビューへ →</Link></div>{data.reviews?.length ? <ul className={styles.reviewList}>{data.reviews.map(item => <li key={item.version_id}><div><Link to={reviewUrl(item)}>{item.title}</Link><p className="muted">{item.number} · 下書き v{item.version_no}</p></div><span className="status open">未承認</span><time className={styles.date}>{formatDate(item.updated_at)}</time></li>)}</ul> : <p className={styles.empty}>確認待ちの下書きはありません。</p>}</section></div> : <section className={styles.section}><h2>問い合わせの前に</h2><p>承認済みの手順から解決方法を探せます。</p><div className={styles.entryLinks}><Link className="button buttonPrimary" to="/knowledge">承認済みナレッジを探す</Link><Link to="/requests?new=1">問い合わせを登録 →</Link></div></section>}
      {operator && <Radar onDirtyChange={onDirtyChange} />}
    </>}
  </div></div>
}
