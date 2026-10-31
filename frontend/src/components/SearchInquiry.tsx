import { useNavigate } from 'react-router'
import type { PublishedItem } from '../lib/business'
import { prepareSearchInquiry } from '../lib/searchInquiry'
import type { SearchDocument } from '../lib/searchInquiry'
import styles from '../features/requests/Requests.module.css'

export default function SearchInquiry({ query, document, references }: { query: string; document?: PublishedItem; references?: SearchDocument[] }) {
  const navigate = useNavigate()
  function start() {
    const searchInquiryId = prepareSearchInquiry(query, document ? {
      number: document.number, title: document.title, version_no: document.version_no,
      url: new URL(`/knowledge/${document.document_id}`, window.location.origin).href,
    } : references)
    navigate('/requests?new=1', { state: { searchInquiryId } })
  }
  return <div className={styles.nextStep}>
    <p>{document ? 'この文書で解決しない場合は、検索内容とこの文書の番号・件名・版を問い合わせへ引き継げます。' : references?.length ? '質問と参考に表示した公開文書を問い合わせへ引き継げます。AIの案内は解決の確定ではありません。' : '検索やAI案内で解決しない場合や利用できない場合は、入力した内容から問い合わせを作成できます。'}内容を確認・編集して「登録」を押すまで送信されません。</p>
    <button type="button" className="button" onClick={start}>担当者に問い合わせ</button>
  </div>
}
