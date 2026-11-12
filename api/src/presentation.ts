import {z} from 'zod';

// EP004's proven motion-graphics vocabulary, with separately drawn story illustrations.
export const LAYOUTS = ['illustration','hook','number','compare','list','truth','chat','icons','outro'] as const;
export const Layout = z.enum(LAYOUTS);
const Word = z.string().trim().min(1).max(80);
const Text = z.string().trim().min(1).max(44);
const Line = z.object({text:Text,at:Word.optional(),color:z.string().max(20).optional()}).strict();
const TimedLine = Line.extend({at:Word});
export const Graphic = z.discriminatedUnion('type',[
  z.object({type:z.literal('illustration')}).strict(),
  z.object({type:z.literal('hook'),lines:z.array(Line).min(1).max(2)}).strict(),
  z.object({type:z.literal('number'),value:z.number().finite().min(-1e9).max(1e9),at:Word,
    prefix:z.string().max(20).optional(),suffix:z.string().max(20).optional(),label:TimedLine,
    decimals:z.number().int().min(0).max(2).optional(),duration:z.number().min(.4).max(3).optional()}).strict(),
  z.object({type:z.literal('compare'),items:z.array(z.object({label:Text,value:z.number().finite().min(0).max(1e9),at:Word,color:z.string().max(20).optional(),display:Text.optional()}).strict()).min(2).max(3)}).strict(),
  z.object({type:z.literal('list'),items:z.array(TimedLine).min(2).max(3),mark:z.enum(['number','check','cross']).optional()}).strict(),
  z.object({type:z.literal('truth'),statement:TimedLine,verdict:z.boolean(),verdict_text:Text,verdict_at:Word}).strict(),
  z.object({type:z.literal('chat'),title:Text,messages:z.array(TimedLine.extend({from:z.enum(['left','right'])})).min(2).max(3)}).strict(),
  z.object({type:z.literal('icons'),items:z.array(z.object({icon:z.string().min(1).max(30),label:Text,at:Word}).strict()).min(2).max(3)}).strict(),
  z.object({type:z.literal('outro'),lines:z.array(TimedLine).min(1).max(2),icon_at:Word}).strict(),
]);

export const presentationVersion = (value:unknown):0|1 => value === 1 ? 1 : 0;
export function withPresentationPolicy<T extends Record<string,any>>(plan:T,version:0|1):T {
  const result={...plan}; delete result.presentation_version;
  return version ? {...result,presentation_version:1} : result;
}

export function presentationSceneProblems(shot:{seg:string;layout?:string},scene:Record<string,any>,enabled:boolean):string[] {
  if(!enabled)return [];
  const parsed=Graphic.safeParse(scene.graphic);
  if(!parsed.success)return [`presentation ${shot.seg}: provide graphic matching layout ${shot.layout}: ${parsed.error.issues.map(x=>x.path.join('.')+' '+x.message).join('; ')}`];
  const errors:string[]=[];
  if(parsed.data.type!==shot.layout)errors.push(`presentation ${shot.seg}: graphic.type must match the saved layout ${shot.layout}`);
  if(!['hook','outro'].includes(parsed.data.type) && !Line.safeParse(scene.headline).success)errors.push(`presentation ${shot.seg}: provide a short headline object; use the engine's large Kanit title, not small c.text headings`);
  return errors;
}

export function presentationPrompt():string {
  return `## Classic motion graphics — the owner's EP004 reference
Restore the presentation of "คนชื่อแมน มีกี่คน แล้วแมนจริงนับยังไง?": bold Kanit headings, thick clean outlines, big readable cards/numbers, bouncy word-timed reveals, stamp reactions, sliding lists, chat bubbles and the existing iris scene transitions. The renderer supplies this typography and animation; do not recreate headings with small c.text. Keep the existing highlighted subtitles. This is a presentation system, not a compulsory cat, cast, location or topic.
Plan each shot.layout from: illustration, hook, number, compare, list, truth, chat, icons, outro. Across the clip use at least 3 different layouts, including illustration for the concrete story examples. Do not repeat a graphic layout in adjacent shots. Prefer 6–8 shots, with a new visual idea/reveal roughly every 3–5 seconds. Maintain one understandable story while varying location, framing and screen composition. Word-timed number counting, a sliding evidence card, a stamped correction or a diagram transformation can be a meaningful motion beat when it explains the spoken idea. Avoid requiring complex full-body acting in every shot.
Every scene remains type:custom with code drawing THIS story's actors, animals, props or actual examples. It also has graphic:{type:shot.layout,...}. For illustration, draw the main example big in y=500..1360 with a regular headline above. For graphic layouts the graphics occupy y=480..1250; draw supporting story art in the lower corners (head near y=1200, size around 80–110) without covering cards or subtitles. The opening hook uses 1–2 large lines at y=480..800; put the named hero or actual topic illustration below (head near y=950, size=240 for a name story), fully visible at video time zero. Do not introduce a stock mascot. Large demonstrations and examples belong in illustration shots rather than being squeezed under a card.
Use scene.set (city, room, classroom, park, beach, office, night, brick, kitchen) when relevant, with varied scene.bg palettes, or draw a new story-specific background in illustration shots. If using a set, do not paint over it with c.grad. Do not use the same room/composition throughout. Text must stay legible on a phone: use headline:{text,at?} for every layout except hook/outro, optional sub:{text,at,color}, and short labels only inside the drawing. Never repeat a headline inside code.
Graphic fields (all at/verdict_at/icon_at are exact narration phrases; no fabricated numbers or claims):
- illustration: {type:"illustration"}; the bespoke illustration carries the explanation.
- hook: {type:"hook",lines:[{text,at?,color?}]} (1–2 lines, first line already visible at frame zero).
- number: {type:"number",value,at,prefix?,suffix?,label:{text,at},decimals?,duration?}; value must be supported by this story, never invent statistics to fill a layout.
- compare: {type:"compare",items:[{label,value,at,color?,display?}]} (2–3 items with supported numeric values).
- list: {type:"list",items:[{text,at}],mark:"number"|"check"|"cross"} (2–3 short items).
- truth: {type:"truth",statement:{text,at},verdict:boolean,verdict_text,verdict_at}; use a qualified correction when the evidence is uncertain.
- chat: {type:"chat",title,messages:[{text,at,from:"left"|"right"}]} (2–3 messages); label invented dialogue as an example, not a quotation from a source.
- icons: {type:"icons",items:[{icon,label,at}]} (2–3 supported icon ids; actual examples still need bespoke illustrations).
- outro: {type:"outro",lines:[{text,at}],icon_at} (1–2 lines).
Keep graphic text concise (at most 44 characters per item). These graphic objects have only the listed fields; headline/sub/set/bg live on the scene. Reuse the original engine's fonts, card animation and transitions. Preview review must check large readable text, clear information hierarchy, no overlaps, varied layouts, and drawings of the storyboard examples. Repair only the offending scene.`;
}
