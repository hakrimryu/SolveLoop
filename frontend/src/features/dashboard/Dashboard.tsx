import { Link } from 'react-router'
import { formatDate, statusLabels, reviewUrl } from '../../lib/business'
import type { DashboardData, Page, TicketItem } from '../../lib/business'
import { useLoad } from '../../lib/useBusiness'
import { LoadState } from '../../components/BusinessState'
import styles from './Dashboard.module.css'

function WorkIcon({ kind }: { kind: 'inbox' | 'reply' | 'person' | 'review' | 'check' | 'radar' | 'book' | 'arrow' }) {
  const paths = {
    inbox: 'M4 4h16v16H4z M4 13h5l1 3h4l1-3h5 M8 8h8',
    reply: 'M4 3h16v12H9l-5 5V3z M8 7h8 M8 11h5',
    person: 'M15 7a3 3 0 1 1-6 0 3 3 0 0 1 6 0 M5 21v-3a7 7 0 0 1 14 0v3',
    review: 'M8 4H5v17h14V4h-3 M9 2h6v5H9z M8 14l3 3 5-6',
    check: 'M5 12l4 4L19 6',
    radar: 'M12 3a9 9 0 1 0 9 9 M12 7a5 5 0 1 0 5 5 M12 12l8-8 M16 3h5v5',
    book: 'M12 5C9 3 6 3 3 4v15c3-1 6-1 9 1m0-15c3-2 6-2 9-1v15c-3-1-6-1-9 1V5z',
    arrow: 'M5 12h14 M14 7l5 5-5 5',
  }
  return <svg className={styles.icon} viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d={paths[kind]} /></svg>
}

export default function Dashboard() {
  const resource = useLoad<DashboardData>('/dashboard')
  const needsReply = useLoad<Page<TicketItem>>('/tickets?queue=needs_reply&page_size=1')
  const waiting = useLoad<Page<TicketItem>>('/tickets?queue=waiting_requester&page_size=1')
  const unread = useLoad<Page<TicketItem>>('/tickets?queue=unread&page_size=1')
  const data = resource.data
  function reload() { resource.reload(); needsReply.reload(); waiting.reload(); unread.reload() }

  return <div className={styles.dashboard}>
    <div className={styles.heading}><div><p className="eyebrow">管理 · 担当者のワークスペース</p><h1 tabIndex={-1}>管理ダッシュボード</h1><p>問い合わせの対応と、公開する知識の確認を進めます。</p></div><button className="button" onClick={reload}>更新</button></div>
    {!data ? <LoadState error={resource.error} reload={reload} /> : <>
      <section className={styles.overview} aria-labelledby="overview-heading">
        <div className={styles.sectionHeading}><div className={styles.titleWithIcon}><span className={styles.titleIcon}><WorkIcon kind="inbox" /></span><h2 id="overview-heading">問い合わせの状況</h2><span className={styles.total}>全 {data.total}件</span></div><time dateTime={data.as_of} className={styles.date}>{formatDate(data.as_of)} JST 時点</time></div>
        <div className={styles.statusFlow}>{(['open', 'in_progress', 'resolved'] as const).map(status => <Link key={status} to={`/requests?status=${status}`} className={styles.statusStep} data-status={status}>
          <span className={styles.statusNode}><WorkIcon kind={status === 'open' ? 'inbox' : status === 'in_progress' ? 'reply' : 'check'} /></span>
          <span className={styles.statusValue}><span>{statusLabels[status]}</span><strong>{data.counts[status]}<small>件</small></strong></span><span className={styles.stepArrow}><WorkIcon kind="arrow" /></span>
        </Link>)}</div>
        <div className={styles.distribution} aria-hidden="true">{(['open', 'in_progress', 'resolved'] as const).filter(status => data.counts[status] > 0).map(status => <span key={status} data-status={status} style={{ flexGrow: data.counts[status] }} />)}</div>
        {data.total === 0 && <p className={styles.overviewNote}>問い合わせはまだありません。</p>}
      </section>

      <section aria-labelledby="actions-heading">
        <h2 id="actions-heading" className={styles.blockHeading}>次に対応すること</h2>
        <div className={styles.actionGrid}>
          <Link className={styles.action} to="/requests?queue=needs_reply" data-tone="blue"><span className={styles.actionIcon}><WorkIcon kind="reply" /></span><span className={styles.actionLabel}>回答が必要<strong>{needsReply.data ? needsReply.data.filtered_count : '—'}<small>件</small></strong><span>{needsReply.error ? '件数を取得できませんでした' : needsReply.loading ? '件数を確認中…' : '質問・追加情報への回答'}</span></span><WorkIcon kind="arrow" /></Link>
          <Link className={styles.action} to="/requests?assignee=unassigned" data-tone="amber"><span className={styles.actionIcon}><WorkIcon kind="person" /></span><span className={styles.actionLabel}>未割り当て<strong>{data.unassigned_count ?? '—'}<small>件</small></strong><span>担当部署・担当者を決める</span></span><WorkIcon kind="arrow" /></Link>
          <Link className={styles.action} to="/knowledge/reviews?status=draft" data-tone="green"><span className={styles.actionIcon}><WorkIcon kind="review" /></span><span className={styles.actionLabel}>確認待ちの下書き<strong>{data.review_pending_count ?? '—'}<small>件</small></strong><span>根拠を読み、公開内容を確認</span></span><WorkIcon kind="arrow" /></Link>
        </div>
        <nav className={styles.secondaryActions} aria-label="そのほかの対応状況">
          <Link to="/requests?assignee=me&status=unresolved"><WorkIcon kind="person" /><span>自分の担当・未解決</span><strong>{data.own_unresolved_count ?? '—'}件</strong></Link>
          <Link to="/requests?queue=waiting_requester"><WorkIcon kind="reply" /><span>申請者の確認待ち</span><strong>{waiting.data ? `${waiting.data.filtered_count}件` : waiting.error ? '取得失敗' : '確認中'}</strong></Link>
          <Link to="/requests?queue=unread"><WorkIcon kind="inbox" /><span>未読の回答</span><strong>{unread.data ? `${unread.data.filtered_count}件` : unread.error ? '取得失敗' : '確認中'}</strong></Link>
        </nav>
      </section>

      <div className={styles.workGrid}>
        <section className={styles.section} aria-labelledby="assigned-heading">
          <div className={styles.sectionHeading}><div className={styles.titleWithIcon}><span className={styles.titleIcon}><WorkIcon kind="person" /></span><h2 id="assigned-heading">自分の担当問い合わせ</h2></div><Link to="/requests?assignee=me">すべて見る →</Link></div>
          {data.recent_tickets.length ? <ul className={styles.workList}>{data.recent_tickets.map(item => <li key={item.id}><Link className={styles.workRow} to={`/requests/${item.id}`}><span className={styles.rowBody}><strong>{item.title}</strong><span>{item.number} · {item.department?.name ?? '担当部署は未定'}</span><time dateTime={item.updated_at}>{formatDate(item.updated_at)} JST</time></span><span className={`status ${item.status}`}>{statusLabels[item.status]}</span><WorkIcon kind="arrow" /></Link></li>)}</ul> : <div className={styles.empty}><span className={styles.emptyIcon}><WorkIcon kind="inbox" /></span><h3>担当する問い合わせはありません</h3><Link to="/requests?assignee=unassigned">未割り当てを確認する →</Link></div>}
        </section>
        <section className={styles.section} aria-labelledby="drafts-heading">
          <div className={styles.sectionHeading}><div className={styles.titleWithIcon}><span className={styles.titleIcon}><WorkIcon kind="review" /></span><h2 id="drafts-heading">確認待ちの下書き</h2></div><Link to="/knowledge/reviews?status=draft">レビューへ →</Link></div>
          {data.reviews?.length ? <ul className={styles.workList}>{data.reviews.map(item => <li key={item.version_id}><Link className={styles.workRow} to={reviewUrl(item)}><span className={styles.rowBody}><strong>{item.title}</strong><span>{item.number} · 下書き v{item.version_no}</span><time dateTime={item.updated_at}>{formatDate(item.updated_at)} JST</time></span><span className="status open">未承認</span><WorkIcon kind="arrow" /></Link></li>)}</ul> : <div className={styles.empty}><span className={styles.emptyIcon}><WorkIcon kind="review" /></span><h3>確認待ちの下書きはありません</h3><Link to="/requests?status=resolved">解決記録から知識を整理する →</Link></div>}
        </section>
      </div>

      <section className={styles.knowledgeFlow} aria-labelledby="knowledge-flow-heading">
        <div className={styles.sectionHeading}><div className={styles.titleWithIcon}><span className={styles.titleIcon}><WorkIcon kind="book" /></span><h2 id="knowledge-flow-heading">解決したことを、次の質問に生かす</h2></div><Link to="/improvements"><WorkIcon kind="radar" />ナレッジ改善へ <span aria-hidden="true">→</span></Link></div>
        <ol className={styles.process}>
          <li><Link to="/requests"><span><WorkIcon kind="reply" /></span><strong>問い合わせに対応</strong></Link></li>
          <li><Link to="/requests?status=resolved"><span><WorkIcon kind="check" /></span><strong>解決記録を整理</strong></Link></li>
          <li><Link to="/knowledge/reviews"><span><WorkIcon kind="review" /></span><strong>文書を確認・承認</strong></Link></li>
          <li><Link to="/knowledge"><span><WorkIcon kind="book" /></span><strong>承認済みの知識を再利用</strong></Link></li>
        </ol>
      </section>
    </>}
  </div>
}
