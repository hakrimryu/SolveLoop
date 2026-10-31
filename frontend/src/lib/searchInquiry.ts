type InquiryInput = { title: string; body: string; department_id: string }
export type SearchDocument = { number: string; title: string; version_no: number; url: string }

let pending: { id: string; input: InquiryInput } | undefined

export function prepareSearchInquiry(query: string, document?: SearchDocument) {
  const question = query.trim()
  const title = Array.from(question || (document ? `${document.title}について` : '')).slice(0, 120).join('')
  const body = question || document ? [
    `質問・困っていること\n${question}`,
    '試したこと・補足\n',
    ...(document ? [`参考文書（問い合わせ作成時の表示）\n${document.number} ${document.title} / v${document.version_no}\n${document.url}`] : []),
  ].join('\n\n') : ''
  const id = crypto.randomUUID()
  pending = { id, input: { title, body, department_id: '' } }
  return id
}

export function readSearchInquiry(id: unknown): InquiryInput | undefined {
  return pending && pending.id === id ? { ...pending.input } : undefined
}

export function clearSearchInquiry() { pending = undefined }
