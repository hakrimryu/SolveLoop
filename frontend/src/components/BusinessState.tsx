import type { Page } from '../lib/business'
import styles from '../features/requests/Requests.module.css'

export function LoadState({ error, reload }: { error?: string; reload: () => void }) {
  return <div className="notice" aria-busy={!error}>{error ? <><p role="alert">{error}</p><button className="button" onClick={reload}>再試行</button></> : <p role="status">読み込み中…</p>}</div>
}

export function Pagination({ data, onPage }: { data: Page<unknown>; onPage: (page: number) => void }) {
  return <nav className={styles.pagination} aria-label="一覧のページ"><span>{data.filtered_count ? (data.page - 1) * data.page_size + 1 : 0}–{Math.min(data.page * data.page_size, data.filtered_count)} / {data.filtered_count}件</span><button className="button" disabled={data.page === 1} onClick={() => onPage(data.page - 1)}>前へ</button><span>{data.page} / {data.page_count}ページ</span><button className="button" disabled={data.page === data.page_count} onClick={() => onPage(data.page + 1)}>次へ</button></nav>
}
