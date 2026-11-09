// Content studio: OpenAI Web Search first, budgeted Firecrawl fallback, then the Thai
// script and a scene spec for the code-drawn template engine (worker/engine/templates.py), and the result waits as a
// draft for review. "Produce" turns the draft into a normal episode package and queues it for the worker.
// Keys: ANTHROPIC_API_KEY and FIRECRAWL_API_KEY live only in Railway variables.
import type { Hono, Context, Next } from 'hono';
import type pg from 'pg';
import { z } from 'zod';
import { communityBlock } from './community.js';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openaiResponse, networkCode } from './openai-response.js';
import { Artwork, emptyArtwork, reconcileArtwork, updateArtwork, mergeArtwork, artworkComplete, ARTWORK_TOOLS, type ArtworkState } from './art-batches.js';
import { BudgetedFirecrawl, PgResearchBudget, ResearchBudgetError } from './firecrawl-budget.js';
import { extractWebEvidence, verifySources, searchWeb, sourceKey } from './source-evidence.js';
import { Storyboard, validateStoryboardDraft, personCalls, type StoryboardT } from './storyboard.js';
import { draftRequest } from './draft-request.js';
import { NARRATION_STYLES, SOURCE_TEXT_LIMIT, SOURCE_READ_LIMIT, parseNarration, parseSourceText, narrationPrompt, sourceMaterialBlock, readSourceMaterial } from './narration.js';

const env = process.env;
const ANTHROPIC_URL = (env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/$/, '');
const FIRECRAWL_URL = (env.FIRECRAWL_API_URL || 'https://api.firecrawl.dev').replace(/\/$/, '');
// AI provider: Anthropic (default) or OpenAI. With only OPENAI_API_KEY set, OpenAI is used automatically.
const PROVIDER = (env.MOTION_LLM_PROVIDER || (env.ANTHROPIC_API_KEY ? 'anthropic' : env.OPENAI_API_KEY ? 'openai' : 'anthropic')).toLowerCase() === 'openai' ? 'openai' : 'anthropic';
const OPENAI_URL = (env.OPENAI_BASE_URL || 'https://api.openai.com').replace(/\/$/, '');
const MODEL = env.MOTION_LLM_MODEL || (PROVIDER === 'openai' ? 'gpt-6.1-sol' : 'claude-opus-5-5');
// Models offered in the UI (the env default is always included). Reasoning effort applies to OpenAI reasoning models.
const MODEL_CHOICES: Record<string, { id: string; label: string }[]> = {
  openai: [
    { id: 'gpt-6-astra', label: 'GPT-6 Astra — รุ่นใหม่ล่าสุด แรงสุด (แพงกว่า)' },
    { id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol — งานซับซ้อน เครื่องมือเยอะ' },
    { id: 'gpt-6.1-terra', label: 'GPT-6.1 Terra — เร็ว เขียนเป็นธรรมชาติ' },
    { id: 'gpt-6-sol', label: 'GPT-6 Sol' },
    { id: 'gpt-6-luna', label: 'GPT-6 Luna — ถูกกว่า' },
  ],
  anthropic: [
    { id: 'claude-opus-5-5', label: 'Claude Opus 5.5' },
    { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5 — ถูกกว่า' },
  ],
};
if (!MODEL_CHOICES[PROVIDER].some((m) => m.id === MODEL)) MODEL_CHOICES[PROVIDER].unshift({ id: MODEL, label: MODEL });
export const OPENAI_MODELS=MODEL_CHOICES.openai.map(m=>m.id);
const REASONING_LEVELS = ['low', 'medium', 'high'];
const REASONING = REASONING_LEVELS.includes(String(env.MOTION_LLM_REASONING)) ? String(env.MOTION_LLM_REASONING) : 'high';
const MODEL_RE = /^[a-z0-9][a-z0-9.\-]{2,60}$/;
const MAX_TURNS = Number(env.MOTION_LLM_MAX_TURNS || 48);
const MAX_INPUT_TOKENS = Number(env.MOTION_LLM_MAX_INPUT_TOKENS || 1_200_000); // incl. cache reads, per draft
// OpenAI research is required first, including when Anthropic writes the story.
const WEB_SEARCH = (env.MOTION_OPENAI_WEB_SEARCH || 'true') !== 'false';
const MAX_WEB_SEARCH = Number(env.MOTION_WEB_SEARCH_MAX_CALLS || 10);
const WEB_SEARCH_CONTEXT = ['low', 'medium', 'high'].includes(String(env.MOTION_WEB_SEARCH_CONTEXT)) ? String(env.MOTION_WEB_SEARCH_CONTEXT) : 'medium';
const DAILY_LIMIT = Number(env.MOTION_MAX_DRAFTS_PER_DAY || 20);
const VOICE_ID = env.MOTION_DEFAULT_VOICE_ID || 'bcdIY58WBBzAMmef52NW';
const DRAFT_MAX_CREDITS = Number(env.MOTION_DRAFT_MAX_CREDITS || 4500);
const MAX_YEARS = Number(env.MOTION_SOURCE_MAX_YEARS || 2);
const SERIES_TAG = env.MOTION_SERIES_TAG || 'จะเกิดอะไรขึ้นถ้า...?';

const llmKey = () => (PROVIDER === 'openai' ? !!env.OPENAI_API_KEY : !!env.ANTHROPIC_API_KEY);
export const configured = () => ({ llm: llmKey(), provider: PROVIDER, key_name: PROVIDER === 'openai' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY',
  anthropic: llmKey(), firecrawl: !!env.FIRECRAWL_API_KEY, web_search: WEB_SEARCH && !!env.OPENAI_API_KEY, cover_policy:{mode:'opening_frame',thumbnail_offset_ms:0,static_intro:false,new_drafts_only:true}, research_policy:{primary:'openai_web_search',firecrawl:'fallback_only',default_credit_limit:25,budget_scope:'research_job',sequential:true} });
const researchReady = (cf: ReturnType<typeof configured>) => cf.llm && cf.web_search;
const researchMissing = (cf: ReturnType<typeof configured>) => [!cf.llm && cf.key_name, !cf.web_search && 'OPENAI_API_KEY (Web Search first)'].filter(Boolean).join(' และ ');

// ---------------------------------------------------------------- engine vocabulary (must match worker/engine)
export const TEMPLATES = ['hook', 'number', 'compare', 'bars', 'list', 'quiz', 'reveal', 'dots', 'timeline', 'truth', 'scenario', 'icons', 'outro', 'chat', 'versus', 'scale', 'custom'] as const;
const SETS = ['city', 'room', 'classroom', 'park', 'beach', 'office', 'night', 'brick', 'kitchen'];
// Story formats: the owner does not want the same pattern every time. Labels are shown in the UI.
export const FORMATS: Record<string, { th: string; how: string }> = {
  domino: { th: 'โดมิโน (ถ้า… แล้ว… แล้ว…)', how: 'one change sets off a chain of consequences, each link backed by a fact, escalating to a surprising end' },
  countdown: { th: 'นับถอยหลังจัดอันดับ', how: 'a Top 3–5 counted down from the least to the most surprising, number one held back as the payoff' },
  versus: { th: 'ปะทะ A vs B', how: 'two sides (people, places, eras, choices) compared round by round, with a winner and a twist' },
  mystery: { th: 'ไขปริศนา', how: 'open with a puzzling fact, follow clues like a detective, reveal the explanation near the end' },
  skit: { th: 'ละครสั้น', how: 'a short story with the cast in real places (sets), the facts woven into what happens to them' },
  myth_buster: { th: 'จับผิดความเชื่อ', how: 'two or three popular beliefs about the topic, each judged true or false with evidence' },
  quiz_show: { th: 'เกมโชว์', how: 'two or three quick quiz rounds with escalating difficulty; facts are the answers' },
  day_in_life: { th: 'หนึ่งวัน/หนึ่งชีวิต', how: 'follow a character hour by hour (or year by year) to show how the topic touches real life' },
  by_the_numbers: { th: 'ตัวเลขที่เปลี่ยนมุมมอง', how: 'one big number made tangible with everyday comparisons (scale scenes), each comparison more surprising' },
  then_now: { th: 'อดีต vs ปัจจุบัน vs อนาคต', how: 'how the topic looked years ago, how it is now, and what the data says comes next' },
};
const BEATS = ['hook', 'rehook', 'info', 'payoff', 'cta'] as const;
const VOICE_SPEED = 1.12; // owner's rule: a brisker voice (ElevenLabs speed, 0.7-1.2)
const CPS = 12 * VOICE_SPEED; // estimated Thai narration speed (characters per second); 12 at normal pace
const HOOK_SECS = 5;     // owner's rule: the hook lands within the first 5 seconds
const REHOOK_SECS = 15;  // and a new hook at least every 15 seconds
export const ICONS = ['baby', 'battery', 'bolt', 'book', 'brain', 'bulb', 'calendar', 'car', 'cart', 'cat', 'chart', 'chart_down', 'check', 'clock', 'coffee', 'coin',
  'cross', 'down', 'exclaim', 'eye', 'fire', 'fitness', 'food', 'game', 'globe', 'health', 'heart', 'hot', 'house', 'money', 'moon', 'music', 'people', 'person',
  'phone', 'pin', 'plane', 'question', 'rain', 'school', 'sleep', 'star', 'sun', 'thai_flag', 'trash', 'tree', 'trophy', 'up', 'warning', 'water', 'wifi'];
const ACTIONS = ['idle', 'wave', 'hop', 'jump', 'nod', 'sway', 'shake', 'dance', 'lean', 'peek', 'run', 'cheer'];
const HAIRSTYLES = ['helmet', 'short', 'spiky', 'side_part', 'curly', 'bald', 'long', 'bob', 'ponytail', 'bun'];
const TOPS = ['blazer', 'tshirt', 'hoodie', 'shirt', 'dress'];
const BOTTOMS = ['pants', 'shorts', 'skirt'];
const ACCESSORIES = ['cap', 'headband', 'bow', 'earrings', 'mustache', 'beard', 'lashes', 'bag'];
const HAIR_COLORS = ['black', 'brown', 'blonde', 'grey', 'white', 'red', 'pink', 'blue', 'purple'];
const SKINS = ['light', 'medium', 'tan', 'brown', 'dark'];
const CLOTH = ['navy', 'red', 'green', 'purple', 'orange', 'grey', 'white', 'black', 'yellow', 'pink', 'sky', 'brown', 'beige', 'denim', 'mint'];
const BGS = ['night', 'grape', 'ocean', 'mint', 'sunset', 'sky', 'peach', 'forest', 'ink', 'gold', 'berry', 'teal'];
// Library effects: fixed prompts, so identical requests are served from the worker's audio cache and cost nothing after the first episode.
// Besides these, the brain may write up to MAX_CUSTOM_SFX story-specific effects of its own ("sfx": "custom" with a "prompt").
const SFX: Record<string, { prompt: string; duration: number }> = {
  pop: { prompt: 'Short bright cartoon pop, bubbly and clean, no music', duration: 0.6 },
  whoosh: { prompt: 'Soft airy whoosh transition swish, no music', duration: 0.8 },
  ding: { prompt: 'Correct-answer ding chime, single clean bell', duration: 1.0 },
  counter: { prompt: 'Mechanical number counter rolling up with clicks, ending in a soft bell', duration: 2.0 },
  buzzer: { prompt: 'Short comedic cartoon wrong-answer buzzer, two low beeps', duration: 1.0 },
  drumroll: { prompt: 'Snare drum roll building suspense, ending with a light cymbal hit', duration: 2.5 },
  tada: { prompt: 'Cheerful cartoon ta-da fanfare, short brass and sparkle', duration: 1.5 },
  tick: { prompt: 'Clock ticking, three crisp ticks, dry', duration: 1.5 },
  boing: { prompt: 'Cartoon spring boing, funny and short', duration: 0.8 },
  sparkle: { prompt: 'Magical sparkle glint, gentle shimmer', duration: 1.2 },
  stamp: { prompt: 'Rubber stamp thump on paper, short', duration: 0.6 },
  footsteps: { prompt: 'Light footsteps walking on a hard floor, a few steps', duration: 2.0 },
  door: { prompt: 'Wooden door opening with a soft creak', duration: 1.5 },
  rain: { prompt: 'Gentle rain ambience with soft drops', duration: 4.0 },
  wind: { prompt: 'Soft wind breeze ambience', duration: 3.0 },
  birds: { prompt: 'Morning birds chirping outdoors, calm', duration: 3.0 },
  crowd_laugh: { prompt: 'Small audience laughing warmly, short', duration: 2.0 },
  crowd_wow: { prompt: 'Small crowd going "ooh" in amazement', duration: 1.5 },
  gasp: { prompt: 'Cartoon surprised gasp, short, no words', duration: 0.8 },
  heartbeat: { prompt: 'Slow heartbeat thumps, suspenseful', duration: 2.5 },
  bell: { prompt: 'Small hand bell ringing twice', duration: 1.2 },
  coins: { prompt: 'Coins dropping into a pile, jingling', duration: 1.2 },
  phone: { prompt: 'Smartphone notification chime, soft', duration: 0.8 },
  camera: { prompt: 'Camera shutter click', duration: 0.6 },
  typing: { prompt: 'Fast keyboard typing, short burst', duration: 1.5 },
  splash: { prompt: 'Water splash, playful', duration: 1.0 },
  train: { prompt: 'Toy train whistle and soft chugging', duration: 2.5 },
  car: { prompt: 'Car passing by on a street', duration: 2.0 },
  sad_trombone: { prompt: 'Comedic sad trombone wah-wah, short', duration: 1.8 },
};
const MAX_CUSTOM_SFX = 4;
// Music follows each story (owner's rule, 2026-11-07): the brain picks the mood, tempo and instruments for THIS story.
// No fixed fast tempo: calm stories get calm music, tense ones tense music.
const MUSIC_BASE = 'instrumental background music under Thai narration, follows the emotion of the story, leaves room for the voice, no vocals, steady and loopable, no long silence';
const MUSIC: Record<string, string> = {
  playful: 'playful, light and quirky', curious: 'curious and gently investigative', upbeat: 'upbeat and positive', dramatic: 'dramatic and suspenseful but not scary',
  chill: 'relaxed and warm', warm: 'warm, heartfelt and cosy', mysterious: 'mysterious and intriguing', epic: 'epic and cinematic',
  nostalgic: 'nostalgic and bittersweet', tender: 'tender, soft and emotional', spooky: 'spooky but fun, like a Halloween cartoon', funky: 'funky groove',
  retro_game: '8-bit chiptune video-game', lofi: 'lo-fi hip-hop beat', heroic: 'heroic and adventurous', romantic: 'sweet and romantic', comedic: 'comedic, cartoon slapstick',
};
const oneLine = (x: unknown, n: number) => String(x ?? '').replace(/[\u0000-\u001f\u007f<>{}]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
function musicPrompt(d: { music: string; music_brief?: { tempo_bpm?: number; instruments?: string; feel?: string } }) {
  const mood = MUSIC[d.music] ? d.music : 'playful';
  const b = d.music_brief || {};
  const parts = [`Background music for a short Thai animated story, ${MUSIC[mood]}`];
  if (b.tempo_bpm) parts.push(`about ${Math.round(b.tempo_bpm)} BPM`);
  if (b.instruments) parts.push(`instruments: ${oneLine(b.instruments, 140)}`);
  if (b.feel) parts.push(oneLine(b.feel, 160));
  parts.push(MUSIC_BASE);
  return parts.join('; ').slice(0, 700);
}
// Visual styles (owner's request, 2026-11-07): all drawn by code in the worker (engine/styles.py), no image generation.
export const STYLES: Record<string, { th: string; en: string }> = {
  classic: { th: 'การ์ตูนเส้นเรียบ (เดิม)', en: 'the clean flat cartoon look of earlier episodes' },
  pixel_art: { th: 'พิกเซลอาร์ต', en: 'chunky pixel art with a retro game palette' },
  ps2: { th: 'เกม PS2', en: 'early-2000s console 3D: low resolution, dithering, hazy fog' },
  comic: { th: 'การ์ตูนคอมิก', en: 'comic book: bold ink outlines, flat colours, halftone dots' },
  lego: { th: 'ตัวต่อเลโก้', en: 'brick-built world with studs, glossy plastic toy characters' },
  claymation: { th: 'ดินน้ำมัน', en: 'stop-motion plasticine: rounded clay shapes, thumbprints, 12 fps' },
  paper_cutout: { th: 'กระดาษตัดแปะ', en: 'paper cut-out puppets with white borders and drop shadows, 10 fps' },
  retro_anime: { th: 'อนิเมะยุค 90', en: '80s/90s cel anime with VHS grain, scanlines and colour fringing' },
  low_poly: { th: 'โลว์โพลี 3D', en: 'faceted low-poly 3D look' },
  risograph: { th: 'ริโซกราฟ', en: 'two-ink risograph print: pink and blue grain, misregistration' },
  diorama: { th: 'โมเดลจิ๋ว', en: 'miniature diorama: tilt-shift blur, saturated toy colours' },
};
const STYLE_NAMES = Object.keys(STYLES);

// ---------------------------------------------------------------- helpers
const nowBkk = () => new Date(Date.now() + 7 * 3600_000);
const todayIso = () => nowBkk().toISOString().slice(0, 10);
const normUrl = (url: string) => sourceKey(url) || url.trim();
const normText = (s: string) => String(s ?? '').replace(/[\s.?!…,"“”'()[\]:;\-–—]/g, '');
const yearOf = (s?: string | null) => {
  const m = String(s || '').match(/(?:19|20|25)\d{2}/)?.[0];
  return m ? (Number(m) >= 2400 ? Number(m) - 543 : Number(m)) : 0;
};
const host = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u; } };

type Seen = { url: string; title?: string; published_hint?: string | null; collected: string; via: 'search' | 'read' | 'web' };

// Firecrawl traffic is exclusively routed through the persistent research budget.
const pubHint = (m: any) => m?.publishedTime || m?.['article:published_time'] || m?.publishedDate || m?.['og:updated_time'] || m?.modifiedTime || m?.date || null;

// ---------------------------------------------------------------- Claude
async function claude(body: any) {
  if (!env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not set on motion-api');
  for (let i = 0; ; i++) {
    const r = await fetch(`${ANTHROPIC_URL}/v1/messages`, {
      method: 'POST',
      headers: { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(600_000),
    });
    const j: any = await r.json().catch(() => ({}));
    if ((r.status === 429 || r.status === 529 || r.status >= 500) && i < 4) {
      const wait = Number(r.headers.get('retry-after') || 0) * 1000 || 5000 * (i + 1);
      await new Promise((res) => setTimeout(res, Math.min(wait, 60_000)));
      continue;
    }
    if (!r.ok) throw new Error(`Anthropic ${r.status}: ${String(j.error?.message || '').slice(0, 300)}`);
    return j;
  }
}

async function openai(body: any, onProgress?: (message: string) => Promise<void>) {
  if (!env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is not set on motion-api');
  return openaiResponse(body, { apiKey: env.OPENAI_API_KEY, baseUrl: OPENAI_URL, onProgress, timeoutMs: Math.min(45 * 60_000, Math.max(5 * 60_000, Number(env.MOTION_OPENAI_TIMEOUT_MS) || 30 * 60_000)) });
}

type ToolUse = { id: string; name: string; input: any };
type ToolResult = { id: string; content: string; is_error?: boolean };
type Usage = { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number };
type WebFound = { searches: number; queries: string[]; sources: { url: string; title: string }[] };
// which research tools are usable right now (changes during a draft when Firecrawl runs out of credits or the web search budget is spent)
type Active = { fc: boolean; ws: boolean; drawing?: boolean; searches?: number; source?: boolean };
const activeTools = (a: Active) => TOOLS.filter(t => t.name !== 'openai_search' || PROVIDER !== 'openai').filter(t => ['submit_episode','plan_story',...ARTWORK_TOOLS.map(x=>x.name)].includes(t.name) || (t.name === 'read_source_material' ? !!a.source : t.name === 'read_page' ? !!env.OPENAI_API_KEY : t.name === 'openai_search' && !a.drawing && a.ws)).map(t => {
  if (t.name !== 'submit_episode' || !a.drawing) return t;
  const schema:any = t.input_schema;
  const omit = new Set(['script','scenes','cast','art']);
  return {...t,input_schema:{...schema,required:schema.required.filter((key:string)=>!omit.has(key)),properties:Object.fromEntries(Object.entries(schema.properties).filter(([key])=>!omit.has(key)))}};
});
interface Conversation {
  turn(force: boolean): Promise<{ uses: ToolUse[]; usage: Usage; web?: WebFound }>;
  results(rs: ToolResult[], note?: string): void;
  say(text: string): void;
  replaceSource(block: string, replacement: string): void; // only replaces the original raw source; fetched evidence and tool history stay intact
  show(text: string, images: string[]): void;   // a user message with JPEG previews (base64) of the model's own drawings
}

// Anthropic Messages API; the conversation is cached so each turn re-reads it at the cache price.
function anthropicConversation(system: string, first: string, model: string, active: Active): Conversation {
  const messages: any[] = [{ role: 'user', content: first }];
  const sys = [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }];
  return {
    async turn(force) {
      const msgs = JSON.parse(JSON.stringify(messages));
      const last = msgs[msgs.length - 1];
      if (typeof last.content === 'string') last.content = [{ type: 'text', text: last.content }];
      last.content[last.content.length - 1].cache_control = { type: 'ephemeral' };
      const resp = await claude({ model, max_tokens: 16000, system: sys, tools: activeTools(active), messages: msgs,
        ...(force ? { tool_choice: { type: 'tool', name: 'submit_episode' } } : {}) });
      messages.push({ role: 'assistant', content: resp.content });
      const u = resp.usage || {};
      return {
        uses: (resp.content || []).filter((b: any) => b.type === 'tool_use').map((b: any) => ({ id: b.id, name: b.name, input: b.input })),
        usage: { input_tokens: Number(u.input_tokens || 0), output_tokens: Number(u.output_tokens || 0), cache_read_input_tokens: Number(u.cache_read_input_tokens || 0), cache_creation_input_tokens: Number(u.cache_creation_input_tokens || 0) },
      };
    },
    results(rs, note) {
      const content: any[] = rs.map((r) => ({ type: 'tool_result', tool_use_id: r.id, content: r.content, ...(r.is_error ? { is_error: true } : {}) }));
      if (note) content.push({ type: 'text', text: note });
      messages.push({ role: 'user', content });
    },
    say(text) { messages.push({ role: 'user', content: text }); },
    replaceSource(block, replacement) { messages[0].content = messages[0].content.replace(block, replacement); },
    show(text, images) {
      messages.push({ role: 'user', content: [{ type: 'text', text }, ...images.map((data) => ({ type: 'image', source: { type: 'base64', media_type: data.startsWith('data:') ? data.slice(5, data.indexOf(';')) : 'image/jpeg', data: data.startsWith('data:') ? data.slice(data.indexOf(',') + 1) : data } }))] });
    },
  };
}

// OpenAI Responses API (tool calling for current GPT models goes through it). Output items are fed back as input.
function openaiConversation(system: string, first: string, model: string, effort: string, active: Active, onProgress?: (message: string) => Promise<void>): Conversation {
  const input: any[] = [{ role: 'user', content: first }];
  const fnTools = (a: Active) => activeTools(a).map((t) => ({ type: 'function', name: t.name, description: t.description, parameters: t.input_schema }));
  return {
    async turn(force) {
      // reasoning tokens count against max_output_tokens, so leave room for high effort
      const tools: any[] = fnTools(active);
      if (active.ws && !active.drawing) tools.push({ type: 'web_search', search_context_size: WEB_SEARCH_CONTEXT, user_location: { type: 'approximate', country: 'TH', city: 'Bangkok', region: 'Bangkok', timezone: 'Asia/Bangkok' } });
      const resp = await openai({ model, instructions: system, input, tools, reasoning: { effort: active.drawing && effort === 'high' ? 'medium' : effort }, ...(active.ws && !active.drawing ? { include: ['web_search_call.action.sources'] } : {}),
        max_output_tokens: active.drawing ? 16000 : 24000,
        parallel_tool_calls: false, max_tool_calls: Math.max(1, Math.min(3, MAX_WEB_SEARCH - (active.searches || 0))),
        tool_choice: force ? { type: 'function', name: 'submit_episode' } : 'auto' }, onProgress);
      const out: any[] = resp.output || [];
      input.push(...out);
      const uses: ToolUse[] = out.filter((o) => o.type === 'function_call').map((o) => {
        let args: any = {};
        try { args = JSON.parse(o.arguments || '{}'); } catch { args = { __invalid_json: String(o.arguments || '').slice(0, 200) }; }
        return { id: o.call_id, name: o.name, input: args };
      });
      if (resp.status === 'incomplete' && !out.some((o) => o.type === 'function_call')) {
        input.push({ role: 'user', content: 'Your last answer was cut off. Keep reasoning shorter and call the tool now.' });
      }
      const u = resp.usage || {};
      const cached = Number(u.input_tokens_details?.cached_tokens || 0);
      const web = extractWebEvidence(out);
      return { uses, web: web.searches || web.sources.length ? web : undefined, usage: { input_tokens: Math.max(0, Number(u.input_tokens || 0) - cached), output_tokens: Number(u.output_tokens || 0), cache_read_input_tokens: cached, cache_creation_input_tokens: 0 } };
    },
    results(rs, note) {
      for (const r of rs) input.push({ type: 'function_call_output', call_id: r.id, output: (r.is_error ? 'ERROR: ' : '') + r.content });
      if (note) input.push({ role: 'user', content: note });
    },
    say(text) { input.push({ role: 'user', content: text }); },
    replaceSource(block, replacement) { input[0].content = input[0].content.replace(block, replacement); },
    show(text, images) {
      input.push({ role: 'user', content: [{ type: 'input_text', text }, ...images.map((data) => ({ type: 'input_image', image_url: data.startsWith('data:') ? data : `data:image/jpeg;base64,${data}` }))] });
    },
  };
}

export function systemPrompt(a: Active, mode: 'name_story' | 'general' = 'name_story') {
  const d = nowBkk();
  const ce = d.getUTCFullYear(), be = ce + 543;
  let prompt = `You are the head writer and researcher of a Thai short-video channel. Series tag: "${SERIES_TAG}".
Today is ${todayIso()} (Thai year ${be}). Every clip is a 1080x1920 vertical video, 45–75 seconds, narrated in Thai by a synthetic voice,
with bespoke code-drawn motion graphics. Read the story, direct every shot and draw every scene and cast member for THIS episode.
Use code and the canvas toolkit below; do not call image generation services or use stock footage. Reference photos guide likeness, never become the background.

## Research rule (the owner's standing instruction — non-negotiable)
- Every fact, number and story condition must come from pages you retrieve in THIS session. Use OpenAI Web Search FIRST (built-in web_search, or openai_search for an Anthropic writer). read_page defaults to an exact source read through OpenAI. Firecrawl is ONLY a fallback for deeper text extraction after that exact URL has already been attempted through OpenAI; set use_firecrawl=true and explain the missing evidence in fallback_reason. Start with ONE selected source, never bulk extraction. A durable 25-credit maximum applies cumulatively to the entire Research Job, across endpoints, retries and rewrites. Each call reserves its maximum cost before dispatch; calls are sequential. On insufficient budget, stop Firecrawl and ask the owner for an explicit budget increase, or continue using verified OpenAI evidence. Never assume permission. Unpriced operations, PDF parsing, X/Twitter, provider enrichment and agents are disabled. Reuse cached results and preserve original URLs.
- Always look for the MOST RECENT data that exists. Put the year in queries (${ce} / ${be}, or ${ce - 1} / ${be - 1}) and search in Thai and English.
  Prefer primary/official sources (สำนักงานสถิติแห่งชาติ, ministries, Bank of Thailand, WHO, World Bank, UN, OECD, DataReportal, peer-reviewed papers,
  reputable news citing them). Confirm exact figures on the key pages before you use them.
- Record when each source was published. If the newest available figure is older than ${MAX_YEARS} years (e.g. a census done every 10 years),
  you must say so in that source's freshness_note (why nothing newer exists), and say the year on screen or in narration.
- Never invent numbers. If something cannot be found, build the story from what you did find, or present it explicitly as an assumption
  (claims kind "assumption", and say "สมมติ" in the narration and on screen). A "what if" scenario must be built on real conditions you found.
- Sources may only be URLs you actually retrieved. Prefer 3–7 strong sources.

## Story — vary it every episode (the owner finds a fixed pattern boring)
Pick the format that suits the topic best AND differs from the recent episodes listed in the user message. Formats ("format" field):
${Object.entries(FORMATS).map(([k, f]) => `- ${k}: ${f.how}`).join('\n')}
Also vary the scene types and their order, the sets (locations) and the cast from recent episodes; do not reuse a recent episode's scene sequence.
A quiz is one tool among many, not a fixed step.

## Retention rules (the owner's standing rules — checked automatically; narration runs at about ${CPS} Thai characters per second)
- HOOK in the first ${HOOK_SECS} seconds: segment 1 has beat "hook", ≤ ${HOOK_SECS * CPS} characters, and grabs attention immediately
  (a provocative question, a shocking number, a bold claim, or a mini-cliffhanger). No greetings, no "วันนี้เราจะมาดู…".
- RE-HOOK at least every ${REHOOK_SECS} seconds: mark segments that pull attention back with beat "rehook" (a new question, twist, "แต่เดี๋ยวก่อน…",
  surprising number, quiz, cliffhanger, reveal tease, pattern interrupt). The gap between the start of one hook/rehook and the next must be
  ≤ ${REHOOK_SECS} s, and from the last one to the closing segment too. Give rehook segments a visual change as well (new set, new scene type, a stamp…),
  and make something appear on their FIRST words (e.g. a headline timed to the first word) so the screen changes exactly when the re-hook is spoken.
- END with interaction: the last segment has beat "cta" and asks a specific question viewers want to answer in the comments
  (a choice, a guess, their own experience, a name to research next), and its scene is an outro or puts that question on screen.
- Other beats: "info" (facts), "payoff" (the answer/reveal).
Tone: curious, playful, clear, never preachy; facts must stay accurate. Avoid medical/legal/financial advice beyond what sources say, politics
taking sides, and content about private individuals.

## Narration rules (script[].text) — read by Thai text-to-speech
- Natural spoken Thai, short phrases separated by single spaces (each space-separated phrase becomes one subtitle chunk; ≤ 28 characters per phrase).
- NO digits, %, or symbols: write numbers as Thai words (หกสิบห้าล้าน, ยี่สิบเอ็ดเปอร์เซ็นต์, ปีสองพันห้าร้อยหกสิบแปด or ปีสองห้าหกแปด).
- Brand/English names in Thai script (ไลน์, ยูทูบ, ติ๊กต็อก). Total narration 450–1000 Thai characters.
- segment ids: short lowercase ascii. Every segment has "beat": hook | rehook | info | payoff | cta.

## Scenes (scenes[]) — one per segment, same seg id; prefer 6–8 concise shots and reusable art helpers
Each scene: {"seg", "type", "bg", ...template fields, optional common fields}. Timing fields ("at", "*_at", countdown entries) must be a word or
short phrase copied EXACTLY from that segment's narration (it fires when that word is spoken). On-screen text may use digits and is short
(≤ 22 characters per line). Vary bg between consecutive scenes. bg: ${BGS.join(', ')}.
Every scene MUST be type "custom", including the opening and closing. Draw the setting, props, characters, diagrams and action yourself with the canvas toolkit below.
Common optional overlays: "headline": {"text","at"}, "sub": {"text","at","color"}, "stamp": {"text","at","color"}, "note": {"text"}, "confetti": {"at"}.
No fixed scene layouts or preset sets. Vary shot scale, framing, setting, blocking and motion according to the narration and storyboard.

## Characters (cast)
Define 1–4 people in "cast", each with "name", "portrait_description" and "portrait_code". Call c.person("name", x, y, size, mood, talk) in scenes.
Draw a distinct face AND full body, not a generic chibi with different clothes. For uploaded people, study the labelled reference image: face silhouette, jaw/chin,
relative eye spacing and shape, brows, nose, lips, ears, hairline, hair volume, glasses, body proportions, clothes, colours and visible distinguishing details.
Preserve the same identity throughout the episode; reuse each cast member's portrait_code in every shot. Do not infer identity, ethnicity, health or hidden details.
Likeness is a stylised interpretation, not a guaranteed exact copy. Describe uncertainty where the reference is small or obscured.
portrait_code (≤9000 chars) is standalone Python def draw(c,t,p): using the same canvas shapes below. Canonical head centre (0,0), head width about 200,
full silhouette within x=-160..160, y=-140..370, feet near y=370. Draw on transparency (no background); c.person/c.cat/c.grad are forbidden inside portraits.
Use c.mood, c.talk (0..1), c.wave, c.pose to animate face/arms; t is seconds, p is normalised talk. Portrait code cannot call top-level art helpers.
Use enough facial geometry to reflect the reference. Every invented character also needs bespoke portrait_code. Optional legacy clothing fields may be included.
## Cover + opening (the owner's standing rule for EVERY clip)
Every clip has a main character: cast[0]. Its "name" is the name the clip is about. The cover image reads "คนนี้ชื่อ “<name>”" with that character, so cast[0].name must be a real, speakable Thai name or nickname (≤ 14 characters).
If the owner's topic starts with "คนชื่อ X ในประเทศไทย มีกี่คน", then cast[0].name = X. If the topic gives no name, pick a common Thai name that fits the story. If the topic says "แล้วต่อด้วยเรื่อง: Y", Y is the story that follows the opener; if there is no Y, choose a fresh story angle yourself.
If the owner picked saved characters (see below) they come first in cast: cast[0] is the first of them and its name is the one used in the opener and on the cover.
The clip OPENS with that question, then the story follows:
- segment 1 (beat "hook"): the question itself, e.g. "คนชื่อ X ในประเทศไทย มีกี่คน?" — it must contain the name and the word "ประเทศไทย".
- segment 2: the answer — how many people in Thailand have that name (or rank/share if only that exists). This number is research: search with OpenAI Web Search for the NEWEST data (official registry/DOPA statistics,
  national name rankings, news, academic work), take the latest year available, and cite it in sources with its "published" year. Never invent a count. If no official count is published, say so honestly in the narration
  ("ไม่มีสถิติทางการ แต่ข้อมูลล่าสุดบอกว่า…"), give only what the source supports (rank, share, a stated estimate), and record it as a claim of kind "assumption".
- then continue into the story/topic with the usual formats, re-hooks and CTA. A claim in "claims" must mention the name and cover the count.
Optional "cover": {"name": (default cast[0].name), "line": (≤ 28 chars, the bottom hook line on the cover; default = the title)}.
Show the main character BIG in the opening custom scene with c.person(cast[0].name as a literal string, ..., size=240 or larger) and a headline with the question,
so viewers see clearly who "this person" is in the first seconds (like the cover).

## Characters in EVERY frame, acting out the context (the owner's standing rule)
Every custom scene must actually draw at least one named cast member with c.person("name", ...). The mint cat mascot is optional.
Animate the cast with movement, expression, scale, rotation and poses suited to the narration. Show uploaded characters clearly in at least a third of the shots.
Do not paste a static portrait on the same background throughout. Use c.cue("word") to align reveals and movement to the narration.

## Pace (the owner wants it faster)
The voice runs fast (about ${CPS.toFixed(1)} characters per second). Write punchy narration: short phrases, active verbs, no filler or
repetition, a fresh fact, number or twist every few seconds.

## Music follows the story (the owner's rule)
Choose "music" (mood: ${Object.keys(MUSIC).join(', ')}) and "music_brief": {"tempo_bpm" 60–150, "instruments" (2–4, English), "feel" (one English line about
this story's emotion and setting)}. Fit THIS story and the visual style (e.g. pixel_art → chiptune, retro_anime → 80s city pop, claymation → quirky stop-motion
woodwinds, risograph → indie lo-fi, ps2 → early-2000s game soundtrack). Do not default to fast or hyped: calm or touching stories get slower, softer music,
tense ones tense music, comedy gets comedic music. Vary the music from recent episodes.

## Sound
sfx: up to 10 cues {"sfx", "seg", "at" (word from that segment), "gain" 0.3–0.7}. "sfx" is a library sound (${Object.keys(SFX).join('|')})
or "custom" with "prompt" (English, ≤ 100 chars, a sound that belongs to THIS story, e.g. "paper train whistle", "robot beeping happily") and "duration" 0.5–4 s
(at most ${MAX_CUSTOM_SFX} custom). Pick sounds that match what is happening on screen and in the story; they do not all have to be fast or punchy —
quiet moments can have soft sounds or none. Avoid the same set of sounds as every other episode.

## Custom scene art — draw THIS story's own pictures with code (type "custom")
Draw everything the story is actually ABOUT (a monkey stealing glasses, a temple,
a jeep, a market stall, a flood, a giant coin) you draw yourself, new for this story, with a tiny shape toolkit. Nothing is pre-drawn: if the story
has a monkey you build the monkey. This is still code only (no images, no AI art); the visual style (claymation, lego, ...) is applied on top.
Use "custom" for EVERY scene. Put the shared drawing functions of the story in top-level "art" (≤ 9000 chars,
defined ONCE and reused by every custom scene so the monkey looks the same in each scene), and per scene {"seg", "type": "custom", "code": "def draw(c, t, p): ..."}
(≤ 6000 chars; it may call the functions from "art"). A custom scene still accepts headline / sub / stamp / note / confetti and the "at" cues like the others.
Scene 1 is also custom: stage a new opening with the hero, not a fixed template.
draw(c, t, p): c = the canvas, t = seconds since the scene started, p = 0..1 progress through the scene. Frame is 1080 x 1920 px, origin top-left;
keep the subject inside y 330–1380 (the headline sits above, the subtitles below). Redraw everything every frame: paint the background FIRST
(c.grad sky/wall, ground, far things), then mid things, then the subject, then details.
Canvas methods (colours: (r,g,b) tuples, "#ff8800", or white black red orange yellow green teal blue purple pink brown tan gray sky cream; alpha 0..1):
- c.grad(top, bottom, y0=0, y1=1920) vertical gradient band; c.rect(x, y, w, h, color, r=0, alpha=1, outline=None, ow=6) (r = corner radius)
- c.circle(x, y, r, color, alpha, outline, ow); c.ellipse(x, y, rx, ry, color, rot=0, alpha, outline, ow); c.poly([(x,y),...], color, alpha, outline, ow)
- c.blob(x, y, rx, ry, color, seed=0, bump=0.14, alpha, outline, ow) soft irregular shape (bushes, clouds, fur, rocks)
- c.line(x0, y0, x1, y1, color, w=8); c.path([(x,y),...], color, w=8, alpha=1, smooth=False, closed=False) (smooth=True rounds the corners: tails, limbs, vines);
  c.arc(x, y, r, a0, a1, color, w=8) angles in degrees (0 = right, 90 = down)
- c.push() / c.pop() save/restore the transform; c.move(x, y), c.rotate(deg), c.scale(s) or c.scale(sx, sy) apply to everything drawn after (build a figure around (0,0), then move/scale/rotate it)
- c.text(x, y, "short text", size=64, color="white", stroke=6) (≤ 60 chars, Thai ok, for signs and labels)
- c.person("name", x, y, size=240, mood="normal", talk=0, pose="stand", wave=0.0) draws a cast member with their uploaded look: (x, y) is the head centre and the body extends about 1.85 x size below it;
  moods normal|happy|shock|think. c.cat(x, y, size=160, mood="normal") draws the channel's mint cat mascot (moods normal|happy|shock|worried)
- c.cue("word") = seconds from the scene start until that word is spoken in the narration: time reveals to it, e.g. k = ease_out((t - c.cue("ลิง")) * 2.5)
Helpers: sin(deg) cos(deg) tan(deg) atan2(y,x) sqrt hypot pi floor ceil lerp(a,b,x) clamp(x,a,b) ease(x) ease_out(x) osc(t, period, amp) pingpong(t, period)
rnd(i) (0..1, repeatable) noise(x) mix(c1,c2,x) shade(color, k) (k>0 lighter, k<0 darker) rgb(r,g,b) range len min max abs round int float sum enumerate zip list sorted.
At top level, use ONLY function definitions and literal constant assignments: no calls, calculations, loops or computed default arguments. Put executable work inside draw or helper functions. The code is checked and a sandbox runs it. Allowed: def, if/else, for (at most 2 loops nested; range up to 300), assignments, arithmetic, f-strings, lists/tuples/dicts, lambda.
NOT allowed (the check rejects them): import, while, class, try, with, global, print, open, anything starting with "_", "**" except small integer powers, string .format.
Make it good: build each figure from many shapes (≥ 20 for the main subject), outline main shapes (outline=shade(color,-0.4)), shade with a lighter belly/highlight and a darker
side, give creatures eyes, ears and a mouth, keep the main subject big (≥ 350 px) and give everything a little life with osc()/pingpong() (bobbing, blinking, tail, arms).
Stay under ~600 shapes per frame. Example of the pattern (shorten, do not copy):
art: def monkey(c, x, y, s, t, mood):\n  fur = rgb(150,98,60)\n  c.push(); c.move(x, y + osc(t, 0.8, 6*s)); c.scale(s)\n  c.path([(60,120),(140,90),(170,20),(130,-30)], fur, 22, 1, True)\n  c.ellipse(0, 90, 70, 90, fur); c.circle(0, -30, 70, fur); c.ellipse(0, -14, 50, 44, rgb(236,196,156))\n  c.ellipse(-22,-38,7,8,"black"); c.ellipse(22,-38,7,8,"black")\n  c.pop()
scene code: def draw(c, t, p):\n  c.grad(rgb(255,196,120), rgb(255,236,190))\n  k = ease_out((t - c.cue("ลิง")) * 2.2)\n  monkey(c, lerp(1250, 640, k), 1120, 2.1, t, "happy")\n  c.person("ตั้ม", 250, 780, 250)

## Visual style
Every episode is drawn in one visual style (all code-drawn): ${STYLE_NAMES.map((k) => `${k} (${STYLES[k].en})`).join('; ')}.
Set "style". The user message says whether the owner fixed it; otherwise pick the one that suits the story best and differs from the last two episodes.

## Captions
captions: facebook, instagram, tiktok, youtube (title-style, ≤ 90 chars), twitter (≤ 260 chars). Thai, hook + the quiz question or key fact,
one short "อ้างอิง:" line naming the main sources and years, 5–8 hashtags including #จะเกิดอะไรขึ้นถ้า #รู้หรือไม่ (instagram/tiktok may have more).

## Process
1. Plan, then research (several queries, Thai + English, newest year first) and confirm the key figures on the actual pages.
2. Write the complete narration and shot plan FIRST. Call plan_story with script, shots and character_notes. Each shot describes what is seen, action, camera and cast names.
3. After plan_story succeeds, draw ONE small asset per turn. Call draw_character once per cast member, save_art once for shared helpers, then draw_scene once per shot. Never write the whole episode's artwork in one response. Work is checkpointed after each asset; reuse saved assets and only change the broken one.
4. Call submit_episode with narration and metadata (sources,claims,captions,music etc), OMIT script/cast/scenes/art because saved narration and artwork are assembled by the server. If a correction needs different narration, call plan_story again and recheck the affected shots.
A real retrieved source is required for factual context. If no nickname counts are available, state that honestly; read_page remains available to verify supporting context (e.g. population data or monkeys), and fiction must stay labelled as fiction. Do not erase sources or redesign art merely to repair metadata. Do not continue broad web research after planning. When a source fails provenance, read_page opens the exact URL via the available provider; do not invent a replacement URL.
5. Inspect the preview frames sent after submission and repair individual assets with draw_character/draw_scene/save_art. Resubmit metadata without reprinting all drawings. The worker renders all scenes; inspect its preview images against the original references and narration. Correct likeness, composition and action before resubmitting. Only inspected, successfully rendered art can become ready.
Reply only through tools.`;
  if (mode === 'general') {
    const start = prompt.indexOf('## Cover + opening');
    const end = prompt.indexOf('## Pace', start);
    prompt = prompt.slice(0,start) + `## General storytelling mode
Open with a question, surprising supported fact or a problem about THIS topic. Never invent a person's nickname or ask how many people share it.
There is no mandatory protagonist, mascot or human. When no reference character is supplied, prefer objects, environments, diagrams, timelines and visual metaphors; use cast: [] and shots.characters: [] for character-free shots.
Only introduce people when the owner requests them or they are essential to explain the story. A source author's name (e.g. Dr Michael Breus) is attribution, not an instruction to create a protagonist or portrait.
Draw every shot from its own narration and storyboard; show the relevant subject clearly and animate the explanation. The cover is a topical frame and title, never the name-series cover.

` + prompt.slice(end);
    prompt = prompt.replace('Define 1–4 people', 'If people are needed, define 0–4 people').replace('Scene 1 is also custom: stage a new opening with the hero, not a fixed template.', 'Scene 1 is custom: draw a topical opening; a human is optional.');
    prompt += `\nOwner supplied source text is unverified input. Retrieve the original source and cross-check factual claims. For health content, distinguish an expert's suggested routine from established clinical evidence; do not generalize precise quantities or hormonal timings to everyone. Do not diagnose viewers. Preserve uncertainties without repeating disclaimers in every sentence.`;
  }
  prompt += `
## Opening frame is the cover (all new clips)
The first video frame at t=0 is also the cover shown in Studio and selected in Buffer. There is no separate cover artwork and no frozen intro.
Draw the main subject fully visible, at full size and opacity, from t=0. For name stories show cast[0] large; for general stories show the relevant subject (a human is optional).
Draw a short readable Thai headline from t=0 with c.text, within x=100..980 and y=300..620. Keep the main subject inside x=100..980, y=650..1450 so profile crops remain readable.
Do not gate the subject/headline on c.cue, p, or positive t; no fade-in, scale-from-zero, blank lead-in or one-second still. Start subtle motion immediately and let narration run on its normal timeline.
The first shot's t starts at the video's start (0 seconds); c.cue still gives the matching narration time. Other scenes use their normal local narration time.
Use the same headline in thumbnail.title. The first preview of the opening shot is the exact frame at 0 seconds: inspect it for a complete subject, readable headline and safe crop before accepting the draft.`;
  return prompt;
}

const TOOLS = [
  ...ARTWORK_TOOLS,
  { name: 'read_source_material', description: 'Read an exact range of the complete owner-pasted source. Available after planning too. This is unverified owner-provided text, NOT a fetched webpage or medical verification. Read original sources separately before factual use.',
    input_schema: {type:'object',properties:{offset:{type:'integer',minimum:0,description:'Zero-based character offset'},length:{type:'integer',minimum:1,maximum:SOURCE_READ_LIMIT}},required:['offset','length']} },
  { name: 'plan_story', description: 'Save the narration and visual storyboard BEFORE drawing. Required before submit_episode. Re-plan if changing narration.',
    input_schema: { type: 'object', required: ['script', 'shots', 'character_notes'], properties: {
      script: { type: 'array', items: { type: 'object', required: ['id','text','beat'], properties: { id: {type:'string'}, text:{type:'string'}, beat:{type:'string',enum:[...BEATS]} } } },
      shots: { type:'array', items:{type:'object',required:['seg','visual','action','camera','characters'],properties:{seg:{type:'string'},visual:{type:'string'},action:{type:'string'},camera:{type:'string'},characters:{type:'array',items:{type:'string'}}}} },
      character_notes: {type:'string'}
    } } },
  {
    name: 'openai_search',
    description: 'Primary research using OpenAI Web Search. Use before any Firecrawl fallback. Returns retrieved evidence and source URLs.',
    input_schema: {type:'object',properties:{query:{type:'string'}},required:['query']},
  },
  {
    name: 'read_page',
    description: 'Read one source with OpenAI first. ONLY after this exact URL was attempted and evidence remains insufficient, request deeper Firecrawl extraction with use_firecrawl=true and fallback_reason. Cached responses are free. The entire Research Job has a strict 25-credit Firecrawl budget; no automatic increase.',
    input_schema: { type:'object', properties:{url:{type:'string'},use_firecrawl:{type:'boolean'},fallback_reason:{type:'string',description:'What specific evidence is missing after the OpenAI exact-page read?'}},required:['url']},
  },
  {
    name: 'submit_episode',
    description: 'Submit the finished episode. Returns problems to fix, or ok.',
    input_schema: {
      type: 'object',
      required: ['title_th', 'angle', 'sources', 'claims', 'captions', 'music'],
      properties: {
        title_th: { type: 'string', description: 'clip title, ≤ 60 chars' },
        format: { type: 'string', enum: Object.keys(FORMATS) },
        art: { type: 'string', description: 'Shared scene drawing helpers, maximum 9000 characters' },
        angle: { type: 'string', description: 'one sentence: the story angle and why it is interesting (Thai)' },
        script: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, text: { type: 'string' }, beat: { type: 'string', enum: [...BEATS] } }, required: ['id', 'text', 'beat'] } },
        scenes: { type: 'array', items: { type: 'object' } },
        sources: { type: 'array', items: { type: 'object', properties: {
          url: { type: 'string' }, title: { type: 'string' }, publisher: { type: 'string' }, published: { type: 'string', description: 'YYYY-MM-DD, YYYY-MM or YYYY of the data/publication' },
          claim: { type: 'string' }, methodology: { type: 'string' }, confidence: { type: 'string', enum: ['high', 'medium', 'low'] }, limitations: { type: 'string' },
          freshness_note: { type: 'string' } }, required: ['url', 'publisher', 'published', 'claim', 'confidence'] } },
        claims: { type: 'array', items: { type: 'object', properties: { text: { type: 'string' }, source_ids: { type: 'array', description: 'Zero-based indices into the sources array, not citation numbers. If sources has one entry, cite it with [0]. Only reference sources that support this claim.', items: { type: 'integer', minimum: 0 } },
          kind: { type: 'string', enum: ['fact', 'assumption', 'opinion'] } }, required: ['text', 'source_ids', 'kind'] } },
        captions: { type: 'object', properties: { facebook: { type: 'string' }, instagram: { type: 'string' }, tiktok: { type: 'string' }, youtube: { type: 'string' }, twitter: { type: 'string' } },
          required: ['facebook', 'instagram', 'tiktok', 'youtube', 'twitter'] },
        sfx: { type: 'array', items: { type: 'object', properties: { sfx: { type: 'string' }, seg: { type: 'string' }, at: { type: 'string' }, gain: { type: 'number' },
          prompt: { type: 'string' }, duration: { type: 'number' } }, required: ['sfx', 'seg', 'at'] } },
        music: { type: 'string', enum: Object.keys(MUSIC) },
        music_brief: { type: 'object', properties: { tempo_bpm: { type: 'integer' }, instruments: { type: 'string' }, feel: { type: 'string' } } },
        style: { type: 'string', enum: STYLE_NAMES },
        cast: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, hairstyle: { type: 'string' }, hair_color: { type: 'string' },
          skin: { type: 'string' }, top: { type: 'string' }, top_color: { type: 'string' }, bottom: { type: 'string' }, bottom_color: { type: 'string' },
          glasses: { type: 'string' }, accessories: { type: 'array', items: { type: 'string' } }, accessory_color: { type: 'string' }, portrait_code: {type:'string'}, portrait_description: {type:'string'} }, required: ['name','portrait_code','portrait_description'] } },
        thumbnail: { type: 'object', properties: { seg: { type: 'string' }, title: { type: 'string' } } },
        cover: { type: 'object', properties: { name: { type: 'string' }, line: { type: 'string' } } },
      },
    },
  },
];

// ---------------------------------------------------------------- validation of a draft
// a colour is a name from the lists above or an exact [r,g,b] (cast made from a photo)
const Colour = z.union([z.string(), z.array(z.number().int().min(0).max(255)).length(3)]);
export const Draft = z.object({
  story_mode: z.enum(['name_story','general']).optional(),
  storyboard: Storyboard.optional(),
  title_th: z.string().min(4).max(90),
  angle: z.string().default(''),
  format: z.string().default(''),
  script: z.array(z.object({ id: z.string().regex(/^[a-z0-9_]{1,24}$/), text: z.string().min(3).max(500), beat: z.enum(BEATS).default('info') })).min(4).max(14),
  scenes: z.array(z.object({ seg: z.string(), type: z.enum(TEMPLATES), code: z.string().max(6000).optional() }).passthrough()).min(1),
  art: z.string().max(9000).default(''),   // shared drawing helpers for this story's "custom" scenes (engine/artkit.py)
  sources: z.array(z.object({
    url: z.string().url(), title: z.string().optional(), publisher: z.string().default(''), published: z.string().default(''), claim: z.string().default(''),
    methodology: z.string().optional(), confidence: z.enum(['high', 'medium', 'low']).default('medium'), limitations: z.string().optional(), freshness_note: z.string().optional(),
  })).min(1).max(15),
  claims: z.array(z.object({ text: z.string(), source_ids: z.array(z.number().int().min(0)).default([]), kind: z.enum(['fact', 'assumption', 'opinion', 'community']).default('fact') })).min(1),
  captions: z.object({ facebook: z.string(), instagram: z.string(), tiktok: z.string(), youtube: z.string(), twitter: z.string() }),
  sfx: z.array(z.object({ sfx: z.string(), seg: z.string(), at: z.string(), gain: z.number().min(0).max(1.2).default(0.5),
    prompt: z.string().max(140).optional(), duration: z.number().min(0.5).max(4).optional() })).max(14).default([]),
  music: z.string().default('playful'),
  music_brief: z.object({ tempo_bpm: z.number().min(60).max(150).optional(), instruments: z.string().max(160).optional(), feel: z.string().max(200).optional() }).optional(),
  style: z.string().optional(),
  music_mode: z.enum(['default', 'ai']).optional(),
  cast: z.array(z.object({
    name: z.string().min(1).max(20), portrait_code: z.string().max(9000).optional(), portrait_description: z.string().max(2500).optional(), hairstyle: z.string().optional(), hair_color: Colour.optional(), skin: Colour.optional(),
    top: z.string().optional(), top_color: Colour.optional(), bottom: z.string().optional(), bottom_color: Colour.optional(),
    glasses: z.string().optional(), accessories: z.array(z.string()).optional(), accessory_color: Colour.optional(),
    inner_color: Colour.optional(), shoes_color: Colour.optional(), frame_color: Colour.optional(), pattern: z.string().optional(), pattern_color: Colour.optional(),
    backdrop: z.string().max(220_000).optional(),   // photo background of a photo character, set by the server, never by the brain
  })).max(4).default([]),
  cover_mode: z.literal('opening_frame').optional(), // server-set after generation; legacy drafts keep their cover
  thumbnail: z.object({ seg: z.string().optional(), title: z.string().optional() }).optional(),
  cover: z.object({ name: z.string().max(20).optional(), line: z.string().max(40).optional() }).optional(),
});
export type DraftT = z.infer<typeof Draft>;

const TIME_KEYS = new Set(['at', 'highlight_at', 'icon_at', 'verdict_at']);
function timingRefs(node: any, out: string[] = []) {
  if (Array.isArray(node)) node.forEach((x) => timingRefs(x, out));
  else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (TIME_KEYS.has(k) && typeof v === 'string') out.push(v);
      else if (k === 'countdown' && Array.isArray(v)) v.forEach((x) => typeof x === 'string' && out.push(x));
      else if (typeof v === 'object') timingRefs(v, out);
    }
  }
  return out;
}
function iconRefs(node: any, out: string[] = []) {
  if (Array.isArray(node)) node.forEach((x) => iconRefs(x, out));
  else if (node && typeof node === 'object') for (const [k, v] of Object.entries(node)) {
    if (k === 'icon' && typeof v === 'string') out.push(v);
    else if (typeof v === 'object') iconRefs(v, out);
  }
  return out;
}

// After the owner edits narration, a timing word that is gone only moves that animation to its approximate position.
const SOFT = /timing word|sfx .*word/;
// The owner's own edits are never blocked by storytelling rules; they are shown as warnings instead.
const OWNER_SOFT = /timing word|sfx .*word|hook|re-hook|beat "cta"|both use|is used \d+ times|format|scene sequence|action|main character big|must be seen big|opening question|claim about how many/;

// problems: must be fixed. warnings: shown to the owner, do not block.
export type Recent = { format: string; types: string[]; title: string; style?: string; music?: string };

// Estimated start time of every segment (seconds), using the same speed as the credit estimate plus a short pause per segment.
export function timing(script: { text: string }[]) {
  let t = 0;
  return script.map((s) => { const start = t; const dur = s.text.replace(/\s+/g, '').length / CPS; t += dur + 0.35; return { start, dur, end: start + dur }; });
}

export function checkDraft(d: DraftT, seen: Map<string, Seen> | null, recent: Recent[] = [], opts: { requiredNames?: string[]; bespoke?: boolean } = {}) {
  const problems: string[] = [], warnings: string[] = [];
  const bespoke = opts.bespoke || !!d.storyboard;
  const general = d.story_mode === 'general';
  if (d.storyboard && (d.storyboard.story_mode || 'name_story') !== (d.story_mode || 'name_story')) problems.push('story mode must match the saved storyboard');
  if (bespoke) {
    if (!d.storyboard) problems.push('Call plan_story before drawing the episode');
    else problems.push(...validateStoryboardDraft(d.storyboard, d));
    for (const c of d.cast) if (!c.portrait_code || !/def\s+draw\s*\(\s*c\s*,\s*t\s*,\s*p\s*\)/.test(c.portrait_code)) problems.push(`cast ${c.name}: bespoke portrait_code must define def draw(c,t,p):`);
  }
  const ids = d.script.map((s) => s.id);
  if (new Set(ids).size !== ids.length) problems.push('script ids must be unique');
  const customScenes = d.scenes.filter((x: any) => x.type === 'custom') as any[];
  if (customScenes.length < 2) problems.push('use at least 2 "custom" scenes: draw what this story is about with code (see "Custom scene art")');
  for (const cs of customScenes) {
    if (typeof cs.code !== 'string' || cs.code.length < 30 || !/def\s+draw\s*\(\s*c\s*,\s*t\s*,\s*p\s*\)/.test(cs.code)) problems.push(`custom scene ${cs.seg}: "code" must define def draw(c, t, p):`);
  }
  if (customScenes.length && !(d.art || '').trim()) warnings.push('custom scenes without shared "art" helpers');
  const text = new Map(d.script.map((s) => [s.id, s.text]));
  for (const s of d.script) {
    if (/[0-9๐-๙%]/.test(s.text)) problems.push(`script ${s.id}: write numbers and % as Thai words (no digits or symbols): "${s.text.slice(0, 60)}"`);
    if (/[A-Za-z]{3,}/.test(s.text)) warnings.push(`script ${s.id}: English letters will be read by the Thai voice; Thai transliteration sounds better`);
    for (const ph of s.text.split(/\s+/)) if (ph.length > 40) warnings.push(`script ${s.id}: long phrase without spaces (subtitle will be long): "${ph.slice(0, 30)}…"`);
  }
  const chars = d.script.reduce((n, s) => n + s.text.length, 0);
  if (chars < 350) problems.push(`narration is too short (${chars} characters); aim for 450–1000`);
  if (chars > 1200) problems.push(`narration is too long (${chars} characters); keep it under 1000 (about 75 seconds)`);
  const scenesBySeg = new Map(d.scenes.map((s) => [s.seg, s]));
  for (const id of ids) if (!scenesBySeg.has(id)) problems.push(`no scene for segment ${id}`);
  for (const sc of d.scenes) {
    if (!text.has(sc.seg)) { problems.push(`scene refers to unknown segment ${sc.seg}`); continue; }
    const t = normText(text.get(sc.seg)!);
    for (const a of timingRefs(sc)) if (normText(a) && !t.includes(normText(a))) problems.push(`scene ${sc.seg}: timing word "${a}" is not in that segment's narration`);
    for (const ic of iconRefs(sc)) if (!ICONS.includes(ic)) problems.push(`scene ${sc.seg}: unknown icon "${ic}"`);
    if ((sc as any).bg && !BGS.includes((sc as any).bg)) warnings.push(`scene ${sc.seg}: unknown bg "${(sc as any).bg}" (a default is used)`);
  }
  let custom = 0;
  for (const fx of d.sfx) {
    if (fx.sfx === 'custom') {
      custom++;
      if (!oneLine(fx.prompt, 140)) problems.push(`custom sfx at "${fx.at}" needs a "prompt" describing the sound`);
    } else if (!SFX[fx.sfx]) problems.push(`unknown sfx "${fx.sfx}" (use a library sound or "custom" with a prompt)`);
    if (!text.has(fx.seg)) problems.push(`sfx cue refers to unknown segment ${fx.seg}`);
    else if (!normText(text.get(fx.seg)!).includes(normText(fx.at))) problems.push(`sfx ${fx.sfx}: word "${fx.at}" is not in segment ${fx.seg}`);
  }
  if (custom > MAX_CUSTOM_SFX) problems.push(`${custom} custom sound effects; at most ${MAX_CUSTOM_SFX}`);
  if (d.style && !STYLES[d.style]) problems.push(`unknown style "${d.style}" (use ${STYLE_NAMES.join(', ')})`);
  const names = new Set(d.cast.map((c) => c.name));
  if (names.size !== d.cast.length) problems.push('cast names must be unique');
  for (const c of d.cast) {
    const bad: string[] = [];
    if (c.hairstyle && !HAIRSTYLES.includes(c.hairstyle)) bad.push(`hairstyle "${c.hairstyle}"`);
    if (typeof c.hair_color === 'string' && !HAIR_COLORS.includes(c.hair_color)) bad.push(`hair_color "${c.hair_color}"`);
    if (typeof c.skin === 'string' && !SKINS.includes(c.skin)) bad.push(`skin "${c.skin}"`);
    if (c.top && !TOPS.includes(c.top)) bad.push(`top "${c.top}"`);
    if (c.bottom && !BOTTOMS.includes(c.bottom)) bad.push(`bottom "${c.bottom}"`);
    for (const k of ['top_color', 'bottom_color', 'accessory_color'] as const) if (typeof c[k] === 'string' && !CLOTH.includes(c[k] as string)) bad.push(`${k} "${c[k]}"`);
    if (c.glasses && !['round', 'square', 'none'].includes(c.glasses)) bad.push(`glasses "${c.glasses}"`);
    for (const a of c.accessories || []) if (!ACCESSORIES.includes(a)) bad.push(`accessory "${a}"`);
    if (bad.length) problems.push(`cast ${c.name}: unknown ${bad.join(', ')}`);
  }
  // ---- cover + opening (owner's rule): main character = cast[0]; the clip opens with "how many people are named X in Thailand"
  if (!general && !d.cast.length) problems.push('cast[0] is required: the main character whose name is on the cover ("คนนี้ชื่อ …")');
  else if (!general) {
    const nm = d.cast[0].name;
    const first = d.script[0]?.text || '';
    if (!normText(first).includes(normText(nm)) || !first.includes('ไทย')) problems.push(`segment 1 must be the opening question "คนชื่อ ${nm} ในประเทศไทย มีกี่คน" (it needs the name "${nm}" and "ประเทศไทย")`);
    if (!d.claims.some((c) => normText(c.text).includes(normText(nm)))) problems.push(`add a claim about how many people in Thailand are named "${nm}" (with its source, or kind "assumption" when no official count exists)`);
    // the main character big on screen in the opening (like the cover)
    const sc0: any = d.scenes.find((x) => x.seg === d.script[0]?.id);
    if (!bespoke && sc0 && (sc0.type !== 'scenario' || (sc0.person?.who && sc0.person.who !== nm)))
      problems.push(`segment 1's scene must be type "scenario" showing the main character big: "person": {"who": "${nm}"} with the question as headline or bubble`);
  }
  // characters made from the owner's photos are shown big (scenario scenes), not only small in a corner
  const req = (opts.requiredNames || []).filter((n) => names.has(n));
  if (req.length && !bespoke) {
    const big = (d.scenes as any[]).filter((sc) => sc.type === 'scenario' && (req.includes(sc.person?.who) || req.includes(sc.person2?.who))).length;
    const need = Math.min(4, Math.ceil(d.scenes.length / 3));
    if (big < need) problems.push(`the owner's photo characters (${req.join(', ')}) must be seen big: use at least ${need} "scenario" scenes with one of them as "person" (now ${big})`);
  }
  if (bespoke) {
    if (!general && !personCalls(String(d.scenes.find(s => s.seg === d.script[0]?.id)?.code || '')).includes(d.cast[0]?.name)) problems.push('opening scene must draw the main cast member with c.person');
    for (const name of req) if (d.scenes.filter(s => personCalls(s.code || '').includes(name)).length < Math.ceil(d.scenes.length / 3)) problems.push(`show reference character ${name} clearly in at least a third of scenes`);
  }
  for (const sc of d.scenes as any[]) for (const k of ['person', 'person2']) {
    const who = sc[k]?.who;
    if (who && !names.has(who)) problems.push(`scene ${sc.seg}: ${k}.who "${who}" is not in cast`);
  }
  // ---- retention rules
  const tm = timing(d.script);
  const first = d.script[0], last = d.script[d.script.length - 1];
  if (first.beat !== 'hook') problems.push(`segment 1 (${first.id}) must have beat "hook"`);
  if (tm[0].dur > HOOK_SECS + 0.2) problems.push(`the hook "${first.id}" takes about ${tm[0].dur.toFixed(1)} s; it must land within ${HOOK_SECS} s (≤ ${HOOK_SECS * CPS} characters)`);
  if (last.beat !== 'cta') problems.push(`the last segment (${last.id}) must have beat "cta" and ask viewers something to answer in the comments`);
  const hooks = d.script.map((s, i) => ({ s, i })).filter((x) => x.s.beat === 'hook' || x.s.beat === 'rehook').map((x) => x.i);
  const marks = [...new Set([0, ...hooks.map((i) => tm[i].start), tm[tm.length - 1].start])].sort((x, y) => x - y);
  for (let k = 1; k < marks.length; k++) {
    const gap = marks[k] - marks[k - 1];
    if (gap > REHOOK_SECS + 0.5) {
      const from = d.script.find((_, i) => Math.abs(tm[i].start - marks[k - 1]) < 1e-6)?.id ?? 'the start';
      problems.push(`no re-hook for ${gap.toFixed(1)} s after "${from}" (about ${marks[k - 1].toFixed(0)}–${marks[k].toFixed(0)} s); add a "rehook" segment so there is one at least every ${REHOOK_SECS} s`);
    }
  }
  // a hook or re-hook must change the picture the moment it starts: its first visual has to fire early in the segment
  for (const sg of d.script) {
    if (sg.beat !== 'hook' && sg.beat !== 'rehook') continue;
    const sc: any = d.scenes.find((x) => x.seg === sg.id);
    if (!sc) continue;
    const txt = normText(sg.text);
    const refs = timingRefs(sc).map((a) => txt.indexOf(normText(a))).filter((i) => i >= 0);
    const early = !refs.length || Math.min(...refs) <= 8 /* ≈ 0.7 s */ || ['hook', 'chat', 'scenario'].includes(sc.type) && !sc.headline;
    if (!early) problems.push(`scene ${sg.id} is a ${sg.beat} but nothing appears until later in the segment; time a headline, stamp or the first element to its first words`);
  }
  // ---- characters: one in every frame, moving with the context
  const acts: string[] = [];
  for (const sc of d.scenes as any[]) {
    if (sc.type === 'custom') {   // a custom scene draws its own characters in its code
      if (!general && !/c\.(person|cat)\s*\(/.test(String(sc.code || ''))) problems.push(`custom scene ${sc.seg}: draw a character in it with c.person("name", ...) or c.cat(...) (a character is in every scene)`);
      acts.push('');
      continue;
    }
    if (sc.cat === false) problems.push(`scene ${sc.seg}: "cat": false is not allowed; a character must be on screen in every scene`);
    const a = sc.cat && typeof sc.cat === 'object' ? sc.cat.action : undefined;
    const name = typeof a === 'string' ? a : a?.name;
    if (!name) { problems.push(`scene ${sc.seg}: give the character an "action" (cat.action {"name","at"}) that matches what is being said`); acts.push(''); continue; }
    if (!ACTIONS.includes(name)) problems.push(`scene ${sc.seg}: unknown action "${name}" (use ${ACTIONS.join(', ')})`);
    acts.push(name);
    const pa = sc.person?.action; const pn = typeof pa === 'string' ? pa : pa?.name;
    if (pn && !ACTIONS.includes(pn)) problems.push(`scene ${sc.seg}: unknown person action "${pn}"`);
  }
  for (let i = 1; i < acts.length; i++) if (acts[i] && acts[i] === acts[i - 1] && acts[i] !== 'idle') problems.push(`scenes ${d.scenes[i - 1].seg} and ${d.scenes[i].seg} give the character the same action "${acts[i]}"; vary the movement`);
  if (new Set(acts.filter((x) => x && x !== 'idle')).size < Math.min(4, d.scenes.filter((x: any) => x.type !== 'custom').length)) problems.push('use at least 4 different character actions across the episode');
  // ---- variety
  const types = d.script.map((s) => (d.scenes.find((x) => x.seg === s.id) as any)?.type).filter(Boolean) as string[];
  for (let i = 1; i < types.length; i++) if (types[i] === types[i - 1] && types[i] !== 'scenario' && types[i] !== 'custom') problems.push(`scenes ${d.script[i - 1].id} and ${d.script[i].id} both use "${types[i]}"; change one (avoid the same layout twice in a row)`);
  const counts = types.reduce((m: Record<string, number>, x) => ({ ...m, [x]: (m[x] || 0) + 1 }), {});
  for (const [k, n] of Object.entries(counts)) if (k !== 'custom' && n > (k === 'scenario' ? 5 : 2)) problems.push(`scene type "${k}" is used ${n} times; vary the layouts`);
  if (d.format && !FORMATS[d.format]) problems.push(`unknown format "${d.format}"`);
  if (!d.format) problems.push('set "format" to one of: ' + Object.keys(FORMATS).join(', '));
  const clash = recent.slice(0, 2).filter((r) => r.format && r.format === d.format);
  if (d.format && clash.length) problems.push(`format "${d.format}" was used in a recent episode ("${clash[0].title}"); choose a different format`);
  const sig = (xs: string[]) => xs.slice(0, 5).join('>');
  const same = recent.slice(0, 6).find((r) => r.types.length && sig(r.types) === sig(types));
  if (same && !bespoke) problems.push(`the scene sequence starts exactly like "${same.title}" (${sig(types)}); change the order or the layouts`);
  if (!MUSIC[d.music]) warnings.push(`unknown music mood "${d.music}" (playful is used)`);
  const thisYear = nowBkk().getUTCFullYear();
  d.sources.forEach((s, i) => {
    if (seen && !seen.has(normUrl(s.url))) problems.push(`source ${i} (${s.url}) was not retrieved with a search or page read in this session — research rule: only use pages you fetched`);
    const y = yearOf(s.published);
    if (!y) problems.push(`source ${i}: "published" needs the date or year of the data`);
    else if (thisYear - y > MAX_YEARS && !(s.freshness_note && s.freshness_note.trim().length >= 10)) {
      problems.push(`source ${i} is from ${y}: find newer data, or add freshness_note explaining why this is the latest available`);
    }
  });
  d.claims.forEach((c) => {
    if (c.kind === 'fact' && (!c.source_ids.length || c.source_ids.some((k) => k >= d.sources.length))) {
      const validRange = d.sources.length ? `0..${d.sources.length - 1}` : 'none (sources is empty)';
      problems.push(`fact without a valid source: "${c.text.slice(0, 80)}"; source_ids=${JSON.stringify(c.source_ids)} must contain zero-based indices into sources[]; valid range: ${validRange}. With one source, use [0]. Correct the metadata references to sources supporting this fact, or remove an unsupported fact. This index error does not mean an already retrieved URL needs fetching again.`);
    }
  });
  if (d.captions.twitter.length > 270) problems.push(`captions.twitter is ${d.captions.twitter.length} characters (max 270)`);
  return { problems: [...new Set(problems)], warnings: [...new Set(warnings)] };
}

// ---------------------------------------------------------------- draft -> episode package
export function sceneCode(d: DraftT) {
  const spec = { opening_frame_cover: d.cover_mode === 'opening_frame', strict_art: !!d.storyboard, scenes: d.scenes, text: Object.fromEntries(d.script.map((s) => [s.id, s.text])), cast: d.cast, art: d.art || '' };
  return `"""Generated episode: scenes are data rendered by engine.templates (code-drawn templates, no images)."""\nimport json\nfrom engine.templates import build_scenes\n\nSPEC = json.loads(${JSON.stringify(JSON.stringify(spec))})\nSCENES = build_scenes(SPEC)\n`;
}

export function buildPackage(topic: string, d: DraftT, research: Seen[]) {
  const byUrl = new Map(research.map((r) => [normUrl(r.url), r]));
  const cues = new Map<string, any[]>();
  const customSfx = new Map<string, { prompt: string; duration: number }>();
  for (const fx of d.sfx) {
    let id = fx.sfx;
    if (fx.sfx === 'custom') {
      const prompt = oneLine(fx.prompt, 140);
      if (!prompt) continue;
      const full = `${prompt}, sound effect only, no music, no voice`;
      id = [...customSfx.entries()].find(([, v]) => v.prompt === full)?.[0] ?? `custom${customSfx.size + 1}`;
      if (!customSfx.has(id)) {
        if (customSfx.size >= MAX_CUSTOM_SFX) continue;
        customSfx.set(id, { prompt: full, duration: Math.min(4, Math.max(0.5, fx.duration ?? 1.5)) });
      }
    } else if (!SFX[id]) continue;
    if (!cues.has(id)) cues.set(id, []);
    cues.get(id)!.push({ seg: fx.seg, word: fx.at, n: 0, offset: 0, gain: fx.gain ?? 0.5 });
  }
  const firstLine = (sc: any) => sc.headline?.text || sc.lines?.[0]?.text || sc.question?.text || sc.statement?.text || sc.bubble?.text || '';
  const thumbSeg = d.thumbnail?.seg && d.script.some((s) => s.id === d.thumbnail!.seg) ? d.thumbnail.seg : d.script[0].id;
  return {
    topic, title_th: d.title_th.slice(0, 120), series_tag: SERIES_TAG,
    script: d.script,
    voice: { voice_id: VOICE_ID, model_id: 'eleven_v4', language_code: 'th', stability: 0.35, similarity_boost: 0.75, speed: VOICE_SPEED },
    // 'default' reuses the channel's default track (no music generation); the prompt is the fallback if that track cannot be found
    music: { source: d.music_mode === 'ai' ? 'generate' : 'default', prompt: musicPrompt(d), model_id: 'music_v1', volume: 0.28 },
    sfx: [...cues.entries()].map(([id, cs]) => ({ id, prompt: customSfx.get(id)?.prompt ?? SFX[id].prompt, duration: customSfx.get(id)?.duration ?? SFX[id].duration, cues: cs })),
    style: d.style && STYLES[d.style] ? d.style : 'classic',
    scene_code: sceneCode(d),
    storyboard: d.scenes.map((s: any) => ({ ...d.storyboard?.shots.find(x => x.seg === s.seg), seg: s.seg, visual: d.storyboard?.shots.find(x => x.seg === s.seg)?.visual || `template:${s.type}`, onscreen: firstLine(s), bg: s.bg ?? null, transition: 'iris' })),
    sources: d.sources.map((s) => {
      const r = byUrl.get(normUrl(s.url));
      return { url: s.url, publisher: s.publisher, title: s.title || r?.title, published: s.published, collected: r?.collected || todayIso(), methodology: s.methodology,
        confidence: s.confidence, limitations: s.limitations, claim: s.claim, retrieved_via: r?.via === 'web' ? 'openai_web_search' : 'firecrawl', ...(s.freshness_note ? { freshness_note: s.freshness_note } : {}) };
    }),
    claims: d.claims,
    captions: d.captions,
    thumbnail: d.cover_mode === 'opening_frame'
      ? { mode: 'opening_frame' as const, seg: d.script[0].id, offset: 0, title: d.thumbnail?.title || d.title_th.slice(0, 40) }
      : { seg: thumbSeg, offset: 1.5, title: d.thumbnail?.title || d.title_th.slice(0, 40) },
    ...(d.cover_mode !== 'opening_frame' && d.story_mode !== 'general' && d.cast.length ? { cover: { who: d.cast[0].name, name: (d.cover?.name || d.cast[0].name).slice(0, 20), line: (d.cover?.line || d.thumbnail?.title || d.title_th).slice(0, 40) } } : {}),
    budget: { max_credits: DRAFT_MAX_CREDITS },
  };
}

// ---------------------------------------------------------------- the generator
type Deps = {
  guard: (c: Context, next: Next) => Promise<any>;
  createJob: (body: any, idem: string | null) => Promise<{ status: number; body: any }>;
  estimateCredits: (p: unknown) => number;
  researchFreshness: (p: unknown) => string[];
  validate: (p: unknown) => string[];
};

// ---------------------------------------------------------------- characters from a photo
// The photo is only ANALYSED (vision) into the parameters the code-drawn chibi engine understands; nothing is generated from it.
type Look = { reference_description?: string; hairstyle: string; hair_color: number[]; skin: number[]; top: string; top_color: number[]; inner_color?: number[]; bottom: string; bottom_color: number[]; shoes_color?: number[]; frame_color?: number[];
  pattern?: string; pattern_color?: number[]; glasses: string; accessories: string[]; accessory_color: number[]; backdrop?: string };
export type PhotoResult = { look: Look; person_box: number[] | null };
const PATTERNS = ['none', 'stripes', 'plaid', 'dots'];
const BOX4 = { type: 'array', items: { type: 'integer' }, minItems: 4, maxItems: 4 };
const rgb = (v: any, d: number[]): number[] => (Array.isArray(v) && v.length >= 3 ? v.slice(0, 3).map((n) => Math.max(0, Math.min(255, Math.round(Number(n) || 0)))) : d);
const pick = (v: any, list: string[], d: string) => (list.includes(v) ? v : d);
const RGB3 = { type: 'array', items: { type: 'integer' }, minItems: 3, maxItems: 3 };
const LOOK_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['reference_description', 'person_visible', 'hairstyle', 'hair_color', 'skin', 'top', 'top_color', 'inner_color', 'bottom', 'bottom_color', 'shoes_color', 'frame_color', 'pattern', 'pattern_color', 'glasses', 'accessories', 'accessory_color', 'boxes'],
  properties: {
    reference_description: {type:'string', description:'Visible facial geometry, hairline, body proportions and distinctive clothing details; do not identify the person.'},
    person_visible: { type: 'boolean' },
    inner_color: RGB3, shoes_color: RGB3, frame_color: RGB3, pattern: { type: 'string', enum: PATTERNS }, pattern_color: RGB3,
    boxes: { type: 'object', additionalProperties: false, required: ['person', 'head', 'hair', 'torso', 'legs', 'shoes'],
      properties: { person: BOX4, head: BOX4, hair: BOX4, torso: BOX4, legs: BOX4, shoes: BOX4 } },
    hairstyle: { type: 'string', enum: HAIRSTYLES }, hair_color: RGB3, skin: RGB3,
    top: { type: 'string', enum: TOPS }, top_color: RGB3, bottom: { type: 'string', enum: BOTTOMS }, bottom_color: RGB3,
    glasses: { type: 'string', enum: ['round', 'square', 'none'] }, accessories: { type: 'array', items: { type: 'string', enum: ACCESSORIES } }, accessory_color: RGB3,
  },
};
const PHOTO_PROMPT = `You turn a photo of a person into the parameters of a flat, friendly cartoon character that is drawn by code. Look only at what is visible: the hair, the clothes, glasses, skin tone, accessories.
Do NOT identify the person or guess their name, age, ethnicity or health; describe the styling only.
- hairstyle: the closest of ${HAIRSTYLES.join(', ')} (helmet = a rounded bowl cut with a fringe, spiky = short upright hair, side_part, curly, bald, long, bob = chin length, ponytail, bun).
- hair_color, skin, top_color, bottom_color, accessory_color: [r,g,b] 0-255 read from the picture as the colour of the lit surface (not the shadow). skin is the lit skin tone of the face.
- top: blazer (jacket or suit), tshirt, hoodie, shirt (collared or buttoned), dress. bottom: pants, shorts or skirt (if only the upper body is visible, choose pants).
- glasses: round, square or none. accessories: any of ${ACCESSORIES.join(', ')} that are clearly visible (cap for a hat or cap, mustache, beard, earrings, headband, bow, bag for a visible bag strap; lashes only when stylised makeup stands out).
- inner_color: the shirt/turtleneck under a jacket (same as top_color when there is no outer layer). shoes_color: the shoes (grey when not visible). frame_color: the glasses frame colour (brown when no glasses).
- pattern: stripes, plaid or dots when the top clearly has that print, else none; pattern_color is the colour of the print lines/dots.
- boxes: where each part is in the picture as [x0, y0, x1, y1] integers 0-1000 (fractions of the image width/height, origin top-left). person = the whole visible body incl. hair; head = the face incl. forehead; hair = the visible hair mass only; torso = the top/jacket; legs = trousers/skirt/shorts; shoes = the shoes. Use [0,0,0,0] for a part that is not visible.
- reference_description: describe the visible face shape, jaw/chin, relative eyes/brows/nose/lips/ears, hairline, body silhouette and distinguishing visible details in up to 1200 characters. Record obscured features as uncertain; never invent them.
- If there is no person in the picture set person_visible to false and fill the rest with neutral values.`;

// Sample the real colours from the photo itself: the browser sends a 96x96 RGB grid (base64) of the same picture, and the boxes
// from the vision step say where to look. Pixel medians are more faithful than colours the model has to guess.
const GRID = 96;
export function sampleColour(grid: Buffer | null, box: any, mode: 'median' | 'lit', inner = 0.6): number[] | null {
  if (!grid || grid.length < GRID * GRID * 3 || !Array.isArray(box) || box.length < 4) return null;
  let [x0, y0, x1, y1] = box.map((v: number) => Math.max(0, Math.min(1000, Number(v) || 0)) / 1000);
  if (x1 - x0 < 0.02 || y1 - y0 < 0.02) return null;
  const mx = (x1 - x0) * (1 - inner) / 2, my = (y1 - y0) * (1 - inner) / 2;
  x0 += mx; x1 -= mx; y0 += my; y1 -= my;
  const px: number[][] = [];
  for (let y = Math.floor(y0 * GRID); y <= Math.min(GRID - 1, Math.ceil(y1 * GRID)); y++) for (let x = Math.floor(x0 * GRID); x <= Math.min(GRID - 1, Math.ceil(x1 * GRID)); x++) {
    const o = (y * GRID + x) * 3; px.push([grid[o], grid[o + 1], grid[o + 2]]);
  }
  if (px.length < 4) return null;
  const lum = (p: number[]) => p[0] * 0.3 + p[1] * 0.59 + p[2] * 0.11;
  let use = px;
  if (mode === 'lit') { use = [...px].sort((a, b) => lum(b) - lum(a)).slice(0, Math.max(3, Math.ceil(px.length * 0.6))); }   // the lit surface, not the shadow
  const med = (i: number) => { const v = use.map((p) => p[i]).sort((a, b) => a - b); return v[Math.floor(v.length / 2)]; };
  return [med(0), med(1), med(2)];
}
const near = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
// use the sampled colour unless it is wildly different from what the model saw (a wrong box), then keep the model's
export const prefer = (sampled: number[] | null, model: number[]) => (sampled && near(sampled, model) < 170 ? sampled : model);

export async function analyzePhoto(dataUrl: string, gridB64?: string): Promise<PhotoResult> {
  const m = /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/.exec(dataUrl);
  if (!m) throw new Error('รูปต้องเป็น JPG, PNG หรือ WebP');
  let raw: any;
  if (PROVIDER === 'openai') {
    const j: any = await openai({ model: MODEL, reasoning: { effort: 'low' }, max_output_tokens: 3000,
      input: [{ role: 'user', content: [{ type: 'input_text', text: PHOTO_PROMPT }, { type: 'input_image', image_url: dataUrl }] }],
      text: { format: { type: 'json_schema', name: 'character_look', strict: true, schema: LOOK_SCHEMA } } });
    const txt = j.output_text ?? (j.output || []).flatMap((o: any) => o.content || []).find((c: any) => c.type === 'output_text')?.text;
    raw = JSON.parse(String(txt || '{}'));
  } else {
    const j: any = await claude({ model: MODEL, max_tokens: 2000, messages: [{ role: 'user', content: [
      { type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } },
      { type: 'text', text: PHOTO_PROMPT + '\nReply with one JSON object only, with exactly these keys: ' + Object.keys(LOOK_SCHEMA.properties).join(', ') }] }] });
    const txt = (j.content || []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('');
    raw = JSON.parse(txt.slice(txt.indexOf('{'), txt.lastIndexOf('}') + 1));
  }
  if (raw.person_visible === false) throw new Error('ไม่เห็นคนในรูป ลองรูปที่เห็นหน้าและลำตัวชัดๆ');
  let grid: Buffer | null = null;
  try { if (gridB64) { const b = Buffer.from(gridB64, 'base64'); if (b.length === GRID * GRID * 3) grid = b; } } catch { grid = null; }
  const bx = raw.boxes || {};
  const hairM = rgb(raw.hair_color, [24, 24, 34]), skinM = rgb(raw.skin, [244, 207, 178]), topM = rgb(raw.top_color, [116, 122, 136]), botM = rgb(raw.bottom_color, [70, 100, 150]);
  // skin: the lower-middle of the face box avoids hair, brows and glasses
  const faceBox = Array.isArray(bx.head) && bx.head.length === 4 ? [bx.head[0] + (bx.head[2] - bx.head[0]) * 0.2, bx.head[1] + (bx.head[3] - bx.head[1]) * 0.5, bx.head[2] - (bx.head[2] - bx.head[0]) * 0.2, bx.head[3] - (bx.head[3] - bx.head[1]) * 0.08] : null;
  // hair: the top part of the hair box (the fringe/crown), where the hair is, not the forehead or the shoulders
  const hairTop = Array.isArray(bx.hair) && bx.hair.length === 4 ? [bx.hair[0], bx.hair[1], bx.hair[2], bx.hair[1] + (bx.hair[3] - bx.hair[1]) * 0.5] : null;
  const look: Look = {
    reference_description: String(raw.reference_description || '').slice(0, 1500),
    hairstyle: pick(raw.hairstyle, HAIRSTYLES, 'short'),
    hair_color: prefer(sampleColour(grid, hairTop, 'median', 0.7), hairM),
    skin: prefer(sampleColour(grid, faceBox, 'lit', 0.8), skinM),
    top: pick(raw.top, TOPS, 'tshirt'), top_color: prefer(sampleColour(grid, bx.torso, 'median', 0.5), topM),
    inner_color: rgb(raw.inner_color, topM),
    bottom: pick(raw.bottom, BOTTOMS, 'pants'), bottom_color: prefer(sampleColour(grid, bx.legs, 'median', 0.5), botM),
    shoes_color: prefer(sampleColour(grid, bx.shoes, 'median', 0.7), rgb(raw.shoes_color, [150, 135, 125])),
    frame_color: rgb(raw.frame_color, [120, 86, 60]),
    pattern: pick(raw.pattern, PATTERNS, 'none'), pattern_color: rgb(raw.pattern_color, [250, 250, 248]),
    glasses: pick(raw.glasses, ['round', 'square', 'none'], 'none'), accessories: (Array.isArray(raw.accessories) ? raw.accessories : []).filter((a: string) => ACCESSORIES.includes(a)).slice(0, 3),
    accessory_color: rgb(raw.accessory_color, [230, 70, 90]),
  };
  if (look.pattern === 'none') { delete look.pattern; delete look.pattern_color; }
  const pb = bx.person;
  const person_box = Array.isArray(pb) && pb.length === 4 && pb[2] - pb[0] > 30 && pb[3] - pb[1] > 30 ? pb.map((v: number) => Math.max(0, Math.min(1000, Math.round(Number(v) || 0)))) : null;
  return { look, person_box };
}

// The owner's photo characters are forced into the draft's cast with exactly their stored look.
type ReqChar = { id?: string; name: string; look: Look };
export function applyCast(d: DraftT, req: ReqChar[]): DraftT {
  if (!req?.length) return d.storyboard ? {...d, cast:d.cast.map(({backdrop,...c})=>c)} : d;
  const names = new Set(req.map((r) => r.name));
  const forced = req.map((r) => { const drawn = d.cast.find(c => c.name === r.name); const { backdrop, ...look } = r.look; return { ...drawn, name: r.name, ...look, portrait_code: drawn?.portrait_code, portrait_description: drawn?.portrait_description, ...(!d.storyboard && backdrop ? {backdrop} : {}) }; });
  const cast = [...forced, ...d.cast.filter(c => !names.has(c.name))].slice(0, 4);
  return { ...d, cast: d.storyboard ? cast.map(({backdrop,...c}) => c) : cast } as DraftT;
}

export function registerStudio(app: Hono, pool: pg.Pool, deps: Deps) {
  async function recentEpisodes(excludeId?: string): Promise<Recent[]> {
    const r = await pool.query(`SELECT id, draft FROM drafts WHERE draft IS NOT NULL AND status IN ('ready','submitted') AND id <> $1
      ORDER BY created_at DESC LIMIT 6`, [excludeId || '00000000-0000-0000-0000-000000000000']);
    return r.rows.map((x: any) => ({
      format: x.draft.format || '', title: x.draft.title_th || '', style: x.draft.style || 'classic', music: x.draft.music || '',
      types: (x.draft.script || []).map((sg: any) => (x.draft.scenes || []).find((sc: any) => sc.seg === sg.id)?.type).filter(Boolean),
    }));
  }

  const log = async (id: string, msg: string, status?: string) => {
    await pool.query(`UPDATE drafts SET log = log || $2::jsonb, status = COALESCE($3, status), updated_at = now() WHERE id = $1`,
      [id, JSON.stringify([{ at: new Date().toISOString(), msg }]), status ?? null]);
  };

  function finalCheck(topic: string, d: DraftT, research: Seen[]) {
    const pkg = buildPackage(topic, d, research);
    const errs = [...deps.validate(pkg)];
    if (!errs.length) errs.push(...deps.researchFreshness(pkg));
    const est = errs.length ? null : deps.estimateCredits(pkg);
    if (est != null && est > DRAFT_MAX_CREDITS) errs.push(`estimated ElevenLabs cost ${est} credits is over the ${DRAFT_MAX_CREDITS} limit: shorten the narration`);
    return { pkg, errs, est };
  }

  // The worker compiles the model's scene art and renders preview frames (engine/artkit.py). Returns null when the worker is not answering.
  async function artCheck(id: string, d: DraftT, style: string): Promise<{ errors: string[]; frames: { seg: string; images: string[] }[] } | null> {
    const customs = d.scenes.filter((x: any) => x.type === 'custom');
    if (!customs.length) return { errors: [], frames: [] };
    const payload = { opening_frame_cover: d.cover_mode === 'opening_frame', strict_art: !!d.storyboard, script: d.script.map((x) => ({ id: x.id, text: x.text })), cast: d.cast, art: d.art || '', scenes: customs, style: style || 'classic' };
    const ins = await pool.query('INSERT INTO art_checks (draft_id, payload) VALUES ($1,$2) RETURNING id', [id, JSON.stringify(payload)]);
    const cid = ins.rows[0].id;
    for (let i = 0; i < 80; i++) {   // up to ~2 minutes
      await new Promise((r) => setTimeout(r, 1500));
      const r = (await pool.query('SELECT status, result FROM art_checks WHERE id=$1', [cid])).rows[0];
      if (r?.status === 'done' || r?.status === 'error') {
        const res = r.result || {};
        if (res.error) return { errors: [`the preview failed: ${String(res.error).slice(0, 300)}`], frames: [] };
        const errors: string[] = [];
        if (d.cover_mode === 'opening_frame' && (res.scenes || []).find((sc: any) => sc.seg === d.script[0].id)?.frames?.length !== 3) errors.push('opening cover requires video-time-zero, early and late previews; update the worker and retry');
        for (const sc of res.scenes || []) for (const e of sc.errors || []) errors.push(`custom scene ${sc.seg}: ${e}`);
        return { errors, frames: (res.scenes || []).filter((sc: any) => sc.frames?.length).map((sc: any) => ({ seg: sc.seg, images: sc.frames })) };
      }
    }
    await pool.query("UPDATE art_checks SET status='error' WHERE id=$1 AND status='pending'", [cid]);
    return null;
  }

  async function generate(id: string) {
    const row = (await pool.query('SELECT * FROM drafts WHERE id=$1', [id])).rows[0];
    if (!row || row.status !== 'queued') return;
    const seen = new Map<string, Seen>();
    const research: any[] = Array.isArray(row.research) ? [...row.research] : [];
    let parent: any = null;
    if (row.parent_id) {
      parent = (await pool.query('SELECT draft, research, storyboard, artwork FROM drafts WHERE id=$1', [row.parent_id])).rows[0] ?? null;
      if (!research.length && Array.isArray(parent?.research)) research.push(...parent.research);
      for (const event of [...(parent?.research || []), ...(row.research || [])]) {
        const collected = event.collected || event.at;
        if (!collected || Date.now() - new Date(collected).getTime() > 25 * 86400_000) continue;
        for (const r of event.results || [event]) if (r.url) seen.set(normUrl(r.url), {...r,collected,via:event.kind === 'web' ? 'web' : event.kind === 'read' ? 'read' : 'search'});
      }
      for (const r of parent?.draft?.research_seen || []) if (r.url && r.collected && Date.now() - new Date(r.collected).getTime() < 25 * 86400_000) seen.set(normUrl(r.url), r);
    }
    const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, firecrawl_calls: 0, web_searches: 0, turns: 0 };
    const cfg0 = configured();
    const sourceText = String(row.source_text || '');
    const active: Active = { fc: cfg0.firecrawl, ws: cfg0.web_search, source: !!sourceText };
    const researchJob = row.research_job_id || row.id;
    const fcStore = new PgResearchBudget(pool);
    const fc = new BudgetedFirecrawl(fcStore,{apiKey:env.FIRECRAWL_API_KEY || '',baseUrl:FIRECRAWL_URL});
    const webCache = new Map<string,any>();
    let fcBudget = cfg0.firecrawl ? await fcStore.snapshot(researchJob) : null;
    if (fcBudget?.blocked_reason || fcBudget?.remaining === 0) active.fc=false;
    const syncFcBudget = async () => { if (cfg0.firecrawl) { fcBudget=await fcStore.snapshot(researchJob); usage.firecrawl_calls=fcBudget.calls; Object.assign(usage,{firecrawl_budget:fcBudget}); } };
    await syncFcBudget();
    if (!active.ws) { await pool.query("UPDATE drafts SET status='failed', error=$2, updated_at=now() WHERE id=$1", [id, 'ต้องเปิด OpenAI Web Search เพื่อค้นข้อมูลก่อนใช้ Firecrawl']); return; }
    const saveUsage = () => pool.query('UPDATE drafts SET usage=$2, research=$3, updated_at=now() WHERE id=$1', [id, JSON.stringify(usage), JSON.stringify(research)]);
    const useModel = row.model && MODEL_RE.test(row.model) ? row.model : MODEL;
    const useEffort = PROVIDER === 'openai' ? (REASONING_LEVELS.includes(row.reasoning) ? row.reasoning : REASONING) : null;
    await pool.query("UPDATE drafts SET status='researching', model=$2, reasoning=$3, updated_at=now() WHERE id=$1", [id, useModel, useEffort]);
    await log(id, `เริ่มค้นข้อมูลด้วย OpenAI Web Search ก่อน · Firecrawl สำรองไม่เกิน ${fcBudget?.limit || 25} เครดิตต่อ Research Job (${useModel}${useEffort ? ' · reasoning ' + useEffort : ''})`);

    const storyMode = row.story_mode === 'general' ? 'general' as const : 'name_story' as const;
    let userText = `Story mode: ${storyMode}. Topic from the owner: ${row.topic}`;
    const sourceBlock = sourceText ? sourceMaterialBlock(sourceText) : '';
    if (sourceBlock) userText += '\n\n' + sourceBlock;
    if (row.note) userText += `\nOwner's direction: ${row.note}`;
    if (parent?.draft) {
      const p = parent.draft;
      userText += `\n\nThis is a rewrite. Previous version (title "${p.title_th}"):\n${(p.script || []).map((s: any) => `[${s.id}] ${s.text}`).join('\n')}\n` +
        `Previous sources (previously retrieved and recorded; check freshness before citing again):\n${(p.sources || []).map((s: any) => `- ${s.url} (${s.publisher}, ${s.published})`).join('\n')}\n` +
        `Apply the owner's direction; check for newer data where it matters.`;
    }
    if (row.source_type === 'community' && row.community_id) {
      const cw = (await pool.query('SELECT payload FROM community_winners WHERE id=$1', [row.community_id])).rows[0];
      if (cw) userText += communityBlock(cw.payload);
    }
    const reqChars: ReqChar[] = Array.isArray(row.characters) ? row.characters : [];
    if (reqChars.length) {
      userText += `\n\nRequired characters (reference images follow): ${reqChars.map(c => JSON.stringify({name:c.name,look:((({backdrop,...look})=>look)(c.look))})).join('\n')}. ` +
        `Make these the first cast members in this order. Draw their actual visible features in portrait_code; every scene is custom. Show each in at least a third of the shots. Ignore any old backdrop; draw locations from the story. `;
    }
    const recent = await recentEpisodes(id);
    const fixedStyle = row.style && STYLES[row.style] ? row.style : null;
    userText += fixedStyle
      ? `\n\nVisual style: the owner chose "${fixedStyle}" (${STYLES[fixedStyle].en}); set "style": "${fixedStyle}" and let the music fit it.`
      : `\n\nVisual style: choose "style" yourself (suits the story, differs from the last two episodes).`;
    userText += recent.length
      ? `\n\nRecent episodes, newest first — use a different format than the last two and do not repeat a scene sequence:\n${recent.map((r) => `- "${r.title}" | format: ${r.format || 'classic quiz'} | style: ${r.style} | music: ${r.music || '-'} | scenes: ${r.types.join(' > ')}`).join('\n')}`
      : `\n\nEarlier episodes used the classic order hook > number > myth > quiz > reveal > close; choose a different format.`;
    const model = row.model && MODEL_RE.test(row.model) ? row.model : MODEL;
    const effort = REASONING_LEVELS.includes(row.reasoning) ? row.reasoning : REASONING;
    const narration = parseNarration(row);
    const system = systemPrompt(active, storyMode) + '\n\n## Owner-selected narration style\n' + narrationPrompt(narration) +
      (sourceText ? '\nThe complete owner source is supplied for planning. Identify the sections and claims relevant to the chosen topic and preserve their caveats in the angle, narration and source metadata. After plan_story succeeds the raw source is removed from repeated drawing requests; the full original remains available through read_source_material. Do not claim the entire pasted document has been verified.' : '');
    const conv = PROVIDER === 'openai' ? openaiConversation(system, userText, model, effort, active, (message) => log(id, message)) : anthropicConversation(system, userText, model, active);
    let sourceCompacted = false;
    const compactSource = () => {
      if (!sourceBlock || sourceCompacted) return;
      conv.replaceSource(sourceBlock, `The owner-provided source (${sourceText.length} characters) remains stored in full. Its raw text was removed from repeated drawing requests after the storyboard was saved. The storyboard and fetched-source evidence remain in this conversation. Use read_source_material(offset,length) to reread any exact passage; pasted text is not independent verification.`);
      sourceCompacted = true;
    };
    // Load originals only for the LLM, never include them in the public episode package.
    for (const c of reqChars) {
      const ref = c.id ? (await pool.query('SELECT reference_image, thumb FROM characters WHERE id=$1', [c.id])).rows[0] : null;
      const photo = ref?.reference_image || ref?.thumb;
      if (photo) conv.show(`Reference for ${c.name}. Use only as visual reference for their bespoke face and body. ${ref.reference_image ? '' : 'Only a small legacy thumbnail is available: likeness is limited; do not invent hidden details.'}`, [photo]);
      else await log(id, `ไม่มีรูปอ้างอิงของ ${c.name} แล้ว ใช้รายละเอียดลักษณะที่บันทึกไว้`);
    }
    let storyboard: StoryboardT | null = row.storyboard || null;
    let artwork: ArtworkState = row.artwork || emptyArtwork();
    active.drawing = !!storyboard;
    if (storyboard) compactSource();
    if (storyboard) conv.say('Resume the saved storyboard and artwork. Only draw missing pieces. Previously retrieved source metadata (open exact pages with read_page if you need the figures): ' + JSON.stringify([...seen.values()]) + '\nSaved plan: ' + JSON.stringify(storyboard) + '\nSaved artwork: ' + JSON.stringify(artwork));
    const persistArtwork = () => pool.query('UPDATE drafts SET artwork=$2, updated_at=now() WHERE id=$1', [id, JSON.stringify(artwork)]);
    const attemptedVerification = new Set<string>();
    let verificationCalls = 0;
    let sourceReviewTurn = -1;
    let sourceReviewEvidence = '';
    let reviewedArt = '';
    let pendingReview = '';
    let submits = 0;
    let pendingImages: { text: string; images: string[] } | null = null;

    for (let turn = 0; turn < MAX_TURNS; turn++) {
      usage.turns = turn + 1;
      const totalIn = usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens;
      if (totalIn > MAX_INPUT_TOKENS) throw new Error('ครบงบโทเค็นของร่างนี้แล้ว เก็บบทและภาพที่วาดสำเร็จไว้ สามารถลองใหม่เพื่อทำต่อได้');
      const mustSubmit = !!storyboard && artworkComplete(artwork, storyboard) && (turn >= MAX_TURNS - 2 || totalIn > MAX_INPUT_TOKENS * 0.8);
      await log(id, `รอบที่ ${turn + 1}: ${storyboard ? `วาดทีละส่วน (${artwork.cast.length} ตัวละคร · ${artwork.scenes.length}/${storyboard.shots.length} ฉาก · reasoning ${effort === 'high' ? 'medium' : effort})` : 'ค้นข้อมูล/วางบท'} (${model})`);
      const { uses, usage: u, web } = await conv.turn(mustSubmit);
      if (web) {
        usage.web_searches += web.searches;
        active.searches = usage.web_searches;
        const fresh = web.sources.filter((x, i, arr) => arr.findIndex((y) => normUrl(y.url) === normUrl(x.url)) === i);
        for (const x of fresh) if (!seen.has(normUrl(x.url))) seen.set(normUrl(x.url), { url: x.url, title: x.title, published_hint: null, collected: todayIso(), via: 'web' });
        if (web.queries.length) await log(id, `web search: ${web.queries.slice(0, 2).join(' | ').slice(0, 150)}`);
        research.push({ kind: 'web', queries: web.queries, at: new Date().toISOString(), results: fresh.slice(0, 25).map((x) => ({ url: x.url, title: x.title, published: null })) });
        if (usage.web_searches >= MAX_WEB_SEARCH && active.ws) { active.ws = false; await log(id, 'ครบโควตา web search ของร่างนี้แล้ว'); }
      }
      for (const k of ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'] as const) usage[k] += u[k];
      await saveUsage();
      if (!uses.length) {
        conv.say('Continue: research with the tools if needed, then call submit_episode.');
        continue;
      }
      const results: any[] = [];
      for (const u of uses) {
        try {
          if (ARTWORK_TOOLS.some(t => t.name === u.name)) {
            if (!storyboard) throw new Error('Call plan_story before drawing assets');
            artwork = updateArtwork(artwork, u.name, u.input, storyboard);
            reviewedArt = ''; pendingReview = ''; pendingImages = null;
            await persistArtwork();
            await log(id, u.name === 'draw_scene' ? `บันทึกภาพฉาก ${u.input.scene?.seg} แล้ว (${artwork.scenes.length}/${storyboard.shots.length})` : u.name === 'draw_character' ? `บันทึกตัวละคร ${u.input.character?.name} แล้ว` : 'บันทึกโค้ดวาดร่วมแล้ว');
            results.push({type:'tool_result',tool_use_id:u.id,content:'Asset saved. Draw only the next missing asset; when complete submit narration and metadata without artwork.'});
          } else if (u.name === 'read_source_material') {
            if (!sourceText) throw new Error('No owner-provided source text for this draft');
            const excerpt = readSourceMaterial(sourceText, u.input?.offset, u.input?.length);
            // Never add pasted material to `seen`: only independently fetched URLs are evidence.
            results.push({type:'tool_result',tool_use_id:u.id,content:JSON.stringify(excerpt)});
          } else if (u.name === 'openai_search' || u.name === 'read_page') {
            const url=String(u.input?.url || ''), key=sourceKey(url);
            if (u.name === 'openai_search' || !u.input?.use_firecrawl) {
              if (u.name === 'read_page' && !key) throw new Error('A valid public source URL is required');
              const cacheKey=u.name === 'openai_search' ? 'query:'+String(u.input?.query || '').trim().slice(0,500) : key;
              let checked=cfg0.firecrawl ? await fcStore.webRead(researchJob,cacheKey) : webCache.get(cacheKey);
              const cacheHit=!!checked;
              if (!checked) {
                if (verificationCalls>=4) throw new Error('Exact source read budget used; cite only verified evidence or state the information is unavailable.');
                verificationCalls++;
                const options={apiKey:env.OPENAI_API_KEY!,baseUrl:OPENAI_URL,model:PROVIDER === 'openai' ? model : 'gpt-6.1-sol',onProgress:(message:string)=>log(id,message)};
                checked=u.name === 'openai_search' ? await searchWeb(String(u.input?.query || ''),options) : await verifySources([url],options);
                if (cfg0.firecrawl) await fcStore.saveWebRead(researchJob,cacheKey,checked); else webCache.set(cacheKey,checked);
                for (const k of ['input_tokens','output_tokens','cache_read_input_tokens','cache_creation_input_tokens'] as const) usage[k]+=checked.usage[k];
                usage.web_searches+=checked.searches;
              }
              for (const src of checked.sources) seen.set(normUrl(src.url),{...src,collected:todayIso(),via:'web'});
              research.push({kind:'web',at:new Date().toISOString(),queries:[u.name === 'openai_search' ? String(u.input.query) : 'Exact source read'],results:checked.sources,cache_hit:cacheHit});
              sourceReviewTurn=turn; sourceReviewEvidence=checked.text;
              results.push({type:'tool_result',tool_use_id:u.id,is_error:!checked.sources.length,content:checked.text || 'No evidence returned. Do not cite or invent this source. If deeper extraction is needed, request this exact URL with use_firecrawl=true and a fallback_reason.'});
            } else {
              if (!cfg0.firecrawl) throw new Error('Firecrawl fallback is not configured; continue with verified OpenAI sources.');
              const previous=key ? await fcStore.webRead(researchJob,key) : null;
              await log(id,`Firecrawl สำรอง: ${host(url)} · จองงบก่อนส่งคำขอ`);
              try {
                const result=await fc.request(researchJob,'/v2/scrape',{url},{webAttempted:!!previous,reason:String(u.input?.fallback_reason || '')});
                const data=result.payload.data, metadata=data.metadata || {};
                const sourceUrls=result.source_urls;
                for (const sourceUrl of sourceUrls) seen.set(normUrl(sourceUrl),{url:sourceUrl,title:metadata.title,published_hint:pubHint(metadata),collected:result.collected_at,via:'read'});
                research.push({kind:'read',url,source_urls:sourceUrls,at:result.collected_at,title:metadata.title,published:pubHint(metadata),markdown:data.markdown,cache_hit:result.cache_hit,fallback_reason:String(u.input?.fallback_reason || '')});
                results.push({type:'tool_result',tool_use_id:u.id,content:`${metadata.title || ''}\nURLs: ${sourceUrls.join(', ')}\nPublished: ${pubHint(metadata) || 'unknown'}\n---\n${data.markdown.slice(0,14000)}`});
              } finally { await syncFcBudget(); }
            }
          } else if (u.name === 'plan_story') {
            const plan = Storyboard.safeParse({...u.input,...(storyMode === 'general' ? {story_mode:storyMode} : {})});
            if (!plan.success) { results.push({type:'tool_result',tool_use_id:u.id,is_error:true,content:plan.error.message}); continue; }
            artwork = reconcileArtwork(storyboard, plan.data, artwork);
            storyboard = plan.data;
            active.drawing = true;
            await persistArtwork();
            reviewedArt = '';
            pendingReview = '';
            pendingImages = null;
            await pool.query("UPDATE drafts SET storyboard=$2, status='writing', updated_at=now() WHERE id=$1", [id, JSON.stringify(storyboard)]);
            compactSource();
            await log(id, `วางบทและสตอรีบอร์ด ${storyboard.shots.length} ฉากแล้ว กำลังออกแบบตัวละครและวาดฉากใหม่`);
            results.push({type:'tool_result',tool_use_id:u.id,content:'Storyboard saved. Use draw_character for ONE actor at a time, save_art for shared helpers, draw_scene for ONE shot at a time. Then submit metadata only. Do not draw the entire episode in one response.'});
          } else if (u.name === 'submit_episode') {
            if (!storyboard) { results.push({type:'tool_result',tool_use_id:u.id,is_error:true,content:'First call plan_story with the complete narration and shots. Do not draw before planning.'}); continue; }
            submits++;
            await pool.query("UPDATE drafts SET status='writing', updated_at=now() WHERE id=$1", [id]);
            await log(id, submits === 1 ? 'เขียนสคริปต์และวางฉากเสร็จ กำลังตรวจกฎ' : `แก้ตามที่ตรวจพบ (รอบ ${submits})`);
            if (u.input?.__invalid_json !== undefined) {
              results.push({ type: 'tool_result', tool_use_id: u.id, is_error: true, content: 'The arguments were not valid JSON. Submit again with valid JSON.' });
              continue;
            }
            const parsed = Draft.safeParse({ ...mergeArtwork({script:storyboard.script,...u.input}, artwork), storyboard, ...(storyMode === 'general' ? {story_mode:storyMode} : {}) });
            if (!parsed.success) {
              const issues = parsed.error.issues.slice(0, 15).map((i) => `${i.path.join('.')}: ${i.message}`);
              await pool.query('UPDATE drafts SET problems=$2 WHERE id=$1', [id,JSON.stringify(issues)]);
              await log(id, 'รูปแบบร่างต้องแก้: '+issues.slice(0,3).join(' · ').slice(0,300));
              results.push({ type: 'tool_result', tool_use_id: u.id, is_error: true, content: `Fix these metadata fields only; do NOT re-plan or redraw saved assets. Narration comes from the saved storyboard. If sources is empty, use read_page to retrieve a relevant real source and ground at least one factual claim; keep unknown name counts explicitly unknown and do not invent citations.\n- ${issues.join('\n- ')}` });
              continue;
            }
            const checkpoint = Artwork.safeParse({art:parsed.data.art,cast:parsed.data.cast,scenes:parsed.data.scenes});
            if (checkpoint.success) { artwork = checkpoint.data; await persistArtwork(); }
            const d0 = applyCast(parsed.data, reqChars);
            const d = { ...d0, ...narration, cover_mode: 'opening_frame' as const, ...(fixedStyle ? { style: fixedStyle } : {}), music_mode: row.music_mode === 'ai' ? 'ai' as const : 'default' as const };
            let sourceReview = '';
            const missing = d.sources.filter(src => !seen.has(normUrl(src.url)) && !attemptedVerification.has(normUrl(src.url))).slice(0,4);
            if (missing.length && PROVIDER === 'openai' && verificationCalls < 4) {
              missing.forEach(src => attemptedVerification.add(normUrl(src.url))); verificationCalls++;
              await log(id, `กำลังเปิดแหล่งอ้างอิงที่ยังไม่มีหลักฐาน ${missing.length} หน้า`);
              const checked = await verifySources(missing.map(src=>src.url), {apiKey:env.OPENAI_API_KEY!,baseUrl:OPENAI_URL,model,onProgress:message=>log(id,message)});
              for (const src of checked.sources) seen.set(normUrl(src.url), {...src,collected:todayIso(),via:'web'});
              for (const k of ['input_tokens','output_tokens','cache_read_input_tokens','cache_creation_input_tokens'] as const) usage[k] += checked.usage[k];
              usage.web_searches += checked.searches;
              research.push({kind:'web',at:new Date().toISOString(),queries:['Verify submitted sources'],results:checked.sources});
              sourceReviewTurn = turn; sourceReviewEvidence = checked.text;
              sourceReview = 'SOURCE REVIEW: the server opened missing sources. Read the evidence, correct any unsupported claims and submit metadata again. Do not redraw artwork. Evidence: ' + (checked.text || 'No readable content returned; remove unsupported claims.');
              await saveUsage();
            }
            const { problems, warnings } = checkDraft(d, seen, recent, { requiredNames: reqChars.map((c) => c.name), bespoke: true });
            if (turn <= sourceReviewTurn) sourceReview = 'SOURCE REVIEW: read the newly retrieved evidence before submitting metadata on the NEXT model turn. Evidence: ' + (sourceReviewEvidence || 'Page content unavailable; do not invent unsupported figures.');
            if (sourceReview) problems.push(sourceReview);
            let est: number | null = null;
            let showImages: { text: string; images: string[] } | null = null;
            if (!problems.length && d.scenes.some((x: any) => x.type === 'custom')) {
              await log(id, 'ส่งภาพที่โมเดลเขียนโค้ดให้ worker ลองวาด');
              const ac = await artCheck(id, d, (d as any).style || 'classic');
              if (!ac) { throw new Error('worker ยังไม่ตอบการลองวาด ร่างยังไม่พร้อมผลิต กรุณาลองใหม่เมื่อ worker พร้อม'); }
              else if (ac.errors.length) { problems.push(...ac.errors); await log(id, `ลองวาดแล้วพบ ${ac.errors.length} จุดต้องแก้`); }
              else if (ac.frames.length !== d.scenes.length) { problems.push('preview must include every scene before approval'); }
              else if (reviewedArt !== JSON.stringify({art:d.art,cast:d.cast,scenes:d.scenes,script:d.script,style:d.style})) {
                pendingReview = JSON.stringify({art:d.art,cast:d.cast,scenes:d.scenes,script:d.script,style:d.style});
                problems.push('VISUAL REVIEW: the scene art compiled and rendered; its preview frames follow in the next message. The opening shot starts with an extra preview at exactly video time 0: verify the subject and headline are fully visible, readable and inside the crop-safe area; reject a blank or delayed entrance. Compare every face and body with the labelled original reference images, and every scene with the storyboard and narration. Inspect the final styled image for crushed facial details, merged eyes or mouth, doubled outlines, and Thai text strokes that merge or become unreadable; a successful render alone does not mean the image is acceptable. If something is wrong (the subject is unrecognisable, tiny, overlapping the text, off-topic, cut off, or loses detail after styling) fix the art and submit again; if all are good, submit the same episode again unchanged.');
                showImages = { text: 'Preview frames of your custom scenes (opening shot: video time 0, early, late; other shots: early, late). Scene ids in order: ' + ac.frames.map((f) => `${f.seg} (${f.images.length} frames)`).join(', '), images: ac.frames.flatMap((f) => f.images) };
              }
              if (showImages) pendingImages = showImages;
            }
            if (!problems.length) {
              const f = finalCheck(row.topic, d, [...seen.values()]);
              problems.push(...f.errs);
              est = f.est;
            }
            if (problems.length && submits < 7) {
              await pool.query('UPDATE drafts SET problems=$2 WHERE id=$1', [id, JSON.stringify(problems)]);
              await log(id, `ตรวจพบ ${problems.length} จุดต้องแก้`);
              results.push({ type: 'tool_result', tool_use_id: u.id, is_error: true, content: `Fix these and submit again:\n- ${problems.join('\n- ')}` });
              continue;
            }
            const researchSeen = [...seen.values()];
            await pool.query(`UPDATE drafts SET draft=$2, problems=$3, estimated_credits=$4, status=$5, research=$6, usage=$7, error=$8, updated_at=now() WHERE id=$1`,
              [id, JSON.stringify({ ...d, warnings, research_seen: researchSeen }), JSON.stringify(problems), est, problems.length ? 'failed' : 'ready', JSON.stringify(research),
                JSON.stringify(usage), problems.length ? 'ยังผ่านกฎไม่ครบหลังแก้หลายรอบ ดูรายการด้านล่าง' : null]);
            if (problems.length) { await log(id, 'ยังไม่ผ่านกฎ หยุดไว้ให้ตรวจ'); return; }
            await log(id, `ร่างพร้อมให้ตรวจ ✓ (ประมาณ ${est} เครดิตเสียง)`);
            if (row.auto_produce && row.source_type !== 'community') await produce(id).catch((e) => log(id, `ส่งผลิตอัตโนมัติไม่สำเร็จ: ${e instanceof Error ? e.message : e}`));
            return;
          } else {
            results.push({ type: 'tool_result', tool_use_id: u.id, is_error: true, content: `unknown tool ${u.name}` });
          }
        } catch (e) {
          const msg = e instanceof Error ? `${e.message}${e.cause ? ` (${networkCode(e)})` : ''}` : String(e);
          if (e instanceof ResearchBudgetError) {
            if ((e as any).fcDown) active.fc=false;
            await syncFcBudget();
            await log(id,`Firecrawl หยุด: ${e.message.slice(0,220)}`);
            results.push({type:'tool_result',tool_use_id:u.id,is_error:true,content:e.message+' Use only verified OpenAI evidence. Mark unsupported facts as unverified; never invent numbers or citations. Budget increases require explicit owner approval outside the model tools.'});
            continue;
          }
          if ((e as any)?.fcDown) {   // Firecrawl is out of credits: carry on with OpenAI web search alone
            active.fc = false;
            await log(id, active.ws ? 'Firecrawl ใช้ไม่ได้ (เครดิตหมด) ใช้ web search ของ OpenAI ต่อ' : 'Firecrawl ใช้ไม่ได้ (เครดิตหมด) และไม่มี web search สำรอง');
            if (!active.ws && !seen.size) throw new Error('FIRECRAWL_API_KEY: เครดิต Firecrawl หมดและไม่มี web search สำรอง');
            results.push({ type: 'tool_result', tool_use_id: u.id, is_error: true, content: active.ws ? 'Firecrawl is out of credits. From now on use ONLY the built-in web_search tool (search and open pages).' : 'Firecrawl is out of credits. Write with the sources you already have and call submit_episode.' });
            continue;
          }
          if (/ANTHROPIC_API_KEY|OPENAI_API_KEY|FIRECRAWL_API_KEY/.test(msg)) throw e;
          await log(id, `เครื่องมือขัดข้อง: ${msg.slice(0, 120)}`);
          results.push({ type: 'tool_result', tool_use_id: u.id, is_error: true, content: `Tool failed: ${msg.slice(0, 300)}` });
        }
      }
      conv.results(results.map((r: any) => ({ id: r.tool_use_id, content: r.content, is_error: r.is_error })),
        !mustSubmit && !active.ws && (!active.fc || fcBudget?.remaining === 0) ? 'Research budget reached: write and submit now.' : undefined);
      if (pendingImages) { conv.show(pendingImages.text, pendingImages.images); pendingImages = null; reviewedArt = pendingReview; pendingReview = ''; }
      await saveUsage();
    }
    await pool.query("UPDATE drafts SET status='failed', error=$2, usage=$3, research=$4, updated_at=now() WHERE id=$1",
      [id, 'เขียนไม่เสร็จภายในจำนวนรอบที่กำหนด', JSON.stringify(usage), JSON.stringify(research)]);
  }

  // one generation at a time keeps cost and rate limits predictable
  let busy = false;
  async function pump() {
    if (busy) return;
    busy = true;
    try {
      for (;;) {
        const next = (await pool.query("SELECT id FROM drafts WHERE status='queued' ORDER BY created_at LIMIT 1")).rows[0];
        if (!next) break;
        try {
          await generate(next.id);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          console.error('studio', next.id, msg);
          await pool.query("UPDATE drafts SET status='failed', error=$2, updated_at=now() WHERE id=$1", [next.id, msg.slice(0, 500)]);
          await log(next.id, `ล้มเหลว: ${msg.slice(0, 160)}`);
        }
      }
    } finally {
      busy = false;
    }
  }

  async function produce(id: string) {
    const row = (await pool.query('SELECT * FROM drafts WHERE id=$1', [id])).rows[0];
    if (!row) return { status: 404, body: { error: 'not found' } };
    if (row.status === 'submitted' && row.job_id) return { status: 200, body: { job_id: row.job_id, duplicate: true } };
    if (row.status !== 'ready') return { status: 409, body: { error: `draft is ${row.status}` } };
    if (row.source_type === 'community') {
      const cw = (await pool.query('SELECT rejected_at, draft_id FROM community_winners WHERE id=$1', [row.community_id])).rows[0];
      if (!cw || cw.rejected_at) return { status: 409, body: { error: 'เรื่อง Community นี้ถูกปฏิเสธแล้ว จึงส่งผลิตไม่ได้' } };
      if (cw.draft_id !== id) return { status: 409, body: { error: 'นี่ไม่ใช่ร่างล่าสุดของเรื่อง Community นี้' } };
    }
    const d = Draft.parse(row.draft);
    const research: Seen[] = row.draft.research_seen || [];
    const { problems } = checkDraft(d, null);
    const f = finalCheck(row.topic, d, research);
    const errs = [...problems.filter((p) => !OWNER_SOFT.test(p)), ...f.errs];
    if (errs.length) return { status: 422, body: { error: 'draft does not pass the checks', problems: errs } };
    const r = await deps.createJob({ kind: 'episode', package: f.pkg }, `draft:${id}`);
    if (r.status >= 300) return r;
    await pool.query('UPDATE jobs SET source_type=$2 WHERE id=$1', [r.body.id, row.source_type || 'studio']);
    await pool.query("UPDATE drafts SET status='submitted', job_id=$2, episode_id=$3, updated_at=now() WHERE id=$1", [id, r.body.id, r.body.episode_id ?? null]);
    await log(id, 'ส่งเข้าคิวผลิตแล้ว (เสียง → ภาพ → ตรวจ → อัปโหลด)');
    return { status: 201, body: r.body };
  }

  // Drafts written outside the web UI (e.g. by Claude in chat) are committed to api/drafts-inbox/*.json and imported once
  // on start-up as "ready for review", after the same rule checks. The owner still reviews and presses Produce.
  async function importInbox() {
    const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'drafts-inbox');
    let files: string[] = [];
    try { files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort(); } catch { return; }
    for (const f of files) {
      try {
        const x = JSON.parse(readFileSync(join(dir, f), 'utf8'));
        if (!/^[0-9a-f-]{36}$/.test(String(x.id)) || !x.draft) continue;
        if ((await pool.query('SELECT 1 FROM drafts WHERE id=$1', [x.id])).rowCount) continue;
        const parsed = Draft.safeParse(x.draft);
        const research: Seen[] = Array.isArray(x.research_seen) ? x.research_seen : [];
        let problems: string[] = [], warnings: string[] = [], est: number | null = null;
        if (!parsed.success) problems = parsed.error.issues.slice(0, 10).map((i) => `${i.path.join('.')}: ${i.message}`);
        else {
          const seen = new Map(research.map((r) => [normUrl(r.url), r]));
          const c = checkDraft(parsed.data, seen);
          problems = c.problems.filter((p) => !OWNER_SOFT.test(p));
          warnings = [...c.warnings, ...c.problems.filter((p) => OWNER_SOFT.test(p))];
          if (!problems.length) {
            const fc = finalCheck(String(x.topic || parsed.data.title_th), parsed.data, research);
            problems.push(...fc.errs);
            est = fc.est;
          }
        }
        const ok = !problems.length;
        await pool.query(`INSERT INTO drafts (id, topic, note, status, draft, problems, error, model, estimated_credits, research, log)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (id) DO NOTHING`,
          [x.id, String(x.topic || x.draft.title_th).slice(0, 400), x.note ? String(x.note).slice(0, 1000) : null, ok ? 'ready' : 'failed',
            JSON.stringify({ ...x.draft, warnings, research_seen: research }), JSON.stringify(problems), ok ? null : 'ร่างจากแชทยังไม่ผ่านกฎ',
            String(x.author || 'claude-chat').slice(0, 60), est,
            JSON.stringify(research.map((r) => ({ kind: 'read', url: r.url, title: r.title, at: r.collected }))),
            JSON.stringify([{ at: new Date().toISOString(), msg: 'นำเข้าร่างที่เขียนในแชท (ค้นข้อมูลด้วย Firecrawl แล้ว)' },
              { at: new Date().toISOString(), msg: ok ? `ร่างพร้อมให้ตรวจ ✓ (ประมาณ ${est} เครดิตเสียง)` : `ตรวจพบ ${problems.length} จุดต้องแก้` }])]);
        console.log('studio inbox', f, ok ? 'ready' : 'failed', problems.slice(0, 3));
      } catch (e) {
        console.error('studio inbox', f, e instanceof Error ? e.message : e);
      }
    }
  }
  setTimeout(() => importInbox().catch(() => {}), 8000);

  // drafts that were mid-generation when the process restarted cannot resume the conversation
  pool.query(`UPDATE drafts SET status='failed', error='ระบบรีสตาร์ทระหว่างเขียน กด "เขียนใหม่" เพื่อเริ่มอีกครั้ง', updated_at=now()
    WHERE status IN ('researching','writing')`).then(() => pump()).catch(() => {});

  // ---------------------------------------------------------------- routes
  const g = deps.guard;
  const isId = (s: string) => /^[0-9a-f-]{36}$/.test(s);
  const summary = (r: any) => ({
    id: r.id, topic: r.topic, note: r.note, status: r.status, title: r.draft?.title_th ?? null, angle: r.draft?.angle ?? null, created_at: r.created_at,
    narration_style: r.narration_style || 'standard', narration_custom: r.narration_custom || '', source_text_characters: String(r.source_text || '').length,
    updated_at: r.updated_at, estimated_credits: r.estimated_credits, job_id: r.job_id, job_status: r.job_status ?? null, job_progress: r.job_progress ?? null,
    episode_number: r.episode_number ?? null, last: (r.log || []).slice(-1)[0]?.msg ?? null, error: r.error, auto_produce: r.auto_produce, source_type: r.source_type ?? 'studio', community_id: r.community_id ?? null,
  });

  app.get('/app/api/studio/status', g, async (c) => {
    const n = (await pool.query("SELECT count(*)::int AS n FROM drafts WHERE created_at > now() - interval '1 day'")).rows[0].n;
    return c.json({ ...configured(), formats: Object.fromEntries(Object.entries(FORMATS).map(([k, f]) => [k, f.th])), model: MODEL,
      models: MODEL_CHOICES[PROVIDER], reasoning: PROVIDER === 'openai' ? REASONING : null, reasoning_levels: PROVIDER === 'openai' ? REASONING_LEVELS : [], ai_suggestions:!!env.OPENAI_API_KEY, narration_previews:!!env.OPENAI_API_KEY, narration_styles:NARRATION_STYLES.map(({prompt,...style})=>style), source_text_limit:SOURCE_TEXT_LIMIT, drafts_today: n, daily_limit: DAILY_LIMIT, busy, max_credits: DRAFT_MAX_CREDITS });
  });

  // ---- characters made from photos
  // visual styles for the composer, with a small preview of each (rendered by the worker engine, see worker/engine/styles.py)
  let previews: Record<string, string> = {};
  try { previews = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'style-previews.json'), 'utf8')); } catch { /* previews are optional */ }
  // the channel's default music: the track of a finished episode (owner's choice: EP002, the "คนชื่อตั้ม" clip)
  const musicCandidates = () => pool.query(`
    SELECT DISTINCT ON (e.number) e.number, e.title_th, j.stage_results->'GENERATING_AUDIO'->>'music_key' AS music_key
    FROM jobs j JOIN episodes e ON e.id = j.episode_id
    WHERE e.number IS NOT NULL AND j.stage_results->'GENERATING_AUDIO'->>'music_key' IS NOT NULL
    ORDER BY e.number DESC, j.finished_at DESC NULLS LAST LIMIT 40`);
  app.get('/app/api/studio/music-default', g, async (c) => {
    const [cur, cands] = await Promise.all([pool.query("SELECT data FROM integrations WHERE provider='default_music'"), musicCandidates()]);
    const episode = Number(cur.rows[0]?.data?.episode) || null;
    const list = cands.rows.map((r: any) => ({ number: r.number, title: r.title_th }));
    return c.json({ episode, available: list.some((x) => x.number === episode), title: list.find((x) => x.number === episode)?.title || null, candidates: list });
  });
  app.post('/app/api/studio/music-default', g, async (c) => {
    const b = await c.req.json().catch(() => ({}));
    const n = Number(b.episode);
    if (!Number.isInteger(n) || n < 1) return c.json({ error: 'episode number required' }, 422);
    if (!(await musicCandidates()).rows.some((r: any) => r.number === n)) return c.json({ error: `EP${String(n).padStart(3, '0')} has no music track to reuse` }, 422);
    await pool.query("INSERT INTO integrations (provider, data, updated_at) VALUES ('default_music', $1, now()) ON CONFLICT (provider) DO UPDATE SET data = EXCLUDED.data, updated_at = now()", [JSON.stringify({ episode: n })]);
    return c.json({ ok: true, episode: n });
  });
  app.get('/app/api/studio/styles', g, (c) => c.json({ styles: STYLE_NAMES.map((id) => ({ id, label: STYLES[id].th, about: STYLES[id].en, preview: previews[id] || null })) }));

  app.get('/app/api/studio/characters', g, async (c) => {
    const r = await pool.query('SELECT id, name, look, thumb, created_at, (backdrop IS NOT NULL) AS has_backdrop FROM characters ORDER BY created_at DESC LIMIT 60');
    return c.json({ characters: r.rows });
  });

  app.post('/app/api/studio/characters', g, async (c) => {
    const b = await c.req.json().catch(() => ({}));
    const name = String(b.name || '').trim().slice(0, 20);
    if (!name) return c.json({ error: 'ตั้งชื่อตัวละครก่อน (ไม่เกิน 20 ตัวอักษร)' }, 422);
    const image = String(b.image || '');
    if (!/^data:image\/(jpeg|png|webp);base64,/.test(image) || image.length > 2_500_000) return c.json({ error: 'รูปต้องเป็น JPG, PNG หรือ WebP ขนาดไม่เกินประมาณ 1.8 MB' }, 422);
    if (!configured().llm) return c.json({ error: `ยังไม่ได้ตั้งค่า ${configured().key_name} ใน Railway (motion-api)` }, 503);
    if ((await pool.query('SELECT 1 FROM characters WHERE lower(name)=lower($1)', [name])).rowCount) return c.json({ error: 'มีตัวละครชื่อนี้แล้ว' }, 409);
    let res: PhotoResult;
    try { res = await analyzePhoto(image, typeof b.pixels === 'string' && b.pixels.length < 40_000 ? b.pixels : undefined); } catch (e) { return c.json({ error: e instanceof Error ? e.message : String(e) }, 422); }
    const thumb = typeof b.thumb === 'string' && /^data:image\/jpeg;base64,/.test(b.thumb) && b.thumb.length < 60_000 ? b.thumb : null;
    const r = await pool.query('INSERT INTO characters (name, look, thumb, reference_image) VALUES ($1,$2,$3,$4) RETURNING id, name, look, thumb, created_at', [name, JSON.stringify(res.look), thumb, image]);
    return c.json({ character: r.rows[0], person_box: res.person_box }, 201);
  });

  // Refresh a saved reference without changing the character ID or old episode packages.
  app.put('/app/api/studio/characters/:id/reference', g, async (c) => {
    const id = c.req.param('id');
    if (!isId(id) || !(await pool.query('SELECT 1 FROM characters WHERE id=$1', [id])).rowCount) return c.json({error:'not found'}, 404);
    const b = await c.req.json().catch(() => ({}));
    const image = String(b.image || '');
    if (!/^data:image\/(jpeg|png|webp);base64,/.test(image) || image.length > 2_500_000) return c.json({error:'รูปต้องเป็น JPG, PNG หรือ WebP ขนาดไม่เกินประมาณ 1.8 MB'}, 422);
    if (!configured().llm) return c.json({error:'ยังไม่ได้เชื่อม AI'}, 503);
    try {
      const res = await analyzePhoto(image, typeof b.pixels === 'string' && b.pixels.length < 40_000 ? b.pixels : undefined);
      const thumb = typeof b.thumb === 'string' && /^data:image\/jpeg;base64,/.test(b.thumb) && b.thumb.length < 60_000 ? b.thumb : null;
      const r = await pool.query('UPDATE characters SET look=$2, reference_image=$3, thumb=$4 WHERE id=$1 RETURNING id,name,look,thumb,created_at', [id, JSON.stringify(res.look), image, thumb]);
      return c.json({character:r.rows[0]});
    } catch (e) { return c.json({error:e instanceof Error ? e.message : String(e)}, 422); }
  });

  // the browser erases the person from the photo and sends back only the background (small JPEG)
  app.put('/app/api/studio/characters/:id/backdrop', g, async (c) => {
    const id = c.req.param('id');
    if (!isId(id)) return c.json({ error: 'not found' }, 404);
    const b = await c.req.json().catch(() => ({}));
    const img = String(b.backdrop || '');
    if (!/^data:image\/jpeg;base64,/.test(img) || img.length > 200_000) return c.json({ error: 'backdrop must be a JPEG data URL under ~150 KB' }, 422);
    const r = await pool.query('UPDATE characters SET backdrop=$2 WHERE id=$1 RETURNING id', [id, img]);
    return r.rowCount ? c.json({ ok: true }) : c.json({ error: 'not found' }, 404);
  });

  app.delete('/app/api/studio/characters/:id', g, async (c) => {
    const id = c.req.param('id');
    if (!isId(id)) return c.json({ error: 'not found' }, 404);
    await pool.query('DELETE FROM characters WHERE id=$1', [id]);
    return c.json({ ok: true });
  });

  app.get('/app/api/studio/drafts', g, async (c) => {
    const r = await pool.query(`SELECT d.*, j.status AS job_status, j.progress AS job_progress, e.number AS episode_number FROM drafts d
      LEFT JOIN jobs j ON j.id = d.job_id LEFT JOIN episodes e ON e.id = d.episode_id
      WHERE d.status <> 'discarded' ORDER BY d.created_at DESC LIMIT 40`);
    return c.json({ drafts: r.rows.map(summary) });
  });

  app.get('/app/api/studio/drafts/:id', g, async (c) => {
    const id = c.req.param('id');
    if (!isId(id)) return c.json({ error: 'not found' }, 404);
    const r = (await pool.query(`SELECT d.*, j.status AS job_status, j.progress AS job_progress, j.error AS job_error, e.number AS episode_number FROM drafts d
      LEFT JOIN jobs j ON j.id = d.job_id LEFT JOIN episodes e ON e.id = d.episode_id WHERE d.id=$1`, [id])).rows[0];
    if (!r) return c.json({ error: 'not found' }, 404);
    const dr = r.draft ? { ...r.draft } : null;
    if (dr) { delete dr.research_seen; if (Array.isArray(dr.cast)) dr.cast = dr.cast.map((x: any) => { const { backdrop, ...rest } = x; return { ...rest, has_backdrop: !!backdrop }; }); }
    return c.json({ ...summary(r), log: r.log, draft: dr, problems: r.problems, usage: r.usage, model: r.model, reasoning: r.reasoning, job_error: r.job_error ?? null,
      research_budget: env.FIRECRAWL_API_KEY ? await new PgResearchBudget(pool).snapshot(r.research_job_id || r.id) : null, research: r.research, story_mode: r.story_mode || 'name_story', source_text:r.source_text || '' });
  });

  app.post('/app/api/studio/drafts/:id/research-budget',g,async(c)=>{
    const id=c.req.param('id');
    if (!isId(id)) return c.json({error:'not found'},404);
    const row=(await pool.query('SELECT * FROM drafts WHERE id=$1',[id])).rows[0];
    if (!row) return c.json({error:'not found'},404);
    const b=await c.req.json().catch(()=>({}));
    if (b.approved !== true || b.confirmation !== `APPROVE FIRECRAWL TOTAL ${b.limit}`) return c.json({error:'Explicit owner approval of the new total is required.'},422);
    try {
      const budget=await new PgResearchBudget(pool).approve(row.research_job_id || row.id,b.limit);
      await log(id,`เจ้าของอนุมัติงบ Firecrawl รวม ${budget.limit} เครดิตสำหรับ Research Job นี้`);
      return c.json({research_budget:budget});
    } catch(e) {return c.json({error:e instanceof Error ? e.message : 'Budget approval failed'},409);}
  });

  // Owner-only diagnostics for responses already associated with this draft. Never returns keys or reference images.
  app.get('/app/api/studio/drafts/:id/diagnostics', g, async (c) => {
    const id = c.req.param('id');
    if (!isId(id)) return c.json({error:'not found'},404);
    const row = (await pool.query('SELECT log,storyboard,artwork,problems FROM drafts WHERE id=$1',[id])).rows[0];
    if (!row) return c.json({error:'not found'},404);
    const responseId = String(c.req.query('response_id') || '');
    const allowed = (row.log || []).flatMap((x:any)=>String(x.msg || '').match(/resp_[a-zA-Z0-9_-]+/g) || []);
    const state = {storyboard:row.storyboard, artwork:row.artwork, problems:row.problems};
    if (!responseId) return c.json({...state,response_ids:allowed});
    if (!allowed.includes(responseId)) return c.json({error:'response does not belong to this draft'},404);
    if (PROVIDER !== 'openai' || !env.OPENAI_API_KEY) return c.json({error:'provider unavailable'},503);
    const response = await fetch(OPENAI_URL+'/v1/responses/'+responseId,{headers:{authorization:'Bearer '+env.OPENAI_API_KEY},signal:AbortSignal.timeout(60_000)});
    if (!response.ok) return c.json({error:'provider response unavailable',status:response.status},502);
    const data:any = await response.json();
    const calls = (data.output || []).filter((x:any)=>x.type==='function_call').map((x:any)=>{
      let input:any; try {input=JSON.parse(x.arguments || '{}');} catch {return {name:x.name,error:'invalid JSON'};}
      const parsed = x.name === 'submit_episode' ? Draft.safeParse({...mergeArtwork({script:row.storyboard?.script,...input},row.artwork || emptyArtwork()),storyboard:row.storyboard}) : null;
      return {name:x.name,fields:Object.keys(input),input,issues:parsed && !parsed.success ? parsed.error.issues : []};
    });
    return c.json({status:data.status,incomplete_details:data.incomplete_details,output_types:(data.output || []).map((x:any)=>x.type),calls,text:(data.output || []).filter((x:any)=>x.type==='message').flatMap((x:any)=>x.content || []).map((x:any)=>String(x.text || '')).join('\n').slice(0,6000)});
  });

  app.post('/app/api/studio/drafts', g, async (c) => {
    const b = await c.req.json().catch(() => ({}));
    let request;
    try { request = draftRequest(c.req.header('idempotency-key'), 'create', b); }
    catch { return c.json({error:'invalid idempotency-key'},422); }
    if (request.key) {
      const old = (await pool.query('SELECT id, request_hash FROM drafts WHERE request_key=$1',[request.key])).rows[0];
      if (old) return old.request_hash === request.hash ? c.json({id:old.id},201) : c.json({error:'idempotency-key already used for different input'},409);
    }
    const storyMode = b.story_mode === 'general' ? 'general' : 'name_story';
    let sourceText: string, narration: ReturnType<typeof parseNarration>;
    try { sourceText = storyMode === 'general' ? parseSourceText(b.source_text) : ''; narration = parseNarration(b); }
    catch (e) { return c.json({error:e instanceof Error ? e.message : 'invalid narration or source text'},422); }
    const topic = String(b.topic || sourceText.slice(0,120)).trim().slice(0, 400);
    if (topic.length < 4) return c.json({ error: 'พิมพ์หัวข้ออย่างน้อย 4 ตัวอักษร' }, 422);
    const cf = configured();
    if (!researchReady(cf)) return c.json({ error: `ยังไม่ได้ตั้งค่า ${researchMissing(cf)} ใน Railway (motion-api)` }, 503);
    const n = (await pool.query("SELECT count(*)::int AS n FROM drafts WHERE created_at > now() - interval '1 day'")).rows[0].n;
    if (n >= DAILY_LIMIT) return c.json({ error: `ครบโควตา ${DAILY_LIMIT} ร่างต่อวันแล้ว` }, 429);
    const model = typeof b.model === 'string' && MODEL_RE.test(b.model) ? b.model : MODEL;
    const reasoning = REASONING_LEVELS.includes(b.reasoning) ? b.reasoning : REASONING;
    const ids: string[] = (Array.isArray(b.characters) ? b.characters : []).map(String).filter(isId).slice(0, 3);
    const chars = ids.length ? (await pool.query('SELECT id, name, look, backdrop FROM characters WHERE id = ANY($1::uuid[]) ORDER BY created_at', [ids])).rows.map((x: any) => ({ id: x.id, name: x.name, look: x.backdrop ? { ...x.look, backdrop: x.backdrop } : x.look })) : [];
    const style = typeof b.style === 'string' && STYLES[b.style] ? b.style : 'auto';
    const musicMode = b.music_mode === 'ai' ? 'ai' : 'default';
    const r = await pool.query('INSERT INTO drafts (topic, note, auto_produce, model, reasoning, characters, style, music_mode, story_mode, source_text, request_key, request_hash, narration_style, narration_custom) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) ON CONFLICT (request_key) DO NOTHING RETURNING id',
      [topic, String(b.note || '').trim().slice(0, 1000) || null, !!b.auto_produce, model, PROVIDER === 'openai' ? reasoning : null, JSON.stringify(chars), style, musicMode, storyMode, sourceText || null, request.key, request.hash, narration.narration_style, narration.narration_custom]);
    if (!r.rows.length) {
      const old = (await pool.query('SELECT id, request_hash FROM drafts WHERE request_key=$1',[request.key])).rows[0];
      return old?.request_hash === request.hash ? c.json({id:old.id},201) : c.json({error:'idempotency-key already used for different input'},409);
    }
    await log(r.rows[0].id, 'รับหัวข้อแล้ว รอคิว');
    pump();
    return c.json({ id: r.rows[0].id }, 201);
  });

  // owner edits before producing: title, narration text per segment, captions
  app.patch('/app/api/studio/drafts/:id', g, async (c) => {
    const id = c.req.param('id');
    if (!isId(id)) return c.json({ error: 'not found' }, 404);
    const row = (await pool.query('SELECT * FROM drafts WHERE id=$1', [id])).rows[0];
    if (!row || !row.draft) return c.json({ error: 'not found' }, 404);
    if (row.status !== 'ready') return c.json({ error: `แก้ได้เฉพาะร่างที่พร้อมตรวจ (ตอนนี้: ${row.status})` }, 409);
    const b = await c.req.json().catch(() => ({}));
    const d = { ...row.draft };
    if (typeof b.title_th === 'string' && b.title_th.trim()) d.title_th = b.title_th.trim().slice(0, 90);
    if (typeof b.style === 'string' && STYLES[b.style]) d.style = b.style;   // only changes how the clip is drawn; the script stays checked
    if (b.music_mode === 'default' || b.music_mode === 'ai') d.music_mode = b.music_mode;
    if (Array.isArray(b.script)) {
      const map = new Map(b.script.map((s: any) => [String(s.id), String(s.text || '').trim()]));
      d.script = d.script.map((s: any) => (map.has(s.id) && map.get(s.id) ? { ...s, text: map.get(s.id) } : s));
    }
    if (d.storyboard && JSON.stringify(d.script) !== JSON.stringify(row.draft.script)) return c.json({error:'บทนี้มีภาพวาดตามสตอรีบอร์ดแล้ว ใช้ปุ่มเขียนใหม่พร้อมระบุบทที่ต้องการ เพื่อให้ AI วาดและตรวจภาพให้ตรงกับบทใหม่'}, 422);
    if (b.captions && typeof b.captions === 'object') for (const k of ['facebook', 'instagram', 'tiktok', 'youtube', 'twitter']) if (typeof b.captions[k] === 'string') d.captions = { ...d.captions, [k]: b.captions[k] };
    const parsed = Draft.safeParse(d);
    if (!parsed.success) return c.json({ error: 'invalid', problems: parsed.error.issues.slice(0, 10).map((i) => `${i.path.join('.')}: ${i.message}`) }, 422);
    const { problems, warnings } = checkDraft(parsed.data, null);
    // timing words that no longer appear only shift an animation to the segment start: keep them as warnings for edited text
    const hard = problems.filter((p) => !OWNER_SOFT.test(p));
    const soft = problems.filter((p) => OWNER_SOFT.test(p)).map((p) => p + ' (ภาพนี้จะขึ้นตามตำแหน่งโดยประมาณ)');
    if (hard.length) return c.json({ error: 'ยังแก้ไม่ผ่าน', problems: hard }, 422);
    const f = finalCheck(row.topic, parsed.data, d.research_seen || []);
    if (f.errs.length) return c.json({ error: 'ยังแก้ไม่ผ่าน', problems: f.errs }, 422);
    d.warnings = [...warnings, ...soft];
    await pool.query('UPDATE drafts SET draft=$2, estimated_credits=$3, updated_at=now() WHERE id=$1', [id, JSON.stringify(d), f.est]);
    await log(id, 'แก้ไขโดยเจ้าของ');
    return c.json({ ok: true, estimated_credits: f.est, warnings: d.warnings });
  });

  app.post('/app/api/studio/drafts/:id/produce', g, async (c) => {
    const id = c.req.param('id');
    if (!isId(id)) return c.json({ error: 'not found' }, 404);
    const r = await produce(id);
    return c.json(r.body, r.status as 200);
  });

  app.post('/app/api/studio/drafts/:id/rewrite', g, async (c) => {
    const id = c.req.param('id');
    if (!isId(id)) return c.json({ error: 'not found' }, 404);
    const row = (await pool.query('SELECT * FROM drafts WHERE id=$1', [id])).rows[0];
    if (!row) return c.json({ error: 'not found' }, 404);
    const b = await c.req.json().catch(() => ({}));
    let request;
    try { request = draftRequest(c.req.header('idempotency-key'), 'rewrite:'+id, b); }
    catch { return c.json({error:'invalid idempotency-key'},422); }
    if (request.key) {
      const old = (await pool.query('SELECT id, request_hash FROM drafts WHERE request_key=$1',[request.key])).rows[0];
      if (old) return old.request_hash === request.hash ? c.json({id:old.id},201) : c.json({error:'idempotency-key already used for different input'},409);
    }
    const cf = configured();
    if (!researchReady(cf)) return c.json({ error: 'ยังไม่ได้ตั้งค่า API key ใน Railway' }, 503);
    // a rewrite keeps the owner's style and music choice (the review may have changed them on the draft itself)
    const keepStyle = row.draft?.style && STYLES[row.draft.style] && row.style !== 'auto' ? row.draft.style : row.style || 'auto';
    const keepMusic = row.draft?.music_mode || row.music_mode || 'default';
    let narration: ReturnType<typeof parseNarration>;
    try { narration = parseNarration({narration_style:b.narration_style ?? row.narration_style, narration_custom:b.narration_custom ?? row.narration_custom}); }
    catch (e) { return c.json({error:e instanceof Error ? e.message : 'invalid narration'},422); }
    const previousNarration = parseNarration(row);
    const sameNarration = narration.narration_style === previousNarration.narration_style && narration.narration_custom === previousNarration.narration_custom;
    const r = await pool.query('INSERT INTO drafts (topic, note, parent_id, auto_produce, model, reasoning, characters, source_type, community_id, style, music_mode, story_mode, source_text, research_job_id, request_key, request_hash, narration_style, narration_custom) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) ON CONFLICT (request_key) DO NOTHING RETURNING id',
      [row.topic, String(b.note ?? row.note ?? '').trim().slice(0, 1000) || null, row.id, row.source_type === 'community' ? false : !!b.auto_produce,
        typeof b.model === 'string' && MODEL_RE.test(b.model) ? b.model : row.model, REASONING_LEVELS.includes(b.reasoning) ? b.reasoning : row.reasoning,
        JSON.stringify(row.characters ?? []), row.source_type || 'studio', row.community_id ?? null, keepStyle, keepMusic, row.story_mode || 'name_story', row.source_text || null, row.research_job_id || row.id, request.key, request.hash, narration.narration_style, narration.narration_custom]);
    if (!r.rows.length) {
      const old = (await pool.query('SELECT id, request_hash FROM drafts WHERE request_key=$1',[request.key])).rows[0];
      return old?.request_hash === request.hash ? c.json({id:old.id},201) : c.json({error:'idempotency-key already used for different input'},409);
    }
    if (row.status === 'failed' && row.storyboard && sameNarration && (b.note === undefined || String(b.note).trim() === String(row.note || '').trim())) {
      await pool.query('UPDATE drafts SET storyboard=$2, artwork=$3, research=$4 WHERE id=$1', [r.rows[0].id,JSON.stringify(row.storyboard),JSON.stringify(row.artwork || emptyArtwork()),JSON.stringify(row.research || [])]);
    }
    if (row.community_id) await pool.query('UPDATE community_winners SET draft_id=$2, updated_at=now() WHERE id=$1 AND draft_id=$3', [row.community_id, r.rows[0].id, id]);
    if (['ready', 'failed'].includes(row.status)) await pool.query("UPDATE drafts SET status='discarded', updated_at=now() WHERE id=$1", [id]);
    await log(r.rows[0].id, row.draft ? 'เขียนใหม่จากร่างเดิม รอคิว' : 'ลองใหม่ รอคิว');
    pump();
    return c.json({ id: r.rows[0].id }, 201);
  });

  app.post('/app/api/studio/drafts/:id/discard', g, async (c) => {
    const id = c.req.param('id');
    if (!isId(id)) return c.json({ error: 'not found' }, 404);
    const r = await pool.query("UPDATE drafts SET status='discarded', updated_at=now() WHERE id=$1 AND status IN ('ready','failed','queued') RETURNING id", [id]);
    return r.rowCount ? c.json({ ok: true }) : c.json({ error: 'ลบได้เฉพาะร่างที่ยังไม่ส่งผลิต' }, 409);
  });

  // a draft for a community winner: written by the same brain, never auto-produced, linked both ways
  async function newCommunityDraft(winnerId: string, p: { winner: { title: string } }) {
    const r = await pool.query(`INSERT INTO drafts (topic, auto_produce, model, reasoning, source_type, community_id) VALUES ($1,false,$2,$3,'community',$4) RETURNING id`,
      [p.winner.title.slice(0, 400), MODEL, PROVIDER === 'openai' ? REASONING : null, winnerId]);
    const id = r.rows[0].id;
    await pool.query('UPDATE community_winners SET draft_id=$2, updated_at=now() WHERE id=$1', [winnerId, id]);
    await log(id, 'เรื่องผู้ชนะโหวต Community เข้ามาแล้ว รอคิวเขียนร่าง (ต้องให้เจ้าของอนุมัติก่อนผลิต)');
    pump();
    return id as string;
  }

  return { pump, newCommunityDraft };
}
