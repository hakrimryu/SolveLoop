import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { LoadState } from '../../components/BusinessState'
import { api, errorMessage, isStale } from '../../lib/api'
import type { User } from '../../lib/api'
import { formatDate, statusLabels } from '../../lib/business'
import type { Page, TicketItem } from '../../lib/business'
import { readGuidance, retainGuidance } from '../../lib/guidanceState'
import type { Guidance } from '../../lib/guidanceState'
import { useBusinessCall, useLoad } from '../../lib/useBusiness'
import styles from './EmployeeHome.module.css'

function HomeIcon({ kind }: { kind: 'ask' | 'book' | 'check' | 'inbox' | 'person' | 'arrow' }) {
  const paths = {
    ask: 'M4 3h16v12H9l-5 5V3z M8 7h8 M8 11h5',
    book: 'M12 5C9 3 6 3 3 4v15c3-1 6-1 9 1m0-15c3-2 6-2 9-1v15c-3-1-6-1-9 1V5z',
    check: 'M5 12l4 4L19 6',
    inbox: 'M4 4h16v16H4z M4 13h5l1 3h4l1-3h5 M8 8h8',
    person: 'M15 7a3 3 0 1 1-6 0 3 3 0 0 1 6 0 M5 21v-3a7 7 0 0 1 14 0v3',
    arrow: 'M5 12h14 M14 7l5 5-5 5',
  }
  return <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" className={styles.icon}><path d={paths[kind]} /></svg>
}

function TicketRow({ item, attention = false }: { item: TicketItem; attention?: boolean }) {
  return <li><Link to={`/my/requests/${item.id}`} className={styles.ticketRow}>
    <span className={`${styles.ticketIcon} ${attention ? styles.attentionIcon : ''}`}><HomeIcon kind={attention ? 'ask' : 'inbox'} /></span>
    <span className={styles.ticketBody}>
      <span className={styles.ticketTitle}>{item.title}</span>
      <span className={styles.ticketMeta}><span>{item.number}</span><span>{item.department?.name ?? '担当部署は未定'}</span><time dateTime={item.updated_at}>{formatDate(item.updated_at)} JST</time></span>
    </span>
    <span className={styles.ticketState}>
      <span className={`status ${item.status}`}>{statusLabels[item.status]}</span>
      {!!item.unread_count && <span className={styles.unread}>未読の回答 {item.unread_count}件</span>}
      {item.next_action === 'requester' && <span className={styles.actionNeeded}>確認・追加情報が必要</span>}
    </span>
    <span className={styles.rowArrow}><HomeIcon kind="arrow" /></span>
  </Link></li>
}

export default function EmployeeHome({ user }: { user: User }) {
  const recent = useLoad<Page<TicketItem>>('/tickets?scope=mine&page_size=5&sort=updated_at_desc')
  const unread = useLoad<Page<TicketItem>>('/tickets?scope=mine&queue=unread&page_size=5&sort=updated_at_desc')
  const waiting = useLoad<Page<TicketItem>>('/tickets?scope=mine&queue=waiting_requester&page_size=5&sort=updated_at_desc')
  const attentionItems = Array.from(new Map([...(unread.data?.items ?? []), ...(waiting.data?.items ?? [])].map(item => [item.id, item])).values())
    .sort((a, b) => Number(!!b.unread_count) - Number(!!a.unread_count) || b.updated_at.localeCompare(a.updated_at)).slice(0, 5)
  const showAttention = !unread.data || !waiting.data || !!unread.data.filtered_count || !!waiting.data.filtered_count
  const [query, setQuery] = useState(() => { const draft = readGuidance(); return draft.editing ? draft.query : '' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const pending = useRef<AbortController | null>(null)
  const generation = useRef(api.snapshot().identityGeneration).current
  const call = useBusinessCall()
  const navigate = useNavigate()
  useEffect(() => {
    setBusy(false)
    return () => { pending.current?.abort(); pending.current = null }
  }, [])

  async function ask() {
    if (pending.current || !query.trim()) return
    const controller = new AbortController()
    pending.current = controller
    setBusy(true); setError('')
    try {
      const result = await call<Guidance>('/knowledge/guidance', { query: query.trim() }, { signal: controller.signal })
      if (controller.signal.aborted || pending.current !== controller) return
      retainGuidance(generation, { query: query.trim(), result, editing: false })
      navigate('/ask')
    } catch (cause) {
      if (!controller.signal.aborted && !isStale(cause)) setError(errorMessage(cause))
    } finally {
      if (pending.current === controller) { pending.current = null; setBusy(false) }
    }
  }

  function stopReceiving() {
    pending.current?.abort(); pending.current = null; setBusy(false)
    setError('結果の受信を中止しました。処理が続いている場合は「AIに質問」の履歴で確認できます。')
  }

  return <div className={styles.home}>
    <div className={styles.heading}><div><p className="eyebrow">社員のワークスペース</p><h1 tabIndex={-1}>ホーム</h1></div><p className={styles.greeting}>{user.display_name}さん、お疲れさまです。</p></div>

    <section className={styles.questionPanel} aria-labelledby="home-question-heading">
      <div className={styles.questionMain}>
        <div className={styles.sectionTitle}><span className={styles.sectionIcon}><HomeIcon kind="ask" /></span><div><h2 id="home-question-heading">何かお困りですか？</h2><p>承認済みの社内文書から、解決方法を確認します。</p></div></div>
        <form onSubmit={event => { event.preventDefault(); void ask() }} onKeyDown={event => { if (event.key === 'Enter' && event.nativeEvent.isComposing) event.preventDefault() }} aria-busy={busy}>
          <label className="srOnly" htmlFor="home-question">質問・困っていること</label>
          <textarea id="home-question" value={query} onChange={event => { setQuery(event.target.value); setError('') }} maxLength={500} required rows={3} disabled={busy} aria-describedby="home-question-hint home-question-privacy" placeholder="例：社用携帯を交換した後、認証アプリでログインできません。" />
          <div className={styles.formFooter}><p id="home-question-hint">500文字まで · パスワードは入力しないでください。</p><button className="button buttonPrimary" disabled={busy || !query.trim()}><HomeIcon kind="ask" />{busy ? '社内文書を確認中…' : 'AIに質問する'}<HomeIcon kind="arrow" /></button></div>
          <p id="home-question-privacy" className={styles.privacy}>質問と案内は30日間保存され、本人と担当者が確認できます。</p>
          {busy && <div className={styles.pending}><p role="status">案内を作成しています。混雑時は順番を待つ場合があります。</p><button className="button" type="button" onClick={stopReceiving}>受信を中止</button></div>}
          {error && <p role="alert" className={styles.error}>{error}</p>}
        </form>
      </div>
      <aside className={styles.guide} aria-label="質問から解決までの流れ">
        <p className={styles.guideLabel}>解決までの流れ</p>
        <ol className={styles.flow}>
          <li><span className={styles.flowNode}><HomeIcon kind="ask" /></span><span><strong>質問する</strong><small>状況や困りごとを入力</small></span></li>
          <li><span className={styles.flowNode}><HomeIcon kind="book" /></span><span><strong>AIの案内を確認</strong><small>根拠の社内文書も読めます</small></span></li>
          <li><span className={`${styles.flowNode} ${styles.flowEnd}`}><HomeIcon kind="check" /></span><span><strong>解決できたか確認</strong><small>結果を自分で記録</small></span></li>
        </ol>
        <div className={styles.handoff}><HomeIcon kind="person" /><span>解決しないときは<br /><strong>担当者へ引き継ぎ</strong></span><HomeIcon kind="arrow" /></div>
      </aside>
      <nav className={styles.shortcuts} aria-label="ほかの相談方法">
        <Link to="/knowledge"><span className={styles.shortcutIcon}><HomeIcon kind="book" /></span><span><strong>社内文書を探す</strong><small>手順やルールを自分で確認</small></span><HomeIcon kind="arrow" /></Link>
        <Link to="/my/requests?new=1"><span className={styles.shortcutIcon}><HomeIcon kind="person" /></span><span><strong>担当者に直接問い合わせ</strong><small>急ぎの相談や個別の判断はこちら</small></span><HomeIcon kind="arrow" /></Link>
      </nav>
    </section>

    {showAttention && <section className={`${styles.section} ${styles.attention}`} aria-labelledby="attention-heading">
      <div className={styles.listHeading}><div className={styles.sectionTitle}><span className={`${styles.sectionIcon} ${styles.attentionIcon}`}><HomeIcon kind="ask" /></span><h2 id="attention-heading">確認が必要な問い合わせ</h2></div><button className="button" onClick={() => { unread.reload(); waiting.reload() }}>更新</button></div>
      <nav className={styles.attentionFilters} aria-label="確認する問い合わせの種類">
        <Link to="/my/requests?queue=unread">未読の回答<span>{unread.data ? `${unread.data.filtered_count}件` : unread.error ? '取得失敗' : '確認中'}</span></Link>
        <Link to="/my/requests?queue=waiting_requester">確認・追加情報待ち<span>{waiting.data ? `${waiting.data.filtered_count}件` : waiting.error ? '取得失敗' : '確認中'}</span></Link>
      </nav>
      {!unread.data && <div className={styles.loadState}><p>未読の回答</p><LoadState error={unread.error} reload={unread.reload} /></div>}
      {!waiting.data && <div className={styles.loadState}><p>確認・追加情報待ち</p><LoadState error={waiting.error} reload={waiting.reload} /></div>}
      <ul className={styles.ticketList}>{attentionItems.map(item => <TicketRow key={item.id} item={item} attention />)}</ul>
      {attentionItems.length > 0 && <p className={styles.listNote}>未読の回答を優先して最大5件を表示しています。</p>}
    </section>}

    <section className={styles.section} aria-labelledby="recent-tickets-heading">
      <div className={styles.listHeading}><div className={styles.sectionTitle}><span className={styles.sectionIcon}><HomeIcon kind="inbox" /></span><h2 id="recent-tickets-heading">最近の自分の問い合わせ</h2></div><div className={styles.listActions}><button className="button" onClick={recent.reload}>更新</button><Link to="/my/requests">すべて見る <span aria-hidden="true">→</span></Link></div></div>
      {!recent.data ? <LoadState error={recent.error} reload={recent.reload} /> : recent.data.items.length ? <ul className={styles.ticketList}>{recent.data.items.map(item => <TicketRow key={item.id} item={item} />)}</ul> : <div className={styles.empty}><span className={styles.emptyIcon}><HomeIcon kind="inbox" /></span><h3>問い合わせはまだありません</h3><p>困ったときは、上の入力欄から質問してみてください。</p><Link to="/knowledge">社内文書から探す <span aria-hidden="true">→</span></Link></div>}
    </section>
  </div>
}
