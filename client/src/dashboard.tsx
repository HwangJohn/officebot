import React, { useEffect, useRef, useState } from 'react';
import { AlertTriangle, ArrowRight, CalendarDays, CircleHelp, RefreshCw } from 'lucide-react';
import type { SystemOverview } from '../../src/systemOverview.js';

type Props = { active: boolean; openGoal: (id?: string) => void; openActivity: () => void; openApprovals: () => void };
const date = (value: string | number) => { const d = new Date(value); return Number.isNaN(d.getTime()) ? '시각 확인 불가' : new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', dateStyle: 'medium', timeStyle: 'short' }).format(d) + ' (서울)'; };
const kind = (value: string) => ({ event: '자료 변경 확인', daily_review: '일간 점검', weekly_review: '주간 점검', notification: '알림' } as Record<string, string>)[value] ?? '업무';

export function Dashboard({ active, openGoal, openActivity, openApprovals }: Props) {
  const [snapshot, setSnapshot] = useState<SystemOverview | null>(null);
  const [failed, setFailed] = useState(false);
  const [refreshToken, setRefreshToken] = useState(0);
  const inFlight = useRef(false);
  useEffect(() => {
    if (!active) return;
    let stopped = false, timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | undefined;
    const schedule = () => { if (!stopped && document.visibilityState === 'visible') timer = setTimeout(load, 10000); };
    async function load() {
      if (stopped || document.visibilityState !== 'visible') return;
      if (inFlight.current) { timer = setTimeout(load, 100); return; }
      inFlight.current = true;
      controller = new AbortController();
      const timeout = setTimeout(() => controller?.abort(), 8000);
      try {
        const response = await fetch('/api/overview', { signal: controller.signal, cache: 'no-store' });
        if (!response.ok) throw new Error('overview unavailable');
        const value = await response.json() as SystemOverview;
        if (value.version !== 1 || !value.collectedAt || !value.goals || !value.jobs || !value.runtime) throw new Error('invalid overview');
        if (!stopped && document.visibilityState === 'visible') { setSnapshot(value); setFailed(false); }
      } catch {
        if (!stopped && document.visibilityState === 'visible') setFailed(true);
      } finally { clearTimeout(timeout); inFlight.current = false; if (!stopped) schedule(); }
    }
    function visibility() { clearTimeout(timer); if (document.visibilityState === 'hidden') controller?.abort(); else if (!inFlight.current) void load(); }
    document.addEventListener('visibilitychange', visibility);
    void load();
    return () => { stopped = true; clearTimeout(timer); controller?.abort(); document.removeEventListener('visibilitychange', visibility); };
  }, [active, refreshToken]);
  const retry = () => setRefreshToken(n => n + 1);
  if (!snapshot) return <section className="dashboard" aria-label="시스템 대시보드">{failed ? <div className="dashboard-empty" role="alert"><h2>현황을 불러오지 못했습니다</h2><p>연결을 확인한 후 다시 시도해 주세요.</p><button onClick={retry}>다시 시도</button></div> : <div className="dashboard-empty" role="status">저장된 현황을 불러오는 중입니다...</div>}</section>;
  const { goals, approvals, jobs, runtime } = snapshot;
  const deferred = approvals.deferred ?? 0;
  const attention = approvals.pending + deferred + approvals.invalid + snapshot.legacyApprovals.pending + snapshot.legacyApprovals.invalid + jobs.failed + jobs.held + snapshot.deliveries.held;
  return <section className="dashboard" aria-label="시스템 대시보드">
    {failed ? <div className="dashboard-warning" role="alert"><AlertTriangle size={18} /> 새로고침에 실패했습니다. 아래는 마지막 성공 시점의 오래된 정보입니다. <button onClick={retry}>다시 시도</button></div> : null}
    <section className="runtime-summary" aria-label="시스템 상태 요약">
      <h3>시스템 상태</h3>
      <div className="runtime-summary-grid">
        <div><span>실행 모드</span><strong>{runtime.engine === 'offline' ? '오프라인' : 'OpenAI 설정됨'}</strong><small>모델 미관찰</small></div>
        <div><span>Discord</span><strong>{runtime.discord.state === 'unobserved' ? (runtime.discord.configured ? '설정됨 · 미관찰' : '미관찰') : runtime.discord.state === 'connected' ? '연결 관찰됨' : '연결 끊김 관찰됨'}</strong><small>{runtime.discord.observedAt ? `관찰 ${date(runtime.discord.observedAt)}` : '최근 관찰 기록 없음'}</small></div>
        <div><span>백그라운드 일정</span><strong>{runtime.scheduler === 'configured' ? '설정됨 · 실행 미확인' : '꺼짐'}</strong><small>Temporal {runtime.temporal === 'configured' ? '설정됨 · 미관찰' : '꺼짐'}</small></div>
        <div><span>Discord 알림</span><strong>대기 {snapshot.deliveries.queued} · 보류 {snapshot.deliveries.held}</strong><small>전송 중 {snapshot.deliveries.sending}</small></div>
      </div>
    </section>
    <div className="dashboard-intro"><div><span className="eyebrow">YOUR WORK, AT A GLANCE</span><h2>오늘의 업무 현황</h2><p>{attention ? `확인이 필요한 항목 ${attention}건이 있습니다.` : '현재 확인된 승인·실패·보류 항목이 없습니다.'} 저장된 목표와 예정된 업무를 한눈에 살펴보세요.</p></div><div className="snapshot-time"><span>{failed ? '마지막 성공 · 오래됨' : '마지막 성공 수집'}</span><strong>{date(snapshot.collectedAt)}</strong><button className="refresh-link" onClick={retry} aria-label="현황 새로고침"><RefreshCw size={15} /> 새로고침</button></div></div>
    <div className="dashboard-stats" aria-label="업무 요약">
      <button onClick={() => openGoal()}><span>진행 중인 목표</span><strong>{goals.active}</strong><small>계획 단계 완료 {goals.completed}</small></button>
      <button onClick={() => approvals.items[0] ? openGoal(approvals.items[0].goalId) : snapshot.legacyApprovals.items.length ? openApprovals() : openGoal()}><span>승인 확인</span><strong>{approvals.pending + snapshot.legacyApprovals.pending}</strong><small>보류 {deferred} · 무효 확인 {approvals.invalid + snapshot.legacyApprovals.invalid} · 유효성 미확인</small></button>
      <button onClick={() => openGoal()}><span>실행 업무</span><strong>{jobs.running}</strong><small>대기열 {jobs.queued} · 예정 {jobs.waiting} · 일정 {snapshot.scheduleCount}</small></button>
      <button onClick={() => openGoal(jobs.attention[0]?.goalId)}><span>확인이 필요한 업무</span><strong>{jobs.failed + jobs.held + snapshot.deliveries.held}</strong><small>실패 {jobs.failed} · 보류 {jobs.held + snapshot.deliveries.held}</small></button>
    </div>
    <section className="dashboard-panel attention-panel"><div className="dashboard-heading"><div><span className="eyebrow">NEEDS ATTENTION</span><h3>먼저 확인할 일</h3></div><AlertTriangle size={20} /></div>
      {attention === 0 ? <p className="dashboard-muted">현재 확인된 항목이 없습니다. 연결 상태는 아래에서 별도로 확인하세요.</p> : <div className="dashboard-list">
        {jobs.attention.map((item, i) => <button className="dashboard-row" key={`j${i}`} onClick={() => openGoal(item.goalId)}><span className="severity">{item.status === 'held' ? '보류' : '실패'}</span><span><strong>{kind(item.kind)}</strong><small>{item.status === 'held' ? '외부 결과 확인이 필요합니다.' : '목표에서 실패 내역을 확인하세요.'}</small></span><ArrowRight size={17} /></button>)}
        {snapshot.deliveries.attention.map((item, i) => <button className="dashboard-row" key={`d${i}`} onClick={() => openGoal(item.goalId)}><span className="severity">보류</span><span><strong>Discord 알림 결과 확인</strong><small>발송 결과가 불확실합니다. 자동 재전송하지 않습니다.</small></span><ArrowRight size={17} /></button>)}
        {snapshot.legacyApprovals.items.map(item => <button className="dashboard-row" key={`legacy-${item.id}`} onClick={openApprovals}><span className="severity">{item.status === 'invalid' ? '무효' : '승인'}</span><span><strong>{item.status === 'invalid' ? '샘플 업무 승인 무효' : '샘플 업무 승인 검토'}</strong><small>승인함에서 정확한 내용을 확인하세요.</small></span><ArrowRight size={17} /></button>)}
        {approvals.items.map(item => <button className="dashboard-row" key={item.id} onClick={() => openGoal(item.goalId)}><span className="severity">{item.status === 'invalid' ? '무효' : item.status === 'deferred' ? '보류' : '승인'}</span><span><strong>{item.status === 'invalid' ? '변경되었거나 만료된 승인' : item.status === 'deferred' ? '보류한 승인' : '검토 대기 중인 승인'}</strong><small>목표에서 정확한 내용과 유효성을 확인하세요.</small></span><ArrowRight size={17} /></button>)}
      </div>}
      {attention > jobs.attention.length + approvals.items.length + snapshot.legacyApprovals.items.length + snapshot.deliveries.attention.length ? <p className="dashboard-muted">일부 항목만 표시합니다. 목표 화면에서 전체 내역을 확인하세요.</p> : null}
    </section>
    <div className="dashboard-columns"><section className="dashboard-panel"><div className="dashboard-heading"><div><span className="eyebrow">GOALS</span><h3>목표 진행</h3></div><button className="text-link" onClick={() => openGoal()}>전체 보기 <ArrowRight size={15} /></button></div>
      {!goals.items.length ? <p className="dashboard-muted">저장된 목표가 없습니다. 목표 화면에서 시작해 보세요.</p> : <div className="dashboard-list">{goals.items.map(g => <button className="dashboard-goal" key={g.id} onClick={() => openGoal(g.id)}><span><strong>{g.title}</strong><small>{g.project} · 다음: {g.nextStep}</small></span><span className="goal-progress">{g.completedSteps}/{g.totalSteps}<small>계획 단계</small></span></button>)}</div>}
      <p className="dashboard-footnote">계획 단계 완료는 실제 목표 달성 여부와 다를 수 있습니다.</p>
    </section><section className="dashboard-panel"><div className="dashboard-heading"><div><span className="eyebrow">UP NEXT</span><h3>다가오는 일정</h3></div><CalendarDays size={19} /></div>
      {!snapshot.schedules.length ? <p className="dashboard-muted">등록된 활성 일정이 없습니다.</p> : <div className="dashboard-list">{snapshot.schedules.map((s, i) => <button className="dashboard-row" key={`${s.goalId}-${i}`} onClick={() => openGoal(s.goalId)}><span className="schedule-icon"><CalendarDays size={17} /></span><span><strong>{kind(s.kind)}</strong><small>{date(s.dueAt)}</small></span><ArrowRight size={17} /></button>)}</div>}
    </section></div>
    <div className="dashboard-columns"><section className="dashboard-panel"><div className="dashboard-heading"><div><span className="eyebrow">RECENT</span><h3>최근 활동</h3></div><button className="text-link" onClick={openActivity}>활동 보기 <ArrowRight size={15} /></button></div>
      {!snapshot.events.length && !snapshot.artifacts.length ? <p className="dashboard-muted">아직 기록된 활동이 없습니다.</p> : <div className="dashboard-list">{snapshot.artifacts.slice(0, 4).map(a => <button className="dashboard-row" key={`a${a.id}`} onClick={() => openGoal(a.goalId)}><span className="activity-dot" /><span><strong>산출물 생성</strong><small>{date(a.createdAt)}</small></span><ArrowRight size={17} /></button>)}{snapshot.events.slice(0, 4).map(e => <button className="dashboard-row" key={`e${e.id}`} onClick={openActivity}><span className="activity-dot" /><span><strong>{e.title || '자료 수집'}</strong><small>{e.source} · {e.project} · {date(e.occurredAt)}</small></span><ArrowRight size={17} /></button>)}</div>}
    </section><section className="dashboard-panel"><div className="dashboard-heading"><div><span className="eyebrow">CONNECTIONS & RUNTIME</span><h3>연결 및 실행 상태</h3></div><CircleHelp size={19} /></div>
      <div className="runtime-line"><span>실행 모드</span><strong>{runtime.engine === 'offline' ? '오프라인' : 'OpenAI 설정됨'}</strong></div><div className="runtime-line"><span>모델 연결</span><strong>관찰되지 않음</strong></div><div className="runtime-line"><span>백그라운드 일정</span><strong>{runtime.scheduler === 'configured' ? '설정됨 · 상태 미관찰' : '꺼짐'}</strong></div><div className="runtime-line"><span>Temporal 파일럿</span><strong>{runtime.temporal === 'configured' ? '설정됨 · 상태 미관찰' : '꺼짐'}</strong></div><div className="runtime-line"><span>Discord 알림</span><strong>대기 {snapshot.deliveries.queued} · 전송 중 {snapshot.deliveries.sending} · 보류 {snapshot.deliveries.held}</strong></div><div className="runtime-line"><span>Discord</span><strong>{runtime.discord.state === 'unobserved' ? (runtime.discord.configured ? '설정됨 · 미관찰' : '미관찰') : runtime.discord.state === 'connected' ? '연결 관찰됨' : '연결 끊김 관찰됨'}</strong></div><p className="dashboard-footnote">Discord 관찰: {runtime.discord.observedAt ? date(runtime.discord.observedAt) : '기록 없음'} · 수집: {date(snapshot.collectedAt)} · 승인 기준 시각: {date(approvals.clock)}</p><div className="mock-label">Teams · Outlook · Jira · Confluence <b>모의 연결</b></div>
    </section></div>
  </section>;
}
