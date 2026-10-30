import { useCallback, useEffect, useRef, useState } from 'react'
import { api, errorMessage, isStale, StaleSession } from './api'
import type { RequestOptions } from './api'

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
