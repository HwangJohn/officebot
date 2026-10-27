import { createService } from '../../src/core.js';
import { fixtures } from '../../src/fixtures.js';

const dbPath = process.argv[2];
const liveAdapterFactory = () => ({
  prepare: async (id: string) => ({ snapshot: `snap:${id}` }),
  decide: async (id: string) => {
    process.send?.({ approvalId: id });
    return new Promise<{ snapshot: string }>(() => {});
  }
});
const service = createService({ dbPath, engine: 'openai', liveAdapterFactory });
for (const fixture of fixtures.slice(0, 6)) service.ingest(fixture);
await service.advanceGoal();
const id = service.state().approvals.find((approval: any) => approval.action_type === 'send_message').id;
void service.decide(id, 'approve');
