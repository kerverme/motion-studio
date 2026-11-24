/* A separate product flow: plan -> review -> explicit price approval -> production. */
let TV_CONFIG=null;
const TV_PATH='/app/api/text-video';
const tvTime=n=>Math.floor(n/60)+':'+String(n%60).padStart(2,'0');
const tvUsd=n=>'$'+(Math.max(0,Math.ceil((Number(n)-1e-10)*100))/100).toFixed(2)+' USD';
const tvState=p=>p.job_status==='CANCELLED'?'ยกเลิกการผลิตแล้ว':p.job_status==='FAILED'?'ผลิตไม่สำเร็จ · ตรวจราคาซ่อมเฉพาะส่วน':p.status==='done'?'พร้อมใช้':({queued:'รอสมอง',planning:'กำลังวางบท',ready:'รอตรวจบทและยืนยันราคา',failed:'วางบทไม่สำเร็จ',producing:'กำลังผลิต'})[p.status]||p.status;
function tvField(label,input,help){return h('label',{class:'tv-field'},h('span',{},label),input,help?h('small',{class:'sub'},help):null);}
function tvModelSelect(value){return h('select',{'aria-label':'โมเดลวิดีโอ fal.ai'},TV_CONFIG.models.map(m=>h('option',{value:m.id,selected:m.id===value},m.label)));}
function tvResolutionSelect(model,value){return h('select',{'aria-label':'ความละเอียดวิดีโอ'},TV_CONFIG.models.find(m=>m.id===model).resolutions.map(r=>h('option',{value:r,selected:r===value},r)));}
function renderTextVideo(cfg,plans){
  TV_CONFIG=cfg;
  const topic=h('textarea',{rows:3,minlength:3,maxlength:400,required:true,'aria-label':'หัวข้อ Text to Video',placeholder:'อยากเล่าเรื่องอะไร?'});
  const source=h('textarea',{rows:5,maxlength:100000,'aria-label':'เนื้อหาอ้างอิง Text to Video',placeholder:'วางบทความ ข้อมูลจาก NotebookLM หรือลิงก์ต้นฉบับ (ไม่บังคับ)'});
  const note=h('textarea',{rows:2,maxlength:2000,'aria-label':'แนวภาพและรายละเอียดเพิ่มเติม',placeholder:'เช่น การ์ตูนอบอุ่น เล่าผ่านเหตุการณ์เดียว ตัวละครตามเนื้อเรื่อง'});
  const {modelSel:brain,effSel,notice:brainNotice,refreshBtn:refreshModels}=brainControls(
    cfg.brains.map(id=>({id,label:generationModelLabel(id)})),cfg.default_brain,cfg.reasoning_levels,cfg.default_reasoning,
    cfg.model_catalog,'สมอง Text to Video','Reasoning Text to Video');
  const route=tvSelect('วิธีเลือกโมเดล',TV_ROUTES,'best_value');
  const budget=h('input',{type:'number',min:0.01,step:0.01,max:10000,value:5,required:true,'aria-label':'งบผลิต USD'});
  const resolution=tvSelect('ความละเอียดที่ต้องการ',['720p'],'720p');
  const duration=h('select',{'aria-label':'ความยาวคลิป Text to Video'},cfg.durations.map(n=>h('option',{value:n},n===60?'1 นาที':n===90?'1 นาที 30 วินาที':'2 นาที')));
  const manual=h('select',{'aria-label':'เลือกโมเดลด้วยตัวเอง'});
  const manualBox=tvField('โมเดลที่เลือก',manual);manualBox.hidden=true;
  const resolutionNote=h('small',{class:'sub'});
  function updateResolutions(){
    const models=(tvLatestArena?.categories||[]).flatMap(board=>(board.models||[]).flatMap(m=>[m.fal_error?null:m.fal,m.video_to_video_error?null:m.video_to_video])).filter(m=>m?.available);
    const subset=route.value==='manual'&&manual.value?models.filter(m=>m.endpoint_id===manual.value):models;
    const wanted=resolution.value||'720p',supported=[...new Set(subset.flatMap(m=>m.resolutions||[]).map(r=>r.toLowerCase()))];
    const values=[...new Set(['720p',...supported,wanted])].sort((a,b)=>parseInt(a)-parseInt(b));
    put(resolution,values.map(r=>h('option',{value:r,selected:r===wanted},r)));
    resolutionNote.textContent=subset.length&&!supported.includes(wanted)?'รุ่นที่เลือกไม่รองรับ '+wanted+' กรุณาเลือกความละเอียดอื่นก่อนวางแผน':'';
  }
  route.addEventListener('change',()=>{manualBox.hidden=route.value!=='manual';manual.required=!manualBox.hidden;updateResolutions();});
  manual.addEventListener('change',updateResolutions);resolution.addEventListener('change',updateResolutions);
  const arena=tvArenaPanel(info=>{
    const previous=manual.value,choices=tvArenaOptions(info);
    put(manual,h('option',{value:''},'เลือกโมเดล'),choices);
    if([...manual.options].some(o=>o.value===previous&&!o.disabled))manual.value=previous;updateResolutions();
  },endpoint=>{route.value='manual';route.dispatchEvent(new Event('change'));manual.value=endpoint;updateResolutions();manual.focus();});
  const style=h('select',{'aria-label':'สไตล์เล่า Text to Video'},cfg.narration_styles.map(s=>h('option',{value:s.id},s.label)));
  const custom=h('textarea',{class:'tv-custom',rows:2,maxlength:1000,'aria-label':'สไตล์เล่าที่กำหนดเอง Text to Video',placeholder:'อธิบายสไตล์ที่ต้องการ',hidden:true});style.addEventListener('change',()=>custom.hidden=style.value!=='custom');
  const err=h('div',{class:'err',role:'alert'});
  const create=h('button',{class:'btn primary',disabled:!cfg.openai_configured,type:'submit'},'ให้สมองวางบทและแบ่งช็อต');
  const form=h('form',{class:'tv-panel tv-form',on:{submit:async e=>{e.preventDefault();create.disabled=true;err.textContent='';try{
    if(resolutionNote.textContent)throw Error(resolutionNote.textContent);
    const r=await draftPost(TV_PATH+'/plans',{topic:topic.value,source_text:source.value,note:note.value,model:brain.value,reasoning:effSel.value,engine_version:2,routing_mode:route.value,budget_usd:Number(budget.value),...(route.value==='manual'?{manual_endpoint:manual.value}:{}),resolution:resolution.value,duration:Number(duration.value),narration_style:style.value,narration_custom:style.value==='custom'?custom.value:''});openTextVideo(r.id);
  }catch(x){err.textContent=x.message;}finally{create.disabled=!cfg.openai_configured;}}}},
    tvField('เรื่องที่อยากเล่า',topic),
    h('div',{class:'tv-grid'},tvField('วิธีเลือกโมเดล',route),tvField('งบประมาณต่อคลิป (USD)',budget)),manualBox,
    h('div',{class:'tv-grid'},tvField('ความยาวสูงสุด',duration),tvField('ความละเอียด',resolution,resolutionNote)),
    h('details',{class:'tv-fold'},h('summary',{},'เนื้อหาอ้างอิงและแนวทางการเล่า'),h('div',{class:'tv-stack'},
      tvField('เนื้อหาหรือลิงก์อ้างอิง',source),tvField('สไตล์การเล่า',style),custom,tvField('กำกับภาพและเสียงเพิ่มเติม',note))),
    h('details',{class:'tv-fold'},h('summary',{},'สมองวางแผน · '+generationModelLabel(brain.value)),h('div',{class:'tv-stack'},h('div',{class:'tv-grid'},tvField('สมอง OpenAI',brain),tvField('ระดับการคิด',effSel)),h('div',{class:'catalog-line'},brainNotice,refreshModels))),
    h('div',{class:'tv-actions'},create,h('small',{class:'sub'},'ขั้นนี้ใช้ OpenAI วางแผน คุณจะเห็นราคาและยืนยันก่อนผลิตวิดีโอและเสียง')),err);
  const brainHeading=form.querySelectorAll('.tv-fold summary')[1];brain.addEventListener('change',()=>brainHeading.textContent='สมองวางแผน · '+generationModelLabel(brain.value));
  put(mainEl,h('h1',{},'Text to Video'),h('p',{class:'lede'},'วางบท เลือกโมเดลรายฉาก และตรวจราคาก่อนผลิต'),
    form,arena,h('section',{id:'tv-plans',class:'drafts'}),tvHistoryPanel());
  renderTextVideoList(plans);
}
function renderTextVideoList(plans){const el=document.getElementById('tv-plans');if(!el)return;put(el,h('h2',{},'บทและคลิป Text to Video'),plans.length?plans.map(p=>h('button',{class:'btn',style:'display:block;width:100%;text-align:left;margin:10px 0',on:{click:()=>openTextVideo(p.id)}},
  h('b',{},p.plan?.title||p.request.topic),h('div',{class:'sub'},tvState(p)+' · '+tvTime(p.request.duration)+' · '+generationModelLabel(p.request.model)+' · '+(p.request.engine_version===2?(TV_ROUTES[p.request.routing_mode]||'แผนรายฉาก'):(TV_CONFIG?.models?.find(m=>m.id===p.request.video_model)?.label||p.request.video_model||'วิดีโอ'))))):h('p',{class:'sub'},'ยังไม่มีบท เริ่มจากหัวข้อด้านบน'));}
function openTextVideo(id,repairProposal){
  drawer(({body,titleEl,close})=>{
    body.classList.add('tv-review');
    let timer,closed=false,dirty=false;
    const observer=new MutationObserver(()=>{if(!body.isConnected){closed=true;clearTimeout(timer);observer.disconnect();}});observer.observe(document.body,{childList:true,subtree:true});
    async function refresh(){
      if(closed)return;
      try{const p=await api(TV_PATH+'/plans/'+id);if(closed)return;if(!TV_CONFIG)TV_CONFIG=await api(TV_PATH+'/config');if(closed)return;titleEl.textContent='Text to Video · '+tvState(p);dirty=false;
        const error=h('div',{class:'err',role:'alert'},p.error||p.job_error||'');
        if(!p.plan){put(body,h('h2',{},p.request.topic),h('p',{},[p.progress||tvState(p),tvElapsed(p.created_at)].filter(Boolean).join(' · ')),error,p.status==='failed'?h('button',{class:'btn',on:{click:async()=>{try{await api(TV_PATH+'/plans/'+id+'/resume',{method:'POST',body:'{}'});refresh();}catch(x){error.textContent=x.message;}}}},'ตรวจคำตอบ OpenAI เดิมอีกครั้ง'):null);}
        else if(p.request.engine_version===2){
          if(!tvLatestArena)tvLatestArena=await api(TV_ARENA).catch(()=>null);
          if(closed)return;tvProductionReview(p,body,refresh,repairProposal);
        }else{
          const editable=!p.job_id&&p.status==='ready',data=structuredClone(p.plan);
          const title=h('input',{value:data.title,maxlength:120,'aria-label':'ชื่อคลิป Text to Video',disabled:!editable});
          const bible=h('textarea',{rows:4,maxlength:2000,'aria-label':'รายละเอียดภาพต่อเนื่อง',disabled:!editable},data.visual_bible);
          const videoModel=tvModelSelect(p.request.video_model);videoModel.disabled=!editable;
          let resolution=tvResolutionSelect(videoModel.value,p.request.resolution);resolution.disabled=!editable;
          const resBox=h('div',{},resolution);
          const priceBox=h('div',{'data-tv-pricing':true});const markDirty=()=>{dirty=true;put(priceBox,h('p',{class:'tv-notice'},'บทหรือการตั้งค่าเปลี่ยนแล้ว ต้องบันทึกและตรวจราคาใหม่'));};
          videoModel.addEventListener('change',()=>{resolution=tvResolutionSelect(videoModel.value,videoModel.value==='h3_max'?'768P':'720p');resolution.addEventListener('change',markDirty);put(resBox,resolution);markDirty();});resolution.addEventListener('change',markDirty);
          title.addEventListener('input',markDirty);bible.addEventListener('input',markDirty);
          const shots=data.shots.map((s,i)=>{
            const narration=h('textarea',{rows:3,maxlength:165,'aria-label':`บทพูดช็อต ${i+1}`,disabled:!editable},s.narration);
            const prompt=h('textarea',{rows:4,maxlength:2400,'aria-label':`ภาพช็อต ${i+1}`,disabled:!editable},s.visual_prompt);
            const end=h('textarea',{rows:2,maxlength:800,'aria-label':`เฟรมท้ายช็อต ${i+1}`,disabled:!editable},s.end_frame);
            for(const field of [narration,prompt,end])field.addEventListener('input',markDirty);
            return {narration,prompt,end,node:h('section',{class:'tv-panel',style:'margin:16px 0'},h('h3',{},`ช็อต ${i+1} · ${tvTime(i*15)}–${tvTime((i+1)*15)}`),tvField('บทพูดภาษาไทย',narration),tvField('ภาพและการเคลื่อนไหว',prompt),tvField('เฟรมส่งต่อไปช็อตถัดไป',end))};
          });
          const collect=()=>({...data,title:title.value,visual_bible:bible.value,shots:data.shots.map((s,i)=>({...s,narration:shots[i].narration.value,visual_prompt:shots[i].prompt.value,end_frame:shots[i].end.value}))});
          let revision=p.revision;
          const save=async()=>{const result=await api(TV_PATH+'/plans/'+id,{method:'PATCH',body:JSON.stringify({revision,plan:collect(),video_model:videoModel.value,resolution:resolution.value})});revision=result.revision;dirty=false;return result;};
          const rate=h('input',{type:'number',min:0,max:100,step:'any',value:p.quote?.eleven_usd_per_1000_characters??TV_CONFIG.eleven_pricing?.usd_per_1000_characters??'',placeholder:'ใส่อัตรา API ของบัญชีคุณ','aria-label':'ราคา ElevenLabs USD ต่อ 1000 ตัวอักษร'});
          rate.addEventListener('input',()=>put(priceBox,h('p',{class:'tv-notice'},'อัตราค่าเสียงเปลี่ยนแล้ว กรุณาตรวจราคาใหม่')));
          const getQuote=h('button',{class:'btn primary',on:{click:async()=>{getQuote.disabled=true;error.textContent='';try{
            if(rate.value==='')throw new Error('ใส่อัตรา API USD ต่อ 1,000 ตัวอักษรของ ElevenLabs ก่อน');
            if(dirty)await save();const q=await api(TV_PATH+'/plans/'+id+'/quote',{method:'POST',body:JSON.stringify({eleven_usd_per_1000_characters:Number(rate.value)})});showQuote(q);
          }catch(x){error.textContent=x.message;}finally{getQuote.disabled=false;}}}},p.job_id?'ตรวจราคาซ่อมเฉพาะส่วน':'ตรวจราคาก่อนผลิต');
          function showQuote(q){
            const confirm=h('input',{type:'checkbox','aria-label':'ยืนยันบทและค่าใช้จ่าย Text to Video'});
            const send=h('button',{class:'btn primary',disabled:true,on:{click:async()=>{send.disabled=true;error.textContent='';try{
              if(dirty||!confirm.checked)throw new Error('ต้องตรวจบทและยืนยันราคาใหม่');
              await api(TV_PATH+'/plans/'+id+'/produce',{method:'POST',body:JSON.stringify({approved:true,quote_id:q.id,revision,confirmation:'CONFIRM '+q.id})});toast('ส่งเข้าคิวผลิตแล้ว โดยปิดการโพสต์อัตโนมัติ');refresh();
            }catch(x){error.textContent=x.message;send.disabled=false;}}}},'ยืนยันราคาและส่งผลิตจริง');
            confirm.addEventListener('change',()=>send.disabled=!confirm.checked||dirty||Date.now()>Date.parse(q.expires_at));
            put(priceBox,h('section',{class:'tv-panel tv-price',style:'margin-top:18px'},h('h3',{},'สรุปค่าใช้จ่ายก่อนผลิต'),
              h('p',{},`fal.ai: ${tvUsd(q.fal_usd)} · ${q.fal.length} ช็อตที่ยังต้องสร้าง`),
              h('p',{},`ElevenLabs: ${tvUsd(q.eleven_usd)} · ${q.eleven_characters.toLocaleString()} ตัวอักษร (คิดเผื่อ ${q.eleven_budget_characters.toLocaleString()})`),
              h('strong',{},'รวมประมาณ '+tvUsd(q.total_usd)),h('p',{class:'sub'},q.note+' · ยอดแสดงปัดขึ้นถึงเซนต์'),h('a',{href:q.pricing_source,target:'_blank',rel:'noopener'},'ดูราคาต้นทาง fal.ai'),h('a',{href:q.eleven_pricing_source,target:'_blank',rel:'noopener'},'ดูราคา API ของ ElevenLabs'),
              h('p',{class:'sub'},'ราคานี้ใช้ได้ถึง '+new Date(q.expires_at).toLocaleTimeString('th-TH')+' · การแก้บทหรือโมเดลจะยกเลิกราคานี้'),
              h('label',{style:'display:block;margin:16px 0'},confirm,' ฉันตรวจบทและยืนยันค่าใช้จ่ายตามรายการนี้แล้ว'),send));
          }
          const canQuote=editable||p.job_status==='FAILED';
          put(body,tvField('ชื่อคลิป',title),h('p',{},p.plan.synopsis),h('p',{class:'sub'},`${tvTime(p.request.duration)} · สมอง ${generationModelLabel(p.request.model)}`),
            h('div',{class:'tv-grid'},tvField('โมเดล fal.ai',videoModel),tvField('ความละเอียด',resBox)),tvField('ลักษณะภาพและตัวละครที่ใช้ต่อเนื่อง',bible),
            h('details',{},h('summary',{},'แหล่งข้อมูล '+p.plan.sources.length+' แห่ง'),p.plan.sources.map(s=>h('p',{},h('a',{href:s.url,target:'_blank',rel:'noopener'},s.title),h('small',{class:'sub'},' · '+s.publisher+' · '+s.published)))),
            shots.map(s=>s.node),editable?h('button',{class:'btn',on:{click:async()=>{try{await save();toast('บันทึกบทแล้ว ต้องตรวจราคาใหม่');refresh();}catch(x){error.textContent=x.message;}}}},'บันทึกการแก้บท'):null,
            error,canQuote?h('section',{class:'tv-panel'},tvField('ราคา API ของ ElevenLabs ต่อ 1,000 ตัวอักษร (USD)',rate,'ค่าเริ่มต้นเป็นราคาสาธารณะของ Eleven v3 ตรวจเมื่อ '+(TV_CONFIG.eleven_pricing?.verified||'')+' ปรับได้หากบัญชีหรือแพ็กเกจของคุณใช้อัตราต่างกัน หากรวมในโควตาและไม่มีค่าใช้จ่ายเพิ่มให้ระบุ 0'),getQuote,priceBox):
              h('p',{class:'tv-notice'},p.job_status==='CANCELLED'?'ยกเลิกการผลิตแล้ว · ไม่มีการส่งคำขอเสียเงินเพิ่ม':p.status==='done'?`คลิปพร้อมใช้แล้ว${p.episode_number?' · EP'+String(p.episode_number).padStart(3,'0'):''}`:'กำลังผลิต · ดูสถานะได้ที่ “กำลังทำ” ไม่มีการโพสต์อัตโนมัติ'));
          if(canQuote&&p.quote&&!p.approval&&Date.now()<Date.parse(p.quote.expires_at)){
            if(p.quote.eleven_billing_unit==='characters')showQuote(p.quote);
            else put(priceBox,h('p',{class:'tv-notice'},'ราคาเดิมใช้หน่วยเครดิต กรุณาตรวจราคา API ต่อตัวอักษรใหม่ก่อนยืนยัน'));
          }
        }
        if(['queued','planning'].includes(p.status)||(p.status==='producing'&&p.request.engine_version!==2&&!['FAILED','CANCELLED'].includes(p.job_status)))timer=setTimeout(refresh,5000);
      }catch(x){if(!closed)put(body,h('p',{class:'err'},x.message));}
    }
    refresh();
  },true);
}
setInterval(()=>{if(typeof S!=='undefined'&&S.view==='text_video'&&!document.querySelector('.drawer')&&!document.hidden)api(TV_PATH+'/plans').then(r=>renderTextVideoList(r.plans)).catch(()=>{});},5000);

const TV_ROUTES={best_value:'อัตโนมัติ · คุ้มค่า',best_quality:'อัตโนมัติ · คุณภาพสูงสุด',within_budget:'อัตโนมัติ · ภายในงบ',manual:'เลือกเอง'};
const TV_CATEGORIES={'text-to-video':'ข้อความเป็นวิดีโอ','image-to-video':'ภาพเป็นวิดีโอ','video-editing':'ตัดต่อวิดีโอ','video-to-video':'วิดีโอเป็นวิดีโอ'};
const TV_ARENA='/app/api/video-intelligence/arena';
let tvLatestArena=null;
function tvSelect(label,entries,value){
  const items=Array.isArray(entries)?entries.map(v=>[v,v]):Object.entries(entries);
  return h('select',{'aria-label':label},items.map(([id,text])=>h('option',{value:id,selected:String(value)===String(id)},text)));
}
const tvDate=v=>v&&Number.isFinite(Date.parse(v))?new Intl.DateTimeFormat('th-TH',{dateStyle:'short',timeStyle:'short',timeZone:'Asia/Bangkok'}).format(new Date(v)):'';
const tvElapsed=v=>{const sec=Math.floor((Date.now()-Date.parse(v))/1000);return Number.isFinite(sec)&&sec>=0?'เวลาผ่านไป '+(sec<60?sec+' วินาที':Math.floor(sec/60)+' นาที'):'';};
const tvPrice=n=>n!=null&&Number.isFinite(Number(n))?'$'+Number(n).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:4})+' USD':'ยังไม่มีราคาที่ยืนยัน';
function tvLink(url,label){
  try{const u=new URL(url);if(u.protocol==='https:')return h('a',{href:u.href,target:'_blank',rel:'noopener noreferrer'},label);}catch{}
  return null;
}
function tvArenaOptions(info){
  const groups=(info?.categories||[]).map(c=>h('optgroup',{label:TV_CATEGORIES[c.category]||c.category},
    (c.models||[]).map(m=>h('option',{value:m.fal?.endpoint_id||'',disabled:!m.fal?.available||!!m.fal_error||c.stale},'#'+m.rank+' '+m.name+(m.fal_error?' · รอตรวจ fal.ai':!m.fal?.available?' · ยังสร้างไม่ได้':c.stale?' · รอรีเฟรช':'')))));
  const alternates=new Map();
  for(const board of info?.categories||[])for(const m of board.models||[])if(!board.stale&&!m.video_to_video_error&&m.video_to_video?.available)alternates.set(m.video_to_video.endpoint_id,m.video_to_video);
  if(alternates.size)groups.push(h('optgroup',{label:'วิดีโอเป็นวิดีโอ · เลือกเอง'},[...alternates.values()].map(m=>h('option',{value:m.endpoint_id},m.name+' · '+m.endpoint_id))));
  return groups;
}
function tvArenaPanel(onSync,onSelect){
  let active='text-to-video',inFlight=false;
  const list=h('div',{class:'tv-ranks'}),tabs=h('div',{class:'tv-tabs','aria-label':'ประเภท Arena'}),state=h('small',{class:'sub',role:'status'}),source=h('div',{class:'tv-catalog-meta'}),err=h('div',{class:'err',role:'alert'});
  const refresh=h('button',{class:'btn',type:'button',on:{click:()=>sync(true)}},'รีเฟรชอันดับ');
  const panel=h('section',{class:'tv-panel tv-arena','aria-label':'Arena Top 10'},h('div',{class:'tv-actions'},h('h2',{},'Arena Top 10'),refresh),tabs,state,err,source,list);
  function render(){
    const cat=tvLatestArena?.categories?.find(v=>v.category===active);
    put(tabs,['text-to-video','image-to-video','video-editing'].map(id=>h('button',{type:'button',class:'btn','aria-pressed':String(id===active),on:{click:()=>{active=id;render();}}},TV_CATEGORIES[id])));
    const stamp=cat?.last_success_at;
    put(source,tvLink(cat?.source_url,'ดูอันดับบน Arena'),stamp?h('small',{class:'sub'},'ซิงก์ล่าสุด '+tvDate(stamp)+' (กรุงเทพฯ)'):null,cat?.source_updated_at?h('small',{class:'sub'},'Arena อัปเดต '+String(cat.source_updated_at).slice(0,10)):null);
    const rows=cat?.models||[];
    put(list,cat?.stale||cat?.error?h('p',{class:'tv-notice'},[rows.length?'กำลังแสดงอันดับที่บันทึกไว้':'ยังยืนยันอันดับปัจจุบันไม่ได้',cat.error].filter(Boolean).join(' · ')):null,
      cat?.registry_partial&&!cat.stale?h('p',{class:'tv-notice',role:'status'},'อันดับ Arena อัปเดตแล้ว แต่ยังตรวจข้อมูล fal.ai ของบางรุ่นไม่ได้ เลือกรุ่นที่ตรวจผ่านได้'):null,
      rows.map(m=>{
        const f=m.fal,price=f?.price;
        return h('details',{class:'tv-rank'},h('summary',{},h('span',{class:'tv-num'},'#'+m.rank),h('span',{},h('b',{},m.name),h('small',{class:'sub'},m.provider||'ไม่ระบุผู้พัฒนา')),h('span',{class:'sub'},m.elo==null?'':'Elo '+Number(m.elo).toLocaleString('th-TH',{maximumFractionDigits:1})),h('span',{class:'tv-availability'},m.fal_error?'รอตรวจ fal.ai':f?.available?'ใช้กับ fal.ai ได้':'ยังสร้างไม่ได้')),
          h('div',{class:'tv-rank-info'},h('span',{},'ความละเอียด · '+(f?.resolutions?.join(', ')||'ยังไม่ทราบ')),h('span',{},'ความยาว · '+(f?.durations?.length?f.durations.join(', ')+' วินาที':'ยังไม่ทราบ')),
          h('span',{},'เสียงในตัว · '+(f?.audio===true?'รองรับ':f?.audio===false?'ไม่รองรับ':'ยังไม่ทราบ')),h('span',{},price?'ราคาฐาน '+[price.unit_price,price.currency,'/',price.unit].join(' '):'ราคายังไม่ยืนยัน'),f?.pricing_description?h('span',{},f.pricing_description):null,f?.billing?.rates?h('span',{},Object.entries(f.billing.rates).map(([res,usd])=>(res==='*'?'ทุกความละเอียด':res)+' · '+usd+(f.billing.basis==='per_request'?' USD ต่อวิดีโอ':' USD ต่อวินาที')).join(' / ')):null,f?.billing?.source_second_usd?h('small',{class:'sub'},'วิดีโอต้นฉบับ '+f.billing.source_second_usd+' USD ต่อวินาที'):null,f?.billing?.reference_image_usd?h('small',{class:'sub'},'ภาพอ้างอิง '+f.billing.reference_image_usd+' USD'):null,f?.reason?h('span',{class:'sub'},f.reason):null,m.fal_error?h('small',{class:'tv-notice'},'ตรวจโมเดลบน fal.ai ไม่สำเร็จ · '+m.fal_error):null,m.video_to_video_error?h('small',{class:'tv-notice'},'ตรวจรุ่นวิดีโอเป็นวิดีโอไม่สำเร็จ · '+m.video_to_video_error):null,h('button',{class:'btn',type:'button',disabled:!f?.available||!!m.fal_error||cat.stale,on:{click:()=>onSelect(f.endpoint_id)}},'เลือก '+m.name),tvLink(f?.source_url,'ดูโมเดลบน fal.ai'),f?.checked_at?h('small',{class:'sub'},'ตรวจ fal.ai '+tvDate(f.checked_at)):null));
      }),!rows.length&&!inFlight&&!cat?.error?h('span',{class:'sub'},'ยังไม่มีอันดับที่ยืนยันได้สำหรับประเภทนี้'):null);
  }
  async function sync(force){
    if(inFlight)return;
    inFlight=true;refresh.disabled=true;err.textContent='';state.textContent=force?'กำลังตรวจอันดับกับ Arena และตรวจโมเดลกับ fal.ai…':'กำลังโหลดอันดับ…';
    try{
      let data=await api(TV_ARENA+(force?'/refresh':''),force?{method:'POST',body:'{}'}:{});
      while(true){
        if(!panel.isConnected)return;
        tvLatestArena=data;render();onSync(data);
        if(!data.refreshing)break;
        state.textContent='กำลังซิงก์อันดับ ความสามารถ และราคา…';
        await new Promise(resolve=>setTimeout(resolve,3000));if(!panel.isConnected)return;data=await api(TV_ARENA);
      }
      state.textContent='';
    }catch(x){err.textContent=x.message;state.textContent=tvLatestArena?'แสดงข้อมูลที่โหลดไว้ก่อนหน้า':'';}
    finally{inFlight=false;refresh.disabled=false;if(panel.isConnected)render();}
  }
  render();setTimeout(()=>{if(panel.isConnected)void sync(false);},0);return panel;
}

const tvFlatText=value=>Array.isArray(value)?value.map(tvFlatText).filter(Boolean).join(' · '):value&&typeof value==='object'?Object.values(value).map(tvFlatText).filter(Boolean).join(' · '):value==null?'':String(value);
function tvEvidence(plan){
  const story=plan.story_bible||plan.visual_bible;
  return h('details',{class:'tv-fold'},h('summary',{},'ข้อมูลกำกับภาพและแหล่งอ้างอิง'),h('div',{class:'tv-stack'},
    story?h('p',{},tvFlatText(story)):null,
    (plan.sources||[]).map(s=>{const evidence=(plan.evidence||[]).find(e=>e.url===s.url);return h('div',{},tvLink(s.url,s.title||s.url),h('p',{},s.claim||''),h('small',{class:'sub'},[s.publisher,s.published,evidence?.method,evidence?.checked_at?tvDate(evidence.checked_at):null].filter(Boolean).join(' · ')));})));
}
function tvJsonEditor(label,value,editable){
  const field=h('textarea',{rows:8,spellcheck:false,disabled:!editable,'aria-label':label},JSON.stringify(value||{},null,2));
  const read=()=>{try{return JSON.parse(field.value);}catch{throw Error(label+' มี JSON ไม่สมบูรณ์ กรุณาตรวจวงเล็บและเครื่องหมายคำพูด');}};
  return {field,read,node:h('details',{class:'tv-fold'},h('summary',{},label),tvField('ข้อมูล JSON',field))};
}
function tvSceneEditor(shot,index,editable,changed){
  const spec=shot.production||(shot.production={});
  const categories=tvLatestArena?.categories||[],options=tvArenaOptions(tvLatestArena);
  const endpoint=h('select',{'aria-label':'โมเดลฉาก '+(index+1)},h('option',{value:''},'เลือกโมเดล'),options);
  if(spec.endpoint_id&&![...endpoint.options].some(o=>o.value===spec.endpoint_id))endpoint.append(h('option',{value:spec.endpoint_id},spec.endpoint_id));
  endpoint.value=spec.endpoint_id||'';
  const mode=tvSelect('รูปแบบพรอมป์ฉาก '+(index+1),{optimized:'ปรับให้เหมาะกับโมเดล',original:'ใช้ข้อความต้นฉบับ',manual:'แก้ข้อความเอง'},spec.prompt_mode||'optimized');
  const original=h('textarea',{rows:3,maxlength:10000,'aria-label':'พรอมป์ต้นฉบับฉาก '+(index+1)},spec.original_prompt||shot.visual_prompt||'');
  const prompt=h('textarea',{rows:4,maxlength:20000,'aria-label':'พรอมป์ที่จะส่งฉาก '+(index+1)},spec.prompt||shot.visual_prompt||'');
  const direction=tvJsonEditor('แก้รายละเอียดกำกับฉาก '+(index+1),shot.direction,editable);
  const endFrame=h('textarea',{rows:2,minlength:10,maxlength:800,'aria-label':'เฟรมท้ายฉาก '+(index+1)},shot.end_frame||'');
  const initialVisual=h('textarea',{rows:3,minlength:30,maxlength:2400,'aria-label':'ภาพในสตอรีบอร์ดฉาก '+(index+1)},shot.visual_prompt||'');
  const spoken=h('textarea',{rows:2,maxlength:400,required:true,'aria-label':'บทพูดฉาก '+(index+1)},shot.narration||'');
  const duration=h('select',{'aria-label':'ความยาวที่สร้างฉาก '+(index+1)}),resolution=h('select',{'aria-label':'ความละเอียดฉาก '+(index+1)});
  const edited=h('input',{type:'number',min:0.1,step:'any',value:spec.edited_duration||spec.duration||'',required:true,'aria-label':'ความยาวหลังตัดฉาก '+(index+1)});
  const quantity=h('input',{type:'number',min:1,max:4,step:1,value:spec.quantity||1,required:true,'aria-label':'จำนวนครั้งฉาก '+(index+1)});
  const audio=h('input',{type:'checkbox',checked:spec.audio===true,'aria-label':'ใช้เสียงจากโมเดลวิดีโอฉาก '+(index+1)});
  const allowRes=h('input',{type:'checkbox',checked:spec.approve_resolution===true});
  const resWarning=h('label',{class:'tv-check tv-notice'},allowRes,'ยืนยันให้ใช้ความละเอียดที่แสดงแทน 720p ในฉากนี้');
  const reference=h('input',{type:'url',placeholder:'https://…',value:spec.reference_url||'','aria-label':'URL สื่ออ้างอิงฉาก '+(index+1)});
  const refBox=tvField('URL รูปหรือวิดีโออ้างอิง',reference,'ใช้ลิงก์ HTTPS ที่ผู้ให้บริการเปิดได้ในระหว่างผลิต');
  const sound=h('textarea',{rows:2,maxlength:500,placeholder:shot.direction?.audio||'','aria-label':'เสียงประกอบฉาก '+(index+1)},spec.sfx?.text||'');
  const soundDuration=h('input',{type:'number',min:0.5,max:22,step:'any',value:spec.sfx?.duration_seconds??'',placeholder:'วินาที','aria-label':'ความยาวเสียงประกอบฉาก '+(index+1)});
  const soundBox=h('details',{class:'tv-fold'},h('summary',{},'เสียงประกอบ ElevenLabs (ไม่บังคับ)'),h('div',{class:'tv-grid'},tvField('คำอธิบายเสียง',sound,TV_CONFIG?.sfx_usd_per_second?null:'กำลังรอราคาของโมเดลเสียงประกอบ เว้นว่างเพื่อข้าม'),tvField('ความยาว (วินาที)',soundDuration)));
  function audioControls(){soundBox.hidden=audio.checked;soundDuration.required=!!sound.value.trim()&&!audio.checked;}
  sound.addEventListener('input',audioControls);audio.addEventListener('change',audioControls);
  const issueBox=h('div',{class:'tv-notice',role:'status'}),reason=h('p',{class:'sub'}),knowledge=h('small',{class:'sub'});
  function notes(prod){
    reason.textContent=[prod.rank?'Arena #'+prod.rank:'',prod.reason].filter(Boolean).join(' · ');
    knowledge.textContent=[prod.knowledge_version?'ข้อมูลโมเดลรุ่น '+prod.knowledge_version:null,prod.inspection?.passed?'ตรวจพรอมป์แล้ว':null].filter(Boolean).join(' · ');
    issueBox.textContent=tvFlatText(prod.issues);issueBox.hidden=!issueBox.textContent;
  }
  function catalog(initial){
    const model=categories.flatMap(c=>c.models||[]).flatMap(m=>[m.fal_error?null:m.fal,m.video_to_video_error?null:m.video_to_video]).find(f=>f?.endpoint_id===endpoint.value);
    const secs=model?.durations||[],res=model?.resolutions||[];
    const selectedSeconds=initial?spec.duration:duration.value,selectedRes=initial?spec.resolution:resolution.value;
    function fill(el,choices,value){
      const values=[...new Set(choices.map(String))];if(initial&&value!=null&&!values.includes(String(value)))values.push(String(value));
      put(el,h('option',{value:''},'เลือก'),values.map(v=>h('option',{value:v},v)));
      el.value=values.find(v=>v.toLowerCase()===String(value).toLowerCase())||'';
    }
    fill(duration,secs,selectedSeconds);fill(resolution,res,selectedRes);
    resWarning.hidden=!resolution.value||resolution.value.toLowerCase()==='720p';
    refBox.hidden=model?!['image-to-video','video-to-video','video-editing'].includes(model.category):!spec.reference_url;
    refBox.querySelector('small').textContent=['video-editing','video-to-video'].includes(model?.category)?'วิดีโอต้นฉบับ HTTPS บน fal.media หรือโดเมนย่อย ขนาดไม่เกิน 100 MiB':'ใช้รูป HTTPS ที่ผู้ให้บริการเปิดได้ หากเว้นว่างหลังฉากแรกจะใช้เฟรมท้ายฉากก่อน';
    audio.disabled=!editable||model?.audio!==true;
    if(!initial&&audio.disabled)audio.checked=false;audioControls();
  }
  catalog(true);notes(spec);
  endpoint.addEventListener('change',()=>{allowRes.checked=false;catalog(false);});
  resolution.addEventListener('change',()=>{allowRes.checked=false;resWarning.hidden=resolution.value.toLowerCase()==='720p';});
  mode.addEventListener('change',()=>{if(mode.value==='original')prompt.value=original.value;});
  original.addEventListener('input',()=>{if(mode.value==='original')prompt.value=original.value;});
  prompt.addEventListener('input',()=>{mode.value='manual';});
  const node=h('details',{class:'tv-scene tv-fold',open:index===0},h('summary',{},h('span',{},'ฉาก '+(index+1)),h('small',{class:'sub'},shot.description||shot.narration||'')),
    h('div',{class:'tv-stack'},tvField('โมเดลที่ใช้',endpoint),reason,tvField('บทพูด',spoken),tvField('รูปแบบพรอมป์',mode),
      h('details',{class:'tv-fold'},h('summary',{},'ดูต้นฉบับ'),tvField('ข้อความต้นฉบับ',original)),
      tvField('พรอมป์ที่จะส่ง',prompt),knowledge,issueBox,
      shot.direction?h('details',{class:'tv-fold'},h('summary',{},'กำกับภาพและการส่งต่อฉาก'),h('div',{class:'tv-stack'},h('p',{},shot.direction.purpose),h('p',{},[shot.direction.camera,shot.direction.lighting].filter(Boolean).join(' · ')),h('p',{},shot.direction.opening_state),h('ol',{},(shot.direction.actions||[]).map(a=>h('li',{},a.action))),h('p',{},shot.direction.closing_state),tvField('ภาพในสตอรีบอร์ด',initialVisual),tvField('เฟรมท้ายที่จะส่งต่อ',endFrame),direction.node)):null,
      h('div',{class:'tv-grid'},tvField('สร้าง (วินาที)',duration),tvField('หลังตัด (วินาที)',edited),tvField('ความละเอียด',resolution),tvField('จำนวนครั้งที่สร้าง',quantity)),resWarning,
      h('label',{class:'tv-check'},audio,'ใช้เสียงจากโมเดลวิดีโอแทนเสียงบรรยาย ElevenLabs สำหรับฉากนี้'),soundBox,refBox));
  if(!editable)node.querySelectorAll('input,select,textarea').forEach(el=>el.disabled=true);
  for(const el of node.querySelectorAll('input,select,textarea'))el.addEventListener(el.tagName==='SELECT'||el.type==='checkbox'?'change':'input',()=>changed(true));
  function collect(){return {...shot,narration:spoken.value,...(shot.direction?{direction:direction.read(),end_frame:endFrame.value,visual_prompt:initialVisual.value}:{}),production:{...spec,endpoint_id:endpoint.value,prompt_mode:mode.value,prompt:mode.value==='original'?original.value:prompt.value,original_prompt:original.value,
    duration:Number(duration.value)||undefined,edited_duration:Number(edited.value)||undefined,resolution:resolution.value||undefined,approve_resolution:!resWarning.hidden&&allowRes.checked,quantity:Number(quantity.value),audio:audio.checked,sfx:sound.value.trim()&&!audio.checked?{text:sound.value.trim(),duration_seconds:Number(soundDuration.value)}:undefined,reference_url:!refBox.hidden&&reference.value.trim()||undefined}};}
  function saved(updated){
    if(!updated?.production)return;
    Object.assign(spec,updated.production);notes(spec);
    if(spec.endpoint_id&&![...endpoint.options].some(o=>o.value===spec.endpoint_id))endpoint.append(h('option',{value:spec.endpoint_id},spec.endpoint_id));
    endpoint.value=spec.endpoint_id||'';catalog(true);
    original.value=spec.original_prompt||original.value;
    mode.value=spec.prompt_mode||mode.value;
    edited.value=spec.edited_duration??edited.value;
    allowRes.checked=spec.approve_resolution===true;
    if(spec.prompt&&document.activeElement!==prompt)prompt.value=spec.prompt;
  }
  return {node,endpoint,collect,saved,applySuggestion(value){node.open=true;mode.value='manual';prompt.value=value;prompt.focus();changed(true);}};
}

function tvQuoteSummary(q,shots){
  const fal=q.fal||[];
  const generated=fal.reduce((sum,f)=>sum+Number(f.generation_seconds??f.duration??0)*Number(f.quantity||1),0);
  const edited=shots.reduce((sum,s)=>sum+Number(s.production?.edited_duration||0),0);
  const thb=q.total_thb==null?'ยังไม่มีอัตราแลกเปลี่ยน':new Intl.NumberFormat('th-TH',{style:'currency',currency:'THB'}).format(q.total_thb);
  return h('div',{class:'tv-stack tv-quote-summary'},h('div',{class:'tv-total'},h('span',{},'รวมค่าใช้จ่ายรออนุมัติ'),h('strong',{},tvPrice(q.total_usd)),h('small',{class:'sub'},thb)),
    h('p',{},shots.length+' ฉาก · สร้าง '+(q.generated_seconds??generated)+' วินาที · หลังตัด '+(q.edited_seconds??edited)+' วินาที'+(q.output_resolution?' · ไฟล์สุดท้าย '+q.output_resolution:'')),
    q.background_music?h('p',{class:'sub'},tvFlatText(q.background_music)):null,
    h('dl',{class:'tv-cost-list'},h('dt',{},'วิดีโอ fal.ai'),h('dd',{},tvPrice(q.fal_usd)),h('dt',{},'เสียง ElevenLabs'),h('dd',{},tvPrice(q.eleven_usd)),
      q.sfx_usd>0?[h('dt',{},'ในจำนวนนี้เป็นเสียงประกอบ'),h('dd',{},tvPrice(q.sfx_usd))]:null,
      q.qa_usd!=null?[h('dt',{},'ตรวจคุณภาพ '+(q.inspection?.model||'')),h('dd',{},tvPrice(q.qa_usd))]:null,
      q.budget_usd!=null?[h('dt',{},'งบผลิต'),h('dd',{},tvPrice(q.budget_usd))]:null,
      h('dt',{},'ประมวลผลอื่น ๆ'),h('dd',{},q.other_processing_usd==null?'ไม่มีราคาที่แยกวัด':tvPrice(q.other_processing_usd)),
      q.remaining_budget_usd!=null?[h('dt',{},'งบคงเหลือ'),h('dd',{},Number(q.remaining_budget_usd)<0?'เกินงบ '+tvPrice(-q.remaining_budget_usd):tvPrice(q.remaining_budget_usd))]:null),
    h('small',{class:'sub'},'ค่า OpenAI สำหรับวิจัยและวางแผนที่ใช้ไปแล้ว · '+tvPrice(q.research_cost_usd)),
    q.remaining_budget_usd<0?h('small',{class:'tv-notice'},'ค่าใช้จ่ายสูงกว่างบที่ตั้งไว้ ตรวจราคาอีกครั้งก่อนอนุมัติ'):null,
    q.inspection_issue?h('small',{class:'tv-notice'},q.inspection_issue):null,
    q.research_usage&&Object.keys(q.research_usage).length?h('small',{class:'sub'},'OpenAI ใช้ '+(q.research_usage.input_tokens??'—')+' โทเคนขาเข้า · '+(q.research_usage.output_tokens??'—')+' โทเคนขาออก'):null,
    q.usd_to_thb?h('small',{class:'sub'},'อัตราโดยประมาณ '+q.usd_to_thb+' บาทต่อ USD · '+(Number(q.usd_to_thb)===Number(TV_CONFIG?.usd_to_thb)?[TV_CONFIG.fx_source||'ค่าที่ตั้งใน Studio',TV_CONFIG.fx_date].filter(Boolean).join(' · '):'คุณระบุเอง')):null,
    h('small',{class:'sub'},'ใบเสนอราคาหมดอายุ '+tvDate(q.expires_at)+' (กรุงเทพฯ)'));
}
function tvConfirmQuote(q,shots,{approve,focusModel}){
  const dialog=h('dialog',{class:'tv-confirm','aria-labelledby':'tv-confirm-title'}),error=h('p',{class:'err',role:'alert'});
  const cancel=()=>{if(!sending)dialog.close();},send=h('button',{class:'btn primary',type:'button'},'อนุมัติและส่งผลิต');
  let sending=false;
  send.addEventListener('click',async()=>{
    if(sending)return;
    if(Date.now()>=Date.parse(q.expires_at)){error.textContent='ใบเสนอราคาหมดอายุ กรุณาปิดและตรวจราคาใหม่';send.disabled=true;return;}
    sending=true;send.disabled=true;error.textContent='กำลังยืนยันกับเซิร์ฟเวอร์…';
    try{await approve();dialog.close();}catch(x){error.textContent=x.message;send.disabled=false;}finally{sending=false;}
  });
  const isPending=slot=>!Array.isArray(q.pending_slots)||q.pending_slots.includes(slot);
  const lines=(q.fal||[]).map((f,i)=>{
    const shot=shots.find(s=>s.id===f.scene_id||f.slot==='fal:'+s.id)||shots[i]||{},prod=shot.production||{},rank=prod.rank;
    return h('article',{class:'tv-line'},h('h3',{},'ฉาก '+(shots.indexOf(shot)>=0?shots.indexOf(shot)+1:i+1)+' · '+(isPending(f.slot)?tvPrice(f.estimated_usd??f.usd):'ใช้ผลที่สร้างไว้')),
      h('p',{},[rank?'Arena #'+rank:null,f.endpoint||f.endpoint_id,prod.reason].filter(Boolean).join(' · ')),
      h('small',{class:'sub'},[(f.generation_seconds??f.duration??prod.duration)+' วินาที × '+(f.quantity??prod.quantity??1)+' ครั้ง','ตัดเหลือ '+(f.edited_seconds??f.edited_duration??prod.edited_duration)+' วินาที',f.resolution||prod.resolution,(prod.audio?'เสียงในวิดีโอ':'เสียงบรรยาย ElevenLabs')].join(' · ')),
      h('p',{},shot.narration||shot.description||''),h('details',{},h('summary',{},'พรอมป์ที่อนุมัติ'),h('p',{class:'tv-copy'},f.payload?.prompt||prod.prompt)),h('details',{},h('summary',{},'พารามิเตอร์คำขอจริง'),h('pre',{class:'tv-copy'},JSON.stringify(f.payload||{},null,2))));
  });
  put(dialog,h('div',{class:'tv-stack'},h('h2',{id:'tv-confirm-title'},'ยืนยันแผนและค่าใช้จ่าย'),tvQuoteSummary(q,shots),lines,
    (q.eleven||[]).map(a=>h('article',{class:'tv-line'},h('h3',{},a.scene_id+' · '+(a.slot.startsWith('sfx:')?'เสียงประกอบ':'เสียงบรรยาย')+' · '+(isPending(a.slot)?tvPrice(a.estimated_usd):'ใช้เสียงที่สร้างไว้')),h('p',{class:'sub'},[a.model_id,a.voice_id,a.duration_seconds?a.duration_seconds+' วินาที':a.characters+' ตัวอักษร'].filter(Boolean).join(' · ')),h('p',{},a.text))),
    error,h('div',{class:'tv-actions'},send,h('button',{class:'btn',type:'button',on:{click:()=>{if(!sending){cancel();focusModel();}}}},'เปลี่ยนโมเดล'),h('button',{class:'btn',type:'button',on:{click:cancel}},'แก้แผนการผลิต'),h('button',{class:'btn quiet',type:'button',on:{click:cancel}},'ยกเลิก'))));
  dialog.addEventListener('keydown',e=>{if(e.key==='Escape')e.stopPropagation();});
  dialog.addEventListener('cancel',e=>{if(sending)e.preventDefault();});dialog.addEventListener('close',()=>dialog.remove(),{once:true});
  document.body.append(dialog);dialog.showModal();
}

function tvProductionReview(p,body,refresh,repairProposal){
  const editable=p.status==='ready'&&!p.job_id;
  const canQuote=editable||p.job_status==='FAILED';
  const data=structuredClone(p.plan),path=TV_PATH+'/plans/'+encodeURIComponent(p.id);
  const title=h('input',{value:data.title,maxlength:120,disabled:!editable,'aria-label':'ชื่อคลิป Text to Video'});
  const budget=h('input',{type:'number',min:0.01,step:0.01,max:10000,required:true,value:p.request.budget_usd,disabled:!editable,'aria-label':'งบแผนการผลิต USD'});
  const rate=h('input',{type:'text',readonly:true,value:TV_CONFIG.voice_usd_per_1000_characters??'',placeholder:'ยังยืนยันราคาไม่ได้','aria-label':'ราคา ElevenLabs USD ต่อ 1000 ตัวอักษร'});
  const rateInfo=h('span',{},TV_CONFIG.voice_model?TV_CONFIG.voice_model+' · ':'',tvLink(TV_CONFIG.voice_pricing_source||TV_CONFIG.eleven_pricing?.source,'ดูราคาต้นทาง ElevenLabs'));
  const fx=h('input',{type:'number',min:0.01,step:'any',required:true,value:p.quote?.usd_to_thb??TV_CONFIG.usd_to_thb??'',placeholder:'ระบุอัตราที่ใช้คำนวณ','aria-label':'บาทต่อ USD'});
  const sourceRate=TV_CONFIG.fx_source||'ค่าที่ตั้งใน Studio';
  const fxNote=h('small',{class:'sub'});
  const explainRate=()=>fxNote.textContent=fx.value&&Number(fx.value)===Number(TV_CONFIG.usd_to_thb)?'แหล่งอัตราแลกเปลี่ยน · '+sourceRate+(TV_CONFIG.fx_date?' · '+TV_CONFIG.fx_date:''):'ใช้อัตราแลกเปลี่ยนที่คุณระบุ';
  explainRate();fx.addEventListener('input',explainRate);
  const err=h('p',{class:'err',role:'alert'},p.error||p.job_error||'');
  const status=h('p',{class:'sub',role:'status'}),prices=h('div',{'data-tv-pricing':true});
  const controls=h('section',{class:'tv-panel tv-stack','aria-label':'ตรวจราคาการผลิต'});
  const check=h('button',{class:'btn',type:'button',on:{click:()=>{clearTimeout(timer);void update();}}},p.job_id?'ตรวจราคาซ่อมเฉพาะส่วน':'ตรวจราคาปัจจุบัน');
  let revision=p.revision,dirty=false,generation=0,timer,busy=false,quote=null;
  let snapshot=data;
  const editors=data.shots.map((s,i)=>tvSceneEditor(s,i,editable,change));
  const bible=tvJsonEditor('แก้ข้อมูลตัวละคร สถานที่ และวัตถุ',data.story_bible,editable);bible.field.addEventListener('input',()=>change(true));
  const proposal=repairProposal||{scene_id:p.repair_scene,quality:p.repair_quality};
  const fixIndex=data.shots.findIndex(s=>s.id===proposal.scene_id),suggestion=proposal.quality?.revised_prompt;
  const useSuggestion=h('button',{class:'btn',type:'button',on:{click:()=>editors[fixIndex].applySuggestion(suggestion)}},'ใช้พรอมป์ที่แนะนำ');
  const repair=editable&&fixIndex>=0?h('div',{class:'tv-notice tv-stack'},h('b',{},'แผนแก้ฉาก '+(fixIndex+1)),h('p',{},tvFlatText(proposal.quality?.recommendations)),suggestion?h('p',{class:'tv-copy'},suggestion):null,suggestion?useSuggestion:null):null;
  function change(planChanged){
    generation++;dirty=dirty||planChanged;quote=null;put(prices);err.textContent='';
    status.textContent=planChanged?'กำลังรอบันทึกและตรวจราคาใหม่…':'กำลังรอตรวจราคาใหม่…';
    clearTimeout(timer);timer=setTimeout(update,850);
  }
  function show(q){
    quote=q;
    if(q.eleven_usd_per_1000_characters!=null)rate.value=String(q.eleven_usd_per_1000_characters);
    const approvedRevision=revision,approvedGeneration=generation;
    const review=h('button',{class:'btn primary',type:'button',on:{click:()=>{
      if(!valid()) {quote=null;put(prices);status.textContent='ใบเสนอราคาหมดอายุ กรุณาตรวจราคาใหม่';return;}
      tvConfirmQuote(q,snapshot.shots,{focusModel:()=>{const editor=editors.find(e=>!e.endpoint.disabled);if(editor){editor.node.open=true;editor.endpoint.focus();}},
        approve:async()=>{
          if(!valid())throw Error('แผนหรือราคาเปลี่ยนแล้ว กรุณาตรวจราคาใหม่');
          try{await api(path+'/produce',{method:'POST',body:JSON.stringify({approved:true,quote_id:q.id,revision:approvedRevision,confirmation:'CONFIRM '+q.id})});}
          catch(x){if([409,422].includes(x.status)){quote=null;review.disabled=true;status.textContent='เงื่อนไขในระบบเปลี่ยนแล้ว ต้องตรวจราคาอีกครั้ง';}throw x;}
          quote=null;review.disabled=true;toast('ส่งเข้าคิวผลิตแล้ว โดยปิดการโพสต์อัตโนมัติ');void refresh();
        }});
    }}},'ตรวจแผนและอนุมัติ');
    function valid(){return controls.isConnected&&quote===q&&!dirty&&revision===approvedRevision&&generation===approvedGeneration&&Date.now()<Date.parse(q.expires_at);}
    const lines=(q.fal||[]).map((line,i)=>h('li',{},[line.scene_id||('ฉาก '+(i+1)),line.endpoint_id||line.endpoint,line.generation_seconds+' วินาที',!q.pending_slots||q.pending_slots.includes(line.slot)?tvPrice(line.estimated_usd):'ใช้ผลที่สร้างไว้'].filter(Boolean).join(' · ')));
    put(prices,tvQuoteSummary(q,snapshot.shots),h('details',{class:'tv-fold'},h('summary',{},'ราคาวิดีโอรายฉาก'),h('ul',{class:'tv-cost-lines'},lines)),review);
  }
  async function update(){
    if(busy||!controls.isConnected)return;
    const at=generation;
    busy=true;check.disabled=true;err.textContent='';quote=null;put(prices);
    try{
      if(dirty){
        const invalid=[title,budget,...editors.flatMap(e=>[...e.node.querySelectorAll('input,textarea,select')])].find(el=>!el.disabled&&!el.checkValidity());
        if(invalid)throw Error('ตรวจข้อมูลในช่อง '+(invalid.getAttribute('aria-label')||invalid.name||'ที่แก้ไข')+' อีกครั้ง');
        status.textContent='กำลังบันทึกแผน…';
        const result=await api(path,{method:'PATCH',body:JSON.stringify({revision,plan:{...data,title:title.value,...(data.story_bible?{story_bible:bible.read()}:{}),shots:editors.map(e=>e.collect())},budget_usd:Number(budget.value)})});
        revision=result.revision;snapshot=result.plan;
        if(!controls.isConnected||at!==generation)return;
        dirty=false;snapshot.shots.forEach((s,i)=>editors[i]?.saved(s));
      }
      if(!fx.value||!fx.checkValidity()){
        status.textContent='ระบุอัตราบาทต่อ USD เพื่อคำนวณราคา';return;
      }
      status.textContent='กำลังตรวจราคาโมเดลและค่าเสียง…';
      const q=await api(path+'/quote',{method:'POST',body:JSON.stringify({usd_to_thb:Number(fx.value)})});
      if(controls.isConnected&&at===generation){status.textContent='รอคุณอนุมัติแผนและราคานี้';show(q);}
    }catch(x){if(controls.isConnected&&at===generation){err.textContent=[x.message,tvFlatText(x.body?.issues)].filter(Boolean).join(' · ');status.textContent='ยังส่งผลิตไม่ได้';}}
    finally{
      busy=false;check.disabled=false;
      if(at!==generation&&controls.isConnected){clearTimeout(timer);timer=setTimeout(update,100);}
    }
  }
  [title,budget].forEach(el=>el.addEventListener('input',()=>change(true)));
  fx.addEventListener('input',()=>change(false));
  put(controls,h('h2',{},'ค่าใช้จ่ายก่อนผลิต'),h('div',{class:'tv-grid'},tvField('ค่าเสียง ElevenLabs ต่อ 1,000 ตัวอักษร (USD)',rate,rateInfo),tvField('อัตราแลกเปลี่ยนโดยประมาณ (บาทต่อ USD)',fx,fxNote)),check,status,prices);
  put(body,h('div',{class:'tv-stack'},tvField('ชื่อคลิป',title),h('p',{},data.synopsis||''),h('p',{class:'sub'},[generationModelLabel(p.request.model),TV_ROUTES[p.request.routing_mode],tvTime(p.request.duration)].filter(Boolean).join(' · ')),tvEvidence(data),data.story_bible&&editable?bible.node:null),
    p.job_id?tvHistoryPanel(p.job_id,p.job_status,refresh):null,repair,h('h2',{},'แผนการผลิตรายฉาก'),editors.map(e=>e.node),
    canQuote?tvField('งบผลิต (USD)',budget):null,err,canQuote?controls:null);
  if(canQuote){
    if(p.quote&&!p.approval&&Date.now()<Date.parse(p.quote.expires_at)){status.textContent='รอคุณอนุมัติแผนและราคานี้';show(p.quote);}
    else if(editable)timer=setTimeout(update,0);
  }
}

const TV_HISTORY='/app/api/video-intelligence/history';
function tvHistoryPanel(jobId,initialStatus,refreshPlan){
  let loaded=false,busy=false,timer;
  const body=h('div',{class:'tv-stack'}),root=h('details',{class:'tv-fold tv-history',open:!!jobId},h('summary',{},jobId?'ความคืบหน้าและผลตรวจคุณภาพ':'ประวัติการผลิตและคะแนนคุณภาพ'),body);
  const button=h('button',{class:'btn',type:'button',on:{click:()=>load()}},'อัปเดตสถานะ');
  const state=h('p',{class:'sub',role:'status'});
  function scene(s){
    const q=s.quality||{},scores=q.scores||{},criteria={prompt_adherence:'ทำตามพรอมป์',visual_quality:'คุณภาพภาพ',character_consistency:'ตัวละครสม่ำเสมอ',scene_logic:'เหตุผลในฉาก'};
    const rate=tvSelect('ให้คะแนนฉาก '+s.scene_id,{'':'ให้คะแนน',1:'1 / 5',2:'2 / 5',3:'3 / 5',4:'4 / 5',5:'5 / 5'},s.user_rating??'');
    const feedback=h('small',{class:'sub',role:'status'});let previous=s.user_rating??'';
    rate.addEventListener('change',async()=>{
      if(!rate.value){rate.value=previous;return;}
      rate.disabled=true;
      try{await api(TV_HISTORY+'/'+encodeURIComponent(s.id)+'/rating',{method:'POST',body:JSON.stringify({rating:Number(rate.value)})});previous=rate.value;feedback.textContent='บันทึกคะแนนแล้ว';}
      catch(x){rate.value=previous;feedback.textContent=x.message;}finally{rate.disabled=false;}
    });
    const revise=h('button',{class:'btn',type:'button',on:{click:async()=>{
      revise.disabled=true;try{
        const r=await draftPost(TV_HISTORY+'/'+encodeURIComponent(s.id)+'/revision',{});
        root.closest('.drawer')?.querySelector('.d-top button')?.click();openTextVideo(r.id,{scene_id:r.scene_id||s.scene_id,quality:r.quality||q});
      }catch(x){feedback.textContent=x.message;}finally{revise.disabled=false;}
    }}},'สร้างแผนแก้ฉาก');
    const method=q.method==='sampled_frames'?'ตรวจจากภาพตัวอย่าง · ยังไม่ได้ตรวจการเคลื่อนไหวระหว่างเฟรมหรือเสียง':q.method==='native_video'?'ตรวจจากวิดีโอ':'ยังไม่มีผลตรวจภาพ';
    return h('details',{class:'tv-fold'},h('summary',{},(s.scene_id||s.slot)+' · '+(s.model_name||s.endpoint_id)+' · '+s.status),
      h('div',{class:'tv-stack'},h('p',{class:'sub'},[s.endpoint_id,s.scene_type,s.generation_seconds!=null?s.generation_seconds+' วินาที':null].filter(Boolean).join(' · ')),
        h('p',{},'ประมาณ '+tvPrice(s.estimated_usd)+' · ค่าใช้จ่ายจริง '+tvPrice(s.actual_usd)),s.failure_reason?h('p',{class:'err'},s.failure_reason):null,
        h('p',{},[method,q.model,q.samples?.length?q.samples.length+' ภาพตัวอย่าง':null].filter(Boolean).join(' · ')),h('dl',{class:'tv-cost-list'},Object.entries(scores).filter(([,n])=>n!=null).map(([k,n])=>[h('dt',{},criteria[k]||k),h('dd',{},String(n)+' / 100')])),
        q.issues?.length?h('p',{},'ปัญหาที่พบ · '+tvFlatText(q.issues)):null,q.recommendations?.length?h('p',{},'ข้อเสนอแนะ · '+tvFlatText(q.recommendations)):null,
        q.revised_prompt?h('details',{},h('summary',{},'พรอมป์ที่แนะนำ'),h('p',{class:'tv-copy'},q.revised_prompt)):null,
        (q.method==='sampled_frames'||q.method==='native_video')&&(q.revised_prompt||q.recommendations?.length)?revise:null,
        h('details',{class:'tv-fold'},h('summary',{},'รายละเอียดการสร้าง'),h('div',{class:'tv-stack'},h('p',{class:'sub'},[tvDate(s.created_at),s.generation_ms!=null?'เวลาที่ใช้ '+(s.generation_ms/1000).toFixed(1)+' วินาที':null,s.knowledge_version?'ข้อมูลโมเดลรุ่น '+s.knowledge_version:null].filter(Boolean).join(' · ')),s.original_prompt?h('p',{class:'tv-copy'},'ต้นฉบับ · '+s.original_prompt):null,s.compiled_prompt?h('p',{class:'tv-copy'},'ส่งจริง · '+s.compiled_prompt):null)),tvField('คะแนนจากคุณ',rate),feedback));
  }
  async function load(){
    if(busy||!root.isConnected)return;
    clearTimeout(timer);busy=true;button.disabled=true;state.textContent='กำลังโหลด…';
    try{
      const r=await api(TV_HISTORY+(jobId?'?job_id='+encodeURIComponent(jobId):''));
      if(!root.isConnected)return;
      if(jobId&&refreshPlan&&r.job?.status!==initialStatus&&['FAILED','CANCELLED','READY_TO_POST'].includes(r.job?.status)){void refreshPlan();return;}
      const job=r.job,events=r.events||[],scenes=r.scenes||[];
      const expanded=new Set([...body.querySelectorAll('[data-scene-id][open]')].map(el=>el.dataset.sceneId));
      state.textContent=job?[typeof STAGE!=='undefined'?(STAGE[job.stage]||STAGE[job.status]||job.stage||job.status):job.stage||job.status,events[0]?.message,job.created_at&&(!['FAILED','CANCELLED','READY_TO_POST'].includes(job.status)?tvElapsed(job.created_at):tvDate(job.updated_at))].filter(Boolean).join(' · '):'';
      const rows=scenes.map(s=>{const el=scene(s);el.dataset.sceneId=s.id;el.open=expanded.has(s.id);return el;});
      put(body,state,button,events.length?h('details',{class:'tv-fold'},h('summary',{},'บันทึกการผลิต'),events.map(e=>h('p',{},[tvDate(e.created_at),e.message].filter(Boolean).join(' · ')))):null,
        rows,scenes.length?null:h('p',{class:'sub'},'ยังไม่มีผลการผลิตรายฉาก'));loaded=true;
      if(jobId&&job&&!['FAILED','CANCELLED','READY_TO_POST'].includes(job.status))timer=setTimeout(()=>{if(root.open&&root.isConnected)void load();},5000);
    }catch(x){state.textContent=x.message;put(body,state,button);}finally{busy=false;button.disabled=false;}
  }
  root.addEventListener('toggle',()=>{if(root.open&&(!loaded||jobId))void load();else clearTimeout(timer);});
  if(jobId)setTimeout(load,0);
  return root;
}
