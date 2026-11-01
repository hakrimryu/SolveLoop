import { useEffect, useRef, useState } from 'react'
import { ApiError, errorMessage, isStale } from '../../lib/api'
import type { Ticket } from '../../lib/business'
import { formatDate, validateText } from '../../lib/business'
import { useBusinessCall } from '../../lib/useBusiness'
import styles from './Requests.module.css'

export default function RequestConversation({ ticket, operator, personal = false, proposal, disabled, onSaved, onDirtyChange }: { ticket: Ticket; operator: boolean; personal?: boolean; proposal?: { text: string; sequence: number }; disabled: boolean; onSaved: (ticket: Ticket) => void; onDirtyChange: (dirty: boolean) => void }) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [uncertain, setUncertain] = useState(false)
  const [candidate, setCandidate] = useState<string>()
  const [notice, setNotice] = useState('')
  const frozen = useRef<{ body: string; expected_version: number; key: string } | null>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const conversationRef = useRef<HTMLElement>(null)
  const call = useBusinessCall()
  const detailApi = `/tickets/${ticket.id}${personal ? '?scope=mine' : ''}`
  useEffect(() => { onDirtyChange(!!text || uncertain); return () => onDirtyChange(false) }, [text, uncertain, onDirtyChange])
  useEffect(() => { if (proposal) setCandidate(proposal.text) }, [proposal])
  const lastVersion = ticket.messages?.at(-1)?.ticket_version
  useEffect(() => {
    if (!lastVersion || !ticket.unread_count || !conversationRef.current) return
    let reading = false
    const observer = new IntersectionObserver(entries => {
      if (!entries.some(entry => entry.isIntersecting) || reading) return
      reading = true
      void call(`/tickets/${ticket.id}/read`, { message_version: lastVersion }).then(() => observer.disconnect()).catch(cause => { reading = false; if (!isStale(cause)) setError(errorMessage(cause)) })
    })
    observer.observe(conversationRef.current)
    return () => observer.disconnect()
  }, [ticket.id, lastVersion, ticket.unread_count, call])
  async function send() {
    if (busy || disabled) return
    if (!uncertain && validateText(text, 5000)) { setError('回答を1〜5000文字で入力してください。'); inputRef.current?.focus(); return }
    const input = uncertain ? frozen.current! : { body: text, expected_version: ticket.version, key: crypto.randomUUID() }
    frozen.current = input
    setBusy(true); setError(''); setNotice('')
    try {
      const result = await call<Ticket>(`/tickets/${ticket.id}/messages`, { body: input.body, expected_version: input.expected_version }, { idempotencyKey: input.key })
      setText(''); setUncertain(false); frozen.current = null; onSaved(result); setNotice('回答を送信しました。解決処理は行っていません。')
      try { onSaved(await call<Ticket>(detailApi)) }
      catch (cause) { if (!isStale(cause)) setError(`送信は完了しました。最新状態の再取得に失敗しました。${errorMessage(cause)}`) }
    } catch (cause) { if (!isStale(cause)) { setError(errorMessage(cause, true)); setUncertain(!(cause instanceof ApiError) || cause.status >= 500) } }
    finally { setBusy(false) }
  }
  async function refresh() {
    setBusy(true); setError('')
    try { onSaved(await call<Ticket>(detailApi)); setNotice('最新の回答を取得しました。入力は保持しています。') }
    catch (cause) { if (!isStale(cause)) setError(errorMessage(cause)) }
    finally { setBusy(false) }
  }
  return <section ref={conversationRef} className={styles.section} aria-labelledby="conversation-heading"><div className={styles.sectionHeading}><h2 id="conversation-heading">回答・追加の確認</h2><button className="button" disabled={busy || disabled} onClick={() => { void refresh() }}>最新の回答を確認</button></div><p className={styles.help}>{ticket.status === 'resolved' ? '解決済みです。追加の対応は担当者による再開後に行えます。' : ticket.next_action === 'requester' ? '社員の確認・追加情報を待っています。' : '担当者の回答を待っています。'} 回答は申請者と担当者が閲覧できます。</p>
    <ol className={styles.history}>{ticket.messages?.map(message => <li key={message.id}><div><strong>{message.actor.display_name}</strong><span>{message.actor_role === 'operator' ? '担当者' : '申請者'}</span><time dateTime={message.created_at}>{formatDate(message.created_at)} JST</time></div><p className={styles.body}>{message.body}</p></li>)}</ol>
    {!ticket.messages?.length && <p className={styles.help}>回答はまだありません。</p>}{notice && <p role="status">{notice}</p>}{error && <p role="alert" className={styles.errorBanner}>{error}</p>}
    {candidate !== undefined && <div className="notice"><p>AI案を回答欄に反映します。入力済みの文章がある場合は置き換わります。送信前に根拠と公開してよい内容を確認してください。</p><button className="button" disabled={busy || uncertain || disabled} onClick={() => { setText(candidate); setCandidate(undefined); inputRef.current?.focus() }}>確認して回答欄に反映</button><button className="button" onClick={() => setCandidate(undefined)}>反映しない</button></div>}
    {ticket.status !== 'resolved' && <form onSubmit={event => { event.preventDefault(); if (!uncertain) void send() }} onKeyDown={event => { if (event.key === 'Enter' && event.nativeEvent.isComposing) event.preventDefault() }}><label className={styles.field}>{operator ? '社員への回答・確認したいこと' : '担当者への追加情報・質問'}<textarea ref={inputRef} value={text} maxLength={5000} disabled={busy || uncertain || disabled} onChange={event => setText(event.target.value)} /></label><p className={styles.help}>送信する内容を確認してください。送信だけで問い合わせを解決済みにはしません。</p>{uncertain ? <div className="notice"><p>入力と送信キーを保持しています。上の履歴で結果を確認し、必要なら同じ内容で再送してください。送信済みなら重複せず同じ結果を取得します。</p><button type="button" className="button" disabled={busy || disabled} onClick={() => { void send() }}>確認済み・同じ送信の結果を取得</button></div> : <div className={styles.actions}><button className="button buttonPrimary" disabled={busy || disabled || !text.trim()}>{busy ? '送信中…' : '内容を確認して送信'}</button></div>}</form>}
  </section>
}
