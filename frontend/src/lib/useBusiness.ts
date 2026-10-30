import { useCallback, useEffect, useRef, useState } from 'react'
import { api, errorMessage, isStale, StaleSession } from './api'
import type { RequestOptions } from './api'

// 画面離脱で業務要求を中断し、中断を無視した応答も反映しない。
// [ko] 화면 이탈 시 업무 요청을 취소하고 취소를 무시한 응답도 반영하지 않는다.
// [en] Cancel business calls on unmount and reject responses even if cancellation is ignored.
export function useBusinessCall() {
  const scope = useRef(new AbortController())
  useEffect(() => { scope.current = new AbortController(); return () => scope.current.abort() }, [])
  return useCallback(async <T,>(path: string, body?: unknown, options: RequestOptions = {}) => {
    const current = scope.current
    const generation = api.snapshot().generation
    const result = await api.request<T>(path, body, { ...options, business: true, signal: options.signal ?? current.signal })
    api.assertCurrent(generation)
    if (current.signal.aborted || current !== scope.current) throw new StaleSession()
    return result
  }, [])
}

// 経路と再取得番号が一致する結果だけを表示し、古い一覧との混在を防ぐ。
// [ko] 경로와 재조회 번호가 일치하는 결과만 표시해 오래된 목록과 섞이지 않게 한다.
// [en] Display only matching paths and reload revisions to avoid mixing old and new results.
export function useLoad<T>(path: string | null) {
  const call = useBusinessCall()
  const [revision, refresh] = useState(0)
  const [result, setResult] = useState<{ path: string | null; revision: number; data?: T; error?: string }>({ path: null, revision: -1 })
  useEffect(() => {
    if (!path) return
    const controller = new AbortController()
    const generation = api.snapshot().generation
    void call<T>(path, undefined, { signal: controller.signal }).then(data => {
      api.assertCurrent(generation)
      if (!controller.signal.aborted) setResult({ path, revision, data })
    }).catch(error => {
      if (!controller.signal.aborted && !isStale(error)) setResult({ path, revision, error: errorMessage(error) })
    })
    return () => controller.abort()
  }, [path, revision, call])
  const current = result.path === path && result.revision === revision ? result : undefined
  return { data: current?.data, error: current?.error, loading: !!path && !current, reload: useCallback(() => refresh(value => value + 1), []) }
}
