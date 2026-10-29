import { useState } from 'react'
import { Link } from 'react-router'
import { demoUsers } from '../../lib/mockData'
import type { DemoRole } from '../../lib/mockData'
import common from '../requests/Requests.module.css'
import styles from './Knowledge.module.css'

export default function DemoLogin({ role, onRoleChange }: { role: DemoRole; onRoleChange: (role: DemoRole) => void }) {
  const [selected, setSelected] = useState(role)
  const [applied, setApplied] = useState(false)
  return <div className={styles.login}><p className="eyebrow">ログイン補助 · ローカルの画面モック</p><h1 tabIndex={-1}>デモアカウントを選択</h1>
    <p className="muted">実際のログイン・セッション作成・パスワード検証は行いません。ヘッダーの「デモ設定」と同じ役割を切り替えます。</p>
    <form className={`${common.section} ${styles.historySection}`} onSubmit={e => { e.preventDefault(); onRoleChange(selected); setApplied(true) }}>
      <fieldset><legend>表示するデモアカウント</legend>{(['operator', 'employee'] as const).map(value => <label key={value} className={styles.account}><input type="radio" name="account" value={value} checked={selected === value} onChange={() => { setSelected(value); setApplied(false) }} /><span><strong>{demoUsers[value].name}（{demoUsers[value].roleLabel}）</strong><small>{value === 'operator' ? '全問い合わせの対応、下書きの作成・レビュー・承認' : '自分の問い合わせ、承認済みナレッジの検索'}</small></span></label>)}</fieldset>
      <button className="button buttonPrimary">選択した役割を表示</button><p className={common.help}>現在：{demoUsers[role].name}（{demoUsers[role].roleLabel}）。操作結果はタブ内のみで、再読み込みすると担当者に戻ります。</p>
      {applied && <p className={common.success} role="status">表示する役割を反映しました。</p>}<Link className={common.back} to="/dashboard">ダッシュボードへ進む →</Link>
    </form>
  </div>
}
