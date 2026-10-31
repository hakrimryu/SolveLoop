type InquiryInput = { title: string; body: string; department_id: string }
export type SearchDocument = { number: string; title: string; version_no: number; url: string }

let pending: { id: string; input: InquiryInput } | undefined

export function prepareSearchInquiry(query: string, document?: SearchDocument | SearchDocument[]) {
  const documents = document ? (Array.isArray(document) ? document : [document]) : []
  const first = documents[0]
  const question = query.trim()
  const title = Array.from(question || (first ? `${first.title}について` : '')).slice(0, 120).join('')
  const body = question || first ? [
    `質問・困っていること\n${question}`,
    '試したこと・補足\n',
    ...documents.map(item => `参考文書（問い合わせ作成時の表示）\n${item.number} ${item.title} / v${item.version_no}\n${item.url}`),
  ].join('\n\n') : ''
  const id = crypto.randomUUID()
  pending = { id, input: { title, body, department_id: '' } }
  return id
}

export function readSearchInquiry(id: unknown): InquiryInput | undefined {
  return pending && pending.id === id ? { ...pending.input } : undefined
}

export function clearSearchInquiry() { pending = undefined }
