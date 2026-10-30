import { useLayoutEffect, useRef, useState } from 'react'
import type { FocusEvent, ReactNode } from 'react'
import { Link, NavLink, useLocation } from 'react-router'
import type { getMockSession, MockSessionEnd } from '../lib/mockData'
import styles from './AppLayout.module.css'

type Props = {
  session: ReturnType<typeof getMockSession>
  notice: string
  onSessionEnd: (reason: MockSessionEnd) => void
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

export default function AppLayout({ session, notice, onSessionEnd, children }: Props) {
  const location = useLocation()
  const previousPath = useRef(location.pathname === '/' ? '/dashboard' : location.pathname)
  const [menuOpen, setMenuOpen] = useState(false)
  const mainRef = useRef<HTMLElement>(null)
  const user = session
  const showNavigation = !!session && !session.mustChangePassword

  useLayoutEffect(() => {
    if (location.pathname === '/') return
    setMenuOpen(false)
    const heading = mainRef.current?.querySelector('h1')
    if (previousPath.current !== location.pathname) heading?.focus()
    previousPath.current = location.pathname
    document.title = `${heading?.textContent ?? 'SolveLoop'} | SolveLoop`
  }, [location.pathname, session?.loginId, children])

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
          {user ? <><span>{user.name}<span className={styles.role}>{user.role === 'operator' ? '担当者' : '社員'}{user.canManageAccounts ? '・アカウント管理権限あり' : ''}</span></span>
          <details className={styles.demoSettings} onBlur={handleAccountBlur}>
            <summary>アカウント</summary>
            <div className={styles.settingsBody}>
              <p>ログインID：{session?.loginId}<br />このタブ内のモック状態です。</p>
              {showNavigation && <Link to="/password/change">本人のパスワードを変更</Link>}
              <button type="button" className="button" onClick={() => onSessionEnd('logout')}>ログアウト</button>
              <button type="button" className="button" onClick={() => onSessionEnd('expired')}>セッション期限切れを再現（デモ用）</button>
            </div>
          </details>
          </> : <span className={styles.role}>未ログイン（モック）</span>}
        </div>
      </header>
      <div className={styles.mockBar}>
        <p><strong>画面モック</strong> 合成データの操作はこのタブ内のみ。再読み込みで初期化されます。実際の保存・認証・権限検査・AI処理は行いません。</p>
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
            {session?.canManageAccounts && <NavLink to="/settings/accounts" onClick={closeMenu}><MenuIcon kind="accounts" />アカウント管理</NavLink>}
            <p className={styles.navNote}><span>ローカルデモ</span>すべて合成データです。</p>
          </nav>
        </div>}
        <main id="main-content" tabIndex={-1} ref={mainRef} className={styles.main}>
          {notice && <p role="status" className={styles.authNotice}>{notice}</p>}
          {children}
        </main>
      </div>
      <footer className={styles.footer}>SolveLoop · ローカル操作デモ · 操作日時は初期基準日時から1分ずつ進む合成時刻です。</footer>
    </>
  )
}
