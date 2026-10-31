import { useLayoutEffect, useRef, useState } from 'react'
import type { FocusEvent, ReactNode } from 'react'
import { Link, NavLink, useLocation } from 'react-router'
import type { User } from '../lib/api'
import styles from './AppLayout.module.css'

type Props = {
  session: User | null
  notice: string
  onSessionEnd: () => void
  busy?: boolean
  unverified?: boolean
  children: ReactNode
}

function MenuIcon({ kind }: { kind: 'dashboard' | 'requests' | 'knowledge' | 'review' | 'accounts' }) {
  const paths = {
    dashboard: 'M3 3h6v6H3z M13 3h6v6h-6z M3 13h6v6H3z M13 13h6v6h-6z',
    requests: 'M4 4h14v14H4z M4 12h4l2 3h2l2-3h4 M8 8h6',
    knowledge: 'M11 5C8 3 5 3 2 4v14c3-1 6-1 9 1m0-14c3-2 6-2 9-1v14c-3-1-6-1-9 1V5z',
    review: 'M7 4H4v15h14V4h-3 M8 2h6v4H8z M7 12l3 3 5-6',
    accounts: 'M14 7a3 3 0 1 1-6 0 3 3 0 0 1 6 0 M5 19v-3a6 6 0 0 1 12 0v3z',
  }
  return (
    <svg aria-hidden="true" focusable="false" viewBox="0 0 22 22" className={styles.menuIcon}>
      <path d={paths[kind]} />
    </svg>
  )
}

export default function AppLayout({ session, notice, onSessionEnd, busy, unverified, children }: Props) {
  const location = useLocation()
  const previousPath = useRef(location.pathname === '/' ? '/dashboard' : location.pathname)
  const [menuOpen, setMenuOpen] = useState(false)
  const mainRef = useRef<HTMLElement>(null)
  const user = session
  const showNavigation = !!session && !session.must_change_password

  useLayoutEffect(() => {
    if (location.pathname === '/') return
    const heading = mainRef.current?.querySelector('h1')
    if (previousPath.current !== location.pathname) {
      setMenuOpen(false)
      heading?.focus()
    }
    previousPath.current = location.pathname
    document.title = `${heading?.textContent ?? 'SolveLoop'} | SolveLoop`
  }, [location.pathname, session?.id, children])

  function closeMenu() {
    setMenuOpen(false)
  }

  function handleAccountBlur(event: FocusEvent<HTMLDetailsElement>) {
    if (event.relatedTarget instanceof HTMLElement && event.relatedTarget.closest('dialog')) return
    if (!event.currentTarget.contains(event.relatedTarget)) {
      event.currentTarget.open = false
    }
  }

  return (
    <>
      <a className={styles.skipLink} href="#main-content">本文へ移動</a>
      <header className={styles.header}>
        <Link to={showNavigation ? '/dashboard' : session ? '/password/change' : '/login'} className={styles.brand}>
          <span className={styles.brandMark} aria-hidden="true">S</span>
          <span className={styles.brandText}>SolveLoop<small>株式会社 柳</small></span>
        </Link>
        <span className={styles.demoLabel}>架空企業・デモデータ</span>
        <div className={styles.account}>
          {user ? <><span>{user.display_name}<span className={styles.role}>{user.role === 'operator' ? '担当者' : '社員'}{user.can_manage_accounts ? '・アカウント管理権限あり' : ''}</span></span>
          <details className={styles.demoSettings} onBlur={handleAccountBlur}>
            <summary>アカウント</summary>
            <div className={styles.settingsBody}>
              <p>サーバーで認証されたアカウントです。</p>
              {showNavigation && <Link to="/password/change">本人のパスワードを変更</Link>}
              <button type="button" className="button" disabled={busy} onClick={onSessionEnd}>ログアウト</button>
            </div>
          </details>
          </> : <span className={styles.role}>{unverified ? '接続状態は未確認' : '未ログイン'}</span>}
        </div>
      </header>
      <div className={styles.mockBar}>
          <p><strong>問い合わせ・ナレッジは実API・DBに保存</strong> 架空企業のローカルデモです。公開されるのは人が承認した版だけです。意味検索・部署分類・回答案・解決記録からの下書き・RadarはローカルAIを使用します。AI案と文書対応判定は人による確認が必要です。</p>
      </div>
      <div className={showNavigation ? styles.workspace : styles.authWorkspace}>
        {showNavigation && <div className={styles.navigation}>
          <button
            className={styles.menuToggle}
            type="button"
            aria-expanded={menuOpen}
            aria-controls="main-navigation"
            onClick={() => setMenuOpen(!menuOpen)}
          >
            メニュー {menuOpen ? 'を閉じる' : 'を開く'}
          </button>
          <nav
            id="main-navigation"
            aria-label="メインメニュー"
            className={menuOpen ? styles.menuOpen : styles.menu}
          >
            <p className={styles.navLabel}>業務メニュー</p>
            <NavLink to="/dashboard" onClick={closeMenu}>
              <MenuIcon kind="dashboard" />ダッシュボード
            </NavLink>
            <NavLink to="/requests" onClick={closeMenu}>
              <MenuIcon kind="requests" />問い合わせ
            </NavLink>
            <NavLink
              to="/knowledge"
              end={location.pathname.startsWith('/knowledge/reviews')}
              onClick={closeMenu}
            >
              <MenuIcon kind="knowledge" />ナレッジ
            </NavLink>
            {session?.role === 'operator' && (
              <NavLink to="/knowledge/reviews" onClick={closeMenu}>
                <MenuIcon kind="review" />ナレッジレビュー
              </NavLink>
            )}
            {session?.can_manage_accounts && <NavLink to="/settings/accounts" onClick={closeMenu}><MenuIcon kind="accounts" />アカウント管理</NavLink>}
            <p className={styles.navNote}><span>ローカルデモ</span>業務操作はDBに保存されます。</p>
          </nav>
        </div>}
        <main id="main-content" tabIndex={-1} ref={mainRef} className={styles.main}>
          {notice && <p role="status" className={styles.authNotice}>{notice}</p>}
          {children}
        </main>
      </div>
      <footer className={styles.footer}>SolveLoop · 架空企業のローカルデモ · サーバー時刻で記録 · AI案・Radarの文書対応判定は人による確認が必要です。</footer>
    </>
  )
}
