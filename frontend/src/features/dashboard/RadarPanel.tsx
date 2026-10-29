import { useEffect, useRef } from 'react'
import type { KeyboardEvent } from 'react'
import { Link } from 'react-router'
import { demoAsOf, formatDemoDate, radarPeriodStart, statusLabels } from '../../lib/mockData'
import type { DashboardData } from '../../lib/mockData'
import styles from './RadarPanel.module.css'

type Props = {
  candidate: NonNullable<DashboardData['radar']>
  onClose: () => void
}

export default function RadarPanel({ candidate, onClose }: Props) {
  const headingRef = useRef<HTMLHeadingElement>(null)

  useEffect(() => {
    headingRef.current?.focus()
  }, [])

  function handleKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key === 'Escape') {
      event.stopPropagation()
      onClose()
    }
  }

  return (
    <aside
      id="radar-panel"
      className={styles.panel}
      aria-labelledby="radar-panel-title"
      onKeyDown={handleKeyDown}
    >
      <div className={styles.topLine}>
        <span className="sampleLabel">Radar・分析結果のサンプル</span>
        <button className="button" type="button" onClick={onClose}>閉じる</button>
      </div>
      <h2 id="radar-panel-title" tabIndex={-1} ref={headingRef}>{candidate.title}</h2>
      <p className="muted">候補の根拠を確認します。問い合わせの状態や文書の公開状態は変更しません。</p>
      <dl className={styles.metadata}>
        <dt>分析基準日時</dt>
        <dd><time dateTime={demoAsOf}>{formatDemoDate(demoAsOf)} JST</time></dd>
        <dt>分析対象期間</dt>
        <dd>{formatDemoDate(radarPeriodStart)} 〜 {formatDemoDate(demoAsOf)} JST</dd>
        <dt>繰り返し件数</dt>
        <dd>{candidate.requests.length}件（重複候補に含まれる可能性があります）</dd>
      </dl>
      <section className={styles.section}>
        <h3>文書の対応状況</h3>
        <ul className={styles.coverage}>
          <li>対応文書あり <strong>{candidate.coverageCounts.covered}件</strong></li>
          <li>対応文書なし <strong>{candidate.coverageCounts.uncovered}件</strong></li>
          <li>未判定 <strong>{candidate.coverageCounts.unknown}件</strong></li>
        </ul>
        <p className="muted">表示確認用の判定です。未判定を「文書なし」に含めません。</p>
        <h3>確認した承認済み文書</h3>
        <Link to={`/knowledge/${candidate.document.id}`}>
          {candidate.document.title} v{candidate.document.version}
        </Link>
        <p>{candidate.reason}</p>
      </section>
      <section className={styles.section}>
        <h3>根拠となる問い合わせ</h3>
        <p className="muted">解決済みの問い合わせから、元の解決記録を確認する流れです。</p>
        <ul className={styles.requests}>
          {candidate.requests.map(request => (
            <li key={request.id}>
              <span className={`status ${request.status}`}>{statusLabels[request.status]}</span>
              <Link to={`/requests/${request.id}`}>{request.id} · {request.title}</Link>
            </li>
          ))}
        </ul>
      </section>
      <p className="muted">承認後の変化は再分析で確認します。このモックでは分析・下書き作成は行いません。</p>
    </aside>
  )
}
