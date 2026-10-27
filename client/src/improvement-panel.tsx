import React, { useEffect, useRef, useState } from 'react';
import './improvement-panel.css';

type Source = { source: string; reference: string; excerpt: string; blocked: boolean };
type Entry = {
  id: string; title: string; rationale: string; patch: string; scope: string; sourceHash: string; status: string; effectiveStatus: string;
  reviewId: string | null; evidence: { id: string; sha256: string }[];
  evidenceSnapshot: { kind: string; summary: string; sources: Source[] } | null;
  review: { target: string; status: string; checks: { id: string; passed: boolean; detail: string }[]; example?: { before: string; after: string | null } | null; baseFile: string; reviewedFile: string | null } | null;
};

async function request<T>(path: string, post = false): Promise<T> {
  const response = await fetch(path, post ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' } : undefined);
  if (!response.ok) {
    let code = ''; try { code = (await response.json()).code; } catch { /* generic message */ }
    if (code === 'improvement_no_review_evidence') throw new Error('차단·지연 근거가 있는 저장된 점검이 필요합니다.');
    if (['stale_evidence', 'stale_source', 'stale_improvement'].includes(code)) throw new Error('근거나 기준 파일이 변경되었습니다. 최신 점검을 확인해 주세요.');
    throw new Error('개선안을 처리하지 못했습니다. 다시 시도해 주세요.');
  }
  return response.json() as Promise<T>;
}

export function ImprovementPanel({ goalId }: { goalId: string }) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const generation = useRef(0);
  const busyRef = useRef(false);
  const root = `/api/goals/${encodeURIComponent(goalId)}/improvements`;
  useEffect(() => {
    const current = ++generation.current; busyRef.current = false; setEntries([]); setLoading(true); setError(''); setBusy('');
    request<Entry[]>(root).then(data => { if (generation.current === current) setEntries(data); }).catch(() => { if (generation.current === current) setError('개선안을 불러오지 못했습니다.'); }).finally(() => { if (generation.current === current) setLoading(false); });
    return () => { generation.current++; };
  }, [root]);
  async function perform(id: string, path: string) {
    if (busyRef.current) return;
    const current = generation.current; busyRef.current = true; setBusy(id); setError('');
    const refresh = async () => { const data = await request<Entry[]>(root); if (generation.current === current) setEntries(data); };
    try { await request(path, true); await refresh(); }
    catch (e) { if (generation.current === current) setError(e instanceof Error ? e.message : '요청을 처리하지 못했습니다.'); try { await refresh(); } catch { /* retain the safe message */ } }
    finally { if (generation.current === current) { busyRef.current = false; setBusy(''); } }
  }
  const status = (entry: Entry) => entry.effectiveStatus === 'stale' ? '근거 또는 기준이 변경됨' : ({ proposed: '평가 대기', review_required: '사람의 검토 필요', checks_failed: '검사 실패', rejected: '평가 거절' } as Record<string, string>)[entry.status] ?? '상태 확인 필요';
  return <section className="improvement-panel" aria-label="점검 요약 개선안">
    <h3>점검 요약 개선안</h3>
    <p>저장된 차단·지연 점검을 바탕으로 요약에 건수와 출처를 표시하는 한 가지 개선안을 만듭니다. 검토와 평가는 소스를 적용하지 않습니다.</p>
    <button type="button" disabled={!!busy || loading} onClick={() => void perform('generate', `${root}/propose`)}>{busy === 'generate' ? '개선안 생성 중…' : '개선안 생성'}</button>
    <button type="button" disabled={!!busy || loading} onClick={() => { const current = generation.current; setLoading(true); setError(''); request<Entry[]>(root).then(data => { if (generation.current === current) setEntries(data); }).catch(() => { if (generation.current === current) setError('개선안을 불러오지 못했습니다.'); }).finally(() => { if (generation.current === current) setLoading(false); }); }}>상태 새로고침</button>
    {loading && <p role="status">개선안을 불러오는 중…</p>}
    {error && <p role="alert">{error}</p>}
    {!loading && !entries.length && <p>저장된 개선안이 없습니다.</p>}
    {entries.map(entry => <article className="improvement-entry" key={entry.id}>
      <h4>{entry.title}</h4><p>{entry.rationale}</p><p><strong>상태:</strong> {status(entry)}</p>
      {entry.scope !== 'review_summary_v1' ? <p>이전 예제 개선안</p> : <>
        <p>저장된 {entry.evidenceSnapshot?.kind === 'weekly_review' ? '주간' : '일간'} 점검: <code>{entry.reviewId}</code></p>
        <p>{entry.evidenceSnapshot?.summary}</p>
        <ul>{entry.evidenceSnapshot?.sources.map(source => <li key={source.reference}>{source.blocked ? '차단·지연 · ' : ''}{source.source} · <code>{source.reference}</code><br />{source.excerpt}</li>)}</ul>
      </>}
      <details><summary>근거와 기준 해시</summary><p>기준: <code>{entry.sourceHash}</code></p><ul>{entry.evidence.map(e => <li key={e.id}><code>{e.id} · {e.sha256}</code></li>)}</ul></details>
      <details><summary>정확한 변경 내용</summary><pre>{entry.patch}</pre></details>
      {entry.review?.example && <div className="improvement-example"><p><strong>이전:</strong> {entry.review.example.before}</p><p><strong>제안:</strong> {entry.review.example.after ?? '평가를 통과하지 못했습니다.'}</p></div>}
      {entry.review && <><p>평가 대상: <code>{entry.review.target}</code></p><ul>{entry.review.checks.map(check => <li key={check.id}>{check.passed ? '통과' : '실패'} · {check.id} · {check.detail}</li>)}</ul><details><summary>기준과 평가된 파일</summary><p>기준</p><pre>{entry.review.baseFile}</pre><p>평가 결과</p><pre>{entry.review.reviewedFile ?? '평가된 파일 없음'}</pre></details></>}
      {entry.status === 'proposed' && <button type="button" disabled={!!busy || entry.effectiveStatus === 'stale'} onClick={() => void perform(entry.id, `${root}/${encodeURIComponent(entry.id)}/review`)}>{busy === entry.id ? '평가 중…' : '복사본에서 평가'}</button>}
    </article>)}
  </section>;
}
