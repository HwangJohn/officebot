import React, { FormEvent, KeyboardEvent, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Activity,
  Archive,
  Bot,
  Check,
  ChevronRight,
  Clock3,
  Download,
  Edit3,
  FileText,
  Goal,
  Image,
  Inbox,
  LayoutDashboard,
  Menu,
  MessageSquare,
  Paperclip,
  Play,
  Send,
  Sparkles,
  X
} from 'lucide-react';
import './styles.css';
import { WorkspaceGoals } from './workspace-goals.js';
import { Dashboard } from './dashboard.js';

type Approval = {
  id: string;
  action_type: 'send_message' | 'jira_update';
  target: string;
  status: string;
  payload: Record<string, any>;
  task_version: number;
  target_version: number;
  expires_at: string;
  created_at: string;
  decided_at?: string;
  decision_note?: string;
};
type Analysis = {
  id: number;
  normalizedGoal: string;
  engine: string;
  stale: boolean;
  createdAt: string;
  source?: string;
  output: any;
  evidenceSources: Source[];
};
type Source = { id: string; source: string; sourceEventId: string; occurredAt: string; title: string; excerpt: string };
type Message = { id: number; role: 'user' | 'assistant'; content: string; analysisId?: number; createdAt: string };
type Artifact = { id: string; kind: string; title: string; createdAt: string; content?: string; stale?: boolean; output?: any; sources?: Source[]; imagePng?: string; imageSvg?: string };
type State = {
  mode: string;
  liveSdk: boolean;
  now: string;
  goal: any;
  todos: any[];
  latestDraft?: any;
  latestAnalysis?: Analysis;
  approvals: Approval[];
  outcomes: any[];
  events: any[];
  evidence: any[];
  digests: any[];
  messages: Message[];
  duplicateCount: number;
  jira: any;
};

const fixtureLabels = ['요청', '견적 대기', '정책', 'Jira', '목요일 정정', '견적 도착', '타 프로젝트', '중복 재생', '악성 데이터'];
const nav = [
  ['dashboard', LayoutDashboard, '대시보드'],
  ['chat', MessageSquare, '대화'],
  ['goals', Goal, '목표'],
  ['approvals', Inbox, '승인함'],
  ['artifacts', Archive, '산출물'],
  ['activity', Activity, '활동']
] as const;

type ApiInit = Omit<RequestInit, 'body'> & { body?: unknown };
async function api<T>(url: string, init?: ApiInit): Promise<T> {
  const options: RequestInit = { method: init?.method ?? 'GET', headers: init?.headers ?? {} };
  if (init?.body !== undefined) {
    options.headers = { ...options.headers, 'content-type': 'application/json' };
    options.body = JSON.stringify(init.body);
  }
  const res = await fetch(url, options);
  if (!res.ok) {
    let msg = res.statusText;
    try { msg = (await res.json()).error ?? msg; } catch { /* ignore */ }
    throw new Error(msg);
  }
  return res.json();
}

function fmtDate(value?: string) {
  if (!value) return '미정';
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : `${new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', dateStyle: 'medium', timeStyle: 'short' }).format(date)} (서울)`;
}

function sourceLabel(source: string) {
  return ({ outlook: 'Outlook', teams: 'Teams', jira: 'Jira', confluence: 'Confluence' } as Record<string, string>)[source] ?? source;
}

// The server's state includes every event, even when the evidence preview is truncated.
// A relevant state change conservatively invalidates a selected older cached analysis.
function contextKey(state: State) {
  return JSON.stringify([state.now, state.goal, state.jira, state.events.filter((event) => event.project === 'proposal-alpha')]);
}

function App() {
  const [state, setState] = useState<State | null>(null);
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [view, setView] = useState<typeof nav[number][0]>('dashboard');
  const [goalSelection, setGoalSelection] = useState<{ id: string; sequence: number } | null>(null);
  const [composer, setComposer] = useState('목요일 기한과 견적 대기 상태를 반영해서 제안서 회신 초안을 검토해줘');
  const [busy, setBusy] = useState('');
  const busyRef = useRef(false);
  const [selectedAnalysis, setSelectedAnalysis] = useState<{ analysis: Analysis; context: string } | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [drawer, setDrawer] = useState(false);
  const [preview, setPreview] = useState<Artifact | Source | null>(null);
  const [mobileNav, setMobileNav] = useState(false);
  const mobileMenuButton = useRef<HTMLButtonElement>(null);
  const mobileCloseButton = useRef<HTMLButtonElement>(null);
  const sidebarRef = useRef<HTMLElement>(null);
  const pending = state?.approvals.filter((a) => a.status === 'pending' || a.status === 'deferred').length ?? 0;
  const chatEnd = useRef<HTMLDivElement>(null);
  const mounted = useRef(false);
  const loading = useRef<Promise<State> | null>(null);

  async function load(): Promise<State> {
    while (loading.current) {
      try { await loading.current; } catch { /* a fresh attempt may recover */ }
    }
    if (!mounted.current) throw new Error('화면이 닫혔습니다.');
    const request = (async () => {
      const [nextState, nextArtifacts] = await Promise.all([api<State>('/api/state'), api<{ items: Artifact[] }>('/api/artifacts')]);
      if (mounted.current) {
        setState(nextState);
        setArtifacts(nextArtifacts.items);
        setSelectedAnalysis((selected) => selected && contextKey(nextState) !== selected.context
          ? { ...selected, analysis: { ...selected.analysis, stale: true } } : selected);
      }
      return nextState;
    })();
    loading.current = request;
    try { return await request; } finally { if (loading.current === request) loading.current = null; }
  }

  useEffect(() => {
    mounted.current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    let refreshing = false;
    let refreshAgain = false;
    const schedule = () => {
      clearTimeout(timer);
      if (!stopped && document.visibilityState === 'visible') timer = setTimeout(refresh, 5000);
    };
    const refresh = async () => {
      if (stopped || document.visibilityState !== 'visible') return;
      if (refreshing) { refreshAgain = true; return; }
      if (!busyRef.current) {
        refreshing = true;
        try { await load(); } catch (e) { if (!stopped) setError(e instanceof Error ? e.message : String(e)); }
        finally { refreshing = false; }
      }
      if (refreshAgain) { refreshAgain = false; if (!stopped && document.visibilityState === 'visible') { void refresh(); return; } }
      schedule();
    };
    const onVisibility = () => { clearTimeout(timer); if (document.visibilityState === 'visible') void refresh(); };
    document.addEventListener('visibilitychange', onVisibility);
    void refresh();
    return () => { stopped = true; mounted.current = false; clearTimeout(timer); document.removeEventListener('visibilitychange', onVisibility); };
  }, []);
  useEffect(() => {
    if (!mobileNav) return;
    mobileCloseButton.current?.focus();
    return () => { mobileMenuButton.current?.focus(); };
  }, [mobileNav]);
  useEffect(() => { chatEnd.current?.scrollIntoView({ block: 'end' }); }, [state?.messages.length]);
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => { if (event.key === 'Escape') { setPreview(null); setDrawer(false); setMobileNav(false); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  async function run(label: string, fn: () => Promise<unknown>) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(label);
    setError('');
    setNotice('');
    if (label !== 'analysis') setSelectedAnalysis(null);
    try { await fn(); await load(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { busyRef.current = false; setBusy(''); }
  }

  async function postMessage(role: 'user' | 'assistant', content: string, analysisId?: number) {
    await api('/api/messages', { method: 'POST', body: { role, content, analysisId } });
  }

  async function sendAnalysis() {
    const text = composer.trim();
    if (!text) return;
    await run('analysis', async () => {
      const before = await load();
      await postMessage('user', text);
      const result = await api<Analysis>('/api/analyze', { method: 'POST', body: { goalText: text } });
      const summary = result.output?.koreanSummary ?? '분석 결과를 저장했습니다.';
      await postMessage('assistant', `“${text}” 요청: ${summary}`, result.id);
      setSelectedAnalysis({ analysis: result, context: contextKey(before) });
      setComposer((current) => current.trim() === text ? '' : current);
    });
  }

  function onComposerKey(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void sendAnalysis();
    }
  }

  function onSidebarKey(event: KeyboardEvent<HTMLElement>) {
    if (!mobileNav || event.key !== 'Tab') return;
    const controls = Array.from(sidebarRef.current?.querySelectorAll<HTMLButtonElement>('button:not([disabled])') ?? []);
    if (!controls.length) return;
    const first = controls[0], last = controls[controls.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }

  async function firstRun() {
    await run('demo', async () => {
      const existing = await api<State>('/api/state');
      const sampleIds = ['outlook-001', 'teams-001', 'conf-001', 'jira-001', 'teams-002'];
      if (existing.latestDraft && sampleIds.every((id) => existing.events.some((event) => event.source_event_id === id))) {
        setNotice('이미 열린 샘플 업무입니다. 저장된 진행 상태를 그대로 보여줍니다.');
        return;
      }
      let inserted = false;
      for (const i of [0, 1, 2, 3, 4]) {
        const result = await api<{ inserted: boolean }>(`/api/fixtures/${i}`, { method: 'POST', body: {} });
        inserted ||= result.inserted;
      }
      const current = await api<State>('/api/state');
      if (!inserted && current.latestDraft) {
        setNotice('이미 열린 샘플 업무입니다. 저장된 진행 상태를 그대로 보여줍니다.');
        return;
      }
      await api('/api/step', { method: 'POST', body: {} });
      const updated = await api<State>('/api/state');
      await postMessage('assistant', `샘플 업무를 열었습니다. 기한은 ${updated.goal.due_date || '미정'}이며, 다음 단계는 ${updated.goal.next_step}입니다.`);
      const result = await api<Analysis>('/api/analyze', { method: 'POST', body: { goalText: '샘플 제안서 보완 상태를 간단히 정리해줘' } });
      await postMessage('assistant', result.output?.koreanSummary ?? '오프라인 분석을 저장했습니다.', result.id);
    });
  }

  const currentAnalysis = selectedAnalysis?.analysis ?? state?.latestAnalysis;
  if (!state) return <div className="boot" role={error ? "alert" : "status"}>{error ? "작업 공간을 불러오지 못했습니다. 연결을 확인해 주세요. 자동으로 다시 시도합니다." : "Officebot 작업 공간을 여는 중..."}</div>;

  return (
    <div className={`app-shell ${view === 'dashboard' ? 'dashboard-shell' : ''}`}>
      {mobileNav ? <div className="mobile-nav-backdrop" onClick={() => setMobileNav(false)} /> : null}
      <aside ref={sidebarRef} className={`sidebar ${mobileNav ? 'open' : ''}`} onKeyDown={onSidebarKey} role={mobileNav ? 'dialog' : undefined} aria-modal={mobileNav ? true : undefined} aria-label={mobileNav ? '메뉴' : undefined}>
        <div className="brand">
          <div className="mark" aria-hidden="true"><span /><span /><span /></div>
          <div>
            <strong>Officebot</strong>
            <small>개인 업무 비서</small>
          </div>
          <button ref={mobileCloseButton} className="icon close-mobile" aria-label="메뉴 닫기" onClick={() => setMobileNav(false)}><X size={18} /></button>
        </div>
        <nav>
          {nav.map(([id, Icon, label]) => (
            <button key={id} className={view === id ? 'active' : ''} onClick={() => { setView(id); setMobileNav(false); }}>
              <Icon size={18} /> <span>{label}</span>
              {id === 'approvals' && pending > 0 ? <em>{pending}</em> : null}
            </button>
          ))}
        </nav>
        <section className="app-list">
          <h2>연결 앱</h2>
          {['Outlook', 'Teams', 'Jira', 'Confluence'].map((name) => <div key={name}><span>{name}</span><b>MOCK</b></div>)}
        </section>
        <button className="scenario" onClick={() => setDrawer(true)}><Play size={16} /> 데모 시나리오</button>
      </aside>

      <main className="workspace">
        <header className="topbar">
          <button ref={mobileMenuButton} className="icon mobile-menu" aria-label="메뉴 열기" onClick={() => setMobileNav(true)}><Menu size={20} /></button>
          <div>

            <p>{view === 'dashboard' ? '개인 업무 비서' : <>샘플 워크스페이스 · {state.mode === 'openai' ? 'OpenAI 설정' : '오프라인'}</>}</p>

            <h1>{view === 'dashboard' ? '대시보드' : view === 'goals' ? '나의 목표' : '고객 제안서 보완'}</h1>
          </div>

          {view !== 'dashboard' ? <div className="status-pill"><Clock3 size={16} /> 데모 시간 {fmtDate(state.now)}</div> : null}
        </header>
        {busy ? <div className="work-status busy-status" role="status">{busy === 'demo' ? '샘플 업무 준비 처리 중' : busy === 'analysis' ? '분석 요청 처리 중' : '요청 처리 중'} · 완료되면 버튼을 사용할 수 있습니다.</div> : null}
        {error ? <div className="error" role="alert">{error}</div> : null}
        {notice ? <div className="work-status" role="status">{notice}</div> : null}

        <div hidden={view !== 'dashboard'}><Dashboard active={view === 'dashboard'} openGoal={(id) => { if (id) setGoalSelection(prev => ({ id, sequence: (prev?.sequence ?? 0) + 1 })); setView('goals'); }} openActivity={() => setView('activity')} openApprovals={() => setView('approvals')} /></div>
        {view === 'chat' ? <ChatView state={state} analysis={currentAnalysis} busy={busy} composer={composer} setComposer={setComposer} onKey={onComposerKey} send={sendAnalysis} firstRun={firstRun} setPreview={setPreview} chatEnd={chatEnd} /> : null}
        <div hidden={view !== 'goals'}><WorkspaceGoals selectionRequest={goalSelection} active={view === 'goals'} projects={[...new Set(state.events.map((event) => String(event.project)).filter(Boolean))]} messages={state.messages} refreshMessages={load} /></div>
        {view === 'approvals' ? <ApprovalView approvals={state.approvals} busy={busy} run={run} /> : null}
        {view === 'artifacts' ? <ArtifactsView artifacts={artifacts} setPreview={setPreview} /> : null}
        {view === 'activity' ? <ActivityView state={state} run={run} busy={busy} /> : null}
      </main>

      <aside className="context-panel" hidden={view === 'dashboard'}>
        {view === 'goals' ? <section className="panel-block"><div className="panel-title"><Goal size={17} /> 목표별 작업 공간</div><p>각 목표의 계획, 근거, 산출물과 승인 내역을 확인하세요.</p></section> : <>
        <section className="panel-block">
          <div className="panel-title"><Sparkles size={17} /> 현재 상태</div>
          <strong>{state.goal.status}</strong>
          <p>{state.goal.next_step}</p>
          <dl>
            <div><dt>기한</dt><dd>{fmtDate(state.goal.due_date)}</dd></div>
            <div><dt>견적</dt><dd>{state.goal.quote || '대기'}</dd></div>
          </dl>
        </section>
        <section className="panel-block">
          <div className="panel-title"><Paperclip size={17} /> 최신 근거</div>
          {state.evidence.slice(0, 4).map((ev) => (
            <button className="source-link" key={ev.id} onClick={() => setPreview(ev)}>
              <span>{sourceLabel(ev.source)} · {ev.sourceEventId}{ev.trusted ? '' : ' · 신뢰하지 않는 자료'}</span>
              <strong>{ev.title}</strong>
            </button>
          ))}
        </section>
        <section className="panel-block">
          <div className="panel-title"><Image size={17} /> 아키텍처</div>
          <button className="image-mini" onClick={() => setPreview(artifacts.find((a) => a.id === 'architecture-overview') ?? null)}>
            <img src="/api/assets/architecture-overview.svg" alt="업무 비서 흐름 개요" />
          </button>
        </section>
        </>}
      </aside>

      {drawer ? <ScenarioDrawer busy={busy} run={run} close={() => setDrawer(false)} firstRun={firstRun} /> : null}
      {preview ? <Preview item={preview} close={() => setPreview(null)} /> : null}
    </div>
  );
}

function ChatView({ state, analysis, busy, composer, setComposer, onKey, send, firstRun, setPreview, chatEnd }: any) {
  const messages: Message[] = state.messages.length ? state.messages : [
    { id: 0, role: 'assistant', content: '아직 대화 기록이 없습니다. 샘플 업무를 열면 실제 fixture를 수집하고 오프라인 분석을 저장합니다.', createdAt: state.now }
  ];
  return (
    <section className="conversation view">
      <div className="agent-strip">
        <Bot size={24} />
        <div><strong>Officebot</strong><span>읽기 전용 분석 제안 · 실행은 승인 카드로 분리</span></div>
        <button onClick={firstRun} disabled={Boolean(busy)}><Play size={16} /> 샘플 업무 열기</button>
      </div>
      <div className="messages">
        {messages.map((m) => <article key={m.id} className={`message ${m.role}`}><p>{m.content}</p><time>{fmtDate(m.createdAt)}</time></article>)}
        {analysis ? <AnalysisCard analysis={analysis} setPreview={setPreview} hideSummary={messages.some((m) => m.role === 'assistant' && m.analysisId === analysis.id)} /> : null}
        <div ref={chatEnd} />
      </div>
      <div className="suggestions">
        {['현재 대기 조건 정리', '목요일 기한 기준 초안 검토', '근거 출처를 함께 요약'].map((text) => <button key={text} onClick={() => setComposer(text)}>{text}</button>)}
      </div>
      <form className="composer" onSubmit={(e: FormEvent) => { e.preventDefault(); void send(); }}>
        <textarea value={composer} onChange={(e) => setComposer(e.target.value)} onKeyDown={onKey} maxLength={1000} placeholder="Officebot에게 업무 맥락을 근거 기반으로 분석해 달라고 요청하세요" />
        <button className="send" aria-label="분석 요청 보내기" disabled={Boolean(busy) || !composer.trim()}><Send size={18} /></button>
      </form>
    </section>
  );
}

function AnalysisCard({ analysis, setPreview, hideSummary }: { analysis: Analysis; setPreview: (s: Source) => void; hideSummary: boolean }) {
  const output = analysis.output ?? {};
  return (
    <article className={`work-card ${analysis.stale ? 'stale' : ''}`}>
      <header><FileText size={18} /><strong>{output.draftProposal?.title || '저장된 분석 제안'}</strong><span>{analysis.stale ? '오래됨' : analysis.source === 'cached' ? '캐시' : analysis.engine === 'offline-mock' ? '오프라인 샘플' : analysis.engine}</span></header>
      <small>표시 목표: {analysis.normalizedGoal}</small>
      {!hideSummary ? <p>{output.koreanSummary}</p> : null}
      <div className="mini-list">
        {(output.suggestedNextSteps ?? []).slice(0, 3).map((s: any, i: number) => <div key={i}><ChevronRight size={15} /> {s.text}</div>)}
      </div>
      <details>
        <summary>인용 출처 보기</summary>
        {(analysis.evidenceSources ?? []).map((s) => <button className="citation" key={s.id} onClick={() => setPreview(s)}>{s.id} · {sourceLabel(s.source)} · {s.title}</button>)}
      </details>
    </article>
  );
}

function ApprovalView({ approvals, busy, run }: any) {
  return (
    <section className="view approvals">
      {approvals.length === 0 ? <div className="empty"><Inbox size={32} /> 승인 대기 항목이 없습니다.</div> : approvals.map((approval: Approval) => <ApprovalCard key={approval.id} approval={approval} busy={busy} run={run} />)}
    </section>
  );
}

function ApprovalCard({ approval, busy, run }: any) {
  const payload = approval.payload ?? {};
  const editableKey = approval.action_type === 'jira_update' ? 'comment' : 'body';
  const [edit, setEdit] = useState(payload[editableKey] ?? '');
  const [review, setReview] = useState<{ status: string; evidence: string; reviewToken?: string; recoveryToken?: string; scope?: { target: string; taskVersion: number; targetVersion: number } } | null>(null);
  const canAct = approval.status === 'pending' || approval.status === 'deferred';
  const title = approval.action_type === 'jira_update' ? `Jira ${payload.target ?? approval.target} 댓글/상태 변경` : `${payload.recipient ?? approval.target}에게 메시지 발송`;
  const decide = (decision: string, body?: any) => run(`${approval.id}:${decision}`, () => api(`/api/approvals/${encodeURIComponent(approval.id)}/decide`, { method: 'POST', body: { decision, edit: body } }));
  return (
    <article className={`approval-card ${approval.status}`}>
      <header><strong>{title}</strong><span>{approval.status === 'reconciled_no_effect' ? '목업 실행 없음 확인' : approval.status}</span></header>
      {payload.subject ? <h3>{payload.subject}</h3> : null}
      <pre>{payload.body ?? payload.comment}</pre>
      <details><summary>버전과 만료 정보</summary><p>업무 v{approval.task_version} · 대상 v{approval.target_version} · 만료 {fmtDate(approval.expires_at)} · {approval.id}</p></details>
      {approval.status === 'processing' ? <div className="goal-record"><p>로컬 목업 처리가 끝나지 않았습니다. 복구하면 늦게 돌아온 실행을 차단하고 결과 확인 상태로 바꿉니다.</p><button className="secondary" disabled={Boolean(busy)} onClick={() => void run(`${approval.id}:inspect`, async () => { setReview(await api(`/api/approvals/${encodeURIComponent(approval.id)}/reconciliation`)); })}>복구 범위 확인</button>
        {review?.status === 'processing' && review.recoveryToken ? <><p>대상 {review.scope?.target} · 업무 v{review.scope?.taskVersion} · 대상 v{review.scope?.targetVersion}</p><button disabled={Boolean(busy)} onClick={() => void run(`${approval.id}:recover`, async () => { await api(`/api/approvals/${encodeURIComponent(approval.id)}/recovery`, { method: 'POST', body: { recoveryToken: review.recoveryToken } }); setReview(null); })}>늦은 목업 실행 차단 후 결과 확인</button></> : review?.status === 'processing' ? <p>이 요청은 안전하게 복구할 수 없어 보류합니다.</p> : null}</div> : null}
      {approval.status === 'uncertain' ? <div className="goal-record"><p>목업 실행 결과를 확인해야 합니다. 실제 회사 시스템의 결과는 확인하지 않습니다.</p><button className="secondary" disabled={Boolean(busy)} onClick={() => void run(`${approval.id}:inspect`, async () => { setReview(await api(`/api/approvals/${encodeURIComponent(approval.id)}/reconciliation`)); })}>목업 결과 확인</button>
        {review?.status === 'uncertain' ? <><p>{review.evidence === 'mock_no_effect' ? '로컬 목업 실행 기록이 없습니다. 이전 요청을 닫은 뒤 새 실행에는 새 승인이 필요합니다.' : review.evidence === 'mock_effect_recorded' ? '일치하는 로컬 목업 실행 기록이 있습니다.' : '기록이 모순되어 결과를 확인하지 못했습니다. 보류를 유지합니다.'}</p>{review.scope ? <small>대상 {review.scope.target} · 업무 v{review.scope.taskVersion} · 대상 v{review.scope.targetVersion}</small> : null}{review.evidence !== 'unresolved' && review.reviewToken ? <button disabled={Boolean(busy)} onClick={() => void run(`${approval.id}:reconcile`, async () => { await api(`/api/approvals/${encodeURIComponent(approval.id)}/reconciliation`, { method: 'POST', body: { reviewToken: review.reviewToken } }); setReview(null); })}>확인한 목업 결과 기록</button> : null}</> : null}</div> : null}
      <textarea value={edit} onChange={(e) => setEdit(e.target.value)} disabled={!canAct} aria-label="승인 내용 수정" />
      <div className="actions">
        <button onClick={() => decide('approve')} disabled={!canAct || Boolean(busy)}><Check size={15} /> 승인</button>
        <button className="secondary" onClick={() => decide('edit', { [editableKey]: edit })} disabled={!canAct || Boolean(busy)}><Edit3 size={15} /> 수정 후 재승인</button>
        <button className="secondary" onClick={() => decide('defer')} disabled={!canAct || Boolean(busy)}>나중에</button>
        <button className="danger" onClick={() => decide('reject')} disabled={!canAct || Boolean(busy)}>거절</button>
      </div>
    </article>
  );
}

function ArtifactsView({ artifacts, setPreview }: any) {
  return <section className="view artifact-list">{artifacts.map((a: Artifact) => (
    <button key={a.id} className="artifact-row" onClick={() => setPreview(a)}>
      {a.kind === 'image' ? <Image size={20} /> : <FileText size={20} />}
      <span><strong>{a.title}</strong><small>{a.kind} · {fmtDate(a.createdAt)} {a.stale ? '· 오래됨' : ''}</small></span>
      <ChevronRight size={18} />
    </button>
  ))}</section>;
}

function ActivityView({ state, run, busy }: any) {
  const items = [
    ...state.events.map((e: any) => ({ t: e.processed_at ?? e.occurred_at, k: sourceLabel(e.source), v: e.title })),
    ...state.approvals.map((a: any) => ({ t: a.decided_at ?? a.created_at, k: `승인 ${a.status}`, v: a.id })),
    ...state.outcomes.map((o: any) => ({ t: o.created_at, k: `실행 ${o.status}`, v: o.action_id })),
    ...state.digests.map((d: any) => ({ t: d.created_at, k: d.kind, v: d.content }))
  ].sort((a, b) => String(b.t).localeCompare(String(a.t)));
  return <section className="view activity-view">
    <p>데모 시간: {fmtDate(state.now)}</p>
    <div className="clock-actions">
      <button onClick={() => run('day', () => api('/api/clock/advance', { method: 'POST', body: { kind: 'day' } }))} disabled={Boolean(busy)}>데모 하루 진행</button>
      <button className="secondary" onClick={() => run('week', () => api('/api/clock/advance', { method: 'POST', body: { kind: 'week' } }))} disabled={Boolean(busy)}>데모 주간 점검</button>
    </div>
    {items.map((item, i) => <article key={`${item.t}-${i}`}><time>{fmtDate(item.t)}</time><strong>{item.k}</strong><p>{item.v}</p></article>)}
  </section>;
}

function ScenarioDrawer({ busy, run, close, firstRun }: any) {
  return <div className="drawer-backdrop" role="dialog" aria-modal="true"><aside className="drawer">
    <header><strong>데모 시나리오</strong><button className="icon" aria-label="닫기" onClick={close}><X size={18} /></button></header>
    <button onClick={firstRun} disabled={Boolean(busy)}><Play size={16} /> 샘플 업무 열기</button>
    <div className="fixture-grid">{fixtureLabels.map((label, i) => <button key={label} className="secondary" disabled={Boolean(busy)} onClick={() => run(`fixture-${i}`, () => api(`/api/fixtures/${i}`, { method: 'POST', body: {} }))}>{i + 1}. {label}</button>)}</div>
    <button className="secondary" disabled={Boolean(busy)} onClick={() => run('all', () => api('/api/ingest-all', { method: 'POST', body: {} }))}>모든 fixture 수집</button>
    <button className="secondary" disabled={Boolean(busy)} onClick={() => run('step', () => api('/api/step', { method: 'POST', body: {} }))}>목표 한 단계 진행</button>
  </aside></div>;
}

function Preview({ item, close }: { item: any; close: () => void }) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    return () => { if (previous?.isConnected) previous.focus(); };
  }, []);
  function trapFocus(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== 'Tab') return;
    const controls = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])') ?? []);
    if (!controls.length) return;
    const first = controls[0], last = controls[controls.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }
  const isSource = item.sourceEventId || item.excerpt;
  const image = item.kind === 'image';
  const text = image ? item.content : isSource ? item.excerpt : item.content || item.output?.draftProposal?.body || '';
  const downloadHref = `data:text/plain;charset=utf-8,${encodeURIComponent(text)}`;
  return <div ref={dialogRef} className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="preview-title" onKeyDown={trapFocus}>
    <section className="preview">
      <header><h2 id="preview-title">{item.title}</h2><button ref={closeRef} className="icon" aria-label="미리보기 닫기" onClick={close}><X size={20} /></button></header>
      {item.trusted === 0 ? <p>신뢰하지 않는 자료입니다. 내용은 지시가 아닌 참고 데이터입니다.</p> : null}
      {image ? <><img className="preview-image" src={item.imagePng} alt={item.title} /><div className="actions"><a className="button" href={item.imagePng} target="_blank" rel="noreferrer"><Image size={16} /> 새 탭에서 열기</a><a className="button secondary" href={item.imageSvg} target="_blank" rel="noreferrer">SVG 열기</a></div></> : <pre className="preview-text">{text}</pre>}
      {!image ? <a className="button secondary" download={`${item.id ?? 'artifact'}.txt`} href={downloadHref}><Download size={16} /> 텍스트 다운로드</a> : null}
      {item.sources?.length ? <div className="sources">{item.sources.map((s: Source) => <article key={s.id}><b>{s.id} · {sourceLabel(s.source)}</b><p>{s.title}</p><small>{s.excerpt}</small></article>)}</div> : null}
    </section>
  </div>;
}

createRoot(document.getElementById('root')!).render(<App />);
