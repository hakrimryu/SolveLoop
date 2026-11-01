import { useNavigate } from 'react-router'
import type { PublishedItem } from '../lib/business'
import { prepareSearchInquiry } from '../lib/searchInquiry'
import type { SearchDocument } from '../lib/searchInquiry'
import styles from '../features/requests/Requests.module.css'

export default function SearchInquiry({ query, document, references, guidance }: { query: string; document?: PublishedItem; references?: SearchDocument[]; guidance?: { id: string; reason?: string } }) {
  const navigate = useNavigate()
  function start() {
    const searchInquiryId = prepareSearchInquiry(query, document ? {
      number: document.number, title: document.title, version_no: document.version_no,
      url: new URL(`/knowledge/${document.document_id}`, window.location.origin).href,
    } : references, guidance)
    navigate('/my/requests?new=1', { state: { searchInquiryId } })
  }
  return <div className={styles.nextStep}>
    <p>{guidance ? '質問・AIの案内・根拠を担当者に引き継ぎます。登録した案内は問い合わせの記録として残ります。' : document ? '質問とこの文書を担当者に引き継ぎます。' : '解決しない場合は、入力した内容を担当者に相談できます。'}内容を確認して「登録」を押すまで送信されません。</p>
    <button type="button" className={guidance ? "button buttonPrimary" : "button"} onClick={start}>担当者に問い合わせ</button>
  </div>
}
