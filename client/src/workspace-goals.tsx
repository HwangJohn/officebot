import React, { FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { ImprovementPanel } from './improvement-panel.js';

type Goal = { id: string; title: string; completion: string; project: string; current_plan: number };
type Step = { plan_version: number; step_id: string; tool: string; status: string; result_json?: string | null };
type Fact = { id: number; value: string; source: string; observed_at: string; plan_version: number };
type Artifact = { id: number; kind: string; content: string; source_fact_id: number; plan_version: number; created_at: string };
type Approval = { id: string; status: string; effectiveStatus?: string; action_type: string; plan_version: number; artifact_id: number; target_revision: number; expires_at: string; payload: { body?: string; comment?: string; account?: string; thread?: string; issue?: string } };
type Schedule = { schedule_id: string; kind: string; next_due: number; active: number; time_zone: string | null; minute_of_day: number | null; weekday: number | null; current?: boolean };
type Detail = { goal: Goal; plans: { version: number; created_at: string }[]; steps: Step[]; facts: Fact[]; artifacts: Artifact[]; personalTasks?: { id: number; title: string; status: string; source_fact_id: number; plan_version: number }[]; approvals: Approval[]; outcomes: { id: number; approval_id: string; result: { mock?: boolean }; created_at: string }[]; planMemory: { planVersion: number; memory: { preferences?: { key: string; value: string; source: string }[]; conversation?: { source: string; content: string }[] } }[]; automation?: { schedules: Schedule[]; jobs: { id: string; kind: string; status: string; due_at: number; reason: string | null }[]; activity: { effect_id: string; kind: string; details: { source?: string; reference?: string }; created_at: number }[]; reviews: { job_id: string; kind: string; approval_status: string; artifact: { summary?: string; evidence?: { source: string; reference: string; excerpt: string }[]; proposals?: { description: string }[] } }[] } };
type Preference = { key: string; value: string | null; version: number; observedAt: string };
type Message = { id: number; role: string; content: string; version?: number };
type Target = { eventId: number; externalId: string; revision: number; source: string; account: string; title: string };
type Notification = { id?: string; status: string; updated_at: number; next_check_at?: number | null };
type NotificationSettings = { enabled: boolean; bridgeAvailable: boolean; quietHours: { time_zone: string; start_minute: number; end_minute: number } | null; notifications: Notification[] };

async function request<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, body === undefined ? undefined : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!response.ok) {
    let code = ''; try { code = (await response.json()).code; } catch { /* use generic message */ }
    const messages: Record<string, string> = { stale_plan: '계획이 변경되었습니다. 최신 상태를 확인해 주세요.', stale_memory: '대화나 선호가 변경되었습니다. 다시 계획해 주세요.', stale_policy: '계획 조건이 변경되었습니다. 다시 계획해 주세요.', stale_evidence: '근거가 변경되었습니다. 다시 계획해 주세요.', stale_target: '대상이 변경되었습니다. 다시 확인해 주세요.', stale_message: '대화가 변경되었습니다. 최신 내용을 확인해 주세요.', stale_preference: '선호가 변경되었습니다. 최신 내용을 확인해 주세요.', needs_evidence: '현재 프로젝트에 신뢰할 수 있는 근거가 필요합니다.', invalid_mock_target: '유효한 모의 대상을 선택해 주세요.', invalid_quiet_hours: '시간대와 시작·종료 시각을 확인해 주세요.', invalid_civil_schedule: '점검 시간대와 시각을 확인해 주세요.', discord_bridge_unavailable: 'Discord 업무 연결이 설정되지 않아 알림을 켤 수 없습니다.' };
    throw new Error(messages[code] ?? '요청을 처리하지 못했습니다. 최신 상태를 확인하고 다시 시도해 주세요.');
  }
  return response.json();
}
const goalPath = (id: string) => `/api/goals/${encodeURIComponent(id)}`;
const statusText = (status: string) => ({ pending: '대기', waiting: '기다리는 중', wait: '기다리는 중', failed: '실패', complete: '완료', succeeded: '완료', running: '진행 중', stopped: '중단', cancelled: '취소', executed: '모의 실행 완료', rejected: '거절', stale: '변경되어 무효', expired: '만료', uncertain: '결과 확인 필요', processing: '처리 중', held: '보류', deferred: '보류' } as Record<string, string>)[status] ?? status;
const stepText = (tool: string) => ({ record_fact: '근거 기록', create_artifact: '초안 만들기', wait_for_mock_record: '모의 자료 기다리기', personal_followup: '개인 후속 작업' } as Record<string, string>)[tool] ?? tool;
function waitingDetail(step: Step) {
  if (step.status !== 'waiting' || !step.result_json) return '';
  try { const reason = JSON.parse(step.result_json); return typeof reason.source === 'string' && typeof reason.externalId === 'string' ? `${reason.source} · ${reason.externalId}` : ''; } catch { return ''; }
}
const jobText = (kind: string) => ({ event: '자료 변경 확인', daily_review: '일간 점검', weekly_review: '주간 점검', notification: '알림' } as Record<string, string>)[kind] ?? kind;
const dateText = (value: string | number) => {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : `${new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', dateStyle: 'medium', timeStyle: 'short' }).format(date)} (서울)`;
};
const sourceName = (source: string) => ({ outlook: 'Outlook', teams: 'Teams', jira: 'Jira', confluence: 'Confluence', local: '로컬' } as Record<string, string>)[source.split(':')[0].toLowerCase()] ?? '기록된 자료';
function Reference({ reference, label }: { reference: string; label?: string }) {
  return <details className="source-reference"><summary>{label ?? sourceName(reference)} · 원본 참조 보기</summary><code>{reference}</code></details>;
}
const reasonText = (reason: string) => ({ error: '처리 중 오류', lease_expired: '처리 시간 만료', no_progress: '진행 없음', cancelled: '취소됨', progress: '진행 완료' } as Record<string, string>)[reason] ?? reason;

export function WorkspaceGoals({ active, projects, messages, refreshMessages, selectionRequest }: { active: boolean; projects: string[]; messages: Message[]; refreshMessages: () => Promise<unknown>; selectionRequest?: { id: string; sequence: number } | null }) {
  const [goals, setGoals] = useState<Goal[]>([]);
  const [availableProjects, setAvailableProjects] = useState<string[]>([]);
  const [selected, setSelected] = useState('');
  const selectedRef = useRef('');
  const [detail, setDetail] = useState<Detail | null>(null);
  const [preferences, setPreferences] = useState<Preference[]>([]);
  const [notificationSettings, setNotificationSettings] = useState<NotificationSettings | null>(null);
  const [busy, setBusy] = useState('');
  const busyRef = useRef(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [title, setTitle] = useState('');
  const [completion, setCompletion] = useState('');
  const [project, setProject] = useState('');
  const [prefKey, setPrefKey] = useState('response_style');
  const [prefValue, setPrefValue] = useState('');
  const [targets, setTargets] = useState<Target[]>([]);
  const [targetId, setTargetId] = useState('');
  const [artifactId, setArtifactId] = useState('');
  const selectionSeq = useRef(0);
  const alive = useRef(true);

  const refresh = useCallback(async (id: string) => {
    const seq = ++selectionSeq.current;
    const [list, projectsList] = await Promise.all([request<Goal[]>('/api/goals'), request<{ project: string }[]>('/api/projects').catch(() => [])]);
    const goal = list.find((item) => item.id === id);
    const [next, prefs, notificationsResult] = goal ? await Promise.all([request<Detail>(goalPath(goal.id)), request<Preference[]>(`/api/preferences?project=${encodeURIComponent(goal.project)}`), request<NotificationSettings>(`${goalPath(goal.id)}/notifications`).catch(() => null)]) : [null, [], null];
    if (alive.current && seq === selectionSeq.current && selectedRef.current === id) { setGoals(list); setAvailableProjects(projectsList.map((p) => p.project)); setDetail(next); setPreferences(prefs); setNotificationSettings(notificationsResult); }
  }, []);
  function choose(id: string) {
    selectedRef.current = id; setSelected(id); setDetail(null); setPreferences([]); setNotificationSettings(null); setTargets([]); setTargetId(''); setArtifactId(''); setError('');
    void refresh(id).catch(() => setError('목표를 불러오지 못했습니다. 다시 선택해 주세요.'));
  }
  useEffect(() => { alive.current = true; return () => { alive.current = false; selectionSeq.current++; }; }, []);
  const appliedSelection = useRef(0);
  useEffect(() => { if (active && selectionRequest && selectionRequest.sequence !== appliedSelection.current) { appliedSelection.current = selectionRequest.sequence; choose(selectionRequest.id); } }, [active, selectionRequest]);
  useEffect(() => {
    if (!active) return;
    let stopped = false;
    const poll = () => { if (!busyRef.current && document.visibilityState === 'visible') void refresh(selectedRef.current).catch(() => { if (!stopped) setError('목표를 새로 불러오지 못했습니다.'); }); };
    poll(); const timer = setInterval(poll, 7000);
    return () => { stopped = true; clearInterval(timer); };
  }, [active, refresh]);
  async function perform(label: string, work: () => Promise<void>) {
    if (busyRef.current) return;
    busyRef.current = true; selectionSeq.current++; setBusy(label); setError(''); setNotice('');
    try { await work(); await refresh(selectedRef.current); }
    catch (e) { setError(e instanceof Error ? e.message : '요청을 처리하지 못했습니다.'); try { await refresh(selectedRef.current); } catch { /* retain the last visible state */ } }
    finally { busyRef.current = false; setBusy(''); }
  }
  const current = goals.find((item) => item.id === selected);
  const selectedPreference = preferences.find((item) => item.key === prefKey);
  function createGoal(e: FormEvent) {
    e.preventDefault();
    const input = { title: title.trim(), completion: completion.trim(), project };
    if (!input.title || !input.completion || !input.project) return;
    void perform('목표 저장 중', async () => {
      const result = await request<{ id: string }>('/api/goals', input);
      selectedRef.current = result.id; setSelected(result.id); setDetail(null); setTargets([]); setTargetId(''); setArtifactId('');
      setTitle((v) => v.trim() === input.title ? '' : v); setCompletion((v) => v.trim() === input.completion ? '' : v);
      setNotice('새 목표를 만들었습니다.');
    });
  }
  async function savePreference(value: string | null) {
    if (!current) return;
    const key = prefKey.trim();
    await perform('기억 저장 중', async () => { await request('/api/preferences', { project: current.project, key, value, expectedVersion: selectedPreference?.version ?? 0 }); setNotice('선호를 저장했습니다. 기존 계획은 다시 만들어야 할 수 있습니다.'); });
  }
  const selectedArtifact = detail?.artifacts.find((a) => String(a.id) === artifactId);
  return <section className="view goals-workspace" aria-label="목표 작업 공간">
    {busy ? <div className="work-status" role="status">{busy}</div> : null}
    {error ? <div className="error" role="alert">{error}</div> : null}
    {notice ? <div className="work-status" role="status">{notice}</div> : null}
    <div className="goals-layout">
      <div className="goal-list panel-card">
        <div className="section-heading"><div><small>내 작업</small><h2>목표</h2></div><span>{goals.length}</span></div>
        {goals.length === 0 ? <p className="muted">아직 목표가 없습니다. 아래에서 새 목표를 만들어 보세요.</p> : goals.map((g) => <button key={g.id} className={`goal-select ${selected === g.id ? 'selected' : ''}`} aria-pressed={selected === g.id} disabled={Boolean(busy)} onClick={() => choose(g.id)}><strong>{g.title}</strong><small>{g.project} · {g.current_plan ? `계획 ${g.current_plan}` : '계획 전'}</small></button>)}
        <details className="goal-create" open={goals.length === 0}>
          <summary>새 목표 만들기</summary>
          <form onSubmit={createGoal} className="goal-form">
            <label>목표 이름<input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} required /></label>
            <label>완료 조건<textarea value={completion} onChange={(e) => setCompletion(e.target.value)} maxLength={1000} required /></label>
            <label>프로젝트<select value={project} onChange={(e) => setProject(e.target.value)} required><option value="">프로젝트 선택</option>{[...new Set([...availableProjects, ...projects])].map((p) => <option key={p} value={p}>{p}</option>)}</select></label>
            {!availableProjects.length && !projects.length ? <small>프로젝트 자료가 없습니다. 먼저 데모 시나리오에서 자료를 수집하세요.</small> : null}
            <button disabled={Boolean(busy)}>목표 만들기</button>
          </form>
        </details>
      </div>
      <div className="goal-content">
        {!selected ? <div className="panel-card goal-empty"><h2>함께 진행할 목표를 선택하세요</h2><p>목표마다 계획과 근거가 따로 보관됩니다.</p></div> : !detail || !current ? <div className="panel-card">목표를 불러오는 중...</div> : <>
          <div className="panel-card goal-hero"><small>{current.project}</small><h2>{current.title}</h2><p>{current.completion}</p><div className="actions"><button disabled={Boolean(busy)} onClick={() => void perform('계획 만드는 중', async () => { await request(`${goalPath(selected)}/plan`, { expectedVersion: current.current_plan }); setNotice('계획을 저장했습니다.'); })}>{current.current_plan ? '계획 다시 만들기' : '계획 만들기'}</button><button className="secondary" disabled={Boolean(busy) || !current.current_plan} onClick={() => void perform('단계 진행 중', async () => { const result = await request<{ status: string }>(`${goalPath(selected)}/step`, { version: current.current_plan }); setNotice(result.status === 'complete' ? '현재 계획의 단계가 모두 완료되었습니다.' : result.status === 'waiting' ? '필요한 모의 자료를 기다리고 있습니다.' : '한 단계를 진행했습니다.'); })}>한 단계 진행</button></div></div>
          <section className="panel-card"><div className="section-heading"><h3>계획과 활동</h3><small>현재 계획 {current.current_plan || '없음'}</small></div>
            {!detail.plans.length ? <p className="muted">아직 계획이 없습니다. 자료를 바탕으로 계획을 만들어 주세요.</p> : detail.plans.slice().reverse().map((plan) => <div className="plan-block" key={plan.version}><div className="plan-title"><strong>계획 {plan.version}</strong><small>{plan.version === current.current_plan ? '현재' : '이전'} · {dateText(plan.created_at)}</small></div>{detail.steps.filter((step) => step.plan_version === plan.version).map((step) => <div className="goal-step" key={step.step_id}><span>{stepText(step.tool)}{waitingDetail(step) ? <small> · {waitingDetail(step)}</small> : null}</span><b>{statusText(step.status)}</b></div>)}</div>)}
            {detail.personalTasks?.map(task => <div className="goal-record" key={task.id}><strong>개인 후속 작업 · {task.title}</strong><small>{task.status === 'open' ? '진행 전' : task.status === 'done' ? '완료' : task.status} · 근거 {task.source_fact_id}</small>{task.status === 'open' ? <button className="secondary" disabled={Boolean(busy)} onClick={() => void perform('개인 작업 완료 중', async () => { await request(`${goalPath(selected)}/personal-tasks/${task.id}/complete`, { expectedPlanVersion: task.plan_version }); setNotice('개인 작업을 완료했습니다.'); })}>개인 작업 완료</button> : null}</div>)}
            {detail.automation?.jobs.length ? <><h4>자동 활동</h4>{detail.automation.jobs.map((job) => <div className="goal-step" key={job.id}><span>{jobText(job.kind)}<small> · {job.status === 'pending' ? '예정' : '기록된 예정 시각'} {dateText(job.due_at)}</small>{job.reason && !['progress'].includes(job.reason) ? <small className="job-reason">사유: {reasonText(job.reason)} ({job.reason}){job.status === 'held' ? ' · 외부 결과 확인 필요' : ''}</small> : null}</span><b>{statusText(job.status)}</b></div>)}</> : null}
            {detail.automation?.activity.map((event) => <div className="goal-record" key={event.effect_id}><strong>{event.kind === 'evidence_changed' ? '자료 변경 확인' : event.kind}</strong><small>{sourceName(event.details.source ?? '')} · {dateText(event.created_at)}</small>{event.details.reference ? <Reference reference={event.details.reference} /> : null}</div>)}
          </section>
          <ScheduleControls key={selected} schedules={detail.automation?.schedules ?? []} busy={busy} save={(body) => perform('점검 일정 저장 중', async () => { await request(`${goalPath(selected)}/schedules`, body); setNotice('점검 일정을 저장했습니다.'); })} cancel={(schedule) => perform('점검 일정 중지 중', async () => { await request(`${goalPath(selected)}/schedules/${schedule.kind}/cancel`, { expectedScheduleId: schedule.schedule_id }); setNotice('점검 일정을 중지했습니다.'); })} />
          <section className="panel-card"><h3>근거와 산출물</h3>{!detail.facts.length && !detail.artifacts.length ? <p className="muted">단계를 진행하면 기록된 근거와 산출물이 여기에 표시됩니다.</p> : null}
            {detail.facts.map((fact) => <article className="goal-record" key={`fact-${fact.id}`}><strong>근거 · 계획 {fact.plan_version}</strong><small>{sourceName(fact.source)} · {dateText(fact.observed_at)}</small><p>{fact.value}</p><Reference reference={fact.source} /></article>)}
            {detail.artifacts.map((a) => <article className="goal-record" key={`artifact-${a.id}`}><strong>초안 · 계획 {a.plan_version}</strong><small>{dateText(a.created_at)} · 근거 {a.source_fact_id}</small><pre>{a.content}</pre></article>)}
            {detail.automation?.reviews.map((review) => <article className="goal-record" key={review.job_id}><strong>{jobText(review.kind)} · {review.approval_status === 'human_review_required' ? '검토 필요' : review.approval_status === 'no_action' ? '제안 없음' : statusText(review.approval_status)}</strong><p>{review.artifact.summary}</p>{review.artifact.evidence?.map((e) => <div key={e.reference}><p>{sourceName(e.source)}<br />{e.excerpt}</p><Reference reference={e.reference} /></div>)}{review.artifact.proposals?.map((p, index) => <p key={index}>{p.description}</p>)}</article>)}
            {detail.planMemory.map((entry) => (entry.memory.preferences?.length || entry.memory.conversation?.length) ? <details key={entry.planVersion}><summary>계획 {entry.planVersion}에 사용된 기억</summary>{entry.memory.preferences?.map((p) => <div key={p.source}><p>선호 · {p.key}: {p.value}</p><Reference reference={p.source} label="선호" /></div>)}{entry.memory.conversation?.map((m) => <div key={m.source}><p>대화 · {m.content}</p><Reference reference={m.source} label="대화" /></div>)}</details> : null)}
          </section>
          <section className="panel-card"><h3>Discord 알림</h3>{notificationSettings === null ? <p className="muted">알림 상태를 확인하지 못했습니다.</p> : <><NotificationControls key={selected} settings={notificationSettings} busy={busy} save={(path, body) => perform('알림 설정 저장 중', async () => { await request(`${goalPath(selected)}/notifications${path}`, body); setNotice('알림 설정을 저장했습니다.'); })} />{notificationSettings.notifications.length === 0 ? <p className="muted">기록된 알림이 없습니다.</p> : notificationSettings.notifications.map((n, i) => <div className="goal-record" key={n.id ?? i}><div className="goal-step"><span>승인 알림<small> · {dateText(n.updated_at)}</small>{n.status === 'held' ? <small className="job-reason">외부 발송 결과 확인 필요 · 자동 재전송하지 않음</small> : null}{n.status === 'queued' && n.next_check_at ? <small className="job-reason">조용한 시간 후 확인: {dateText(n.next_check_at)}</small> : null}</span><b>{n.status === 'held' ? '보류' : n.status === 'queued' ? '대기' : n.status === 'sending' ? '전송 중 · 결과 확인 필요' : n.status === 'sent' ? '발송 확인' : statusText(n.status)}</b></div>{n.id ? <Reference reference={n.id} label="알림 ID" /> : null}</div>)}</>}</section>
          <section className="panel-card"><h3>승인</h3><p className="muted">완료된 초안으로 모의 대상에 대한 승인 요청을 만들 수 있습니다.</p>
            {detail.approvals.length === 0 ? <p className="muted">승인 요청이 없습니다.</p> : detail.approvals.map((approval) => <WorkspaceApproval key={approval.id} approval={approval} busy={busy} decide={(decision, text) => perform('승인 처리 중', async () => { const result = await request<{ status: string }>(`${goalPath(selected)}/approvals/${encodeURIComponent(approval.id)}/decide`, { decision, text }); setNotice(`승인 상태: ${statusText(result.status)}`); })} />)}
            {detail.outcomes.map((outcome) => <p className="outcome" key={outcome.id}>기록: {outcome.result?.mock ? '모의 실행' : '결과 확인 필요'} · {outcome.approval_id} · {dateText(outcome.created_at)}</p>)}
            <details><summary>승인 요청 만들기</summary><div className="goal-form">
              <label>초안 선택<select value={artifactId} onChange={(e) => setArtifactId(e.target.value)}><option value="">초안 선택</option>{detail.artifacts.filter((a) => a.plan_version === current.current_plan).map((a) => <option key={a.id} value={a.id}>계획 {a.plan_version} · 초안 {a.id}</option>)}</select></label>
              <button className="secondary" disabled={Boolean(busy)} onClick={() => void perform('대상 찾는 중', async () => { const result = await request<Target[]>(`${goalPath(selected)}/targets`); setTargets(result); setTargetId(''); if (!result.length) setNotice('선택할 수 있는 대상이 없습니다.'); })}>대상 찾기</button>
              <label>대상<select aria-label="대상" value={targetId} onChange={(e) => setTargetId(e.target.value)}><option value="">대상 선택</option>{targets.map((t) => <option key={t.eventId} value={t.eventId}>{t.source} · {t.account} · {t.title} · {t.externalId} · 버전 {t.revision}</option>)}</select></label>
              <button disabled={Boolean(busy) || !selectedArtifact || !targetId} onClick={() => void perform('승인 요청 중', async () => { await request(`${goalPath(selected)}/approvals`, { artifactId: Number(artifactId), targetEventId: Number(targetId) }); setNotice('승인 요청을 만들었습니다.'); })}>승인 요청</button>
            </div></details>
          </section>
          <ImprovementPanel goalId={selected} />
          <section className="panel-card"><h3>기억과 선호</h3><p className="muted">선호는 {current.project} 프로젝트에 저장됩니다.</p>
            {preferences.length ? preferences.map((p) => <div className="goal-step" key={p.key}><span>{p.key}: {p.value ?? '철회됨'}</span><small>버전 {p.version} · {dateText(p.observedAt)}</small></div>) : <p className="muted">저장된 선호가 없습니다.</p>}
            <div className="goal-form"><label>선호 이름<input value={prefKey} onChange={(e) => setPrefKey(e.target.value)} maxLength={50} /></label><label>선호 값<input value={prefValue} onChange={(e) => setPrefValue(e.target.value)} maxLength={400} /></label><div className="actions"><button disabled={Boolean(busy) || !prefKey.trim() || !prefValue.trim()} onClick={() => void savePreference(prefValue.trim())}>선호 저장</button><button className="secondary" disabled={Boolean(busy) || !selectedPreference || selectedPreference.value === null} onClick={() => void savePreference(null)}>선호 철회</button></div></div>
            {current.project === 'proposal-alpha' ? <details><summary>내 대화 기억 정정</summary><p className="muted">사용자 메시지만 정정하거나 기억에서 철회할 수 있습니다.</p>{messages.filter((m) => m.role === 'user').map((m) => <Correction key={m.id} message={m} busy={busy} save={(content) => perform('대화 기억 저장 중', async () => { await request(`/api/messages/${m.id}/correction`, { expectedVersion: m.version ?? 0, content }); await refreshMessages(); setNotice('대화 기억을 변경했습니다.'); })} />)}</details> : null}
          </section>
        </>}
      </div>
    </div>
  </section>;
}

function ScheduleControls({ schedules, busy, save, cancel }: { schedules: Schedule[]; busy: string; save: (body: unknown) => Promise<void>; cancel: (schedule: Schedule) => Promise<void> }) {
  const [kind, setKind] = useState<'daily_review' | 'weekly_review'>('daily_review');
  const [zone, setZone] = useState('Asia/Seoul');
  const [time, setTime] = useState('09:00');
  const [day, setDay] = useState('5');
  const currentSchedules = schedules.filter(schedule => schedule.current !== false);
  const existing = currentSchedules.find(schedule => schedule.kind === kind);
  useEffect(() => {
    if (existing?.time_zone) setZone(existing.time_zone);
    if (existing?.minute_of_day != null) setTime(`${String(Math.floor(existing.minute_of_day / 60)).padStart(2, '0')}:${String(existing.minute_of_day % 60).padStart(2, '0')}`);
    if (existing?.weekday != null) setDay(String(existing.weekday));
  }, [kind, existing?.schedule_id]);
  const [hour, minute] = time.split(':').map(Number);
  const valid = /^\d{2}:\d{2}$/.test(time) && hour < 24 && minute < 60 && zone.trim().length > 0;
  return <section className="panel-card"><h3>정기 점검</h3>
    <p className="muted">선택한 시간대의 현지 시각으로 점검합니다. 중단 중 놓친 점검은 최근 한 번만 처리합니다.</p>
    {currentSchedules.map(schedule => <div className="goal-record" key={schedule.schedule_id}><strong>{jobText(schedule.kind)} · {schedule.active ? '설정됨' : '중지됨'}</strong><small>{schedule.time_zone ?? '고정 UTC 간격'}{schedule.active ? ` · 다음 예정 ${dateText(schedule.next_due)}` : ''}</small>{schedule.active ? <button className="secondary" disabled={Boolean(busy)} onClick={() => void cancel(schedule)}>점검 일정 중지</button> : null}</div>)}
    <div className="goal-form"><label>반복<select aria-label="점검 반복" value={kind} onChange={event => setKind(event.target.value as 'daily_review' | 'weekly_review')}><option value="daily_review">매일</option><option value="weekly_review">매주</option></select></label>
      {kind === 'weekly_review' ? <label>요일<select aria-label="점검 요일" value={day} onChange={event => setDay(event.target.value)}>{['일', '월', '화', '수', '목', '금', '토'].map((name, index) => <option value={index} key={name}>{name}요일</option>)}</select></label> : null}
      <label>시간대<input aria-label="점검 시간대" value={zone} onChange={event => setZone(event.target.value)} maxLength={100} /></label><label>시각<input aria-label="점검 시각" type="time" value={time} onChange={event => setTime(event.target.value)} /></label>
      <button disabled={Boolean(busy) || !valid} onClick={() => void save({ kind, firstDueAt: Date.now(), ...(existing ? { expectedScheduleId: existing.schedule_id } : {}), civil: { timeZone: zone.trim(), minuteOfDay: hour * 60 + minute, ...(kind === 'weekly_review' ? { weekday: Number(day) } : {}) } })}>{existing?.active ? '점검 일정 변경' : existing ? '점검 일정 다시 시작' : '점검 일정 저장'}</button>
      {existing?.active ? <small>변경하면 기존 대기 일정은 취소되고 새 일정이 저장됩니다.</small> : null}
    </div>
  </section>;
}

function NotificationControls({ settings, busy, save }: { settings: NotificationSettings; busy: string; save: (path: string, body: unknown) => Promise<void> }) {
  const asTime = (minute: number) => `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
  const minutes = (value: string) => { const [hour, minute] = value.split(':').map(Number); return hour * 60 + minute; };
  const [zone, setZone] = useState(settings.quietHours?.time_zone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC');
  const [start, setStart] = useState(asTime(settings.quietHours?.start_minute ?? 1320));
  const [end, setEnd] = useState(asTime(settings.quietHours?.end_minute ?? 420));
  return <div className="goal-form"><p className="muted">새 승인 알림: {settings.enabled ? '켜짐' : '꺼짐'}{settings.bridgeAvailable ? '' : ' · Discord 업무 연결 미설정'}</p><p className="muted">알림을 받으려면 Discord 봇의 알림 전송도 활성화되어야 합니다.</p>
    <button className="secondary" disabled={Boolean(busy) || (!settings.enabled && !settings.bridgeAvailable)} onClick={() => void save('', { enabled: !settings.enabled })}>{settings.enabled ? '새 알림 끄기' : '새 알림 켜기'}</button>
    <details><summary>조용한 시간 설정</summary><p className="muted">직접 저장한 시간에만 알림을 지연합니다. 현재: {settings.quietHours ? `${settings.quietHours.time_zone} ${asTime(settings.quietHours.start_minute)}–${asTime(settings.quietHours.end_minute)}` : '설정 없음'}</p>
      <label>시간대<input value={zone} onChange={e => setZone(e.target.value)} maxLength={100} /></label><label>시작 시각<input type="time" value={start} onChange={e => setStart(e.target.value)} /></label><label>종료 시각<input type="time" value={end} onChange={e => setEnd(e.target.value)} /></label>
      <div className="actions"><button disabled={Boolean(busy) || !zone.trim() || !start || !end || start === end} onClick={() => void save('/quiet-hours', { quietHours: { timeZone: zone.trim(), startMinute: minutes(start), endMinute: minutes(end) } })}>조용한 시간 저장</button><button className="secondary" disabled={Boolean(busy) || !settings.quietHours} onClick={() => void save('/quiet-hours', { quietHours: null })}>조용한 시간 해제</button></div>
    </details>
  </div>;
}

function WorkspaceApproval({ approval, busy, decide }: { approval: Approval; busy: string; decide: (decision: string, text?: string) => Promise<void> }) {
  const [text, setText] = useState(approval.payload.body ?? approval.payload.comment ?? '');
  const effective = approval.effectiveStatus ?? approval.status;
  const canAct = effective === 'pending';
  return <article className="approval-card workspace-approval"><header><strong>{approval.action_type === 'mock_reply' ? 'Outlook 모의 회신' : approval.action_type === 'mock_jira_update' ? 'Jira 모의 변경' : approval.action_type}</strong><span>{statusText(effective)}</span></header><p>대상: {approval.payload.thread ?? approval.payload.issue ?? '확인 필요'} · {approval.payload.account} · 대상 버전 {approval.target_revision}</p><p>계획 {approval.plan_version} · 초안 {approval.artifact_id} · 만료 {dateText(approval.expires_at)}</p>{canAct ? <p>처리할 때 변경 여부를 다시 확인합니다.</p> : null}<pre>{approval.payload.body ?? approval.payload.comment}</pre><details><summary>전체 승인 데이터 보기</summary><pre>{JSON.stringify(approval.payload, null, 2)}</pre></details>{canAct ? <><label>내용 수정<textarea aria-label="목표 승인 내용 수정" value={text} onChange={(e) => setText(e.target.value)} maxLength={2000} /></label><div className="actions"><button disabled={Boolean(busy)} onClick={() => void decide('approve')}>모의 승인</button><button className="secondary" disabled={Boolean(busy) || !text.trim()} onClick={() => void decide('edit', text)}>수정 후 재승인</button><button className="secondary" disabled={Boolean(busy)} onClick={() => void decide('defer')}>승인 보류</button><button className="danger" disabled={Boolean(busy)} onClick={() => void decide('reject')}>거절</button></div></> : effective === 'deferred' ? <div className="actions"><button className="secondary" disabled={Boolean(busy)} onClick={() => void decide('resume')}>검토 재개</button><button className="danger" disabled={Boolean(busy)} onClick={() => void decide('reject')}>거절</button></div> : null}</article>;
}

function Correction({ message, busy, save }: { message: Message; busy: string; save: (content: string | null) => Promise<void> }) {
  const [text, setText] = useState(message.content);
  return <div className="goal-record"><small>대화 {message.id} · 버전 {message.version ?? 0}</small><p>{message.content}</p><label>정정 내용<textarea value={text} onChange={(e) => setText(e.target.value)} maxLength={2000} /></label><div className="actions"><button className="secondary" disabled={Boolean(busy) || !text.trim()} onClick={() => void save(text.trim())}>정정 저장</button><button className="secondary" disabled={Boolean(busy)} onClick={() => void save(null)}>기억 철회</button></div></div>;
}
