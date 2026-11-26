// Only the planner holding the database lock may advance a checkpoint.
import { openaiResponse, OpenAIReadUnavailable } from './openai-response.js';

type Call = { response_id?: string; result?: any };
export type PlannerProvider = 'openai' | 'anthropic';
export type PlannerCheckpoint = {
  version: 1;
  provider: PlannerProvider;
  turn: number; // -1 is the pre-planning trend verification
  state?: any;
  legacy?: true;
  calls: Record<string, Call>;
};

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
export function plannerCalls(calls: Record<string, Call>, save: () => Promise<void>) {
  const persist = async () => {
    try { await save(); }
    catch (e) { throw new PlannerRecoveryError('บันทึกสถานะคำขอของสมองไม่ได้ จึงหยุดก่อนส่งงานต่อ', {cause:e}); }
  };
  const reserve = async (key: string) => {
    if (Object.hasOwn(calls, key)) {
      const call = calls[key];
      if (!call || (!call.response_id && !call.result)) {
        throw new PlannerRecoveryError('คำขอก่อนหน้าอาจถูกคิดเงินแล้วแต่ไม่มีรหัสตอบกลับ จึงหยุดก่อนส่งซ้ำ ('+key+')');
      }
      return call;
    }
    calls[key] = {};
    await persist();
    return undefined;
  };
  return {
    openai(key: string): typeof openaiResponse {
      return async (body, options) => {
        const prior = await reserve(key);
        if (prior && !prior.response_id) throw new PlannerRecoveryError('จุดบันทึกไม่มีรหัสคำขอ OpenAI ที่ตรวจต่อได้');
        try {
          return await openaiResponse(body, {...options, responseId: prior?.response_id, keepAccepted: true,
            onAccepted: async response_id => {
              calls[key] = {response_id};
              try { await persist(); }
              catch (e) { throw new PlannerRecoveryError('บันทึกรหัส OpenAI ไม่สำเร็จ ให้ตรวจคำขอเดิม ['+response_id+'] ก่อนทำต่อ', {cause:e}); }
            },
          });
        } catch (e) {
          if (e instanceof PlannerRecoveryError || e instanceof OpenAIReadUnavailable) throw e;
          // No ordinary tool-error recovery can create a replacement for this paid request.
          throw new PlannerRecoveryError(e instanceof Error ? e.message : String(e), {cause:e});
        }
      };
    },
    async foreground(key: string, run: () => Promise<any>) {
      const prior = await reserve(key);
      if (prior) {
        if (!prior.result) throw new PlannerRecoveryError('จุดบันทึกไม่มีผลการเขียนของ Anthropic ที่ใช้ต่อได้');
        return prior.result;
      }
      const result = await run();
      calls[key] = {result};
      await persist();
      return result;
    },
  };
}
