import { useLayoutEffect, useRef } from 'react'
import type { KeyboardEvent } from 'react'
import styles from './DiscardDialog.module.css'

export function trapDialogFocus(event: KeyboardEvent<HTMLDialogElement>) {
  if (event.key !== 'Tab') return
  const controls = event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input, textarea, select')
  const first = controls[0]
  const last = controls[controls.length - 1]
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault()
    first.focus()
  }
}

export default function DiscardDialog({ onDiscard, onCancel }: { onDiscard: () => void; onCancel: () => void }) {
  const ref = useRef<HTMLDialogElement>(null)
  // 初期フォーカスを入力継続へ置き、誤操作で未保存内容を捨てないようにする。
  // [ko] 초기 초점을 입력 계속 버튼에 두어 실수로 미저장 내용을 버리지 않게 한다.
  // [en] Focus the keep-editing action first to reduce accidental loss of unsaved input.
  const cancelRef = useRef<HTMLButtonElement>(null)
  useLayoutEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    const dialog = ref.current!
    dialog.showModal()
    cancelRef.current?.focus()
    return () => { dialog.close(); if (previous?.isConnected) previous.focus() }
  }, [])
  return (
    <dialog
      ref={ref} className={styles.dialog} aria-modal="true"
      aria-labelledby="discard-heading" aria-describedby="discard-description"
      onKeyDown={trapDialogFocus} onCancel={event => { event.preventDefault(); onCancel() }}
    >
      <h2 id="discard-heading">未保存の入力があります</h2>
      <p id="discard-description">続けると入力内容が失われます。破棄して操作を続けますか？</p>
      <div className={styles.actions}>
        <button ref={cancelRef} className="button" onClick={onCancel}>入力を続ける</button>
        <button className="button buttonPrimary" onClick={onDiscard}>破棄して続ける</button>
      </div>
    </dialog>
  )
}
