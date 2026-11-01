import type { GuidanceItem } from '../features/knowledge/GuidanceHistory'

export function groupGuidanceSignals(items: GuidanceItem[]) {
  const groups = new Map<string, { item: GuidanceItem; count: number }>()
  for (const item of items) {
    if (item.state === 'error' || item.state === 'processing' || item.outcome === 'solved') continue
    if (item.outcome !== 'unresolved' && item.state !== 'insufficient_evidence') continue
    const key = item.query.normalize('NFKC').toLocaleLowerCase('ja-JP').replace(/\s+/g, ' ').trim()
    const group = groups.get(key)
    if (!group) groups.set(key, { item, count: 1 })
    else { group.count++; if (item.created_at > group.item.created_at) group.item = item }
  }
  return [...groups.values()].sort((a, b) => b.count - a.count || b.item.created_at.localeCompare(a.item.created_at))
}
