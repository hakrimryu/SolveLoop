import type { Department, Role } from './api'

export type UserRef = { id: string; display_name: string }
export type Status = 'open' | 'in_progress' | 'resolved'
export const statusLabels: Record<Status, string> = { open: '未対応', in_progress: '対応中', resolved: '解決済み' }
export const knowledgeLabels = { draft: '下書き', approved: '承認済み', rejected: '差し戻し' }
export const formatDate = (value: string) => new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(value))
export type Page<T> = { items: T[]; page: number; page_size: number; page_count: number; filtered_count: number; visible_total: number; sort: string; as_of: string }
export type TicketItem = { id: string; number: string; title: string; status: Status; department: Department | null; assignee: UserRef | null; requester?: UserRef; created_at: string; updated_at: string }
export type BusinessEvent = { id: string; event_type: string; actor: UserRef; occurred_at: string; payload: Record<string, unknown>; version_no?: number; row_version?: number }
export type Ticket = TicketItem & { requester: UserRef; body: string; resolution: string | null; resolved_at: string | null; version: number; events: BusinessEvent[] }
export type PublishedItem = { document_id: string; number: string; publication_suspended: boolean; version_no: number; title: string; audience: string; department: Department | null; updated_at: string; approved_at: string }
export type Published = PublishedItem & { body: string }
export type SemanticItem = PublishedItem & { version_id: string; chunk_id: string; ordinal: number; text: string; context: string; body_start: number; body_end: number; line_start: number; line_end: number; content_hash: string; chunk_hash: string; cosine_distance: number }
export type SemanticResult = { items: SemanticItem[]; top_k: number; profile_id: string; as_of: string }
export type ReviewItem = Omit<PublishedItem, 'approved_at'> & { version_id: string; status: 'draft' | 'approved' | 'rejected'; row_version: number }
export type Source = { ticket_id: string; ticket_number: string; ticket_version: number; title: string; body: string; resolution: string; department: Department | null; resolved_at: string; updated_at: string; content_hash: string }
export type SourceRef = { ticket_id: string; expected_ticket_version: number }
export type SourceIssue = { ticket_id: string; code: 'SOURCE_CHANGED' | 'SOURCE_NOT_RESOLVED'; expected_ticket_version: number; current_ticket_version: number | null }
export type Review = ReviewItem & { body: string; document_row_version: number; latest_version_no: number; draft_version_no: number | null; published_version_no: number | null; base_version_no: number | null; created_by: UserRef; created_at: string; reviewed_by: UserRef | null; reviewed_at: string | null; sources: Source[]; source_issues: SourceIssue[]; events: BusinessEvent[]; search_preparation: { status: 'ready' | 'required'; profile_id: string | null; chunk_count: number } }
export type KnowledgeInput = { title: string; audience: string; body: string; department_id: string | null }
export type DashboardData = { as_of: string; total: number; counts: Record<Status, number>; recent_tickets: TicketItem[]; unassigned_count?: number; own_unresolved_count?: number; review_pending_count?: number; reviews?: ReviewItem[] }
export type BusinessProps = { role: Role; departments: Department[]; onDirtyChange: (dirty: boolean) => void }
export const reviewUrl = (item: { document_id: string; version_no: number }) => `/knowledge/reviews/${item.document_id}/versions/${item.version_no}`
export const reviewApi = (item: { document_id: string; version_no: number }) => `/knowledge/${item.document_id}/versions/${item.version_no}`
export const normalizeInput = (value: string) => value.replace(/\r\n/g, '\n').trim()
export function validateText(value: string, max: number) { const size = [...normalizeInput(value)].length; return size < 1 || size > max ? `1〜${max}文字で入力してください。` : '' }
export function validateKnowledge(input: KnowledgeInput) { return { title: validateText(input.title, 120), audience: validateText(input.audience, 300), body: validateText(input.body, 20000) } }
// 画面専用の状態をAPIへ送らず、契約で許可した検索条件だけを組み立てる。
// [ko] 화면 전용 상태를 API로 보내지 않고 계약에서 허용한 검색 조건만 구성한다.
// [en] Send only allowed query fields; keep screen-only state out of API requests.
export function apiQuery(params: URLSearchParams, allowed: string[]) { const result = new URLSearchParams(); for (const key of allowed) if (params.has(key)) result.set(key, params.get(key)!); return result.toString() }

export function eventText(event: BusinessEvent) {
  const labels: Record<string, string> = { created: '問い合わせを登録', body_updated: '問い合わせ内容を変更', assignment_changed: '担当部署・担当者を変更', started: '対応を開始', resolved: '解決内容を記録して解決', reopened: '問い合わせを再開', draft_created: '下書きを作成', saved: '下書きを保存', sources_refreshed: '根拠を再確認して保存', approved: '承認', publication_stopped: '公開を停止', publication_resumed: '再公開', rejected: '理由を記録して差し戻し' }
  const p = event.payload
  if (p.generation) {
    const generation = p.generation as { model: string; prompt_version: string; generation_id: string; edited: boolean }
    return `${labels[event.event_type]}：ローカルAI案を人が確認して保存${generation.edited ? '（生成後に編集あり）' : ''}\n${generation.model} / ${generation.prompt_version} / 生成ID ${generation.generation_id}`
  }
  if (event.event_type === 'assignment_changed') {
    const before = p.before as { department?: Department; assignee?: UserRef }
    const after = p.after as { department?: Department; assignee?: UserRef }
    return `${labels[event.event_type]}：${before.department?.name ?? '未定'} / ${before.assignee?.display_name ?? '未割り当て'} → ${after.department?.name ?? '未定'} / ${after.assignee?.display_name ?? '未割り当て'}`
  }
  return `${labels[event.event_type] ?? event.event_type}${p.reason ? `：${p.reason}` : ''}${p.resolution ? `\n${p.resolution}` : ''}${p.previous_resolution ? `\n前回の解決内容：${p.previous_resolution}` : ''}`
}
