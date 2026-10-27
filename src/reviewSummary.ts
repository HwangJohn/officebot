export function formatReviewSummary(kind: 'daily_review' | 'weekly_review', title: string, blockedReferences: readonly string[]): string {
  return `${kind === 'daily_review' ? '일간' : '주간'} 점검: ${title}`;
}
