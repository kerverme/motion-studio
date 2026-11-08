// Long reasoning + hosted search must not hold a single HTTP request open.
// Create once, then retry only reads of that response (never duplicate a paid POST).
type Options = {
  apiKey: string;
  baseUrl: string;
  onProgress?: (message: string) => Promise<void>;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  timeoutMs?: number;
};

export function networkCode(error: unknown): string {
  let e: any = error;
  for (let depth = 0; e && depth < 5; depth++, e = e.cause) {
    if (typeof e.code === 'string' && /^[A-Z0-9_]+$/.test(e.code)) return e.code;
    if (e.name === 'TimeoutError' || e.name === 'AbortError') return e.name;
  }
  return 'NETWORK_ERROR';
}

export async function openaiResponse(body: any, options: Options): Promise<any> {
  const request = options.fetch ?? fetch;
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;
  const started = now();
  const deadline = started + (options.timeoutMs ?? 15 * 60_000);
  const base = options.baseUrl.replace(/\/$/, '') + '/v1/responses';
  const headers = { authorization: `Bearer ${options.apiKey}`, 'content-type': 'application/json' };
  let responseId: string | undefined;
  // Progress persistence must not cause a successful creation to be retried.
  const progress = async (message: string) => {
    try { await options.onProgress?.(message); } catch { /* the response is still running */ }
  };
  const idHint = () => responseId ? ` [${responseId}]` : '';

  async function readJson(url: string, init: RequestInit, polling: boolean): Promise<any> {
    for (let attempt = 0; ; attempt++) {
      let r: Response;
      let j: any;
      try {
        r = await request(url, { ...init, headers, signal: AbortSignal.timeout(Math.max(1, Math.min(60_000, deadline - now()))) });
        j = await r.json();
      } catch (error) {
        if (polling && attempt < 4 && now() < deadline) {
          await progress(`การเชื่อมต่อสะดุด (${networkCode(error)}) กำลังตรวจงาน OpenAI เดิมอีกครั้ง`);
          await sleep(Math.min(2000 * (attempt + 1), Math.max(0, deadline - now())));
          continue;
        }
        throw new Error(`OpenAI ${polling ? 'ตรวจสถานะ' : 'ส่งคำขอ'}ไม่สำเร็จ: ${networkCode(error)}${idHint()}${polling ? '' : ' — ไม่ส่งซ้ำอัตโนมัติเพื่อป้องกันคิดเงินซ้ำ'}`);
      }
      const quota = j.error?.code === 'insufficient_quota' || j.error?.type === 'insufficient_quota';
      // A 429 explicitly rejected the create. A 5xx or broken connection may
      // have accepted it, so only GETs may be retried in those cases.
      if (!quota && (r.status === 429 || (polling && r.status >= 500)) && attempt < 4 && now() < deadline) {
        const retryAfter = Number(r.headers.get('retry-after')) * 1000;
        await progress(`OpenAI HTTP ${r.status} กำลังรอแล้ว${polling ? 'ตรวจงานเดิม' : 'ส่งคำขอ'}อีกครั้ง`);
        await sleep(Math.min(retryAfter > 0 ? retryAfter : 5000 * (attempt + 1), 60_000, Math.max(0, deadline - now())));
        continue;
      }
      if (!r.ok) throw new Error(`OpenAI HTTP ${r.status}: ${quota ? 'insufficient_quota' : String(j.error?.code || j.error?.type || 'request_failed').replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 80)}${idHint()}`);
      return j;
    }
  }

  let response = await readJson(base, { method: 'POST', body: JSON.stringify({ ...body, background: true }) }, false);
  if (typeof response.id === 'string' && /^resp_[a-zA-Z0-9_-]+$/.test(response.id)) responseId = response.id;
  let lastNotice = now();
  if (['queued', 'in_progress'].includes(response.status)) {
    if (!responseId) throw new Error('OpenAI ไม่คืน response ID สำหรับตรวจสถานะ');
    await progress(`OpenAI รับงานแล้ว กำลังประมวลผลเบื้องหลัง [${responseId}]`);
  }
  while (['queued', 'in_progress'].includes(response.status)) {
    if (now() >= deadline) {
      // Best-effort cancellation stops an abandoned request accruing more work.
      let cancelled = false;
      try {
        const r = await request(`${base}/${responseId}/cancel`, { method: 'POST', headers, signal: AbortSignal.timeout(15_000) });
        const j: any = await r.json();
        // Completion can race the deadline. Preserve that answer.
        if (r.ok && ['completed', 'incomplete'].includes(j.status)) return j;
        cancelled = r.ok && j.status === 'cancelled';
      } catch { /* retain the ID for an operator to reconcile */ }
      throw new Error(`OpenAI เกินเวลารอต่อรอบ (${Math.round((deadline - started) / 60_000)} นาที)${idHint()} — ${cancelled ? 'ยกเลิกงานแล้ว' : 'ยังยืนยันการยกเลิกไม่ได้ โปรดตรวจงานเดิมก่อนลองใหม่'}`);
    }
    await sleep(Math.min(3000, Math.max(0, deadline - now())));
    if (now() >= deadline) continue;
    response = await readJson(`${base}/${responseId}`, { method: 'GET' }, true);
    if (now() - lastNotice >= 60_000 && ['queued', 'in_progress'].includes(response.status)) {
      await progress(`OpenAI ยังประมวลผลอยู่ (${Math.floor((now() - started) / 60_000)} นาที · ${response.status})`);
      lastNotice = now();
    }
  }
  if (response.error || !['completed', 'incomplete'].includes(response.status)) {
    throw new Error(`OpenAI ${String(response.status || 'invalid_response')}: ${String(response.error?.code || 'response_failed').slice(0, 80)}${idHint()}`);
  }
  return response;
}
