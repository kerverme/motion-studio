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
  const topic=h('textarea',{rows:3,maxlength:400,'aria-label':'หัวข้อ Text to Video',placeholder:'อยากเล่าเรื่องอะไร?'});
  const source=h('textarea',{rows:5,maxlength:100000,'aria-label':'เนื้อหาอ้างอิง Text to Video',placeholder:'วางบทความ ข้อมูลจาก NotebookLM หรือลิงก์ต้นฉบับ (ไม่บังคับ)'});
  const note=h('textarea',{rows:2,maxlength:2000,'aria-label':'แนวภาพและรายละเอียดเพิ่มเติม',placeholder:'เช่น การ์ตูนอบอุ่น เล่าผ่านเหตุการณ์เดียว ตัวละครตามเนื้อเรื่อง'});
  const brain=h('select',{'aria-label':'สมอง Text to Video'},cfg.brains.map(id=>h('option',{value:id,selected:id==='gpt-6.1-sol'},GENERATION_MODEL_LABELS[id]||id)));
  const model=tvModelSelect('h3_max');let resolution=tvResolutionSelect(model.value,'768P');const resolutionBox=h('div',{},tvField('ความละเอียดต้นทาง',resolution,'ส่งออกแนวตั้ง 1080×1920; ภาพต้นทางความละเอียดต่ำจะถูกขยาย'));
  model.addEventListener('change',()=>{resolution=tvResolutionSelect(model.value,model.value==='h3_max'?'768P':'720p');put(resolutionBox,tvField('ความละเอียดต้นทาง',resolution,'ราคาขึ้นกับโมเดลและความละเอียด'));});
  const duration=h('select',{'aria-label':'ความยาวคลิป Text to Video'},cfg.durations.map(n=>h('option',{value:n},n===60?'1 นาที':n===90?'1 นาที 30 วินาที':'2 นาที')));
  const segments=h('p',{class:'sub'});const showSegments=()=>{const n=Number(duration.value)/15;segments.textContent=`${n} ช็อตต่อเนื่อง · `+Array.from({length:n},(_,i)=>tvTime(i*15)+'–'+tvTime((i+1)*15)).join(' → ');};duration.addEventListener('change',showSegments);showSegments();
  const style=h('select',{'aria-label':'สไตล์เล่า Text to Video'},cfg.narration_styles.map(s=>h('option',{value:s.id},s.label)));
  const custom=h('textarea',{class:'tv-custom',rows:2,maxlength:1000,'aria-label':'สไตล์เล่าที่กำหนดเอง Text to Video',placeholder:'อธิบายสไตล์ที่ต้องการ',hidden:true});style.addEventListener('change',()=>custom.hidden=style.value!=='custom');
  const err=h('div',{class:'err',role:'alert'});
  const create=h('button',{class:'btn primary',disabled:!cfg.openai_configured,type:'submit'},'ให้สมองวางบทและแบ่งช็อต');
  const form=h('form',{class:'tv-panel tv-form',on:{submit:async e=>{e.preventDefault();create.disabled=true;err.textContent='';try{
    const r=await draftPost(TV_PATH+'/plans',{topic:topic.value,source_text:source.value,note:note.value,model:brain.value,reasoning:'medium',video_model:model.value,resolution:resolution.value,duration:Number(duration.value),narration_style:style.value,narration_custom:style.value==='custom'?custom.value:''});openTextVideo(r.id);
  }catch(x){err.textContent=x.message;}finally{create.disabled=!cfg.openai_configured;}}}},
    tvField('หัวข้อหรือเรื่องที่จะเล่า',topic),tvField('เนื้อหาหรือลิงก์อ้างอิง (ไม่บังคับ)',source,'รองรับข้อความยาว 100,000 ตัวอักษร สมองเลือกประเด็นให้เหมาะกับความยาวคลิป'),
    h('div',{class:'tv-grid'},tvField('สมอง OpenAI',brain),tvField('โมเดลวิดีโอ fal.ai',model)),resolutionBox,
    tvField('ความยาวรวมสูงสุด',duration),segments,tvField('สไตล์การเล่า',style),custom,tvField('แนวภาพและรายละเอียดเพิ่มเติม',note),
    h('p',{class:'sub'},'ช็อตแรกสร้างจากข้อความ ช็อตถัดไปใช้เฟรมท้ายของช็อตก่อนเพื่อช่วยคงตัวละครและเหตุการณ์ต่อเนื่อง ความเหมือนไม่รับประกัน 100%'),
    h('p',{class:'sub'},'ขั้นนี้ใช้ OpenAI วางบทเท่านั้น คุณจะเห็นบท รายช็อต และราคาก่อนยืนยันการผลิตด้วย fal.ai และ ElevenLabs'),err,create);
  put(mainEl,h('h1',{},'Text to Video'),h('p',{class:'lede'},'เล่าเรื่องเดียวต่อกันด้วยวิดีโอ AI ช็อตละ 15 วินาที'),
    !cfg.fal_configured||!cfg.worker_ready?h('p',{class:'tv-notice'},'วางบทได้ก่อน · การผลิตยังรอตั้งค่า fal.ai และ worker ให้พร้อม ปุ่มผลิตจะเปิดหลังตรวจราคาและยืนยันเท่านั้น'):null,form,h('section',{id:'tv-plans',class:'drafts'}));
  renderTextVideoList(plans);
}
function renderTextVideoList(plans){const el=document.getElementById('tv-plans');if(!el)return;put(el,h('h2',{},'บทและคลิป Text to Video'),plans.length?plans.map(p=>h('button',{class:'btn',style:'display:block;width:100%;text-align:left;margin:10px 0',on:{click:()=>openTextVideo(p.id)}},
  h('b',{},p.plan?.title||p.request.topic),h('div',{class:'sub'},tvState(p)+' · '+tvTime(p.request.duration)+' · '+(GENERATION_MODEL_LABELS[p.request.model]||p.request.model)+' · '+(TV_CONFIG.models.find(m=>m.id===p.request.video_model)?.label||p.request.video_model)))):h('p',{class:'sub'},'ยังไม่มีบท เริ่มจากหัวข้อด้านบน'));}
function openTextVideo(id){
  drawer(({body,titleEl,close})=>{
    body.classList.add('tv-review');
    let timer,closed=false,dirty=false;
    const observer=new MutationObserver(()=>{if(!body.isConnected){closed=true;clearTimeout(timer);observer.disconnect();}});observer.observe(document.body,{childList:true,subtree:true});
    async function refresh(){
      if(closed)return;
      try{const p=await api(TV_PATH+'/plans/'+id);if(closed)return;titleEl.textContent='Text to Video · '+tvState(p);dirty=false;
        const error=h('div',{class:'err',role:'alert'},p.error||p.job_error||'');
        if(!p.plan){put(body,h('h2',{},p.request.topic),h('p',{},p.progress||tvState(p)),error,p.status==='failed'?h('button',{class:'btn',on:{click:async()=>{try{await api(TV_PATH+'/plans/'+id+'/resume',{method:'POST',body:'{}'});refresh();}catch(x){error.textContent=x.message;}}}},'ตรวจคำตอบ OpenAI เดิมอีกครั้ง'):null);}
        else{
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
          put(body,tvField('ชื่อคลิป',title),h('p',{},p.plan.synopsis),h('p',{class:'sub'},`${tvTime(p.request.duration)} · สมอง ${GENERATION_MODEL_LABELS[p.request.model]||p.request.model}`),
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
        if(['queued','planning'].includes(p.status)||(p.status==='producing'&&!['FAILED','CANCELLED'].includes(p.job_status)))timer=setTimeout(refresh,5000);
      }catch(x){if(!closed)put(body,h('p',{class:'err'},x.message));}
    }
    refresh();
  },true);
}
setInterval(()=>{if(typeof S!=='undefined'&&S.view==='text_video'&&!document.querySelector('.drawer')&&!document.hidden)api(TV_PATH+'/plans').then(r=>renderTextVideoList(r.plans)).catch(()=>{});},5000);
