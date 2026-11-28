// Studio sends reasoning, images and function tools to the Responses API. The
// model index also lists speech, image, realtime and dated snapshot models.
const GENERAL_GPT = /^gpt-(\d+)(?:\.\d+)*(?:-([a-z]+))?$/;
const SPECIALIZED = new Set(['audio','chat','codex','computer','deepresearch','embedding','image','instruct',
  'pro','realtime','research','search','speech','transcribe','tts','vision','preview','latest']);
const configured = process.env.MOTION_LLM_MODEL;
export const DEFAULT_OPENAI_MODEL = configured && process.env.MOTION_LLM_PROVIDER !== 'anthropic' && !configured.startsWith('claude')
  ? configured : 'gpt-6.2-sol';
export const REASONING_LEVELS = ['low', 'medium', 'high'] as const;
export type Reasoning = typeof REASONING_LEVELS[number];
export const DEFAULT_REASONING = REASONING_LEVELS.find(level => level === process.env.MOTION_LLM_REASONING) ?? 'high';

export const FALLBACK_MODELS = [...new Set([DEFAULT_OPENAI_MODEL, 'gpt-6.2-sol', 'gpt-6.2-astra',
  'gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna'])];
export type ModelCatalog = {
  ids: readonly string[];
  source: 'openai' | 'cached' | 'fallback' | 'configured';
  checked_at: string | null;
};

export function openAIModelLabel(id: string): string {
  if (!GENERAL_GPT.test(id)) return id;
  return id.replace(/^gpt-/, 'GPT-').replace(/-([a-z])([a-z]*)$/, (_, first, rest) => ' ' + first.toUpperCase() + rest);
}

export function isStoryModel(id: string): boolean {
  const parts = GENERAL_GPT.exec(id);
  return !!parts && id.length <= 61 && Number(parts[1]) >= 5 && !SPECIALIZED.has(parts[2]);
}

// OpenAI's account index normally returns IDs only. Compatible gateways can also
// publish per-model endpoint/capability restrictions; respect them when present.
function supportsResponsesJson(item:any){
  const listed=item.supported_endpoints??item.endpoints;
  if(Array.isArray(listed)&&!listed.some((v:unknown)=>typeof v==='string'&&/(?:^|\/)responses$/.test(v)))return false;
  return item.capabilities?.responses!==false && item.capabilities?.json_object!==false &&
    item.capabilities?.text?.output!==false && (!Array.isArray(item.output_modalities)||item.output_modalities.includes('text'));
}

export function createOpenAIModelCatalog(options: {request?: typeof fetch; now?: () => number; env?: NodeJS.ProcessEnv;responsesJson?:boolean} = {}) {
  const env = options.env ?? process.env;
  const now = options.now ?? Date.now;
  const fallback: ModelCatalog = {ids: FALLBACK_MODELS, source: 'fallback', checked_at: null};
  let catalog = fallback;
  let nextRefresh = 0;
  let pending: Promise<ModelCatalog> | undefined;

  async function refresh(): Promise<ModelCatalog> {
    try {
      const base = (env.OPENAI_BASE_URL || 'https://api.openai.com').replace(/\/$/, '');
      const response = await (options.request ?? fetch)(base + '/v1/models', {
        headers: {Authorization: 'Bearer ' + env.OPENAI_API_KEY}, redirect: 'error', signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) throw new Error('Model index unavailable');
      const {data} = await response.json();
      if (!Array.isArray(data) || !data.every(item => typeof item?.id === 'string')) throw new Error('Invalid model index');
      const ids = [...new Set<string>(data.filter(item=>!options.responsesJson||supportsResponsesJson(item)).map(item => item.id).filter((id: string) => id === DEFAULT_OPENAI_MODEL || isStoryModel(id)))];
      ids.sort((a, b) => a === DEFAULT_OPENAI_MODEL ? -1 : b === DEFAULT_OPENAI_MODEL ? 1 : b.localeCompare(a, 'en', {numeric: true}));
      catalog = {ids, source: 'openai', checked_at: new Date(now()).toISOString()};
      nextRefresh = now() + 15 * 60_000;
    } catch {
      if (catalog.checked_at) catalog = {...catalog, source: 'cached'};
      nextRefresh = now() + 60_000;
    }
    return catalog;
  }

  return async (refreshNow = false): Promise<ModelCatalog> => {
    if (!env.OPENAI_API_KEY) return fallback;
    if (!refreshNow && now() < nextRefresh) return catalog;
    pending ??= refresh().finally(() => { pending = undefined; });
    return pending;
  };
}

export const getOpenAIModelCatalog = createOpenAIModelCatalog();
export type ModelSource = string[] | ((refreshNow?: boolean) => Promise<ModelCatalog>);

// Fixed lists remain useful for API installations and tests that supply their own models.
export async function readModels(source: ModelSource = getOpenAIModelCatalog, refreshNow = false): Promise<ModelCatalog> {
  return typeof source === 'function' ? source(refreshNow) : {ids: source, source: 'configured', checked_at: null};
}
