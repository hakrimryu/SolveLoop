import { api } from './api'

export type GuidanceSource = { id: string; document_id: string; version_no: number; number: string; title: string; audience: string; text: string; href: string }
export type Guidance = {
  guidance_id?: string; feedback_version?: number; outcome?: 'solved' | 'unresolved' | null; feedback_allowed?: boolean
  query: string; generated_at: string; mode: 'live'; prompt_version: string; request_id: string
  result: { status: 'answered' | 'insufficient_evidence'; summary: string; steps: { text: string; citation_ids: string[] }[]; missing_information: string[] }
  sources: GuidanceSource[]
  notices?: { document_id: string; number: string; version_no: number; audience: string; text: string; href: string }[]
}
type Draft = { query: string; result?: Guidance; editing?: boolean; reason?: string }
let retained: { generation: number; draft: Draft } | undefined
export function readGuidance(): Draft { return retained?.generation === api.snapshot().identityGeneration ? retained.draft : { query: '' } }
export function retainGuidance(generation: number, draft: Draft) {
  if (generation === api.snapshot().identityGeneration) retained = { generation, draft }
}
export function clearGuidance() { retained = undefined }
