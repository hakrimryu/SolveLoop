type Answer = { summary: string; steps: { text: string; citation_ids: string[] }[]; missing_information: string[] }
type Source = { id: string; kind: 'knowledge' | 'ticket'; number: string; title: string; href: string }

export function employeeAnswerDraft(answer: Answer, sources: Source[], origin: string) {
  const used = new Set(answer.steps.flatMap(step => step.citation_ids))
  const references = sources.filter(source => source.kind === 'knowledge' && used.has(source.id))
  return [answer.summary, ...answer.steps.map((step, index) => `${index + 1}. ${step.text}`),
    ...answer.missing_information,
    ...references.map(source => `${source.number} ${source.title} ${new URL(source.href, origin).href}`)].join('\n\n')
}
