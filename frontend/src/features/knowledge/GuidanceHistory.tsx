import { useState } from 'react'
import { api, errorMessage, isStale } from '../../lib/api'
import { formatDate } from '../../lib/business'
import { useBusinessCall, useLoad } from '../../lib/useBusiness'
import type { Guidance } from '../../lib/guidanceState'
import { LoadState } from '../../components/BusinessState'
import common from '../requests/Requests.module.css'
import { groupGuidanceSignals } from '../../lib/guidanceSignals'

export type GuidanceItem = { id: string; query: string; state: string; outcome: 'solved' | 'unresolved' | null; feedback: string | null; version: number; created_at: string; elapsed_ms: number | null; error_code: string | null; requester: { id: string; display_name: string } }
export default function GuidanceHistory({ onLoad, onRetry, unresolved = false, disabled = false }: { onLoad: (value: Guidance, reason: string) => void; onRetry?: (query: string, message: string) => void; unresolved?: boolean; disabled?: boolean }) {
  const resource = useLoad<{ items: GuidanceItem[] }>(`/knowledge/guidance/history${unresolved ? '?unresolved_only=true' : '?scope=mine'}`)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const call = useBusinessCall()
  const groups = resource.data ? (unresolved ? groupGuidanceSignals(resource.data.items).slice(0, 10) : resource.data.items.map(item => ({ item, count: 1 }))) : []
  async function open(item: GuidanceItem) {
    if (disabled || busy) return
    setBusy(true); setError('')
    try {
      const detail = await call<GuidanceItem & { response: Guidance | null; response_restricted?: boolean }>(`/knowledge/guidance/${item.id}`)
      if (detail.response) onLoad({ ...detail.response, feedback_version: detail.version, outcome: detail.outcome, feedback_allowed: detail.requester.id === api.snapshot().user?.id }, detail.feedback ?? '')
      else {
        const message = detail.response_restricted ? '根拠文書が更新・公開停止されたため、以前の案内は表示していません。質問を復元して、現在の文書で聞き直せます。' : `前回の案内は完了していません（${detail.error_code ?? '処理中・結果未確認'}）。質問を復元しました。履歴を更新するか、新しく質問できます。`
        if (onRetry) onRetry(detail.query, message)
        else setError(message)
      }
    } catch (cause) { if (!isStale(cause)) setError(errorMessage(cause)) }
    finally { setBusy(false) }
  }
  return <section className={common.nextStep} aria-label="最近のAI質問"><div className={common.sectionHeading}><h2>{unresolved ? '未解決・根拠不足の質問' : '最近のAI質問'}</h2><button className="button" disabled={busy || disabled} onClick={resource.reload}>更新</button></div><p className={common.help}>30日間保存・本人と担当者のみ閲覧。直近100件です。AIの案内と実際の解決は別に記録します。</p>
    {error && <p role="alert">{error}</p>}<details open={unresolved}><summary>{unresolved ? '質問候補（同じ表現で集計・上位10件）' : '履歴を開く'}</summary>{!resource.data ? <LoadState error={resource.error} reload={resource.reload} /> : groups.length ? <ul className={common.history}>{groups.map(({ item, count }) => <li key={item.id}><button type="button" className="button" disabled={busy || disabled} onClick={() => { void open(item) }}>{item.query}</button>{unresolved && <p className={common.help}>同じ表現 {count}件・最新の記録を表示</p>}<p className={common.help}>{formatDate(item.created_at)} JST · {item.outcome === 'solved' ? '本人が解決を確認' : item.outcome === 'unresolved' ? '未解決' : item.state === 'error' ? 'AI処理エラー' : item.state === 'processing' ? '処理中・結果未確認' : '解決確認なし'}</p></li>)}</ul> : <p>質問の記録はありません。</p>}
  </details></section>
}
