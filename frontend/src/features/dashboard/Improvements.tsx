import { useCallback, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import Radar from './Radar'
import GuidanceHistory from '../knowledge/GuidanceHistory'
import type { Guidance } from '../../lib/guidanceState'
import { useLoad } from '../../lib/useBusiness'
import { LoadState } from '../../components/BusinessState'
import common from '../requests/Requests.module.css'

type Metrics = { total: number; states: Record<string, number>; outcomes: Record<string, number>; unconfirmed: number; median_processing_ms: number | null; tickets: number; escalated: number; first_reply_samples: number; mean_first_reply_seconds: number | null }
export default function Improvements({ onDirtyChange }: { onDirtyChange: (dirty: boolean) => void }) {
  const [selected, setSelected] = useState<{ guidance: Guidance; reason: string }>()
  const [params, setParams] = useSearchParams()
  const view = params.get('view') ?? (params.has('radar') ? 'radar' : 'unresolved')
  const [dirty, setDirty] = useState(false)
  const reportDirty = useCallback((value: boolean) => { setDirty(value); onDirtyChange(value) }, [onDirtyChange])
  const metrics = useLoad<Metrics>('/knowledge/guidance/metrics')
  return <><div className={common.heading}><div><p className="eyebrow">繰り返す質問を減らす</p><h1 tabIndex={-1}>ナレッジ改善</h1><p>未解決の質問と既存の文書を照合し、補足する内容を決めます。</p></div><Link className="button" to="/knowledge/reviews">文書レビューへ</Link></div>
    <nav className="viewSwitch" aria-label="ナレッジ改善の表示">{[['unresolved', '未解決のAI質問'], ['radar', '繰り返す問い合わせ（Radar）'], ['metrics', '利用状況']].map(([key, label]) => <button key={key} type="button" aria-pressed={view === key} disabled={dirty && view !== key} onClick={() => setParams(previous => { previous.set('view', key); return previous })}>{label}</button>)}</nav>
    {dirty && <p className={common.help}>編集中の確認記録を保存するか取り消してから表示を切り替えてください。</p>}
    <section hidden={view !== 'metrics'} className={common.section} aria-label="直近30日の利用状況・処理時間"><p className="eyebrow">直近30日の利用状況・処理時間</p><div className={common.sectionHeading}><h2>観測した件数と時間</h2><button className="button" onClick={metrics.reload}>更新</button></div>{!metrics.data ? <LoadState error={metrics.error} reload={metrics.reload} /> : <><dl className={common.metadata}><dt>AI質問</dt><dd>{metrics.data.total}件</dd><dt>解決確認</dt><dd>{metrics.data.outcomes.solved}件（本人の申告）</dd><dt>未解決</dt><dd>{metrics.data.outcomes.unresolved}件（本人の申告）</dd><dt>確認なし</dt><dd>{metrics.data.unconfirmed}件（案内完了後）</dd><dt>根拠不足</dt><dd>{metrics.data.states.insufficient_evidence}件</dd><dt>処理エラー</dt><dd>{metrics.data.states.error}件</dd><dt>AI処理時間</dt><dd>{metrics.data.median_processing_ms === null ? '未計測' : `中央値 ${(metrics.data.median_processing_ms / 1000).toFixed(1)}秒`}</dd><dt>問い合わせ</dt><dd>{metrics.data.tickets}件・うちAI案内の引き継ぎ {metrics.data.escalated}件</dd><dt>初回回答</dt><dd>{metrics.data.mean_first_reply_seconds === null ? '未計測' : `平均 ${Math.round(metrics.data.mean_first_reply_seconds)}秒（${metrics.data.first_reply_samples}件）`}</dd></dl><p className={common.help}>各項目は重複します。AIの案内成功・本人の解決申告・問い合わせ登録は別の指標です。未回答や離脱を解決に含めません。合成データを含む実測値であり、業務時間の削減効果を示すものではありません。</p></>}</section>
    <div hidden={view !== 'unresolved'}><GuidanceHistory unresolved onLoad={(guidance, reason) => { setSelected({ guidance, reason }); requestAnimationFrame(() => document.getElementById('improvement-action')?.focus()) }} />
    {selected && <section id="improvement-action" tabIndex={-1} className={common.section}><h2>文書を補足する前に確認</h2><p className={common.body}>{selected.guidance.query}</p><p className={common.body}>{selected.reason || selected.guidance.result.summary}</p><p className={common.help}>質問の情報不足か、文書の不足かを人が確認してください。技術エラーはこの候補に含めていません。</p><Link className="button" to={`/knowledge?mode=semantic&q=${encodeURIComponent(selected.guidance.query)}`}>既存の公開文書を確認</Link> <Link className="button" to="/knowledge/reviews/new">新しい下書きを作成</Link></section>}
    </div><div hidden={view !== 'radar'}><Radar onDirtyChange={reportDirty} /></div>
  </>
}
