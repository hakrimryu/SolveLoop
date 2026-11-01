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

function MenuIcon({ kind }: { kind: 'home' | 'dashboard' | 'requests' | 'knowledge' | 'review' | 'accounts' | 'ask' | 'radar' }) {
  const paths = {
    home: 'M2 10l9-8 9 8 M4 8v12h5v-7h4v7h5V8',
    ask: 'M4 3h14v12H9l-5 4V3z M8 7h6 M8 11h4',
    radar: 'M11 2a9 9 0 1 0 9 9 M11 6a5 5 0 1 0 5 5 M11 11l7-7 M15 3h4v4',
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

  const home = showNavigation ? '/home' : session ? '/password/change' : '/login'
  const section = location.pathname === '/home' ? 'ホーム'
    : location.pathname.startsWith('/knowledge/reviews') ? '文書レビュー'
    : location.pathname.startsWith('/knowledge') ? '社内文書'
    : location.pathname.startsWith('/my/requests') ? '自分の問い合わせ'
    : location.pathname.startsWith('/requests') ? session?.role === 'operator' ? '問い合わせ対応' : '自分の問い合わせ'
    : location.pathname.startsWith('/improvements') ? 'ナレッジ改善'
    : location.pathname.startsWith('/settings') ? 'アカウント管理'
    : location.pathname.startsWith('/password') ? 'パスワード変更'
    : location.pathname.startsWith('/dashboard') ? '管理ダッシュボード' : 'AIに質問'
  const brand = <><span className={styles.brandMark} aria-hidden="true">S</span><span className={styles.brandText}>SolveLoop<small>株式会社 柳</small></span></>
  const account = user && <details className={styles.account} onBlur={handleAccountBlur} onKeyDown={event => {
    if (event.key === 'Escape') { event.currentTarget.open = false; event.currentTarget.querySelector('summary')?.focus() }
  }}>
    <summary aria-label={`アカウント：${user.display_name}`}><span className={styles.avatar} aria-hidden="true">{Array.from(user.display_name)[0]}</span><span className={styles.identity}>{user.display_name}<span className={styles.role}>{user.role === 'operator' ? '担当者' : '社員'}</span></span></summary>
    <div className={styles.settingsBody}>
      {user.can_manage_accounts && <p>アカウント管理権限あり</p>}
      {showNavigation && <Link to="/password/change" onClick={closeMenu}>本人のパスワードを変更</Link>}
      <button type="button" className="button" disabled={busy} onClick={onSessionEnd}>ログアウト</button>
    </div>
  </details>

  return <>
    <a className={styles.skipLink} href="#main-content">本文へ移動</a>
    <div className={showNavigation ? styles.shell : styles.authShell}>
      {showNavigation && <aside id="workspace-navigation" className={`${styles.navigation} ${menuOpen ? styles.navigationOpen : ''}`} onKeyDown={event => {
        if (event.key === 'Escape' && menuOpen) { setMenuOpen(false); document.getElementById('menu-toggle')?.focus() }
      }}>
        {account}
        <nav aria-label="メインメニュー" className={styles.menu}>
          <NavLink to="/home" onClick={closeMenu}><MenuIcon kind="home" />ホーム</NavLink>
          <p className={styles.navLabel}>社内サポート</p>
          <NavLink to="/ask" onClick={closeMenu}><MenuIcon kind="ask" />AIに質問</NavLink>
          <NavLink to="/my/requests" onClick={closeMenu}><MenuIcon kind="requests" />自分の問い合わせ</NavLink>
          <NavLink to="/knowledge" end={location.pathname.startsWith('/knowledge/reviews')} onClick={closeMenu}><MenuIcon kind="knowledge" />社内文書</NavLink>
          {(session.role === 'operator' || session.can_manage_accounts) && <p className={styles.navLabel}>管理</p>}
          {session.role === 'operator' && <>
            <NavLink to="/dashboard" onClick={closeMenu}><MenuIcon kind="dashboard" />管理ダッシュボード</NavLink>
            <NavLink to="/requests" onClick={closeMenu}><MenuIcon kind="requests" />問い合わせ対応</NavLink>
            <NavLink to="/improvements" onClick={closeMenu}><MenuIcon kind="radar" />ナレッジ改善</NavLink>
            <NavLink to="/knowledge/reviews" onClick={closeMenu}><MenuIcon kind="review" />文書レビュー</NavLink>
          </>}
          {session.can_manage_accounts && <NavLink to="/settings/accounts" onClick={closeMenu}><MenuIcon kind="accounts" />アカウント管理</NavLink>}
        </nav>
        <div className={styles.sidebarBottom}>
          <Link to={home} className={styles.brand}>{brand}</Link>
        </div>
      </aside>}
      <div className={styles.content}>
        <header className={styles.header}>
          <Link to={home} className={`${styles.brand} ${showNavigation ? styles.mobileBrand : ''}`}>{brand}</Link>
          {showNavigation && <>
            <button id="menu-toggle" type="button" className={styles.menuToggle} aria-expanded={menuOpen} aria-controls="workspace-navigation" onClick={() => setMenuOpen(!menuOpen)}>メニュー</button>
            <div className={styles.breadcrumb}><Link to={home}>ワークスペース</Link><span aria-hidden="true">/</span><strong>{section}</strong></div>
          </>}
          <details className={styles.demoInfo} onBlur={handleAccountBlur} onKeyDown={event => {
            if (event.key === 'Escape') { event.currentTarget.open = false; event.currentTarget.querySelector('summary')?.focus() }
          }}><summary>架空企業・合成データ</summary><div className={styles.demoBody}><p>架空企業のローカルデモです。AIは承認・公開された文書をもとに案内します。</p><p>AI案とRadarの判定は人による確認が必要です。業務時刻は日本時間で表示します。</p></div></details>
          {!showNavigation && (account || <span className={styles.role}>{unverified ? '接続状態は未確認' : '未ログイン'}</span>)}
        </header>
        <main id="main-content" tabIndex={-1} ref={mainRef} className={styles.main}>
          {notice && <p role="status" className={styles.authNotice}>{notice}</p>}
          {children}
        </main>
      </div>
    </div>
  </>
}
