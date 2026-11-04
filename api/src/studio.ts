// Content studio: the owner types a topic; Claude researches it live with Firecrawl (latest data first), writes the Thai
// script and a scene spec for the code-drawn template engine (worker/engine/templates.py), and the result waits as a
// draft for review. "Produce" turns the draft into a normal episode package and queues it for the worker.
// Keys: ANTHROPIC_API_KEY and FIRECRAWL_API_KEY live only in Railway variables.
import type { Hono, Context, Next } from 'hono';
import type pg from 'pg';
import { z } from 'zod';

const env = process.env;
const ANTHROPIC_URL = (env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/$/, '');
const FIRECRAWL_URL = (env.FIRECRAWL_API_URL || 'https://api.firecrawl.dev').replace(/\/$/, '');
const MODEL = env.MOTION_LLM_MODEL || 'claude-opus-5-5';
const MAX_TURNS = Number(env.MOTION_LLM_MAX_TURNS || 18);
const MAX_INPUT_TOKENS = Number(env.MOTION_LLM_MAX_INPUT_TOKENS || 1_200_000); // incl. cache reads, per draft
const MAX_FIRECRAWL = Number(env.MOTION_FIRECRAWL_MAX_CALLS || 16);
const DAILY_LIMIT = Number(env.MOTION_MAX_DRAFTS_PER_DAY || 20);
const VOICE_ID = env.MOTION_DEFAULT_VOICE_ID || 'bcdIY58WBBzAMmef52NW';
const DRAFT_MAX_CREDITS = Number(env.MOTION_DRAFT_MAX_CREDITS || 4500);
const MAX_YEARS = Number(env.MOTION_SOURCE_MAX_YEARS || 2);
const SERIES_TAG = env.MOTION_SERIES_TAG || 'จะเกิดอะไรขึ้นถ้า...?';

export const configured = () => ({ anthropic: !!env.ANTHROPIC_API_KEY, firecrawl: !!env.FIRECRAWL_API_KEY });

// ---------------------------------------------------------------- engine vocabulary (must match worker/engine)
export const TEMPLATES = ['hook', 'number', 'compare', 'bars', 'list', 'quiz', 'reveal', 'dots', 'timeline', 'truth', 'scenario', 'icons', 'outro'] as const;
export const ICONS = ['baby', 'battery', 'bolt', 'book', 'brain', 'bulb', 'calendar', 'car', 'cart', 'cat', 'chart', 'chart_down', 'check', 'clock', 'coffee', 'coin',
  'cross', 'down', 'exclaim', 'eye', 'fire', 'fitness', 'food', 'game', 'globe', 'health', 'heart', 'hot', 'house', 'money', 'moon', 'music', 'people', 'person',
  'phone', 'pin', 'plane', 'question', 'rain', 'school', 'sleep', 'star', 'sun', 'thai_flag', 'trash', 'tree', 'trophy', 'up', 'warning', 'water', 'wifi'];
const BGS = ['night', 'grape', 'ocean', 'mint', 'sunset', 'sky', 'peach', 'forest', 'ink', 'gold', 'berry', 'teal'];
// Fixed prompts: identical requests are served from the worker's audio cache, so recurring effects cost nothing after the first episode.
const SFX: Record<string, { prompt: string; duration: number }> = {
  pop: { prompt: 'Short bright cartoon pop, bubbly and clean, no music', duration: 0.6 },
  whoosh: { prompt: 'Quick soft whoosh transition swish, airy, no music', duration: 0.8 },
  ding: { prompt: 'Bright correct-answer ding chime, single clean bell', duration: 1.0 },
  counter: { prompt: 'Fast mechanical number counter rolling up with rapid clicks, ending in a soft bell', duration: 2.0 },
  buzzer: { prompt: 'Short comedic cartoon wrong-answer buzzer, two quick low beeps', duration: 1.0 },
  drumroll: { prompt: 'Short snare drum roll building suspense, ending with a light cymbal hit', duration: 2.5 },
  tada: { prompt: 'Cheerful cartoon ta-da fanfare, short brass and sparkle', duration: 1.5 },
  tick: { prompt: 'Clock ticking, three crisp ticks, dry', duration: 1.5 },
  boing: { prompt: 'Cartoon spring boing, funny and short', duration: 0.8 },
  sparkle: { prompt: 'Cartoon magical sparkle glint ting, short and playful', duration: 1.2 },
  stamp: { prompt: 'Rubber stamp thump on paper, punchy and short', duration: 0.6 },
};
const MUSIC: Record<string, string> = {
  playful: 'Playful, curious background music for a short fun-fact video: bouncy pizzicato strings, ukulele and light marimba, soft claps, about 100 BPM, bright and friendly like a quirky quiz show, steady groove under narration, instrumental',
  curious: 'Curious, light investigative background music: soft plucked synths, gentle glockenspiel, muted bass, about 95 BPM, inquisitive and warm, steady under narration, instrumental',
  upbeat: 'Upbeat energetic background music for a short explainer: funky bass, crisp drums, bright synth stabs, about 112 BPM, positive and punchy, steady under narration, instrumental',
  dramatic: 'Light dramatic background music for a surprising-facts video: low strings pulse, soft taiko hits, rising tension without being scary, about 90 BPM, steady under narration, instrumental',
  chill: 'Chill lo-fi background music: warm electric piano, soft vinyl texture, relaxed drums, about 85 BPM, calm and friendly, steady under narration, instrumental',
};

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

## Story
Structure (7–10 segments): a 1-sentence hook question (≤ 4 s) → the real situation with the key number(s) → the "what would happen if…" reasoning,
step by step, grounded in the facts → a quiz ("ทายก่อน!" with A/B/C options and "สาม สอง หนึ่ง") → the reveal → a twist, myth-buster or surprising
consequence → a closing line that asks viewers to comment (a question they can answer). Quiz is strongly preferred but optional when it does not fit.
Tone: curious, playful, clear, never preachy; facts must stay accurate. Avoid medical/legal/financial advice beyond what sources say, politics
taking sides, and content about private individuals.

## Narration rules (script[].text) — read by Thai text-to-speech
- Natural spoken Thai, short phrases separated by single spaces (each space-separated phrase becomes one subtitle chunk; ≤ 28 characters per phrase).
- NO digits, %, or symbols: write numbers as Thai words (หกสิบห้าล้าน, ยี่สิบเอ็ดเปอร์เซ็นต์, ปีสองพันห้าร้อยหกสิบแปด or ปีสองห้าหกแปด).
- Brand/English names in Thai script (ไลน์, ยูทูบ, ติ๊กต็อก). Total narration 450–1000 Thai characters.
- segment ids: short lowercase ascii (hook, fact, whatif, quiz, reveal, twist, close…).

## Scenes (scenes[]) — one per segment, same seg id
Each scene: {"seg", "type", "bg", ...template fields, optional common fields}. Timing fields ("at", "*_at", countdown entries) must be a word or
short phrase copied EXACTLY from that segment's narration (it fires when that word is spoken). On-screen text may use digits and is short
(≤ 22 characters per line). Vary bg between consecutive scenes. bg: ${BGS.join(', ')}.
Common optional fields (any type): "headline": {"text","at"} (top title), "sub": {"text","at","color"}, "cat": {"mood": normal|happy|shock|worried,
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
Icons: ${ICONS.join(', ')}.

## Sound
sfx: up to 10 cues {"sfx": one of ${Object.keys(SFX).join('|')}, "seg", "at" (word from that segment), "gain" 0.3–0.7}. Use counter with number
reveals, drumroll/tick before reveals, ding or tada on the answer, buzzer/stamp on myths, pop/whoosh sparingly. music: ${Object.keys(MUSIC).join('|')}.

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
        angle: { type: 'string', description: 'one sentence: the story angle and why it is interesting (Thai)' },
        script: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, text: { type: 'string' } }, required: ['id', 'text'] } },
        scenes: { type: 'array', items: { type: 'object' } },
        sources: { type: 'array', items: { type: 'object', properties: {
          url: { type: 'string' }, title: { type: 'string' }, publisher: { type: 'string' }, published: { type: 'string', description: 'YYYY-MM-DD, YYYY-MM or YYYY of the data/publication' },
          claim: { type: 'string' }, methodology: { type: 'string' }, confidence: { type: 'string', enum: ['high', 'medium', 'low'] }, limitations: { type: 'string' },
          freshness_note: { type: 'string' } }, required: ['url', 'publisher', 'published', 'claim', 'confidence'] } },
        claims: { type: 'array', items: { type: 'object', properties: { text: { type: 'string' }, source_ids: { type: 'array', items: { type: 'integer' } },
          kind: { type: 'string', enum: ['fact', 'assumption', 'opinion'] } }, required: ['text', 'source_ids', 'kind'] } },
        captions: { type: 'object', properties: { facebook: { type: 'string' }, instagram: { type: 'string' }, tiktok: { type: 'string' }, youtube: { type: 'string' }, twitter: { type: 'string' } },
          required: ['facebook', 'instagram', 'tiktok', 'youtube', 'twitter'] },
        sfx: { type: 'array', items: { type: 'object', properties: { sfx: { type: 'string' }, seg: { type: 'string' }, at: { type: 'string' }, gain: { type: 'number' } }, required: ['sfx', 'seg', 'at'] } },
        music: { type: 'string', enum: Object.keys(MUSIC) },
        thumbnail: { type: 'object', properties: { seg: { type: 'string' }, title: { type: 'string' } } },
      },
    },
  },
];

// ---------------------------------------------------------------- validation of a draft
const Draft = z.object({
  title_th: z.string().min(4).max(90),
  angle: z.string().default(''),
  script: z.array(z.object({ id: z.string().regex(/^[a-z0-9_]{1,24}$/), text: z.string().min(3).max(500) })).min(4).max(14),
  scenes: z.array(z.object({ seg: z.string(), type: z.enum(TEMPLATES) }).passthrough()).min(1),
  sources: z.array(z.object({
    url: z.string().url(), title: z.string().optional(), publisher: z.string().default(''), published: z.string().default(''), claim: z.string().default(''),
    methodology: z.string().optional(), confidence: z.enum(['high', 'medium', 'low']).default('medium'), limitations: z.string().optional(), freshness_note: z.string().optional(),
  })).min(1).max(15),
  claims: z.array(z.object({ text: z.string(), source_ids: z.array(z.number().int().min(0)).default([]), kind: z.enum(['fact', 'assumption', 'opinion']).default('fact') })).min(1),
  captions: z.object({ facebook: z.string(), instagram: z.string(), tiktok: z.string(), youtube: z.string(), twitter: z.string() }),
  sfx: z.array(z.object({ sfx: z.string(), seg: z.string(), at: z.string(), gain: z.number().min(0).max(1.2).default(0.5) })).max(14).default([]),
  music: z.string().default('playful'),
  thumbnail: z.object({ seg: z.string().optional(), title: z.string().optional() }).optional(),
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

// problems: must be fixed. warnings: shown to the owner, do not block.
export function checkDraft(d: DraftT, seen: Map<string, Seen> | null) {
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
  for (const fx of d.sfx) {
    if (!SFX[fx.sfx]) problems.push(`unknown sfx "${fx.sfx}"`);
    if (!text.has(fx.seg)) problems.push(`sfx cue refers to unknown segment ${fx.seg}`);
    else if (!normText(text.get(fx.seg)!).includes(normText(fx.at))) problems.push(`sfx ${fx.sfx}: word "${fx.at}" is not in segment ${fx.seg}`);
  }
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
  const spec = { scenes: d.scenes, text: Object.fromEntries(d.script.map((s) => [s.id, s.text])) };
  return `"""Generated episode: scenes are data rendered by engine.templates (code-drawn templates, no images)."""\nimport json\nfrom engine.templates import build_scenes\n\nSPEC = json.loads(${JSON.stringify(JSON.stringify(spec))})\nSCENES = build_scenes(SPEC)\n`;
}

export function buildPackage(topic: string, d: DraftT, research: Seen[]) {
  const byUrl = new Map(research.map((r) => [normUrl(r.url), r]));
  const cues = new Map<string, any[]>();
  for (const fx of d.sfx) {
    if (!SFX[fx.sfx]) continue;
    if (!cues.has(fx.sfx)) cues.set(fx.sfx, []);
    cues.get(fx.sfx)!.push({ seg: fx.seg, word: fx.at, n: 0, offset: 0, gain: fx.gain ?? 0.5 });
  }
  const firstLine = (sc: any) => sc.headline?.text || sc.lines?.[0]?.text || sc.question?.text || sc.statement?.text || sc.bubble?.text || '';
  const thumbSeg = d.thumbnail?.seg && d.script.some((s) => s.id === d.thumbnail!.seg) ? d.thumbnail.seg : d.script[0].id;
  return {
    topic, title_th: d.title_th.slice(0, 120), series_tag: SERIES_TAG,
    script: d.script,
    voice: { voice_id: VOICE_ID, model_id: 'eleven_v4', language_code: 'th', stability: 0.4, similarity_boost: 0.75 },
    music: { prompt: MUSIC[d.music] || MUSIC.playful, model_id: 'music_v1', volume: 0.28 },
    sfx: [...cues.entries()].map(([id, cs]) => ({ id, prompt: SFX[id].prompt, duration: SFX[id].duration, cues: cs })),
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

export function registerStudio(app: Hono, pool: pg.Pool, deps: Deps) {
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
    await pool.query("UPDATE drafts SET status='researching', model=$2, updated_at=now() WHERE id=$1", [id, MODEL]);
    await log(id, `เริ่มค้นข้อมูลด้วย Firecrawl (${MODEL})`);

    let userText = `Topic from the owner: ${row.topic}`;
    if (row.note) userText += `\nOwner's direction: ${row.note}`;
    if (parent?.draft) {
      const p = parent.draft;
      userText += `\n\nThis is a rewrite. Previous version (title "${p.title_th}"):\n${(p.script || []).map((s: any) => `[${s.id}] ${s.text}`).join('\n')}\n` +
        `Previous sources (already fetched with Firecrawl recently, you may cite them again without re-reading):\n${(p.sources || []).map((s: any) => `- ${s.url} (${s.publisher}, ${s.published})`).join('\n')}\n` +
        `Apply the owner's direction; check for newer data where it matters.`;
    }
    const messages: any[] = [{ role: 'user', content: userText }];
    const system = [{ type: 'text', text: systemPrompt(), cache_control: { type: 'ephemeral' } }];
    let submits = 0;

    for (let turn = 0; turn < MAX_TURNS; turn++) {
      usage.turns = turn + 1;
      const totalIn = usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens;
      const mustSubmit = turn >= MAX_TURNS - 2 || totalIn > MAX_INPUT_TOKENS * 0.8;
      // cache the conversation so far: each turn re-reads it at the cache price
      const msgs = JSON.parse(JSON.stringify(messages));
      const last = msgs[msgs.length - 1];
      if (typeof last.content === 'string') last.content = [{ type: 'text', text: last.content }];
      last.content[last.content.length - 1].cache_control = { type: 'ephemeral' };
      const resp = await claude({
        model: MODEL, max_tokens: 16000, system, tools: TOOLS, messages: msgs,
        ...(mustSubmit ? { tool_choice: { type: 'tool', name: 'submit_episode' } } : {}),
      });
      for (const k of ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'] as const) usage[k] += Number(resp.usage?.[k] || 0);
      messages.push({ role: 'assistant', content: resp.content });
      const uses = (resp.content || []).filter((b: any) => b.type === 'tool_use');
      if (!uses.length) {
        messages.push({ role: 'user', content: 'Continue: research with the tools if needed, then call submit_episode.' });
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
            const parsed = Draft.safeParse(u.input);
            if (!parsed.success) {
              const issues = parsed.error.issues.slice(0, 15).map((i) => `${i.path.join('.')}: ${i.message}`);
              results.push({ type: 'tool_result', tool_use_id: u.id, is_error: true, content: `Fix these and submit again:\n- ${issues.join('\n- ')}` });
              continue;
            }
            const d = parsed.data;
            const { problems, warnings } = checkDraft(d, seen);
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
            if (row.auto_produce) await produce(id).catch((e) => log(id, `ส่งผลิตอัตโนมัติไม่สำเร็จ: ${e instanceof Error ? e.message : e}`));
            return;
          } else {
            results.push({ type: 'tool_result', tool_use_id: u.id, is_error: true, content: `unknown tool ${u.name}` });
          }
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (/ANTHROPIC_API_KEY|FIRECRAWL_API_KEY/.test(msg)) throw e;
          await log(id, `เครื่องมือขัดข้อง: ${msg.slice(0, 120)}`);
          results.push({ type: 'tool_result', tool_use_id: u.id, is_error: true, content: `Tool failed: ${msg.slice(0, 300)}` });
        }
      }
      if (mustSubmit === false && usage.firecrawl_calls >= MAX_FIRECRAWL) results.push({ type: 'text', text: 'Research budget reached: write and submit now.' });
      messages.push({ role: 'user', content: results });
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
    const d = Draft.parse(row.draft);
    const research: Seen[] = row.draft.research_seen || [];
    const { problems } = checkDraft(d, null);
    const f = finalCheck(row.topic, d, research);
    const errs = [...problems.filter((p) => !SOFT.test(p)), ...f.errs];
    if (errs.length) return { status: 422, body: { error: 'draft does not pass the checks', problems: errs } };
    const r = await deps.createJob({ kind: 'episode', package: f.pkg }, `draft:${id}`);
    if (r.status >= 300) return r;
    await pool.query("UPDATE drafts SET status='submitted', job_id=$2, episode_id=$3, updated_at=now() WHERE id=$1", [id, r.body.id, r.body.episode_id ?? null]);
    await log(id, 'ส่งเข้าคิวผลิตแล้ว (เสียง → ภาพ → ตรวจ → อัปโหลด)');
    return { status: 201, body: r.body };
  }

  // drafts that were mid-generation when the process restarted cannot resume the conversation
  pool.query(`UPDATE drafts SET status='failed', error='ระบบรีสตาร์ทระหว่างเขียน กด "เขียนใหม่" เพื่อเริ่มอีกครั้ง', updated_at=now()
    WHERE status IN ('researching','writing')`).then(() => pump()).catch(() => {});

  // ---------------------------------------------------------------- routes
  const g = deps.guard;
  const isId = (s: string) => /^[0-9a-f-]{36}$/.test(s);
  const summary = (r: any) => ({
    id: r.id, topic: r.topic, note: r.note, status: r.status, title: r.draft?.title_th ?? null, angle: r.draft?.angle ?? null, created_at: r.created_at,
    updated_at: r.updated_at, estimated_credits: r.estimated_credits, job_id: r.job_id, job_status: r.job_status ?? null, job_progress: r.job_progress ?? null,
    episode_number: r.episode_number ?? null, last: (r.log || []).slice(-1)[0]?.msg ?? null, error: r.error, auto_produce: r.auto_produce,
  });

  app.get('/app/api/studio/status', g, async (c) => {
    const n = (await pool.query("SELECT count(*)::int AS n FROM drafts WHERE created_at > now() - interval '1 day'")).rows[0].n;
    return c.json({ ...configured(), model: MODEL, drafts_today: n, daily_limit: DAILY_LIMIT, busy, max_credits: DRAFT_MAX_CREDITS });
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
    if (dr) delete dr.research_seen;
    return c.json({ ...summary(r), log: r.log, draft: dr, problems: r.problems, usage: r.usage, model: r.model, job_error: r.job_error ?? null,
      research: r.research });
  });

  app.post('/app/api/studio/drafts', g, async (c) => {
    const b = await c.req.json().catch(() => ({}));
    const topic = String(b.topic || '').trim().slice(0, 400);
    if (topic.length < 4) return c.json({ error: 'พิมพ์หัวข้ออย่างน้อย 4 ตัวอักษร' }, 422);
    const cf = configured();
    if (!cf.anthropic || !cf.firecrawl) return c.json({ error: `ยังไม่ได้ตั้งค่า ${[!cf.anthropic && 'ANTHROPIC_API_KEY', !cf.firecrawl && 'FIRECRAWL_API_KEY'].filter(Boolean).join(' และ ')} ใน Railway (motion-api)` }, 503);
    const n = (await pool.query("SELECT count(*)::int AS n FROM drafts WHERE created_at > now() - interval '1 day'")).rows[0].n;
    if (n >= DAILY_LIMIT) return c.json({ error: `ครบโควตา ${DAILY_LIMIT} ร่างต่อวันแล้ว` }, 429);
    const r = await pool.query('INSERT INTO drafts (topic, note, auto_produce) VALUES ($1,$2,$3) RETURNING id',
      [topic, String(b.note || '').trim().slice(0, 1000) || null, !!b.auto_produce]);
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
    if (Array.isArray(b.script)) {
      const map = new Map(b.script.map((s: any) => [String(s.id), String(s.text || '').trim()]));
      d.script = d.script.map((s: any) => (map.has(s.id) && map.get(s.id) ? { ...s, text: map.get(s.id) } : s));
    }
    if (b.captions && typeof b.captions === 'object') for (const k of ['facebook', 'instagram', 'tiktok', 'youtube', 'twitter']) if (typeof b.captions[k] === 'string') d.captions = { ...d.captions, [k]: b.captions[k] };
    const parsed = Draft.safeParse(d);
    if (!parsed.success) return c.json({ error: 'invalid', problems: parsed.error.issues.slice(0, 10).map((i) => `${i.path.join('.')}: ${i.message}`) }, 422);
    const { problems, warnings } = checkDraft(parsed.data, null);
    // timing words that no longer appear only shift an animation to the segment start: keep them as warnings for edited text
    const hard = problems.filter((p) => !SOFT.test(p));
    const soft = problems.filter((p) => SOFT.test(p)).map((p) => p + ' (ภาพนี้จะขึ้นตามตำแหน่งโดยประมาณ)');
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
    if (!cf.anthropic || !cf.firecrawl) return c.json({ error: 'ยังไม่ได้ตั้งค่า API key ใน Railway' }, 503);
    const r = await pool.query('INSERT INTO drafts (topic, note, parent_id, auto_produce) VALUES ($1,$2,$3,$4) RETURNING id',
      [row.topic, String(b.note ?? row.note ?? '').trim().slice(0, 1000) || null, row.draft ? row.id : null, !!b.auto_produce]);
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

  return { pump };
}
