// Only the planner holding the database lock may advance a checkpoint.
import { openaiResponse, OpenAICreateRejected, OpenAIReadUnavailable } from './openai-response.js';

type Call = { response_id?: string; result?: any; requested_at?: number };
export type PlannerProvider = 'openai' | 'anthropic';
type ProviderState = 'queued' | 'in_progress';
type WaitState = ProviderState | 'submitting' | 'retry_read' | 'uncertain' | 'blocked' | 'failed' | 'cancelled';
type Wait = {
  key: string;
  state: WaitState;
  started_at: number;
  provider_status?: ProviderState;
  checked_at?: number;
  next_poll_at?: number;
  failures?: number;
  error?: string;
};

export type PlannerCheckpoint = {
  version: 1;
  provider: PlannerProvider;
  turn: number; // -1 is the pre-planning trend verification
  state?: any;
  legacy?: true;
  calls: Record<string, Call>;
  wait?: Wait;
};

const POLL_MS = 10_000;
const SLOW_MS = 15 * 60_000;
const waitLabels: Record<WaitState | 'slow' | 'studio', string> = {
  studio: 'รอคิวใน Studio',
  submitting: 'กำลังส่งงานให้ OpenAI',
  queued: 'รอคิว OpenAI',
  in_progress: 'OpenAI กำลังเขียน',
  slow: 'รอนานผิดปกติ · กำลังตรวจงานเดิม',
  retry_read: 'รอนานผิดปกติ · กำลังตรวจงานเดิม',
  uncertain: 'ยังยืนยันผลการส่ง OpenAI ไม่ได้',
  blocked: 'เปิดคำขอ OpenAI เดิมไม่ได้',
  failed: 'OpenAI แจ้งว่างานล้มเหลว',
  cancelled: 'OpenAI ยืนยันว่าคำขอถูกยกเลิก',
};

function displayState(wait: Wait, now: number) {
  return ((wait.state === 'queued' || wait.state === 'in_progress') && now-wait.started_at>=SLOW_MS) ? 'slow' : wait.state;
}

// The API exposes only status/timestamps. Checkpoints can contain private input
// and response bodies, and are not returned with draft cards.
export function plannerStatus(status: string, wait?: Wait, now=Date.now()) {
  if (status==='queued') return {phase:'studio',label:waitLabels.studio};
  if (!wait || !['researching','writing','failed'].includes(status) || !Object.hasOwn(waitLabels,wait.state)) return null;
  const phase=displayState(wait,now);
  return {phase,label:waitLabels[phase],provider_status:wait.provider_status,started_at:wait.started_at,
    checked_at:wait.checked_at,next_poll_at:wait.next_poll_at};
}

export class PlannerRecoveryError extends Error {}

export function readPlannerCheckpoint(raw: any, provider: PlannerProvider): PlannerCheckpoint | undefined {
  if (raw == null) return;
  const state = raw.state;
  const normal = state && Array.isArray(state.history) && state.history.length > 0 &&
    typeof state.instructions === 'string' && state.active && state.usage &&
    ['input_tokens','output_tokens','cache_read_input_tokens','cache_creation_input_tokens','web_searches','turns']
      .every(key => Number.isSafeInteger(state.usage[key]) && state.usage[key] >= 0) &&
    Array.isArray(state.research) && Array.isArray(state.seen) && Array.isArray(state.attemptedVerification) &&
    Array.isArray(state.toolFailures);
  const legacy = !state && raw.legacy === true && raw.provider === 'openai' && raw.turn >= 0 &&
    /^resp_[a-zA-Z0-9_-]+$/.test(raw.calls?.main?.response_id ?? '');
  if (raw.version !== 1 || raw.provider !== provider || !Number.isSafeInteger(raw.turn) || raw.turn < -1 ||
      !raw.calls || typeof raw.calls !== 'object' || Array.isArray(raw.calls) ||
      (!normal && !legacy)) {
    throw new PlannerRecoveryError('อ่านจุดบันทึกรอบของสมองไม่ได้ จึงหยุดก่อนส่งคำขอใหม่');
  }
  return raw;
}

// Each logical operation is unique within its turn. A durable empty receipt means a POST
// may have been accepted. Only a known provider ID or stored foreground result permits replay.
export function plannerCalls(checkpoint: PlannerCheckpoint, save: (event?: string) => Promise<void>) {
  const {calls}=checkpoint;
  const persist = async (event?: string) => {
    try { await save(event); }
    catch (e) { throw new PlannerRecoveryError('บันทึกสถานะคำขอของสมองไม่ได้ จึงหยุดก่อนส่งงานต่อ', {cause:e}); }
  };
  return {
    openai(key: string): typeof openaiResponse {
      return async (body, options) => {
        const now=options.now??Date.now;
        const prior=calls[key];
        if (prior?.result) return prior.result;
        let wait=checkpoint.wait?.key===key ? checkpoint.wait : undefined;
        let started=wait?.started_at??prior?.requested_at??now();
        const setWait = async (state: WaitState, values: Partial<Wait>={}, note?: string) => {
          const next: Wait={key,state,started_at:started,provider_status:wait?.provider_status,error:note,...values};
          const phase=displayState(next,now());
          const before=wait && displayState(wait,wait.checked_at??wait.started_at);
          checkpoint.wait=next;
          const event=phase!==before || wait?.state!==state || wait?.error!==note
            ? waitLabels[phase]+(phase==='slow'&&state!==wait?.state?' · '+waitLabels[state]:'')+(note?' · '+note:'') : undefined;
          wait=next;
          await persist(event);
        };
        if (wait && ['failed','blocked','cancelled'].includes(wait.state))
          throw new PlannerRecoveryError(waitLabels[wait.state]+(wait.error?' · '+wait.error:''));
        if (Object.hasOwn(calls,key) && !prior?.response_id) {
          const message='คำขอก่อนหน้าอาจถูกคิดเงินแล้วแต่ไม่มีรหัสตอบกลับ กรุณาตรวจคำขอเดิมก่อนเริ่มใหม่';
          await setWait('uncertain',{},message);
          throw new PlannerRecoveryError(message);
        }
        if (wait?.next_poll_at && wait.next_poll_at>now()) throw new OpenAIReadUnavailable('ยังไม่ถึงเวลาตรวจคำขอเดิม');
        if (!prior) {
          calls[key]={requested_at:started};
          await setWait('submitting');
        }
        let response;
        try {
          response=await openaiResponse(body, {...options,
            // No polling loop and no retries under the Postgres session lock.
            responseId:prior?.response_id,keepAccepted:true,pollOnce:true,retryCreate:false,
            timeoutMs:prior?.response_id ? 5_000 : 15_000,
            onAccepted:async response_id=>{
              calls[key]={...calls[key],response_id};
              await persist('OpenAI รับคำขอแล้ว ['+response_id+']');
            },
          });
        } catch (e) {
          if (e instanceof PlannerRecoveryError) throw e;
          const message=e instanceof Error ? e.message : 'ตรวจคำขอ OpenAI ไม่สำเร็จ';
          const hasReceipt=!!calls[key]?.response_id;
          if (e instanceof OpenAIReadUnavailable && hasReceipt) {
            const failures=(wait?.failures??0)+1, checked_at=now();
            await setWait('retry_read',{failures,checked_at,next_poll_at:checked_at+Math.min(60_000,POLL_MS*2**(failures-1))},message);
            throw e;
          }
          const rejected=e instanceof OpenAICreateRejected;
          await setWait(hasReceipt?'blocked':rejected?'failed':'uncertain',{checked_at:now()},message);
          throw new PlannerRecoveryError(message,{cause:e});
        }

        // A version-1 receipt can predate the scheduling fields. Recover the original
        // start time from the provider when available.
        const created=Number(response.created_at)*1000;
        if (!prior?.requested_at && !wait && created>0 && created<=now()) started=created;
        if (response.status==='queued'||response.status==='in_progress') {
          const checked_at=now();
          await setWait(response.status,{provider_status:response.status,checked_at,next_poll_at:checked_at+POLL_MS});
          throw new OpenAIReadUnavailable('OpenAI รับงานแล้ว รอตรวจรหัสเดิมในรอบถัดไป');
        }
        if (response.error || !['completed','incomplete'].includes(response.status)) {
          const code=String(response.error?.code||response.status||'response_failed').replace(/[^a-zA-Z0-9_.-]/g,'').slice(0,80);
          const state=response.status==='cancelled'?'cancelled':'failed';
          await setWait(state,{checked_at:now()},code);
          throw new PlannerRecoveryError(waitLabels[state]+' · '+code);
        }
        calls[key]={...calls[key],result:response};
        if (checkpoint.wait?.key===key) delete checkpoint.wait;
        await persist(wait?.provider_status?'อ่านคำตอบ OpenAI เดิมสำเร็จ กำลังทำขั้นถัดไป':undefined);
        return response;
      };
    },
    async foreground(key: string, run: () => Promise<any>) {
      if (Object.hasOwn(calls,key)) {
        if (!calls[key]?.result) throw new PlannerRecoveryError('จุดบันทึกไม่มีผลการเขียนของ Anthropic ที่ใช้ต่อได้');
        return calls[key].result;
      }
      calls[key]={};
      await persist();
      const result=await run();
      calls[key]={result};
      await persist();
      return result;
    },
  };
}
