import { useLayoutEffect, useRef, useState } from 'react'
import type { ChangeEvent, FocusEvent, ReactNode } from 'react'
import { Link, NavLink, useLocation } from 'react-router'
import { demoUsers } from '../lib/mockData'
import type { DemoRole } from '../lib/mockData'
import styles from './AppLayout.module.css'

type Props = {
  role: DemoRole
  onRoleChange: (role: DemoRole) => void
  children: ReactNode
}

function MenuIcon({ kind }: { kind: 'dashboard' | 'requests' | 'knowledge' | 'review' }) {
  const paths = {
    dashboard: 'M3 3h6v6H3z M13 3h6v6h-6z M3 13h6v6H3z M13 13h6v6h-6z',
    requests: 'M4 4h14v14H4z M4 12h4l2 3h2l2-3h4 M8 8h6',
    knowledge: 'M11 5C8 3 5 3 2 4v14c3-1 6-1 9 1m0-14c3-2 6-2 9-1v14c-3-1-6-1-9 1V5z',
    review: 'M7 4H4v15h14V4h-3 M8 2h6v4H8z M7 12l3 3 5-6',
  }
  return (
    <svg aria-hidden="true" focusable="false" viewBox="0 0 22 22" className={styles.menuIcon}>
      <path d={paths[kind]} />
    </svg>
  )
}

export default function AppLayout({ role, onRoleChange, children }: Props) {
  const location = useLocation()
  const previousPath = useRef(location.pathname === '/' ? '/dashboard' : location.pathname)
  const [menuOpen, setMenuOpen] = useState(false)
  const mainRef = useRef<HTMLElement>(null)
  const user = demoUsers[role]

  useLayoutEffect(() => {
    if (location.pathname === '/') return
    setMenuOpen(false)
    const heading = mainRef.current?.querySelector('h1')
    if (previousPath.current !== location.pathname) heading?.focus()
    previousPath.current = location.pathname
    document.title = `${heading?.textContent ?? 'SolveLoop'} | SolveLoop`
  }, [location.pathname])

  function closeMenu() {
    setMenuOpen(false)
  }

  function handleRoleChange(event: ChangeEvent<HTMLSelectElement>) {
    onRoleChange(event.target.value as DemoRole)
    closeMenu()
    window.scrollTo({ top: 0 })
  }

  function handleDemoSettingsBlur(event: FocusEvent<HTMLDetailsElement>) {
    if (!event.currentTarget.contains(event.relatedTarget)) {
      event.currentTarget.open = false
    }
  }

  return (
    <>
      <a className={styles.skipLink} href="#main-content">本文へ移動</a>
      <header className={styles.header}>
        <Link to="/dashboard" className={styles.brand}>
          <span className={styles.brandMark} aria-hidden="true">S</span>
          <span className={styles.brandText}>SolveLoop<small>株式会社 柳</small></span>
        </Link>
        <span className={styles.demoLabel}>架空企業・デモデータ</span>
        <div className={styles.account}>
          <span>{user.name}<span className={styles.role}>{user.roleLabel}</span></span>
          <details className={styles.demoSettings} onBlur={handleDemoSettingsBlur}>
            <summary>デモ設定</summary>
            <div className={styles.settingsBody}>
              <label htmlFor="demo-role">デモ用の役割切替</label>
              <select id="demo-role" value={role} onChange={handleRoleChange}>
                <option value="operator">担当者：山田 花子</option>
                <option value="employee">社員：佐藤 美咲</option>
              </select>
              <p>表示する役割を切り替えます。実際のログインではありません。</p>
              <Link to="/login">ログイン画面<span className={styles.pending}>準備中</span></Link>
            </div>
          </details>
        </div>
      </header>
      <div className={styles.mockBar}>
        <p><strong>画面モック</strong> 保存・権限・AIはシミュレーションです。</p>
        <p className="srOnly" role="status">{user.roleLabel}のデモ画面を表示しています。</p>
      </div>
      <div className={styles.workspace}>
        <div className={styles.navigation}>
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
              <MenuIcon kind="requests" />問い合わせ<span className={styles.pending}>準備中</span>
            </NavLink>
            <NavLink
              to="/knowledge"
              end={location.pathname.startsWith('/knowledge/reviews')}
              onClick={closeMenu}
            >
              <MenuIcon kind="knowledge" />ナレッジ<span className={styles.pending}>準備中</span>
            </NavLink>
            {role === 'operator' && (
              <NavLink to="/knowledge/reviews" onClick={closeMenu}>
                <MenuIcon kind="review" />ナレッジレビュー<span className={styles.pending}>準備中</span>
              </NavLink>
            )}
            <p className={styles.navNote}><span>ローカルデモ</span>すべて合成データです。</p>
          </nav>
        </div>
        <main id="main-content" tabIndex={-1} ref={mainRef} className={styles.main}>{children}</main>
      </div>
      <footer className={styles.footer}>SolveLoop · ローカル操作デモ · 実際の保存・認証・AI処理は行いません。</footer>
    </>
  )
}
