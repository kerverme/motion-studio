// Content studio: the owner types a topic; Claude researches it live with Firecrawl (latest data first), writes the Thai
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
const REASONING_LEVELS = ['low', 'medium', 'high'];
const REASONING = REASONING_LEVELS.includes(String(env.MOTION_LLM_REASONING)) ? String(env.MOTION_LLM_REASONING) : 'high';
const MODEL_RE = /^[a-z0-9][a-z0-9.\-]{2,60}$/;
const MAX_TURNS = Number(env.MOTION_LLM_MAX_TURNS || 18);
const MAX_INPUT_TOKENS = Number(env.MOTION_LLM_MAX_INPUT_TOKENS || 1_200_000); // incl. cache reads, per draft
const MAX_FIRECRAWL = Number(env.MOTION_FIRECRAWL_MAX_CALLS || 16);
const DAILY_LIMIT = Number(env.MOTION_MAX_DRAFTS_PER_DAY || 20);
const VOICE_ID = env.MOTION_DEFAULT_VOICE_ID || 'bcdIY58WBBzAMmef52NW';
const DRAFT_MAX_CREDITS = Number(env.MOTION_DRAFT_MAX_CREDITS || 4500);
const MAX_YEARS = Number(env.MOTION_SOURCE_MAX_YEARS || 2);
const SERIES_TAG = env.MOTION_SERIES_TAG || 'จะเกิดอะไรขึ้นถ้า...?';

const llmKey = () => (PROVIDER === 'openai' ? !!env.OPENAI_API_KEY : !!env.ANTHROPIC_API_KEY);
export const configured = () => ({ llm: llmKey(), provider: PROVIDER, key_name: PROVIDER === 'openai' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY',
  anthropic: llmKey(), firecrawl: !!env.FIRECRAWL_API_KEY });

// ---------------------------------------------------------------- engine vocabulary (must match worker/engine)
export const TEMPLATES = ['hook', 'number', 'compare', 'bars', 'list', 'quiz', 'reveal', 'dots', 'timeline', 'truth', 'scenario', 'icons', 'outro', 'chat', 'versus', 'scale'] as const;
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
const normUrl = (u: string) => {
  try {
    const x = new URL(u);
    x.hash = '';
    for (const k of [...x.searchParams.keys()]) if (/^utm_|^fbclid$|^gclid$/.test(k)) x.searchParams.delete(k);
    return (x.origin + x.pathname.replace(/\/+$/, '') + (x.search || '')).toLowerCase();
  } catch {
    return u.trim().toLowerCase();
  }
};
const normText = (s: string) => String(s ?? '').replace(/[\s.?!…,"“”'()[\]:;\-–—]/g, '');
const yearOf = (s?: string | null) => {
  const m = String(s || '').match(/(?:19|20|25)\d{2}/)?.[0];
  return m ? (Number(m) >= 2400 ? Number(m) - 543 : Number(m)) : 0;
};
const host = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u; } };

type Seen = { url: string; title?: string; published_hint?: string | null; collected: string; via: 'search' | 'read' };

// ---------------------------------------------------------------- Firecrawl (research rule: every fact comes from here)
async function firecrawl(path: string, body: unknown, timeoutMs = 90_000) {
  if (!env.FIRECRAWL_API_KEY) throw new Error('FIRECRAWL_API_KEY is not set on motion-api');
  for (let i = 0; ; i++) {
    const r = await fetch(FIRECRAWL_URL + path, {
      method: 'POST',
      headers: { authorization: `Bearer ${env.FIRECRAWL_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const j: any = await r.json().catch(() => ({}));
    if ((r.status === 429 || r.status >= 500) && i < 2) {
      await new Promise((res) => setTimeout(res, 3000 * (i + 1)));
      continue;
    }
    if (!r.ok || j.success === false) throw new Error(`Firecrawl ${r.status}: ${String(j.error || j.message || '').slice(0, 200)}`);
    return j;
  }
}

const pubHint = (m: any) => m?.publishedTime || m?.['article:published_time'] || m?.publishedDate || m?.['og:updated_time'] || m?.modifiedTime || m?.date || null;

async function fcSearch(query: string, recent: boolean) {
  const body: any = { query, limit: 5, sources: ['web'], scrapeOptions: { formats: ['markdown'], onlyMainContent: true } };
  if (recent) body.tbs = 'qdr:y';
  const j = await firecrawl('/v2/search', body);
  const list: any[] = j.data?.web ?? (Array.isArray(j.data) ? j.data : []);
  return list.filter((x) => x?.url).map((x) => ({
    url: String(x.url), title: String(x.title || x.metadata?.title || ''), description: String(x.description || ''),
    published: pubHint(x.metadata), markdown: String(x.markdown || '').replace(/\n{3,}/g, '\n\n').slice(0, 2600),
  }));
}

async function fcRead(url: string) {
  const j = await firecrawl('/v2/scrape', { url, formats: ['markdown'], onlyMainContent: true }, 120_000);
  const d = j.data || {};
  return { url: String(d.metadata?.sourceURL || d.metadata?.url || url), title: String(d.metadata?.title || ''), published: pubHint(d.metadata),
    markdown: String(d.markdown || '').replace(/\n{3,}/g, '\n\n').slice(0, 14000) };
}

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

async function openai(body: any) {
  if (!env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is not set on motion-api');
  for (let i = 0; ; i++) {
    const r = await fetch(`${OPENAI_URL}/v1/responses`, {
      method: 'POST',
      headers: { authorization: `Bearer ${env.OPENAI_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(600_000),
    });
    const j: any = await r.json().catch(() => ({}));
    if ((r.status === 429 || r.status >= 500) && i < 4) {
      const wait = Number(r.headers.get('retry-after') || 0) * 1000 || 5000 * (i + 1);
      await new Promise((res) => setTimeout(res, Math.min(wait, 60_000)));
      continue;
    }
    if (!r.ok) throw new Error(`OpenAI ${r.status}: ${String(j.error?.message || '').slice(0, 300)}`);
    if (j.status === 'failed' || j.error) throw new Error(`OpenAI: ${String(j.error?.message || 'response failed').slice(0, 300)}`);
    return j;
  }
}

type ToolUse = { id: string; name: string; input: any };
type ToolResult = { id: string; content: string; is_error?: boolean };
type Usage = { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number };
interface Conversation {
  turn(force: boolean): Promise<{ uses: ToolUse[]; usage: Usage }>;
  results(rs: ToolResult[], note?: string): void;
  say(text: string): void;
}

// Anthropic Messages API; the conversation is cached so each turn re-reads it at the cache price.
function anthropicConversation(system: string, first: string, model: string): Conversation {
  const messages: any[] = [{ role: 'user', content: first }];
  const sys = [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }];
  return {
    async turn(force) {
      const msgs = JSON.parse(JSON.stringify(messages));
      const last = msgs[msgs.length - 1];
      if (typeof last.content === 'string') last.content = [{ type: 'text', text: last.content }];
      last.content[last.content.length - 1].cache_control = { type: 'ephemeral' };
      const resp = await claude({ model, max_tokens: 16000, system: sys, tools: TOOLS, messages: msgs,
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
  };
}

// OpenAI Responses API (tool calling for current GPT models goes through it). Output items are fed back as input.
function openaiConversation(system: string, first: string, model: string, effort: string): Conversation {
  const input: any[] = [{ role: 'user', content: first }];
  const tools = TOOLS.map((t) => ({ type: 'function', name: t.name, description: t.description, parameters: t.input_schema }));
  return {
    async turn(force) {
      // reasoning tokens count against max_output_tokens, so leave room for high effort
      const resp = await openai({ model, instructions: system, input, tools, reasoning: { effort },
        max_output_tokens: effort === 'high' ? 48000 : effort === 'medium' ? 32000 : 20000,
        tool_choice: force ? { type: 'function', name: 'submit_episode' } : 'auto' });
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
      return { uses, usage: { input_tokens: Math.max(0, Number(u.input_tokens || 0) - cached), output_tokens: Number(u.output_tokens || 0), cache_read_input_tokens: cached, cache_creation_input_tokens: 0 } };
    },
    results(rs, note) {
      for (const r of rs) input.push({ type: 'function_call_output', call_id: r.id, output: (r.is_error ? 'ERROR: ' : '') + r.content });
      if (note) input.push({ role: 'user', content: note });
    },
    say(text) { input.push({ role: 'user', content: text }); },
  };
}

function systemPrompt() {
  const d = nowBkk();
  const ce = d.getUTCFullYear(), be = ce + 543;
  return `You are the head writer and researcher of a Thai short-video channel. Series tag: "${SERIES_TAG}".
Today is ${todayIso()} (Thai year ${be}). Every clip is a 1080x1920 vertical video, 45–75 seconds, narrated in Thai by a synthetic voice,
with 100% code-drawn motion graphics: a mint "jelly cat" mascot narrates, and an optional chibi guy with round glasses ("ตั้ม") acts out scenarios.
The visuals come only from the template engine described below (no images, no AI art, no stock footage).

## Research rule (the owner's standing instruction — non-negotiable)
- Every fact, number and story condition must come from pages you retrieve in THIS session with web_search or read_page (Firecrawl).
- Always look for the MOST RECENT data that exists. Put the year in queries (${ce} / ${be}, or ${ce - 1} / ${be - 1}) and search in Thai and English.
  Prefer primary/official sources (สำนักงานสถิติแห่งชาติ, ministries, Bank of Thailand, WHO, World Bank, UN, OECD, DataReportal, peer-reviewed papers,
  reputable news citing them). Use read_page on the key pages to confirm exact figures before you use them.
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

## Scenes (scenes[]) — one per segment, same seg id
Each scene: {"seg", "type", "bg", ...template fields, optional common fields}. Timing fields ("at", "*_at", countdown entries) must be a word or
short phrase copied EXACTLY from that segment's narration (it fires when that word is spoken). On-screen text may use digits and is short
(≤ 22 characters per line). Vary bg between consecutive scenes. bg: ${BGS.join(', ')}.
Common optional fields (any type): "set": ${SETS.join('|')} (draw the scene in that location instead of a plain background;
best for scenario, hook, chat, versus, outro), "headline": {"text","at"} (top title), "sub": {"text","at","color"}, "cat": {"mood": normal|happy|shock|worried,
"x": right|left|center, "react": {"mood","at"}}, "person": {"mood": normal|happy|shock|think, "x": left|right, "outfit": navy|red|green|purple|orange|grey,
"react": {...}}, "stamp": {"text" (≤ 12 chars),"at","color": red|green|orange}, "note": {"text"} (small source line, e.g. "ที่มา: สสช. 2568"), "confetti": {"at"}.
Templates:
- hook: {"lines": [{"text","at","color"}] (1–3 lines), "icon", "icon_at"}
- number: {"value": number, "decimals", "prefix", "suffix" (e.g. " ล้านคน", "%"), "at", "label": {"text","at"}, "icon"} — counter rolls up when "at" is spoken
- compare: {"items": [{"label","value","display","icon","at","color"}] (2–3), "highlight": index, "highlight_at"} — vertical bars
- bars: {"items": [{"label","value","display","at"}] (2–6), "highlight": index} — horizontal ranking
- list: {"items": [{"text","icon","at"}] (2–5), "mark": number|check|cross|icon}
- quiz: {"question": {"text","at"}, "options": [{"letter","text","at"}] (3), "countdown": ["สาม","สอง","หนึ่ง"]}
- reveal: {"options": same as quiz, "correct": index, "at", "big": {"text","at"}}
- dots: {"total": 10–400, "highlight": count, "at", "highlight_at", "label": {"text","at"}, "unit": person|dot, "color"} — "x out of N"
- timeline: {"items": [{"year","text","at"}] (2–5)}
- truth: {"statement": {"text","at"}, "verdict": true|false, "verdict_at", "verdict_text", "explain": {"text","at"}} — myth vs fact
- scenario: {"bubble": {"text","at"}, "icon", "icon_at", "person": {...}, "cat": {...}} — acted-out "what if" moment
- icons: {"items": [{"icon","label","at"}] (2–6)}
- outro: {"lines": [{"text","at"}] (1–2), "icon_at"} — comment call to action
- chat: {"title", "messages": [{"from": left|right, "name", "text", "at"}] (2–6)} — a phone chat that types out as it is spoken
- versus: {"items": [{"label", "who" (cast name) or "icon", "lines": [short stats], "at", "color"}] (exactly 2), "winner": index, "winner_at"}
- scale: {"icon", "count": 1–60, "at", "label": {"text","at"}} — "that equals N of these" with the icon repeated
Icons: ${ICONS.join(', ')}.

## Characters (cast)
Define the people in this episode in "cast" (0–4 characters), each a distinct look, and refer to them in scenes with "person": {"who": name, ...}.
Give each character a look that fits who they are; make characters in the same episode clearly different (hairstyle, hair colour, top colour).
Fields: {"name" (as spoken/shown, e.g. "แบงค์"), "hairstyle": ${HAIRSTYLES.join('|')}, "hair_color": ${HAIR_COLORS.join('|')},
"skin": ${SKINS.join('|')}, "top": ${TOPS.join('|')}, "top_color", "bottom": ${BOTTOMS.join('|')}, "bottom_color" (colours: ${CLOTH.join('|')}),
"glasses": round|square|none, "accessories": [${ACCESSORIES.join(', ')}], "accessory_color"}.
## Cover + opening (the owner's standing rule for EVERY clip)
Every clip has a main character: cast[0]. Its "name" is the name the clip is about. The cover image reads "คนนี้ชื่อ “<name>”" with that character, so cast[0].name must be a real, speakable Thai name or nickname (≤ 14 characters).
If the owner's topic starts with "คนชื่อ X ในประเทศไทย มีกี่คน", then cast[0].name = X. If the topic gives no name, pick a common Thai name that fits the story. If the topic says "แล้วต่อด้วยเรื่อง: Y", Y is the story that follows the opener; if there is no Y, choose a fresh story angle yourself.
If the owner picked saved characters (see below) they come first in cast: cast[0] is the first of them and its name is the one used in the opener and on the cover.
The clip OPENS with that question, then the story follows:
- segment 1 (beat "hook"): the question itself, e.g. "คนชื่อ X ในประเทศไทย มีกี่คน?" — it must contain the name and the word "ประเทศไทย".
- segment 2: the answer — how many people in Thailand have that name (or rank/share if only that exists). This number is research: search with Firecrawl for the NEWEST data (official registry/DOPA statistics,
  national name rankings, news, academic work), take the latest year available, and cite it in sources with its "published" year. Never invent a count. If no official count is published, say so honestly in the narration
  ("ไม่มีสถิติทางการ แต่ข้อมูลล่าสุดบอกว่า…"), give only what the source supports (rank, share, a stated estimate), and record it as a claim of kind "assumption".
- then continue into the story/topic with the usual formats, re-hooks and CTA. A claim in "claims" must mention the name and cover the count.
Optional "cover": {"name": (default cast[0].name), "line": (≤ 28 chars, the bottom hook line on the cover; default = the title)}.
Show the main character BIG in the opening: segment 1's scene must be type "scenario" with "person": {"who": cast[0].name} and a "headline" (or "bubble") with the question,
so viewers see clearly who "this person" is in the first seconds (like the cover).

## Characters in EVERY frame, acting out the context (the owner's standing rule)
The jelly cat narrator is on screen in every scene and any cast member appears in every scene too (the engine adds them even if you do not place them; "cat": false is not allowed).
They must MOVE differently with what is being said. Give every scene's "cat" an "action": {"name", "at"} (and "person" one when it is placed; the person's action should differ from the cat's).
Actions: ${ACTIONS.join(', ')} — wave (greeting/CTA), hop (good news), jump (the big hook or reveal), nod (agreeing, facts), sway (thinking, quiz), shake (shock, no, myth),
dance (celebration, outro), lean (pointing at the number/item on screen), peek (a surprise slides in), run (journey, timeline, getting away), cheer (the answer is right), idle (calm).
"at" is a word from that segment's narration (the action starts when it is spoken). Combine with moods (cat: normal|happy|shock|worried, person: normal|happy|shock|think) and "react".
Match the action to the meaning of the words, change it between consecutive scenes, and use at least 4 different actions in an episode. Move the characters with "x": left|right|center in some scenes.

## Pace (the owner wants it faster)
The voice runs fast (about ${CPS.toFixed(1)} characters per second). Write punchy narration: short phrases, active verbs, no filler or
repetition, a fresh fact, number or twist every few seconds.

## Music follows the story (the owner's rule)
Choose "music" (mood: ${Object.keys(MUSIC).join(', ')}) and "music_brief": {"tempo_bpm" 60–150, "instruments" (2–4, English), "feel" (one English line about
this story's emotion and setting)}. Fit THIS story and the visual style (e.g. pixel_art → chiptune, retro_anime → 80s city pop, claymation → quirky stop-motion
woodwinds, risograph → indie lo-fi, ps2 → early-2000s game soundtrack). Do not default to fast or hyped: calm or touching stories get slower, softer music,
tense ones tense music, comedy gets comedic music. Vary the music from recent episodes.

"ตั้ม" is the recurring guy from earlier episodes (hairstyle helmet, top blazer navy, glasses round, accessories [bag]); reuse exactly that look if he appears.
A "scenario" scene can show two characters: "person" (left) and "person2" (right), with "bubble" and "bubble2" speech lines; name tags show automatically.
Elsewhere "person" appears small in a corner. The cat is always the narrator.

## Sound
sfx: up to 10 cues {"sfx", "seg", "at" (word from that segment), "gain" 0.3–0.7}. "sfx" is a library sound (${Object.keys(SFX).join('|')})
or "custom" with "prompt" (English, ≤ 100 chars, a sound that belongs to THIS story, e.g. "paper train whistle", "robot beeping happily") and "duration" 0.5–4 s
(at most ${MAX_CUSTOM_SFX} custom). Pick sounds that match what is happening on screen and in the story; they do not all have to be fast or punchy —
quiet moments can have soft sounds or none. Avoid the same set of sounds as every other episode.

## Visual style
Every episode is drawn in one visual style (all code-drawn): ${STYLE_NAMES.map((k) => `${k} (${STYLES[k].en})`).join('; ')}.
Set "style". The user message says whether the owner fixed it; otherwise pick the one that suits the story best and differs from the last two episodes.

## Captions
captions: facebook, instagram, tiktok, youtube (title-style, ≤ 90 chars), twitter (≤ 260 chars). Thai, hook + the quiz question or key fact,
one short "อ้างอิง:" line naming the main sources and years, 5–8 hashtags including #จะเกิดอะไรขึ้นถ้า #รู้หรือไม่ (instagram/tiktok may have more).

## Process
1. Plan, then research with web_search (several queries, Thai + English, newest year first) and read_page on the most important pages.
2. Write everything, then call submit_episode once with the complete episode. If it returns problems, fix them and call submit_episode again.
Reply only through tools.`;
}

const TOOLS = [
  {
    name: 'web_search',
    description: 'Search the web with Firecrawl. Returns up to 5 results with title, URL, publication hint and the start of each page as markdown. Put the year in the query to get the newest data.',
    input_schema: { type: 'object', properties: { query: { type: 'string' }, recent_only: { type: 'boolean', description: 'only pages from the past 12 months' } }, required: ['query'] },
  },
  {
    name: 'read_page',
    description: 'Read one page with Firecrawl (markdown, up to ~14k characters). Use it to confirm exact numbers and publication dates.',
    input_schema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
  },
  {
    name: 'submit_episode',
    description: 'Submit the finished episode. Returns problems to fix, or ok.',
    input_schema: {
      type: 'object',
      required: ['title_th', 'angle', 'script', 'scenes', 'sources', 'claims', 'captions', 'music'],
      properties: {
        title_th: { type: 'string', description: 'clip title, ≤ 60 chars' },
        format: { type: 'string', enum: Object.keys(FORMATS) },
        angle: { type: 'string', description: 'one sentence: the story angle and why it is interesting (Thai)' },
        script: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, text: { type: 'string' }, beat: { type: 'string', enum: [...BEATS] } }, required: ['id', 'text', 'beat'] } },
        scenes: { type: 'array', items: { type: 'object' } },
        sources: { type: 'array', items: { type: 'object', properties: {
          url: { type: 'string' }, title: { type: 'string' }, publisher: { type: 'string' }, published: { type: 'string', description: 'YYYY-MM-DD, YYYY-MM or YYYY of the data/publication' },
          claim: { type: 'string' }, methodology: { type: 'string' }, confidence: { type: 'string', enum: ['high', 'medium', 'low'] }, limitations: { type: 'string' },
          freshness_note: { type: 'string' } }, required: ['url', 'publisher', 'published', 'claim', 'confidence'] } },
        claims: { type: 'array', items: { type: 'object', properties: { text: { type: 'string' }, source_ids: { type: 'array', items: { type: 'integer' } },
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
          glasses: { type: 'string' }, accessories: { type: 'array', items: { type: 'string' } }, accessory_color: { type: 'string' } }, required: ['name'] } },
        thumbnail: { type: 'object', properties: { seg: { type: 'string' }, title: { type: 'string' } } },
        cover: { type: 'object', properties: { name: { type: 'string' }, line: { type: 'string' } } },
      },
    },
  },
];

// ---------------------------------------------------------------- validation of a draft
// a colour is a name from the lists above or an exact [r,g,b] (cast made from a photo)
const Colour = z.union([z.string(), z.array(z.number().int().min(0).max(255)).length(3)]);
const Draft = z.object({
  title_th: z.string().min(4).max(90),
  angle: z.string().default(''),
  format: z.string().default(''),
  script: z.array(z.object({ id: z.string().regex(/^[a-z0-9_]{1,24}$/), text: z.string().min(3).max(500), beat: z.enum(BEATS).default('info') })).min(4).max(14),
  scenes: z.array(z.object({ seg: z.string(), type: z.enum(TEMPLATES) }).passthrough()).min(1),
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
    name: z.string().min(1).max(20), hairstyle: z.string().optional(), hair_color: Colour.optional(), skin: Colour.optional(),
    top: z.string().optional(), top_color: Colour.optional(), bottom: z.string().optional(), bottom_color: Colour.optional(),
    glasses: z.string().optional(), accessories: z.array(z.string()).optional(), accessory_color: Colour.optional(),
    inner_color: Colour.optional(), shoes_color: Colour.optional(), frame_color: Colour.optional(), pattern: z.string().optional(), pattern_color: Colour.optional(),
    backdrop: z.string().max(220_000).optional(),   // photo background of a photo character, set by the server, never by the brain
  })).max(4).default([]),
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

export function checkDraft(d: DraftT, seen: Map<string, Seen> | null, recent: Recent[] = [], opts: { requiredNames?: string[] } = {}) {
  const problems: string[] = [], warnings: string[] = [];
  const ids = d.script.map((s) => s.id);
  if (new Set(ids).size !== ids.length) problems.push('script ids must be unique');
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
  if (!d.cast.length) problems.push('cast[0] is required: the main character whose name is on the cover ("คนนี้ชื่อ …")');
  else {
    const nm = d.cast[0].name;
    const first = d.script[0]?.text || '';
    if (!normText(first).includes(normText(nm)) || !first.includes('ไทย')) problems.push(`segment 1 must be the opening question "คนชื่อ ${nm} ในประเทศไทย มีกี่คน" (it needs the name "${nm}" and "ประเทศไทย")`);
    if (!d.claims.some((c) => normText(c.text).includes(normText(nm)))) problems.push(`add a claim about how many people in Thailand are named "${nm}" (with its source, or kind "assumption" when no official count exists)`);
    // the main character big on screen in the opening (like the cover)
    const sc0: any = d.scenes.find((x) => x.seg === d.script[0]?.id);
    if (sc0 && (sc0.type !== 'scenario' || (sc0.person?.who && sc0.person.who !== nm)))
      problems.push(`segment 1's scene must be type "scenario" showing the main character big: "person": {"who": "${nm}"} with the question as headline or bubble`);
  }
  // characters made from the owner's photos are shown big (scenario scenes), not only small in a corner
  const req = (opts.requiredNames || []).filter((n) => names.has(n));
  if (req.length) {
    const big = (d.scenes as any[]).filter((sc) => sc.type === 'scenario' && (req.includes(sc.person?.who) || req.includes(sc.person2?.who))).length;
    const need = Math.min(4, Math.ceil(d.scenes.length / 3));
    if (big < need) problems.push(`the owner's photo characters (${req.join(', ')}) must be seen big: use at least ${need} "scenario" scenes with one of them as "person" (now ${big})`);
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
  if (new Set(acts.filter((x) => x && x !== 'idle')).size < Math.min(4, d.scenes.length)) problems.push('use at least 4 different character actions across the episode');
  // ---- variety
  const types = d.script.map((s) => (d.scenes.find((x) => x.seg === s.id) as any)?.type).filter(Boolean) as string[];
  for (let i = 1; i < types.length; i++) if (types[i] === types[i - 1] && types[i] !== 'scenario') problems.push(`scenes ${d.script[i - 1].id} and ${d.script[i].id} both use "${types[i]}"; change one (avoid the same layout twice in a row)`);
  const counts = types.reduce((m: Record<string, number>, x) => ({ ...m, [x]: (m[x] || 0) + 1 }), {});
  for (const [k, n] of Object.entries(counts)) if (n > (k === 'scenario' ? 5 : 2)) problems.push(`scene type "${k}" is used ${n} times; vary the layouts`);
  if (d.format && !FORMATS[d.format]) problems.push(`unknown format "${d.format}"`);
  if (!d.format) problems.push('set "format" to one of: ' + Object.keys(FORMATS).join(', '));
  const clash = recent.slice(0, 2).filter((r) => r.format && r.format === d.format);
  if (d.format && clash.length) problems.push(`format "${d.format}" was used in a recent episode ("${clash[0].title}"); choose a different format`);
  const sig = (xs: string[]) => xs.slice(0, 5).join('>');
  const same = recent.slice(0, 6).find((r) => r.types.length && sig(r.types) === sig(types));
  if (same) problems.push(`the scene sequence starts exactly like "${same.title}" (${sig(types)}); change the order or the layouts`);
  if (!MUSIC[d.music]) warnings.push(`unknown music mood "${d.music}" (playful is used)`);
  const thisYear = nowBkk().getUTCFullYear();
  d.sources.forEach((s, i) => {
    if (seen && !seen.has(normUrl(s.url))) problems.push(`source ${i} (${s.url}) was not retrieved with web_search/read_page in this session — research rule: only use pages you fetched`);
    const y = yearOf(s.published);
    if (!y) problems.push(`source ${i}: "published" needs the date or year of the data`);
    else if (thisYear - y > MAX_YEARS && !(s.freshness_note && s.freshness_note.trim().length >= 10)) {
      problems.push(`source ${i} is from ${y}: find newer data, or add freshness_note explaining why this is the latest available`);
    }
  });
  d.claims.forEach((c) => {
    if (c.kind === 'fact' && (!c.source_ids.length || c.source_ids.some((k) => k >= d.sources.length))) problems.push(`fact without a valid source: "${c.text.slice(0, 80)}"`);
  });
  if (d.captions.twitter.length > 270) problems.push(`captions.twitter is ${d.captions.twitter.length} characters (max 270)`);
  return { problems: [...new Set(problems)], warnings: [...new Set(warnings)] };
}

// ---------------------------------------------------------------- draft -> episode package
export function sceneCode(d: DraftT) {
  const spec = { scenes: d.scenes, text: Object.fromEntries(d.script.map((s) => [s.id, s.text])), cast: d.cast };
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
    storyboard: d.scenes.map((s: any) => ({ seg: s.seg, visual: `template:${s.type}`, onscreen: firstLine(s), bg: s.bg ?? null, transition: 'iris' })),
    sources: d.sources.map((s) => {
      const r = byUrl.get(normUrl(s.url));
      return { url: s.url, publisher: s.publisher, title: s.title || r?.title, published: s.published, collected: r?.collected || todayIso(), methodology: s.methodology,
        confidence: s.confidence, limitations: s.limitations, claim: s.claim, retrieved_via: 'firecrawl', ...(s.freshness_note ? { freshness_note: s.freshness_note } : {}) };
    }),
    claims: d.claims,
    captions: d.captions,
    thumbnail: { seg: thumbSeg, offset: 1.5, title: d.thumbnail?.title || d.title_th.slice(0, 40) },
    ...(d.cast.length ? { cover: { who: d.cast[0].name, name: (d.cover?.name || d.cast[0].name).slice(0, 20), line: (d.cover?.line || d.thumbnail?.title || d.title_th).slice(0, 40) } } : {}),
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
type Look = { hairstyle: string; hair_color: number[]; skin: number[]; top: string; top_color: number[]; inner_color?: number[]; bottom: string; bottom_color: number[]; shoes_color?: number[]; frame_color?: number[];
  pattern?: string; pattern_color?: number[]; glasses: string; accessories: string[]; accessory_color: number[]; backdrop?: string };
export type PhotoResult = { look: Look; person_box: number[] | null };
const PATTERNS = ['none', 'stripes', 'plaid', 'dots'];
const BOX4 = { type: 'array', items: { type: 'integer' }, minItems: 4, maxItems: 4 };
const rgb = (v: any, d: number[]): number[] => (Array.isArray(v) && v.length >= 3 ? v.slice(0, 3).map((n) => Math.max(0, Math.min(255, Math.round(Number(n) || 0)))) : d);
const pick = (v: any, list: string[], d: string) => (list.includes(v) ? v : d);
const RGB3 = { type: 'array', items: { type: 'integer' }, minItems: 3, maxItems: 3 };
const LOOK_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['person_visible', 'hairstyle', 'hair_color', 'skin', 'top', 'top_color', 'inner_color', 'bottom', 'bottom_color', 'shoes_color', 'frame_color', 'pattern', 'pattern_color', 'glasses', 'accessories', 'accessory_color', 'boxes'],
  properties: {
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
  if (!req?.length) return d;
  const names = new Set(req.map((r) => r.name));
  const forced = req.map((r) => ({ name: r.name, ...r.look }));
  return { ...d, cast: [...forced, ...d.cast.filter((c) => !names.has(c.name))].slice(0, 4) } as DraftT;
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

  async function generate(id: string) {
    const row = (await pool.query('SELECT * FROM drafts WHERE id=$1', [id])).rows[0];
    if (!row || row.status !== 'queued') return;
    const seen = new Map<string, Seen>();
    const research: any[] = [];
    let parent: any = null;
    if (row.parent_id) {
      parent = (await pool.query('SELECT draft, research FROM drafts WHERE id=$1', [row.parent_id])).rows[0] ?? null;
      for (const r of (parent?.research ?? []) as any[]) {
        if (r.url && r.collected && Date.now() - new Date(r.collected).getTime() < 25 * 86400_000) seen.set(normUrl(r.url), r);
      }
    }
    const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, firecrawl_calls: 0, turns: 0 };
    const saveUsage = () => pool.query('UPDATE drafts SET usage=$2, research=$3, updated_at=now() WHERE id=$1', [id, JSON.stringify(usage), JSON.stringify(research)]);
    const useModel = row.model && MODEL_RE.test(row.model) ? row.model : MODEL;
    const useEffort = PROVIDER === 'openai' ? (REASONING_LEVELS.includes(row.reasoning) ? row.reasoning : REASONING) : null;
    await pool.query("UPDATE drafts SET status='researching', model=$2, reasoning=$3, updated_at=now() WHERE id=$1", [id, useModel, useEffort]);
    await log(id, `เริ่มค้นข้อมูลด้วย Firecrawl (${useModel}${useEffort ? ' · reasoning ' + useEffort : ''})`);

    let userText = `Topic from the owner: ${row.topic}`;
    if (row.note) userText += `\nOwner's direction: ${row.note}`;
    if (parent?.draft) {
      const p = parent.draft;
      userText += `\n\nThis is a rewrite. Previous version (title "${p.title_th}"):\n${(p.script || []).map((s: any) => `[${s.id}] ${s.text}`).join('\n')}\n` +
        `Previous sources (already fetched with Firecrawl recently, you may cite them again without re-reading):\n${(p.sources || []).map((s: any) => `- ${s.url} (${s.publisher}, ${s.published})`).join('\n')}\n` +
        `Apply the owner's direction; check for newer data where it matters.`;
    }
    if (row.source_type === 'community' && row.community_id) {
      const cw = (await pool.query('SELECT payload FROM community_winners WHERE id=$1', [row.community_id])).rows[0];
      if (cw) userText += communityBlock(cw.payload);
    }
    const reqChars: ReqChar[] = Array.isArray(row.characters) ? row.characters : [];
    if (reqChars.length) {
      userText += `\n\nRequired characters (the owner uploaded photos of them; their look is applied automatically, do not change it): ${reqChars.map((c) => `"${c.name}"`).join(', ')}. ` +
        `Make them the main cast of this episode: put them in "cast" by exactly these names, write them into the story (what they do, say and feel) and refer to them in scenes with "person": {"who": name}. ` +
        `Show them BIG so viewers recognise them: about a third of the scenes must be "scenario" scenes with one of them as "person". ` +
        (reqChars.some((c) => (c.look as any)?.backdrop) ? `The background of their uploaded photo is drawn automatically behind their scenario scenes (and on the cover), so do NOT give those scenario scenes a "set" (leave "set" out); use "set" only on scenes about other places. ` : '') +
        `You may add at most ${Math.max(0, 4 - reqChars.length)} other characters.`;
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
    const conv = PROVIDER === 'openai' ? openaiConversation(systemPrompt(), userText, model, effort) : anthropicConversation(systemPrompt(), userText, model);
    let submits = 0;

    for (let turn = 0; turn < MAX_TURNS; turn++) {
      usage.turns = turn + 1;
      const totalIn = usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens;
      const mustSubmit = turn >= MAX_TURNS - 2 || totalIn > MAX_INPUT_TOKENS * 0.8;
      const { uses, usage: u } = await conv.turn(mustSubmit);
      for (const k of ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'] as const) usage[k] += u[k];
      if (!uses.length) {
        conv.say('Continue: research with the tools if needed, then call submit_episode.');
        continue;
      }
      const results: any[] = [];
      for (const u of uses) {
        try {
          if (u.name === 'web_search' || u.name === 'read_page') {
            if (usage.firecrawl_calls >= MAX_FIRECRAWL) {
              results.push({ type: 'tool_result', tool_use_id: u.id, is_error: true, content: 'Research budget for this clip is used up. Write the episode with what you have and call submit_episode.' });
              continue;
            }
            usage.firecrawl_calls++;
            if (u.name === 'web_search') {
              const q = String(u.input?.query || '').slice(0, 300);
              await log(id, `ค้นหา: ${q}`);
              const res = await fcSearch(q, !!u.input?.recent_only);
              for (const r of res) {
                const s: Seen = { url: r.url, title: r.title, published_hint: r.published, collected: todayIso(), via: 'search' };
                if (!seen.has(normUrl(r.url))) seen.set(normUrl(r.url), s);
              }
              research.push({ kind: 'search', query: q, at: new Date().toISOString(), results: res.map((r) => ({ url: r.url, title: r.title, published: r.published })) });
              results.push({ type: 'tool_result', tool_use_id: u.id, content: res.length ? res.map((r, i) =>
                `[${i + 1}] ${r.title}\nURL: ${r.url}\nPublished (page metadata): ${r.published || 'unknown'}\n${r.description}\n---\n${r.markdown}`).join('\n\n=====\n\n') : 'No results. Try another query.' });
            } else {
              const url = String(u.input?.url || '');
              await log(id, `อ่าน: ${host(url)}`);
              const r = await fcRead(url);
              seen.set(normUrl(url), { url, title: r.title, published_hint: r.published, collected: todayIso(), via: 'read' });
              if (normUrl(r.url) !== normUrl(url)) seen.set(normUrl(r.url), { url: r.url, title: r.title, published_hint: r.published, collected: todayIso(), via: 'read' });
              research.push({ kind: 'read', url, at: new Date().toISOString(), title: r.title, published: r.published });
              results.push({ type: 'tool_result', tool_use_id: u.id, content: `${r.title}\nURL: ${r.url}\nPublished (page metadata): ${r.published || 'unknown'}\n---\n${r.markdown || '(empty page)'}` });
            }
          } else if (u.name === 'submit_episode') {
            submits++;
            await pool.query("UPDATE drafts SET status='writing', updated_at=now() WHERE id=$1", [id]);
            await log(id, submits === 1 ? 'เขียนสคริปต์และวางฉากเสร็จ กำลังตรวจกฎ' : `แก้ตามที่ตรวจพบ (รอบ ${submits})`);
            if (u.input?.__invalid_json !== undefined) {
              results.push({ type: 'tool_result', tool_use_id: u.id, is_error: true, content: 'The arguments were not valid JSON. Submit again with valid JSON.' });
              continue;
            }
            const parsed = Draft.safeParse(u.input);
            if (!parsed.success) {
              const issues = parsed.error.issues.slice(0, 15).map((i) => `${i.path.join('.')}: ${i.message}`);
              results.push({ type: 'tool_result', tool_use_id: u.id, is_error: true, content: `Fix these and submit again:\n- ${issues.join('\n- ')}` });
              continue;
            }
            const d0 = applyCast(parsed.data, reqChars);
            const d = { ...d0, ...(fixedStyle ? { style: fixedStyle } : {}), music_mode: row.music_mode === 'ai' ? 'ai' as const : 'default' as const };
            const { problems, warnings } = checkDraft(d, seen, recent, { requiredNames: reqChars.map((c) => c.name) });
            let est: number | null = null;
            if (!problems.length) {
              const f = finalCheck(row.topic, d, [...seen.values()]);
              problems.push(...f.errs);
              est = f.est;
            }
            if (problems.length && submits < 4) {
              await pool.query('UPDATE drafts SET problems=$2 WHERE id=$1', [id, JSON.stringify(problems)]);
              await log(id, `ตรวจพบ ${problems.length} จุดต้องแก้`);
              results.push({ type: 'tool_result', tool_use_id: u.id, is_error: true, content: `Fix these and submit again:\n- ${problems.join('\n- ')}` });
              continue;
            }
            const researchSeen = [...seen.values()];
            await pool.query(`UPDATE drafts SET draft=$2, problems=$3, estimated_credits=$4, status=$5, research=$6, usage=$7, error=$8, updated_at=now() WHERE id=$1`,
              [id, JSON.stringify({ ...d, warnings, research_seen: researchSeen }), JSON.stringify(problems), est, problems.length ? 'failed' : 'ready', JSON.stringify(research),
                JSON.stringify(usage), problems.length ? 'ยังผ่านกฎไม่ครบหลังแก้ 4 รอบ ดูรายการด้านล่าง' : null]);
            if (problems.length) { await log(id, 'ยังไม่ผ่านกฎ หยุดไว้ให้ตรวจ'); return; }
            await log(id, `ร่างพร้อมให้ตรวจ ✓ (ประมาณ ${est} เครดิตเสียง)`);
            if (row.auto_produce && row.source_type !== 'community') await produce(id).catch((e) => log(id, `ส่งผลิตอัตโนมัติไม่สำเร็จ: ${e instanceof Error ? e.message : e}`));
            return;
          } else {
            results.push({ type: 'tool_result', tool_use_id: u.id, is_error: true, content: `unknown tool ${u.name}` });
          }
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (/ANTHROPIC_API_KEY|OPENAI_API_KEY|FIRECRAWL_API_KEY/.test(msg)) throw e;
          await log(id, `เครื่องมือขัดข้อง: ${msg.slice(0, 120)}`);
          results.push({ type: 'tool_result', tool_use_id: u.id, is_error: true, content: `Tool failed: ${msg.slice(0, 300)}` });
        }
      }
      conv.results(results.map((r: any) => ({ id: r.tool_use_id, content: r.content, is_error: r.is_error })),
        !mustSubmit && usage.firecrawl_calls >= MAX_FIRECRAWL ? 'Research budget reached: write and submit now.' : undefined);
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
    updated_at: r.updated_at, estimated_credits: r.estimated_credits, job_id: r.job_id, job_status: r.job_status ?? null, job_progress: r.job_progress ?? null,
    episode_number: r.episode_number ?? null, last: (r.log || []).slice(-1)[0]?.msg ?? null, error: r.error, auto_produce: r.auto_produce, source_type: r.source_type ?? 'studio', community_id: r.community_id ?? null,
  });

  app.get('/app/api/studio/status', g, async (c) => {
    const n = (await pool.query("SELECT count(*)::int AS n FROM drafts WHERE created_at > now() - interval '1 day'")).rows[0].n;
    return c.json({ ...configured(), formats: Object.fromEntries(Object.entries(FORMATS).map(([k, f]) => [k, f.th])), model: MODEL,
      models: MODEL_CHOICES[PROVIDER], reasoning: PROVIDER === 'openai' ? REASONING : null, reasoning_levels: PROVIDER === 'openai' ? REASONING_LEVELS : [], drafts_today: n, daily_limit: DAILY_LIMIT, busy, max_credits: DRAFT_MAX_CREDITS });
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
    const r = await pool.query('INSERT INTO characters (name, look, thumb) VALUES ($1,$2,$3) RETURNING id, name, look, thumb, created_at', [name, JSON.stringify(res.look), thumb]);
    return c.json({ character: r.rows[0], person_box: res.person_box }, 201);
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
      research: r.research });
  });

  app.post('/app/api/studio/drafts', g, async (c) => {
    const b = await c.req.json().catch(() => ({}));
    const topic = String(b.topic || '').trim().slice(0, 400);
    if (topic.length < 4) return c.json({ error: 'พิมพ์หัวข้ออย่างน้อย 4 ตัวอักษร' }, 422);
    const cf = configured();
    if (!cf.llm || !cf.firecrawl) return c.json({ error: `ยังไม่ได้ตั้งค่า ${[!cf.llm && cf.key_name, !cf.firecrawl && 'FIRECRAWL_API_KEY'].filter(Boolean).join(' และ ')} ใน Railway (motion-api)` }, 503);
    const n = (await pool.query("SELECT count(*)::int AS n FROM drafts WHERE created_at > now() - interval '1 day'")).rows[0].n;
    if (n >= DAILY_LIMIT) return c.json({ error: `ครบโควตา ${DAILY_LIMIT} ร่างต่อวันแล้ว` }, 429);
    const model = typeof b.model === 'string' && MODEL_RE.test(b.model) ? b.model : MODEL;
    const reasoning = REASONING_LEVELS.includes(b.reasoning) ? b.reasoning : REASONING;
    const ids: string[] = (Array.isArray(b.characters) ? b.characters : []).map(String).filter(isId).slice(0, 3);
    const chars = ids.length ? (await pool.query('SELECT id, name, look, backdrop FROM characters WHERE id = ANY($1::uuid[]) ORDER BY created_at', [ids])).rows.map((x: any) => ({ id: x.id, name: x.name, look: x.backdrop ? { ...x.look, backdrop: x.backdrop } : x.look })) : [];
    const style = typeof b.style === 'string' && STYLES[b.style] ? b.style : 'auto';
    const musicMode = b.music_mode === 'ai' ? 'ai' : 'default';
    const r = await pool.query('INSERT INTO drafts (topic, note, auto_produce, model, reasoning, characters, style, music_mode) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id',
      [topic, String(b.note || '').trim().slice(0, 1000) || null, !!b.auto_produce, model, PROVIDER === 'openai' ? reasoning : null, JSON.stringify(chars), style, musicMode]);
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
    const cf = configured();
    if (!cf.llm || !cf.firecrawl) return c.json({ error: 'ยังไม่ได้ตั้งค่า API key ใน Railway' }, 503);
    // a rewrite keeps the owner's style and music choice (the review may have changed them on the draft itself)
    const keepStyle = row.draft?.style && STYLES[row.draft.style] && row.style !== 'auto' ? row.draft.style : row.style || 'auto';
    const keepMusic = row.draft?.music_mode || row.music_mode || 'default';
    const r = await pool.query('INSERT INTO drafts (topic, note, parent_id, auto_produce, model, reasoning, characters, source_type, community_id, style, music_mode) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id',
      [row.topic, String(b.note ?? row.note ?? '').trim().slice(0, 1000) || null, row.draft ? row.id : null, row.source_type === 'community' ? false : !!b.auto_produce,
        typeof b.model === 'string' && MODEL_RE.test(b.model) ? b.model : row.model, REASONING_LEVELS.includes(b.reasoning) ? b.reasoning : row.reasoning,
        JSON.stringify(row.characters ?? []), row.source_type || 'studio', row.community_id ?? null, keepStyle, keepMusic]);
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
