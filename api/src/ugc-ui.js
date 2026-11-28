/* global api,h,put,S,go,mainEl,draftPost */
'use strict';

const ugcPath='/app/api/ugc';
let ugcSession=0;
const ugcJSON=(method,body)=>({method,body:JSON.stringify(body)});
const ugcDollars=new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',minimumFractionDigits:2,maximumFractionDigits:6});
const ugcUSD=value=>ugcDollars.format(value);
const ugcDate=value=>new Date(value).toLocaleString('th-TH',{timeZone:'Asia/Bangkok'});
const ugcState={NEW:'รอเข้าคิว',GENERATING_AUDIO:'ทำเสียง',RENDERING:'กำลังทำภาพและตัดต่อ',
  READY_TO_POST:'พร้อมดาวน์โหลด',FAILED:'หยุด · ตรวจรายละเอียด',CANCELLED:'ยกเลิก'};
const ugcPaid={submitting:'กำลังส่ง',accepted:'ส่งแล้ว · รอผล',done:'เสร็จ',failed:'ล้มเหลว',unknown:'รอตรวจคำขอเดิม'};
const ugcOption=(value,label)=>h('option',{value},label);
function ugcSelect(values,current,change,label){
  const select=h('select',{'aria-label':label,on:{change:event=>change(event.target.value)}},values.map(x=>ugcOption(...x)));
  select.value=current;
  return select;
}
function ugcDraftId(){return location.hash.match(/^#ugc\/([0-9a-f-]{36})$/i)?.[1]||'';}
function openUgc(id){history.replaceState(null,'',location.pathname+location.search+(id?'#ugc/'+id:''));go('ugc');}
function ugcRateText(rate){
  return ugcUSD(rate.unit_usd)+' / '+(/^seconds?$/i.test(rate.unit)?'วินาที':'ครั้ง')+
    (rate.image_usd?' + '+ugcUSD(rate.image_usd)+' / รูปอ้างอิง':'');
}
function rankedOptions(data,fits=()=>true){
  const models=data.models||[], groups=[], entries=[];
  function option(model,rank){
    const endpoint=rank?.endpoint||model?.id;
    const preset=rank?.resolution;
    const reason=rank?.reason||(!model||!fits(model)?'ไม่รองรับการตั้งค่าของร่างนี้':'');
    const key=rank?'arena:'+rank.key:endpoint;
    const disabled=!!reason||rank?.available===false;
    const label=rank?'#'+rank.rank+' '+rank.name+' · '+rank.developer: model.name;
    const item=h('option',{value:key,disabled},label+(endpoint?' · '+endpoint:'')+(reason?' · '+reason:''));
    entries.push({key,endpoint,rank:rank?.key,preset,disabled,model});
    return item;
  }
  if(data.ranked?.length)groups.push(h('optgroup',{label:'อันดับ Arena · Image-to-Video'},data.ranked.map(r=>option(models.find(m=>m.id===r.endpoint),r))));
  const extra=(data.featured||[]).map(id=>models.find(m=>m.id===id)).filter(Boolean);
  if(extra.length)groups.push(h('optgroup',{label:'แนะนำบน fal.ai'},extra.map(m=>option(m))));
  return {groups,entries};
}
function catalogNotice(data){
  return [data.error,data.checked_at?'อัปเดตสำเร็จล่าสุด '+ugcDate(data.checked_at):'',
    ...(data.stale?Object.entries(data.source_status||{}).filter(([,s])=>s.error).map(([key,s])=>
      ({arena:'Arena',featured:'fal.ai New and Noteworthy',index:'fal.ai catalog'})[key]+' · '+(s.checked_at?'ข้อมูลล่าสุด '+ugcDate(s.checked_at):'ยังไม่มีข้อมูลที่ตรวจสอบแล้ว')):[])
  ].filter(Boolean).join(' · ');
}
function renderUgcHome(){
  const session=++ugcSession;
  const active=()=>session===ugcSession&&S.view==='ugc'&&root.isConnected;
  const root=h('section',{class:'ugc-home'});
  const errors=h('p',{role:'alert',class:'ugc-note'}),tabs=h('div',{class:'ugc-tabs',role:'tablist','aria-label':'UGC AI'});
  const placeholder='ช่วยทำคลิปผู้หญิงถือแก้วเก็บความเย็นแล้วรีวิวเป็นภาษาไทย เปิดคลิปด้วยการยกแก้วให้กล้องดู';
  const brief=h('textarea',{id:'ugc-brief',rows:5,maxlength:1600,'aria-label':'บรีฟคลิป',placeholder});
  const query=h('textarea',{id:'ugc-idea-query',rows:4,maxlength:200,'aria-label':'คำค้น Shopee',placeholder:'หาของใช้ในบ้านที่กำลังขายดีใน Shopee ไทย งบไม่เกิน 500 บาท'});
  const file=h('input',{type:'file',accept:'image/jpeg,image/png,image/webp,video/mp4',id:'ugc-attach',class:'ugc-file','aria-label':'แนบรูปหรือคลิปสินค้า'});
  const filename=h('span',{class:'sub'});
  file.onchange=()=>{filename.textContent=file.files[0]?.name||'';};
  const old=h('details',{class:'ugc-old'},h('summary',{},'ร่างเก่า'));
  const result=h('div',{class:'ugc-results','aria-live':'polite'});
  let idea=null,activeSearch='',poll,tab='create';
  const hint=h('div',{class:'ugc-note'}),ideaHint=()=>{put(hint,idea?h('span',{},'จาก Shopee · ',h('a',{href:idea.url,rel:'noopener noreferrer',target:'_blank'},idea.name),' ',
    h('button',{type:'button',class:'btn',on:{click:()=>{idea=null;ideaHint();remember();}}},'นำออก')):null);};
  function remember(){
    sessionStorage.setItem('ms.ugc.composer',JSON.stringify({brief:brief.value,query:query.value,idea}));
  }
  try{const saved=JSON.parse(sessionStorage.getItem('ms.ugc.composer')||'{}');brief.value=saved.brief||'';query.value=saved.query||'';idea=saved.idea||null;}catch{}
  brief.oninput=remember;query.oninput=remember;ideaHint();
  function action(label,fn,primary=false){
    const btn=h('button',{type:'button',class:'btn'+(primary?' primary':''),on:{click:async()=>{
      if(btn.disabled)return;
      btn.disabled=true;errors.textContent='';
      try{await fn();}catch(e){if(active())errors.textContent=e.message;}finally{btn.disabled=false;}
    }}},label);
    return btn;
  }
  function selector(kind,label){
    const key='ms.ugc.model.'+kind, status=h('small',{role:'status',class:'sub'}),rate=h('small',{class:'sub'});
    const select=h('select',{'aria-label':label});
    let items=[],entries=[],missing=false,loading=false,initialized=false;
    const selection=()=>entries.find(x=>x.key===select.value&&!x.disabled);
    const chosen=()=>selection()?.model;
    const showRate=()=>{
      const m=chosen(),r=m?.rates?.find(x=>x.resolution.toLowerCase()===(selection()?.preset||'720p'))??m?.rates?.[0];
      put(rate,r?h('a',{href:m.source_url,target:'_blank',rel:'noopener'},r.resolution+' · '+ugcRateText(r)):null);
    };
    function remember(){
      const entry=selection();
      if(!entry)return;
      localStorage.setItem(key,entry.key);
      if(kind==='video'){
        localStorage.setItem(key+'.endpoint',entry.endpoint);
        localStorage.setItem(key+'.resolution',entry.preset||entry.model.resolutions.find(x=>x.toLowerCase()==='720p')||entry.model.resolutions[0]);
      }
    }
    select.onchange=()=>{if(select.value){missing=false;remember();status.textContent=lastStatus;}showRate();};
    let lastStatus='';
    let pending;
    const refreshLabel=kind==='video'?'อัปเดตอันดับและโมเดล':'อัปเดตโมเดล';
    const refresh=action(refreshLabel,()=>update(true));
    function update(force=false){
      if(!pending)pending=read(force).finally(()=>{pending=null;});
      return pending;
    }
    async function read(force){
      if(loading)return;
      loading=true;select.disabled=true;refresh.disabled=true;
      refresh.textContent='กำลังอัปเดต…';status.textContent='กำลังอัปเดต…';
      try{
        const data=await api(ugcPath+'/catalog/'+kind+(force?'?refresh=1':''));
        if(!active())return;
        const wanted=localStorage.getItem(key)||select.value||'';
        items=data.models;
        const ranked=kind==='video'?rankedOptions(data):null;
        entries=ranked?.entries||items.map(m=>({key:m.id,endpoint:m.id,model:m}));
        const available=entries.filter(x=>!x.disabled);
        const priorId=kind==='video'&&wanted?(localStorage.getItem(key+'.endpoint')||(!wanted.startsWith('arena:')?wanted:'')):'';
        const priorSize=priorId?localStorage.getItem(key+'.resolution')?.toLowerCase():'';
        const same=m=>(!priorId||m.endpoint===priorId)&&(!priorSize||(!m.preset||m.preset===priorSize)&&m.model.resolutions.some(r=>r.toLowerCase()===priorSize));
        const exact=available.find(x=>x.key===wanted&&same(x));
        const keep=exact||(priorId&&available.find(x=>x.endpoint===priorId&&same(x)));
        missing=!!wanted&&!keep;
        put(select,ugcOption('','เลือกโมเดล'),ranked?ranked.groups:items.map(m=>ugcOption(m.id,m.name)));
        select.value=keep?.key||(missing?'':available.find(x=>x.endpoint===data.default_id)?.key||available[0]?.key||'');
        if(select.value)remember();
        initialized=true;
        lastStatus=catalogNotice(data)||(!items.length?'ไม่มีโมเดลที่รองรับในขณะนี้':'');
        showRate();
      }catch(e){lastStatus='ยังไม่ได้อัปเดต · '+e.message+(lastStatus?' · '+lastStatus:'');}
      finally{loading=false;refresh.textContent=refreshLabel;refresh.disabled=false;select.disabled=false;
        status.textContent=(missing?'โมเดลที่เลือกใช้ไม่ได้แล้ว กรุณาเลือกใหม่ · ':'')+lastStatus.replace(/^ · /,'');}
    }
    return {node:h('div',{class:'ugc-model'},h('label',{},label,select),refresh,rate,status),select,update,selection,
      get ready(){return pending;},get initialized(){return initialized;},get missing(){return missing;},get loading(){return loading;}};
  }
  const video=selector('video','โมเดลวิดีโอ'),brain=selector('ideas','โมเดลคิดไอเดีย');
  async function prepare(){
    const text=brief.value.trim();
    if(text.length<2){brief.focus();throw Error('พิมพ์บรีฟคลิปก่อนเตรียมร่าง');}
    if(video.loading){errors.textContent='กำลังตรวจรายการโมเดลวิดีโอ…';await video.ready;errors.textContent='';}
    if(video.missing||video.select.options.length>1&&!video.select.value)throw Error('โมเดลเดิมใช้ไม่ได้แล้ว กรุณาเลือกโมเดลวิดีโอใหม่');
    const attached=file.files[0];
    if(attached?.size>32*1024*1024)throw Error('ไฟล์ต้องไม่เกิน 32 MB');
    const selected=video.selection();
    const input={brief:text,endpoint:selected?.endpoint||'',...(selected?.rank?{arena_key:selected.rank}:{}),...(selected?.preset?{resolution:selected.preset}:{}),...(idea?{idea:{search:idea.search,id:idea.id}}:{})};
    const signature=JSON.stringify([input,attached?[attached.name,attached.size,attached.lastModified]:null]);
    const slot='ms.ugc.prepare';
    let pending=JSON.parse(sessionStorage.getItem(slot)||'null');
    if(pending){
      try{
        const existing=await api(ugcPath+'/drafts/'+pending.id);
        sessionStorage.removeItem(slot);openUgc(existing.id);return;
      }catch(e){if(e.status!==404)throw e;}
      if(pending.signature!==signature)throw Error('ส่งบรีฟหรือไฟล์เดิมอีกครั้งเพื่อตรวจคำขอที่ยังไม่ทราบผล');
    }else{pending={id:crypto.randomUUID(),signature};sessionStorage.setItem(slot,JSON.stringify(pending));}
    const form=new FormData();form.set('input',JSON.stringify(input));if(attached)form.set('media',attached);
    const options=attached?{method:'POST',body:form}:{method:'POST',body:JSON.stringify(input)};
    try{
      const draft=await api(ugcPath+'/prepare',{...options,headers:{'idempotency-key':pending.id}});
      sessionStorage.removeItem(slot);sessionStorage.removeItem('ms.ugc.composer');
      if(active())openUgc(draft.id);
    }catch(e){if(e.status>=400&&e.status<500&&e.status!==408)sessionStorage.removeItem(slot);throw e;}
  }
  function use(card,search){
    idea={search,id:card.id,name:card.name,url:card.url};
    brief.value='ช่วยทำคลิปคนถือและรีวิว'+card.name+'เป็นภาษาไทย เปิดด้วย “'+card.hook+'” '+card.reason;
    ideaHint();remember();show('create');brief.focus();
  }
  function present(data){
    if(!active()||data.id!==activeSearch)return;
    clearTimeout(poll);
    if(!['failed','done'].includes(data.state)){
      search.disabled=true;
      put(result,h('p',{role:'status'},data.state==='research'?'กำลังค้นและอ่านหน้าสินค้า Shopee ไทย…':'กำลังคิดมุมรีวิวและ Hook…'));
      poll=setTimeout(()=>check(data.id),1700);return;
    }
    search.disabled=false;
    put(result,data.notice?h('p',{role:'status'},data.notice):null,
      data.previous?h('p',{},'ผลล่าสุดที่มี · แสดงเวลาตรวจเดิมของแต่ละรายการ'):null,
      data.cards.map(card=>h('article',{class:'ugc-idea-card'},h('h3',{},card.name),
        h('p',{},[card.price,card.shop].filter(Boolean).join(' · ')),h('p',{},[card.label,card.signal].filter(Boolean).join(' · ')),
        h('p',{},card.reason),h('p',{},'“'+card.hook+'”'),
        h('div',{class:'row'},h('a',{href:card.url,target:'_blank',rel:'noopener noreferrer'},'Shopee · '+ugcDate(card.checked_at)+(card.cached?' · จากแคช':'')),
          action('ใช้ไอเดียนี้',()=>use(card,data.source_id))))));
  }
  async function check(id){
    if(!active()||activeSearch!==id)return;
    try{present(await api(ugcPath+'/ideas/'+id));}
    catch(e){if(active()){
      if(e.status===404){sessionStorage.removeItem('ms.ugc.idea-search');activeSearch='';search.disabled=false;put(result,h('p',{},e.message));}
      else put(result,h('p',{role:'status'},'ตรวจงานค้นหาเดิมไม่ได้ · '+e.message),action('ตรวจงานเดิม',()=>check(id)));
    }}
  }
  const search=h('button',{type:'button',class:'btn primary',on:{click:async()=>{
    if(search.disabled)return;
    if(query.value.trim().length<2||!brain.select.value){errors.textContent='กรอกคำค้นและเลือกโมเดลคิดไอเดีย';return;}
    search.disabled=true;errors.textContent='';clearTimeout(poll);
    try{const data=await draftPost(ugcPath+'/ideas',{query:query.value.trim(),model:brain.select.value});
      activeSearch=data.id;sessionStorage.setItem('ms.ugc.idea-search',activeSearch);present(data);}
    catch(e){if(active()){errors.textContent=e.message;search.disabled=false;}}
  }}},'หาไอเดียจาก Shopee');
  const panels={
    create:h('div',{id:'ugc-create',role:'tabpanel','aria-labelledby':'ugc-tab-create'},h('div',{class:'ugc-composer'},brief,
      h('div',{class:'ugc-attach'},h('label',{for:'ugc-attach',class:'btn'},'แนบรูปหรือคลิปสินค้า'),file,filename),hint,
      video.node,h('div',{class:'ugc-submit'},action('เตรียมคลิป',prepare,true))),old),
    ideas:h('div',{id:'ugc-ideas',role:'tabpanel','aria-labelledby':'ugc-tab-ideas'},h('div',{class:'ugc-composer'},query,brain.node,
      h('div',{class:'ugc-submit'},search)),result)};
  function show(next){
    tab=next;errors.textContent='';
    for(const t of tabs.children){const on=t.dataset.tab===next;t.setAttribute('aria-selected',String(on));t.tabIndex=on?0:-1;}
    for(const [key,panel] of Object.entries(panels))panel.hidden=key!==next;
    if(next==='ideas'&&!brain.initialized&&!brain.loading)void brain.update();
    if(next==='ideas'&&!activeSearch){const id=sessionStorage.getItem('ms.ugc.idea-search');if(id){activeSearch=id;search.disabled=true;void check(id);}}
    (next==='ideas'?query:brief).focus({preventScroll:true});
  }
  for(const [key,label] of [['create','สร้างคลิป'],['ideas','คิดไอเดีย']]){
    tabs.append(h('button',{type:'button',role:'tab',id:'ugc-tab-'+key,'aria-controls':'ugc-'+key,'data-tab':key,
      on:{click:()=>show(key),keydown:e=>{if(['ArrowLeft','ArrowRight'].includes(e.key)){e.preventDefault();show(tab==='create'?'ideas':'create');tabs.querySelector('[aria-selected="true"]').focus();}}}},label));
  }
  put(root,h('h1',{},'UGC AI'),tabs,errors,panels.create,panels.ideas);put(mainEl,root);show('create');
  void video.update();
  void api(ugcPath+'/drafts').then(({drafts})=>{
    if(active())old.append(drafts.length?ugcSelect([['','เลือกร่าง'],...drafts.map(d=>[d.id,d.name||d.brief||'ร่างสินค้า'])],'',id=>{if(id)openUgc(id);},'ร่าง UGC'):h('p',{class:'sub'},'ยังไม่มีร่าง'));
  }).catch(e=>{if(active())old.append(h('p',{},e.message));});
}

async function createUgc(product={}){
  const result=await draftPost(ugcPath+'/drafts',product);
  if(result?.id)openUgc(result.id);
}

async function renderUgc(config,drafts){
  const session=++ugcSession;
  const active=()=>S.view==='ugc' && session===ugcSession && root.isConnected;
  const root=h('section',{}), message=h('p',{role:'status'}), work=h('div',{});
  const pick=ugcSelect([['','เลือกร่าง'],...drafts.map(d=>[d.id,(d.name||'ร่างสินค้า')+(d.job_status?' · '+(ugcState[d.job_status]||d.job_status):'')])],
    ugcDraftId(),id=>{if(id)openUgc(id);},'ร่าง UGC');
  function button(label,action,disabled=false,primary=false){
    const btn=h('button',{type:'button',class:'btn'+(primary?' primary':''),disabled,on:{click:async()=>{
      btn.disabled=true;message.textContent='';
      try{await action();}
      catch(error){message.textContent=error.message;}
      finally{if(btn.isConnected)btn.disabled=disabled;}
    }}},label);
    return btn;
  }
  put(mainEl,root);
  root.append(h('h1',{},'UGC AI'),h('div',{class:'row'},button('กลับหน้าสร้างคลิป',()=>openUgc('')),pick),message,work);
  const id=ugcDraftId();
  if (!id) {work.append(h('p',{},'สร้างร่างเพื่ออัปโหลดรูปหรือ MP4 ของสินค้า หรือเลือกสินค้าจาก Notion'));return;}
  const path=ugcPath+'/drafts/'+id;
  let row;
  try {row=await api(path);}
  catch(error){if(active())message.textContent=error.message;return;}
  if(!active())return;
  let d=structuredClone(row.document);
  const newReviewer=()=>({kind:'',product_media_id:row.media.find(m=>(!m.role||m.role==='product')&&m.kind==='image')?.id||null,
    source_id:null,frame_id:null,opening_id:null,image_endpoint:config.image_models[0]});
  const upgrade=!d.reviewer&&!row.job_id&&!row.source_job_id;
  if(upgrade)Object.assign(d,{reviewer:newReviewer(),endpoint:config.creator_video_models[0],resolution:'720p',duration:18,
    scenes:[],hooks:[],hook:'',cta:d.product.order_url?'กดสั่งซื้อ':'ดูรายละเอียดสินค้า'});
  let dirty=upgrade;
  let quote=upgrade?null:row.quote;
  let imageQuote=upgrade?null:row.image_quote;
  let confirmed=false;
  let models=[],modelCatalog={};
  let modelsLoading=false,modelsLoaded=false,modelNotice='';
  const opened=new Set();
  const modelPanel=h('div',{class:'ugc-grid'});
  let imported=null;
  let quoteTimer;
  const priceBox=h('div',{});
  function set(key,value){
    const target=key.includes('.')?d[key.split('.')[0]]:d;
    target[key.split('.').at(-1)]=value;
    if(key==='presenter_direction'&&d.scenes[0])d.scenes[0].visual='Hold the product and speak Thai to camera. '+value;
    if(d.reviewer&&['product.name','product.variant','presenter_direction'].includes(key)){
      d.reviewer.opening_id=null;d.reviewer.frame_id=null;
      if(d.scenes.length){d.scenes[0].media_id=null;d.scenes.at(-1).media_id=null;}
    }
    invalidate();
  }
  function invalidate(){dirty=true;quote=null;imageQuote=null;confirmed=false;priceView();}
  async function save(removePortrait){
    if (!dirty) return;
    const submitted=JSON.stringify(d);
    row={...row,...await api(path,{method:'PATCH',body:JSON.stringify({revision:row.revision,document:JSON.parse(submitted),...(removePortrait?{remove_portrait:removePortrait}:{})})})};
    imageQuote=row.image_quote;
    dirty=JSON.stringify(d)!==submitted;
    if(!dirty&&d.reviewer){
      Object.assign(d.reviewer,row.document.reviewer);
      d.scenes.forEach((shot,i)=>{shot.media_id=row.document.scenes[i].media_id;});
    }
    if(dirty)throw Error('ร่างถูกแก้ระหว่างบันทึก กรุณาบันทึกอีกครั้ง');
  }
  function field(label,key,value,attrs={},tag='input'){
    const node=h(tag,{'aria-label':label,...attrs},tag==='textarea'?value:null);
    if(tag==='input')node.value=value;
    node.addEventListener('input',()=>set(key,attrs.type==='number' ? Number(node.value) : node.value));
    return h('label',{},label,node);
  }
  function reload(next){row={...row,...next};d=structuredClone(row.document);quote=row.quote;imageQuote=row.image_quote;dirty=false;render();}
  async function modelList(force=false){
    if(modelsLoading)return;
    modelsLoading=true;renderModels();
    try {
      const data=await api(ugcPath+(d.reviewer?'/catalog/video'+(force?'?refresh=1':''):'/models'));
      models=data.models;modelCatalog=data;modelsLoaded=true;
      modelNotice=catalogNotice(data);
    }
    catch(error){if(active())message.textContent=error.message;}
    finally {modelsLoading=false;if(active()){renderModels();priceView();}}
  }
  function renderModels(){
    const chosen=models.find(x=>x.id===d.endpoint);
    const options=models.filter(x=>(!d.reviewer||d.scenes.filter(s=>s.mode==='fal').every(s=>x.durations?.some(n=>n>=s.seconds)))&&
      (x.available&&(!d.reviewer||x.native_audio)||x.id===d.endpoint)).map(x=>[x.id,x.name]);
    if(!chosen&&d.endpoint&&!d.reviewer)options.unshift([d.endpoint,d.endpoint]);
    const fits=m=>d.scenes.filter(s=>s.mode==='fal').every(s=>m.durations?.some(n=>n>=s.seconds));
    const picker=rankedOptions(modelCatalog,fits);
    const compatible=picker.entries.filter(x=>!x.disabled&&x.endpoint===d.endpoint&&(!x.preset||x.preset===d.resolution.toLowerCase()));
    const prior=modelCatalog.ranked?.some(r=>r.key===d.arena_key);
    const selected=prior?compatible.find(e=>e.rank===d.arena_key):compatible[0];
    const resolutions=(chosen?.available?chosen.resolutions:[d.resolution].filter(Boolean))
      .filter(x=>!d.reviewer||(!selected?.preset||x.toLowerCase()===selected.preset)&&['360p','480p','720p','1080p'].includes(x.toLowerCase())).map(x=>[x,x]);
    const rate=chosen?.rates?.find(x=>x.resolution===d.resolution);
    const select=d.reviewer?h('select',{'aria-label':'โมเดลวิดีโอ'},ugcOption('','เลือกโมเดล'),picker.groups):
      ugcSelect([['','เลือกโมเดล'],...options],d.endpoint,()=>{},'โมเดลวิดีโอ');
    if(d.reviewer)select.value=selected?.key||'';
    select.onchange=()=>{
      const entry=picker.entries.find(e=>e.key===select.value&&!e.disabled);
      if(d.reviewer&&entry?.rank)d.arena_key=entry.rank;else delete d.arena_key;
      set('endpoint',d.reviewer?entry?.endpoint||'':select.value);
      const model=models.find(x=>x.id===d.endpoint);
      set('resolution',model?.resolutions.find(x=>x.toLowerCase()===(entry?.preset||'720p'))||model?.resolutions[0]||'');
      renderModels();
    };
    put(modelPanel,
      h('label',{},'โมเดลวิดีโอ fal.ai',select),
      h('label',{},'ความละเอียดภาพจาก fal',ugcSelect([['','เลือกความละเอียด'],...resolutions],d.resolution,v=>{
        set('resolution',v);renderModels();
      },'ความละเอียดภาพจาก fal')),
      rate?h('div',{},h('p',{},ugcRateText(rate)),
        h('a',{class:'sub',href:chosen.source_url,target:'_blank',rel:'noopener'},'ตรวจเรต '+ugcDate(chosen.checked_at))):
        h('p',{class:'sub'},chosen?.reason||(modelsLoading?'กำลังตรวจรุ่นและราคา…':'เลือกโมเดลและความละเอียดเพื่อดูเรต')),
      h('p',{role:'status',class:'sub'},[d.reviewer&&modelsLoaded&&d.endpoint&&!selected?'โมเดลที่เลือกใช้ไม่ได้แล้ว กรุณาเลือกใหม่':'',modelNotice].filter(Boolean).join(' · ')),
      button(modelsLoading?'กำลังอัปเดต…':d.reviewer?'อัปเดตอันดับและโมเดล':'อัปเดตโมเดล',()=>modelList(true),modelsLoading));
  }
  function productMedia(){return row.media.filter(x=>!x.role||x.role==='product');}
  function attachProduct(media,replace){
    if(d.reviewer && media.kind==='image' && (replace||!d.reviewer.product_media_id)){
      d.reviewer.product_media_id=media.id;
      d.reviewer.opening_id=null;
    }
    for(const shot of (d.reviewer?d.scenes.slice(1,-1):d.scenes)){
      if(!shot.media_id)shot.media_id=media.id;
    }
  }
  function mediaOptions(){
    return [['','เลือกสื่อ'],...productMedia().map((m,i)=>[m.id,(m.kind==='image'?'รูป':'วิดีโอ')+' '+(i+1)])];
  }
  const section=(title,...kids)=>h('section',{class:'ugc-block'},h('h2',{},title),kids);
  function fold(title,...children){
    return h('details',{class:'ugc-block','data-fold':title,open:opened.has(title)},h('summary',{},title),children);
  }
  function reveal(title){
    const detail=Array.from(work.querySelectorAll('details[data-fold]')).find(el=>el.dataset.fold===title);
    if(detail){detail.open=true;detail.scrollIntoView({block:'nearest'});}
  }
  function priceView(){
    clearTimeout(quoteTimer);
    if(!active())return;
    if(d.reviewer&&!d.reviewer.opening_id&&!row.job_id){
      put(priceBox,h('p',{},'เลือกคนรีวิวและยืนยันภาพเปิดก่อนคิดราคาวิดีโอ'));
      return;
    }
    if(d.reviewer&&modelsLoaded&&!row.job_id){
      const ranked=modelCatalog.ranked||[], prior=ranked.find(r=>r.key===d.arena_key);
      const matches=r=>r.available&&r.endpoint===d.endpoint&&(!r.resolution||r.resolution===d.resolution.toLowerCase());
      if(!(prior?matches(prior):modelCatalog.featured?.includes(d.endpoint)||ranked.some(matches))){
        put(priceBox,h('p',{},'กรุณาเลือกโมเดลวิดีโอที่ยังใช้ได้'));return;
      }
    }
    if(d.reviewer && !row.job_id && modelsLoaded && !models.some(m=>m.id===d.endpoint&&m.resolutions?.includes(d.resolution)&&d.scenes.filter(s=>s.mode==='fal').every(s=>m.durations?.some(n=>n>=s.seconds)))){
      put(priceBox,h('p',{role:'status'},'กรุณาเลือกโมเดลวิดีโอและความละเอียดที่ยังใช้ได้ก่อนตรวจราคา'),
        button('เลือกโมเดลวิดีโอ',()=>{reveal('บทและฉาก');modelPanel.scrollIntoView();}));return;
    }
    const ack=h('input',{type:'checkbox',on:{change:e=>{confirmed=e.target.checked;estimate.disabled=!confirmed;}}});
    ack.checked=confirmed;
    const estimate=button('ตรวจราคา',async()=>{
      await save();
      const next=await api(path+'/quote',ugcJSON('POST',{revision:row.revision,product_confirmed:true}));
      if(dirty||!confirmed)throw Error('ร่างเปลี่ยนระหว่างคิดราคา กรุณาตรวจใหม่');
      quote=next;
      priceView();
    },!confirmed);
    const contents=[h('label',{},h('span',{},ack,' ยืนยันว่าราคา โปร จุดขาย และ URL สั่งซื้อเป็นข้อมูลร้านที่ตรวจแล้ว')),estimate];
    if(quote){
      const q=quote;
      const rows=q.fal.map(x=>[q.plan.shots.findIndex(s=>s.id===x.scene_id)+1,x.model_name,x.resolution,x.edited_seconds,
        x.generation_seconds,x.billing_quantity+' '+(/^seconds?$/i.test(x.billing_unit)?'วิ':x.billing_unit),ugcUSD(x.unit_usd)+(x.reference_image_usd?' + '+ugcUSD(x.reference_image_usd)+'/รูป':''),
        q.reused.includes(x.slot)?'ใช้ไฟล์เดิม':ugcUSD(x.estimated_usd)]);
      const table=h('table',{class:'ugc-price'},h('thead',{},h('tr',{},['ฉาก','โมเดล','ความละเอียด','ในคลิป (วิ)','ส่ง fal (วิ)','หน่วยประเมิน','USD/หน่วย','ฉาก (USD)'].map(x=>h('th',{scope:'col'},x)))),
        h('tbody',{},rows.map(line=>h('tr',{},line.map(cell=>h('td',{},cell))))));
      const expiresIn=Date.parse(q.expires_at)-Date.now();
      const expired=expiresIn<=0;
      if(!expired)quoteTimer=setTimeout(priceView,expiresIn+50);
      contents.push(h('h3',{},'คลิป '+q.input.duration+' วิ · 9:16 · '+q.input.resolution),
        rows.length?table:h('p',{},'ใช้สื่อสินค้าจริงทุกฉาก'),
        q.fal.some(item=>item.billed_seconds>item.generation_seconds)?
          h('p',{class:'sub'},'ใบราคาของฉากที่มีวินาทีเผื่อใช้ความยาวผลลัพธ์ที่ประเมินไว้ ค่าจริงขึ้นกับวิดีโอที่ fal ส่งกลับ'):null,
        d.reviewer?h('p',{},row.media.find(m=>m.id===d.reviewer.opening_id)?.role==='opening'?
          'เฟรมเปิด · ใบราคาที่อนุมัติแยกไว้ '+ugcUSD(row.media.find(m=>m.id===d.reviewer.opening_id).details.estimated_usd):
          'เฟรมเปิดจากคลิปคนจริง · ตัดจากไฟล์เดิม'):null,
        h('p',{},'วิดีโอ fal.ai '+ugcUSD(q.fal_usd)+' · เสียง '+q.voice_model+' '+ugcUSD(q.eleven_usd)+' · ตัดต่อ '+ugcUSD(q.editing_usd)),
        h('p',{},'เรตเสียง '+ugcUSD(q.eleven[0].usd_per_1000_characters)+'/1,000 ตัวอักษร · '+ugcDate(q.voice_checked_at)),
        q.fal.map(item=>h('p',{class:'sub'},h('a',{href:item.pricing_source,target:'_blank',rel:'noopener'},item.model_name+' · ตรวจเรต '+ugcDate(item.pricing_checked_at)))),
        h('p',{},h('strong',{},'ยอดรวม '+ugcUSD(q.total_usd)+' USD'),' · '+(expired?'ใบราคาหมดอายุ':'ใช้ได้ถึง '+ugcDate(q.expires_at))),
        button('ยืนยันราคาและเริ่มผลิต',async()=>{
          if(Date.now()>=Date.parse(q.expires_at) || q.id!==quote?.id || dirty)throw Error('ตรวจราคาใหม่ก่อนเริ่มผลิต');
          try{
            await api(path+'/produce',ugcJSON('POST',{revision:row.revision,quote_id:q.id,approved:true}));
            go('ugc');
          }catch(error){
            if(error.status===409){quote=null;priceView();}
            throw error;
          }
        },expired,true));
    }
    put(priceBox,...contents);
  }
  function editScene(shot,index){
    const speaking=!!d.reviewer&&(index===0||index===d.scenes.length-1);
    const hasPrev=d.reviewer?index>1&&index<d.scenes.length-1:index>0;
    const hasNext=d.reviewer?index>0&&index<d.scenes.length-2:index<d.scenes.length-1;
    const edit=(key,value)=>{shot[key]=value;invalidate();};
    const control=(label,key,kind='text')=>{
      const node=h(kind==='textarea'?'textarea':'input',kind==='number'?{type:'number',min:2,max:15}:kind==='textarea'?{rows:2}:{});
      node.value=shot[key];
      node.addEventListener('input',()=>edit(key,kind==='number'?Number(node.value):node.value));
      return h('label',{},label,node);
    };
    const move=offset=>{[d.scenes[index],d.scenes[index+offset]]=[d.scenes[index+offset],shot];invalidate();render();};
    const preview=row.media.find(m=>m.id===shot.media_id);
    return h('article',{class:'ugc-scene'},h('div',{class:'row'},h('strong',{},'ฉาก '+(index+1)+(d.reviewer?(index===0?' · คนถือสินค้าเปิดคลิป':speaking?' · คนเดิมปิดด้วย CTA':' · รายละเอียดสินค้า'):'')),
      button('ขึ้น',()=>move(-1),!hasPrev),button('ลง',()=>move(1),!hasNext),
      button('นำฉากออก',()=>{d.scenes.splice(index,1);invalidate();render();},d.reviewer?(speaking||d.scenes.length<=3):d.scenes.length<=2)),
      h('div',{class:'ugc-grid'},
        speaking&&index===0?h('p',{},'0–3 วินาที'):control('ความยาว (วิ)','seconds','number'),
        speaking?h('p',{},'ใช้ภาพเปิดที่อนุมัติและเสียงจากโมเดลวิดีโอ'):h('label',{},'ภาพ',ugcSelect([['original','สื่อจริง · รุ่น โลโก้ แพ็กเกจ'],['fal','ขยับภาพด้วย fal.ai']],shot.mode,v=>edit('mode',v),'ชนิดภาพฉาก '+(index+1))),
        speaking?null:h('label',{},'สื่ออ้างอิง',ugcSelect(mediaOptions(),shot.media_id||'',v=>edit('media_id',v||null),'สื่อฉาก '+(index+1)))),
      preview?.kind==='image'?h('div',{class:'ugc-media'},h('img',{src:preview.url,alt:'ภาพอ้างอิงฉาก '+(index+1)})):null,
      index===0&&!d.reviewer?h('p',{},'บทพูดเปิดใช้ Hook ที่เลือก'):control('บทพูดไทย','narration','textarea'),
      control('ซับที่แก้เอง (เว้นว่างเพื่อใช้บทพูด)','subtitle','textarea'),
      control('ภาพและการเคลื่อนไหว','visual','textarea'),control('มุมกล้อง','camera'));
  }
  function addScene(){
    const id=Array.from({length:99},(_,i)=>'shot_'+String(i+1).padStart(2,'0')).find(id=>!d.scenes.some(x=>x.id===id));
    d.scenes.push({id,seconds:d.scenes.length?5:4,narration:'ดูรายละเอียดได้ที่หน้าร้าน',
      subtitle:'',visual:'Show the product in good light',camera:'steady close-up',mode:'original',media_id:productMedia()[0]?.id||null});
    if(d.reviewer&&d.scenes.length>1)d.scenes.splice(d.scenes.length-2,0,d.scenes.pop());
    invalidate();render();
  }
  function notionPanel(){
    if(!config.notion.enabled)return h('p',{class:'sub'},'ตั้งค่าฐานสินค้า Notion ด้วย UGC_NOTION_TOKEN และ UGC_NOTION_DATABASE_IDS');
    const content=h('div',{});
    const database=ugcSelect(config.notion.databases.map(id=>[id,id]),config.notion.mapping?.database_id||config.notion.databases[0],()=>put(content),'Notion database');
    async function mapping(){
      const {columns}=await api(ugcPath+'/notion/columns/'+database.value);
      const types={name:['title','rich_text','select'],variant:['title','rich_text','number','select','multi_select'],
        price:['number','rich_text'],promo:['rich_text','select'],selling_points:['rich_text','multi_select','select'],order_url:['url','rich_text'],media:['files']};
      const labels={name:'ชื่อ',variant:'รุ่น',price:'ราคา (บาท)',promo:'โปรโมชัน',selling_points:'จุดขาย',order_url:'URL สั่งซื้อ',media:'รูปหรือวิดีโอ'};
      const selects=Object.entries(types).map(([key,allowed])=>{
        const component=ugcSelect([['','ไม่ใช้'],...columns.filter(x=>allowed.includes(x.type)).map(x=>[x.id,x.name])],
          config.notion.mapping?.database_id===database.value?config.notion.mapping.fields[key]||'':'',()=>{},labels[key]);
        return {key,component,label:labels[key]};
      });
      put(content,h('div',{class:'ugc-grid'},selects.map(x=>h('label',{},x.label,x.component))),
        button('บันทึก mapping',async()=>{
          config.notion.mapping=await api(ugcPath+'/notion/config',ugcJSON('PUT',{database_id:database.value,
            fields:Object.fromEntries(selects.map(x=>[x.key,x.component.value||'']))}));
          await products();
        }));
    }
    async function products(cursor){
      const r=await api(ugcPath+'/notion/products'+(cursor?'?cursor='+encodeURIComponent(cursor):''));
      const selector=ugcSelect([['','เลือกสินค้า'],...r.items.map(x=>[x.id,x.name])],'',()=>{},'สินค้า Notion');
      put(content,selector,button('ใช้สินค้านี้',async()=>{
        if(!selector.value)throw Error('เลือกสินค้าจาก Notion ก่อน');
        imported=await api(path+'/import-notion',ugcJSON('POST',{page_id:selector.value}));
        d.product=imported.product;
        if(imported.media){
          row.media.push(imported.media);
          attachProduct(imported.media,true);
        }
        invalidate();await save();render();
        message.textContent=imported.warning||'นำเข้าสินค้าแล้ว ตรวจราคาและ URL ก่อนผลิต';
      }),r.next?button('สินค้าหน้าถัดไป',()=>products(r.next)):null);
    }
    return h('details',{},h('summary',{},'เลือกสินค้าจาก Notion'),h('div',{class:'row'},database,
      button('ตั้งค่า mapping',mapping),button('แสดงสินค้า',()=>products())),content);
  }
  async function uploadMedia(file,role){
    const chosen=file.files[0];
    if(!chosen||chosen.size>32*1024*1024)throw Error('เลือกไฟล์ขนาดไม่เกิน 32 MB');
    const added=await api(path+'/media?role='+role,{method:'POST',headers:{'content-type':'application/octet-stream'},body:chosen});
    row.media.push(added);
    return added;
  }
  // Keep a user's selected clip if a draft status update redraws this panel before Upload.
  const reviewerClipFile=h('input',{type:'file',accept:'video/mp4'});
  function reviewerPanel(planning){
    const r=d.reviewer;
    if(!r)return null;
    async function persistInputs(key,value,removePortrait){
      r[key]=value;r.opening_id=null;r.frame_id=null;
      if(d.scenes.length){d.scenes[0].media_id=null;d.scenes.at(-1).media_id=null;}
      invalidate();await save(removePortrait);reload(await api(path));
    }
    const change=(key,value)=>persistInputs(key,value).catch(e=>{message.textContent=e.message;});
    const product=productMedia().filter(m=>m.kind==='image');
    const sourceMedia=row.media.filter(m=>m.role==='presenter'&&m.kind===(r.kind==='clip'?'video':'image'));
    const source=sourceMedia.find(m=>m.id===r.source_id);
    const reviewed=r.kind==='clip'?row.media.filter(m=>m.role==='frame'&&m.matches_frame!==false&&m.details.source_id===r.source_id):
      row.media.filter(m=>m.role==='opening'&&m.matches_reviewer);
    const approved=reviewed.find(m=>m.id===r.opening_id);
    const job=row.image_job, waiting=job&&!['READY_TO_POST','FAILED','CANCELLED'].includes(job.status);
    const reel=r.kind==='clip'&&source?h('video',{class:'ugc-player',controls:true,playsinline:true,preload:'metadata',src:source.url,
      'aria-label':'คลิปคนรีวิวสำหรับเลือกเฟรม'}):null;
    const file=reviewerClipFile;
    const portraitInput=h('input',{type:'file',id:'ugc-portrait',class:'ugc-file',disabled:!config.storage,accept:'image/jpeg,image/png,image/webp','aria-label':'อัปโหลดรูปคนรีวิว'});
    const usePortrait=async media=>{
      r.kind='portrait';
      await persistInputs('source_id',media.id);
    };
    portraitInput.onchange=async()=>{
      if(!portraitInput.files.length)return;
      portraitInput.disabled=true;
      try{
        const media=await uploadMedia(portraitInput,'presenter');
        if(media.kind!=='image')throw Error('โปรดเลือกรูปคนรีวิว');
        await usePortrait(media);
      }catch(e){message.textContent=e.message;portraitInput.disabled=false;}
    };
    function notionReviewers(){
      if(!config.notion.reviewers_enabled)return h('div',{},h('button',{class:'btn',type:'button',disabled:true},'เลือกรูปจาก Notion'),h('p',{class:'sub'},'ยังไม่ได้ตั้งค่าฐานคนรีวิว Notion'));
      const list=h('div',{class:'ugc-portraits'}),notice=h('small',{role:'status'}),more=h('div',{});
      const query=h('input',{'aria-label':'ค้นหาคนรีวิว',placeholder:'ชื่อคนรีวิว',maxlength:140});
      let seq=0;
      async function search(q,cursor){
        const attempt=++seq;notice.textContent='กำลังโหลดรูปคนรีวิว…';put(more);if(!cursor)put(list);
        try{
          const page=await api(ugcPath+'/notion/reviewers?q='+encodeURIComponent(q)+(cursor?'&cursor='+encodeURIComponent(cursor):''));
          if(seq!==attempt)return;
          for(const item of page.items){
            const pick=button(item.name,async()=>{
              const media=await api(path+'/import-reviewer',ugcJSON('POST',{page:item.page,file:item.file}));
              row.media.push(media);await usePortrait(media);
            });
            pick.title=item.filename||item.name;
            pick.prepend(h('img',{src:item.thumbnail,alt:'',loading:'lazy',width:56,height:64}));
            list.append(pick);
          }
          notice.textContent=list.children.length?'':'ไม่พบรูปที่ใช้ได้ในฐานคนรีวิว';
          if(page.next)put(more,button('ดูคนรีวิวเพิ่ม',()=>search(q,page.next)));
        }catch(e){if(seq===attempt)notice.textContent=e.message;}
      }
      const panel=h('details',{},h('summary',{},'เลือกรูปจาก Notion'),query,button('ค้นหาคนรีวิว',()=>search(query.value.trim())),notice,list,more);
      panel.ontoggle=()=>{if(panel.open&&!seq)void search('');};
      query.onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();void search(query.value.trim());}};
      return panel;
    }
    const quotePanel=h('div',{});
    function displayQuote(){
      const q=imageQuote;
      const fresh=q&&Date.parse(q.expires_at)>Date.now();
      put(quotePanel,fresh?h('div',{},
        h('p',{},q.item.model_name+' · '+q.item.resolution+' · '+ugcUSD(q.item.unit_usd)+' / ภาพ · รวม '+ugcUSD(q.item.estimated_usd)+' USD'),
        h('a',{href:q.item.pricing_source,target:'_blank',rel:'noopener'},'ตรวจเรต '+ugcDate(q.item.pricing_checked_at)),
        button('ยืนยันราคาและเตรียมภาพเปิด',async()=>{
          if(dirty||q.id!==imageQuote?.id||Date.parse(q.expires_at)<=Date.now())throw Error('ตรวจราคาภาพล่าสุดก่อนยืนยัน');
          try {
            await api(path+'/produce-image',ugcJSON('POST',{revision:row.revision,quote_id:q.id,approved:true}));
            reload(await api(path));
          }catch(error){imageQuote=null;displayQuote();throw error;}
        },waiting,true)):q?h('p',{},'ใบราคาภาพหมดอายุ'):null);
    }
    displayQuote();
    async function approve(media){
      if(r.kind==='clip')r.frame_id=media.id;
      r.opening_id=media.id;
      if(d.scenes.length){d.scenes[0].media_id=media.id;d.scenes.at(-1).media_id=media.id;}
      invalidate();
      await save();
      reload(await api(path));
    }
    return fold('คนรีวิวและภาพเปิด',h('fieldset',{disabled:planning},
      h('label',{},'คนรีวิว',ugcSelect([['','เลือกคนรีวิว'],['clip','คลิปคนจริงถือสินค้า'],['portrait','รูปคนรีวิว'],['ai','สร้างพิธีกร AI']],r.kind,
        value=>{if(value===r.kind)return;r.source_id=null;change('kind',value);},'คนรีวิว')),
      h('div',{class:'ugc-attach'},h('label',{for:'ugc-portrait',class:'btn'},'อัปโหลดรูปคนรีวิว'),portraitInput),notionReviewers(),
      r.kind==='portrait'&&source?h('div',{class:'ugc-media'},
        h('img',{src:source.url,alt:'รูปคนรีวิวที่เลือก'}),button('ลบรูปคนรีวิว',()=>persistInputs('source_id',null,source.id))):null,
      product.length>1?h('label',{},'รูปสินค้าสำหรับเฟรมเปิด',ugcSelect([['','เลือกรูป'],...product.map((m,i)=>[m.id,'รูปสินค้า '+(i+1)])],
        r.product_media_id,value=>change('product_media_id',value||null),'รูปสินค้าสำหรับเฟรมเปิด')):null,
      !r.kind?h('p',{},'เลือกว่าใครจะถือหรือสาธิตสินค้าใน 3 วินาทีแรก'):null,
      r.kind==='clip'?h('div',{},
        h('label',{},r.kind==='clip'?'คลิป MP4 ที่เห็นหน้า มือ และสินค้า':'รูปคนรีวิวที่อนุญาตให้ใช้',file),
        button('อัปโหลดสื่อคนรีวิว',async()=>{
          const added=await uploadMedia(file,'presenter');
          await persistInputs('source_id',added.id);file.value='';
        },!config.storage),
        sourceMedia.length>1?h('label',{},'สื่อของคนรีวิว',ugcSelect(sourceMedia.map((m,i)=>[m.id,'สื่อคนรีวิว '+(i+1)]),
          r.source_id, v=>change('source_id',v),'สื่อของคนรีวิว')):null):null,
      reel,
      reel?button('เลือกเฟรมจากตำแหน่งที่เล่นอยู่',async()=>{
        if(!Number.isFinite(reel.duration)||reel.currentTime>=reel.duration)throw Error('เลื่อนคลิปไปยังเฟรมที่เห็นคนกับสินค้าชัด');
        const seconds=Math.round(reel.currentTime*1000)/1000;
        await save();
        await api(path+'/extract-frame',ugcJSON('POST',{revision:row.revision,seconds}));
        reload(await api(path));
      },waiting||!r.product_media_id):null,
      ['ai','portrait'].includes(r.kind)?h('div',{class:'ugc-grid'},
        h('label',{},'โมเดลเตรียมภาพ',ugcSelect(config.image_models.map((x,i)=>[x,i===0?'Nano Banana Pro':'Nano Banana 2']),
          r.image_endpoint,v=>change('image_endpoint',v),'โมเดลเตรียมภาพ')),
        button('ตรวจราคาภาพเปิด',async()=>{
          await save();
          imageQuote=await api(path+'/image-quote',ugcJSON('POST',{revision:row.revision}));
          displayQuote();
        },waiting||!r.product_media_id||(r.kind==='portrait'&&!source)),quotePanel):null,
      waiting?h('p',{role:'status'},job.is_frame?'กำลังตัดเฟรมจากคลิป':'กำลังเตรียมภาพเปิด'):job?.error?h('p',{role:'alert'},job.error):null,
      reviewed.length?h('div',{},h('p',{},'ตรวจหน้า มือ โลโก้ และกล่องสินค้าจริงก่อนยืนยัน'),
        reviewed.slice().reverse().map(m=>h('div',{class:'ugc-scene'},h('a',{href:m.url,target:'_blank',rel:'noopener',class:'ugc-opening'},
          h('img',{src:m.url,alt:'ภาพเปิดคนถือสินค้า'})),
          m.details?.seconds!==undefined?h('p',{},'เฟรมที่ '+m.details.seconds+' วิ'):null,
          m.role==='opening'?h('p',{},[m.details.model,'อนุมัติ '+ugcUSD(m.details.estimated_usd),
            m.details.actual_usd==null?'ยอดจริงรอ fal ยืนยัน':'ยอดจริง '+ugcUSD(m.details.actual_usd)].join(' · ')):null,
          approved?.id===m.id?h('strong',{},'ยืนยันภาพเปิดแล้ว'):button('ยืนยันภาพเปิดนี้',()=>approve(m))))):null));
  }
  function chooseAngle(angle){
    d.hook=angle.hook;
    const r=d.reviewer;
    d.scenes=[
      {id:'shot_01',seconds:3,narration:angle.opening,visual:'Hold the product up beside the face, make eye contact and speak to the phone camera. '+(d.presenter_direction||''),camera:'Eye-level medium close-up',mode:'fal',media_id:r.opening_id},
      {id:'shot_02',seconds:d.duration-7,narration:angle.middle,visual:'Show the real product details that help a buyer decide.',camera:'Steady close-up',mode:'original',media_id:d.scenes[1]?.media_id||r.product_media_id||productMedia()[0]?.id||null},
      {id:'shot_03',seconds:4,narration:angle.close,visual:'The same reviewer shows the product and gives the short call to action.',camera:'Natural medium close-up',mode:'fal',media_id:r.opening_id},
    ].map(s=>({...s,subtitle:''}));
    invalidate();render();
  }
  let pollTimer;
  function reviewScenes(job,player,canEdit){
    if(!job.presenter||!job.video)return null;
    let start=0;
    return h('section',{class:'ugc-block'},h('h2',{},'ตรวจคลิปทีละฉาก'),job.scenes.map((scene,index)=>{
      const offset=start;
      start+=scene.seconds;
      const checks={presenter:'',product:'',thai:'',lip_sync:'',captions:'',cta:'',...scene.review?.checks};
      const labels={
        presenter:'คนในเฟรม ใบหน้า และมือ',product:'สินค้า กล่อง และโลโก้',thai:'เสียงและคำพูดภาษาไทย',
        lip_sync:'ปากตรงเสียง',captions:'ซับตรงบท',cta:'CTA ตรงกับร้าน',
      };
      const note=h('textarea',{rows:2,maxlength:450,'aria-label':'จุดที่ต้องแก้ฉาก '+(index+1)},scene.review?.note||'');
      const edits=Object.keys(labels).filter(k=>(k!=='lip_sync'&&k!=='presenter'||scene.speaking)&&(k!=='cta'||index===job.scenes.length-1));
      const flag=h('strong',{},Object.values(checks).includes('ต้องแก้')?'ต้องแก้':edits.every(k=>checks[k]==='ผ่าน')?'ตรวจแล้ว':'รอตรวจ');
      return h('article',{class:'ugc-scene'},
        h('div',{class:'row'},h('strong',{},'ฉาก '+(index+1)+' · '+offset+'–'+start+' วิ'),flag,
          button('ดูฉาก '+(index+1),async()=>{player.currentTime=offset;await player.play();})),
        scene.preview?h('div',{class:'ugc-media'},h('img',{src:scene.preview,alt:'เฟรมที่เรนเดอร์ฉาก '+(index+1)})):null,
        scene.technical?.frame_review?h('p',{role:'status'},'เฟรมแรกต่างจากภาพที่อนุมัติ ตรวจว่าคนและสินค้ายังอยู่ในเฟรม'):null,
        h('p',{},'บทพูด · '+scene.narration),h('p',{},'ซับ · '+scene.subtitle),
        index===job.scenes.length-1?h('p',{},[job.notes.cta,job.notes.order_url].filter(Boolean).join(' · ')):null,
        canEdit?h('div',{},h('div',{class:'ugc-grid'},edits.map(k=>h('label',{},labels[k],
          ugcSelect([['','ยังไม่ตรวจ'],['ผ่าน','ผ่าน'],['ต้องแก้','ต้องแก้']],checks[k],v=>{checks[k]=v;},labels[k]+' ฉาก '+(index+1))))),
          note,button('บันทึกผลตรวจฉาก '+(index+1),async()=>{
            await api(ugcPath+'/jobs/'+job.id+'/review',ugcJSON('PUT',{scene:scene.id,checks,note:note.value}));
            flag.textContent=edits.some(k=>checks[k]==='ต้องแก้')?'ต้องแก้':edits.every(k=>checks[k]==='ผ่าน')?'ตรวจแล้ว':'รอตรวจ';
          }),
          button('แก้เฉพาะฉาก '+(index+1),async()=>{
            await api(path+'/edit',ugcJSON('POST',{job_id:job.id,scene:scene.id}));go('ugc');
          })):null);
    }));
  }
  async function statusView(){
    const current=row.job_id;
    const status=h('div',{}),view=h('div',{});
    const history=row.history||[];
    const historySelect=ugcSelect(history.map(x=>[x.id,ugcDate(x.created_at)+' · '+(ugcState[x.status]||x.status)]),current,
      id=>update(id),'ฉบับผลิต');
    const selected=()=>historySelect.value||current;
    put(work,section(d.product.name||'งาน UGC',history.length>1?historySelect:null,status,view));
    let displayed='';
    async function update(jobId){
      clearTimeout(pollTimer);
      try {
        const job=await api(ugcPath+'/jobs/'+jobId);
        if(!active()||jobId!==selected())return;
        const usage=job.fal_usage||[];
        put(status,h('h3',{},ugcState[job.status]||job.status),h('progress',{value:job.progress||0,max:1}),
          job.error?h('p',{role:'alert'},job.error):null,
          h('ol',{},job.scenes.map(s=>h('li',{},[s.state==='done'?'ภาพพร้อม':s.state==='rendering'?'กำลังเตรียมภาพ':s.state==='review'?'ต้องตรวจเสียงหรือภาพ':'รอภาพ',
            s.video?'fal · '+(ugcPaid[s.video]||s.video):'',s.voice?'เสียง · '+(ugcPaid[s.voice]||s.voice):''].filter(Boolean).join(' · ')))),
          usage.length?h('details',{},h('summary',{},'ค่าใช้ fal.ai รายครั้ง'),h('ol',{},usage.map(call=>{
            const index=job.scenes.findIndex(s=>'fal:'+s.id===call.slot);
            const amount=call.reused?'ใช้คลิปเดิม':[
              call.estimated_usd==null?'':'อนุมัติ '+ugcUSD(call.estimated_usd),
              call.actual_usd==null?'ยอดจริงรอ fal ยืนยัน':'ยอดจริง '+ugcUSD(call.actual_usd),
            ].filter(Boolean).join(' · ');
            return h('li',{},[index>=0?'ฉาก '+(index+1):call.slot,call.model_name,call.resolution,
              ugcPaid[call.status]||call.status,amount].filter(Boolean).join(' · '));
          }))):null);
        if(job.status==='FAILED'&&jobId===current){priceView();status.append(priceBox);}
        if(displayed!==(job.video?'video:':'')+jobId+job.status){
          displayed=(job.video?'video:':'')+jobId+job.status;
          const player=job.video?h('video',{class:'ugc-player',controls:true,playsinline:true,preload:'metadata',src:job.video}):null;
          put(view,player?h('div',{},player,
            h('div',{class:'row'},h('a',{class:'btn primary',href:job.download},'ดาวน์โหลด MP4'),
              job.notes.order_url?h('a',{class:'btn',href:job.notes.order_url,target:'_blank',rel:'noopener noreferrer'},'สั่งซื้อ'):null,
              button('คัดลอกแคปชันและลิงก์',async()=>{await navigator.clipboard.writeText([job.notes.caption,job.notes.order_url].filter(Boolean).join('\n'));message.textContent='คัดลอกแล้ว';})),
            h('textarea',{readonly:true,'aria-label':'แคปชันและ URL สั่งซื้อ',rows:3},[job.notes.caption,job.notes.order_url].filter(Boolean).join('\n')),
            reviewScenes(job,player,jobId===current)):null,
            ['READY_TO_POST','FAILED','CANCELLED'].includes(job.status)&&jobId===current?h('div',{class:'row'},
              button('เปิดฉบับแก้ไข',async()=>{await api(path+'/edit',ugcJSON('POST',{job_id:jobId}));go('ugc');}),
              ...job.scenes.flatMap((scene,i)=>scene.mode==='fal'&&(!job.presenter||!job.video)?[button('สร้างฉาก '+(i+1)+' ใหม่',async()=>{
                await api(path+'/edit',ugcJSON('POST',{job_id:jobId,scene:scene.id}));go('ugc');
              })]:[])):null);
        }
        if(!['READY_TO_POST','FAILED','CANCELLED'].includes(job.status))pollTimer=setTimeout(()=>update(jobId),2500);
      }catch(error){if(active()){message.textContent=error.message;pollTimer=setTimeout(()=>update(jobId),5000);}}
    }
    await update(current);
  }
  function render(){
    clearTimeout(pollTimer);
    if(!active())return;
    if(row.job_id){void statusView();return;}
    opened.clear();
    for(const el of work.querySelectorAll('details[data-fold][open]'))opened.add(el.dataset.fold);
    const planning=['queued','submitting','accepted'].includes(row.planning?.state);
    const history=row.history?.filter(x=>x.status==='READY_TO_POST')||[];
    const file=h('input',{type:'file',accept:'image/jpeg,image/png,image/webp,video/mp4'});
    const upload=button('อัปโหลดสื่อ',async()=>{
      const added=await uploadMedia(file,'product');
      attachProduct(added,false);
      invalidate();await save();render();
    },!config.storage);
    const product=h('fieldset',{disabled:planning},h('div',{class:'ugc-grid'},
      field('ชื่อสินค้า','product.name',d.product.name,{maxlength:140}),
      field('รุ่น','product.variant',d.product.variant,{maxlength:80}),
      field('ราคา (บาท)','product.price',d.product.price,{inputmode:'decimal',maxlength:32}),
      field('โปรโมชัน','product.promo',d.product.promo,{maxlength:100}),
      field('URL สั่งซื้อ','product.order_url',d.product.order_url,{type:'url',maxlength:2048}),
      field('จุดขายที่ร้านยืนยันแล้ว','product.selling_points',d.product.selling_points,{rows:2,maxlength:1400},'textarea')),
      h('label',{},'รูปสินค้า หรือวิดีโอ MP4 (32 MB)',file),upload,
      h('div',{class:'ugc-media'},productMedia().map((m,i)=>m.kind==='image'?
        h('img',{src:m.url,alt:'รูปสินค้า '+(i+1)}):h('video',{src:m.url,'aria-label':'วิดีโอสินค้า '+(i+1),controls:true,preload:'metadata'}))),
      notionPanel(),
      row.evidence.length?h('details',{},h('summary',{},'หลักฐานเทรนด์สินค้า'),h('ul',{},row.evidence.map(e=>h('li',{},
        h('a',{href:e.url,target:'_blank',rel:'noopener noreferrer'},e.title||e.url),' · '+e.quote)))):null);
    renderModels();
    const selectedHook=ugcSelect([['','เลือก Hook'],...d.hooks.map(x=>[x,x])],d.hook,v=>{set('hook',v);render();},'Hook ที่ AI เสนอ');
    const plan=h('fieldset',{disabled:planning},
      h('div',{class:'ugc-grid'},
        field('บรีฟภาษาธรรมชาติ','brief',d.brief,{rows:2,maxlength:1600,placeholder:'คนถือรองเท้าพูดกับกล้อง ขายเร็ว เน้นโปรและการจัดส่ง'},'textarea'),
        field('ความยาวรวม (วิ)','duration',d.duration,{type:'number',min:d.reviewer?12:8,max:d.reviewer?22:30}),
        h('label',{},'สมอง OpenAI',ugcSelect([...new Set([d.model,...config.brains])].map(x=>[x,x]),d.model,v=>set('model',v),'สมอง OpenAI')),
        h('label',{},'ระดับการคิด',ugcSelect(['low','medium','high'].map(x=>[x,x]),d.reasoning,v=>set('reasoning',v),'ระดับการคิด'))),
      button('ให้ AI เสนอ 3 Hook และวางฉาก',async()=>{
        await save();
        const result=await draftPost(path+'/suggest',{revision:row.revision});
        reload(result);
      },!config.openai),
      planning?h('p',{role:'status'},'กำลังเขียน Hook และวางฉาก…'):row.planning?.error?h('p',{role:'alert'},row.planning.error):h('p',{class:'sub'},'การขอบทใช้โทเค็น OpenAI ตามสมองที่เลือก'),
      d.reviewer?(d.angles||[]).map((angle,i)=>h('article',{class:'ugc-scene'},
        h('strong',{},angle.hook),h('p',{},[angle.opening,angle.middle,angle.close].join(' · ')),
        button(d.hook===angle.hook?'เลือกมุมนี้แล้ว':'เลือกมุม '+(i+1),()=>chooseAngle(angle),d.hook===angle.hook))):
      h('div',{class:'ugc-grid'},h('label',{},'Hook ที่ AI เสนอ',selectedHook),field('Hook ที่จะใช้','hook',d.hook,{maxlength:85})),
      d.scenes.map(editScene),button('เพิ่มฉาก',addScene,d.scenes.length>=10||(d.reviewer&&d.scenes.length===0)),modelPanel);
    const toggled=(key,label)=>{
      const input=h('input',{type:'checkbox',on:{change:e=>set(key,e.target.checked)}});
      input.checked=d[key];
      return h('label',{},h('span',{},input,' '+label));
    };
    if(row.regenerate_scene&&!dirty)message.textContent='ระบบจะสร้างใหม่เฉพาะฉากที่เลือกและใช้สื่อที่ทำเสร็จแล้วกับฉากอื่น';
    put(work,
      history.length?h('details',{},h('summary',{},'คลิปที่เคยผลิต'),history.map(x=>button(ugcDate(x.created_at),async()=>{
        const j=await api(ugcPath+'/jobs/'+x.id);
        const preview=h('dialog',{},h('video',{class:'ugc-player',controls:true,src:j.video}),h('a',{class:'btn',href:j.download},'ดาวน์โหลด MP4'),
          button('ปิด',()=>{preview.close();preview.remove();}));
        root.append(preview);preview.showModal();
      }))):null,
      section('สรุปร่าง',planning?h('p',{role:'status'},'กำลังเขียน Hook และวางฉาก…'):null,
        row.planning?.error?h('p',{role:'alert'},row.planning.error):null,
        h('p',{},d.product.name||d.brief||'ร่างสินค้า'),h('p',{class:'sub'},d.duration+' วินาที · 9:16 · '+(d.endpoint||'ยังไม่ได้เลือกโมเดลวิดีโอ')),
        d.reviewer && !planning?h('div',{},
          field('คนรีวิวและท่าเปิดคลิป','presenter_direction',d.presenter_direction||'',{maxlength:400,rows:2},'textarea'),
          d.hook?field('Hook ของคลิป','hook',d.hook,{maxlength:85}):null,
          d.scenes.length?h('label',{},'บทพูดเปิด',h('textarea',{'aria-label':'บทพูดเปิด',rows:2,maxlength:160,on:{input:e=>{d.scenes[0].narration=e.target.value;invalidate();}}},d.scenes[0].narration)):null,
          d.scenes.length?h('ol',{start:2},d.scenes.slice(1).map(s=>h('li',{},s.narration))):null,
          button('บันทึกร่าง',async()=>{await save();message.textContent='บันทึกแล้ว';})):null,
        !planning&&d.reviewer&&!d.reviewer.product_media_id?button('เพิ่มรูปสินค้าจริง',()=>{reveal('รายละเอียดสินค้า');work.querySelector('input[type=file]')?.focus();}):
        !planning&&d.reviewer&&!d.reviewer.opening_id?button('ตรวจภาพคนถือสินค้า',()=>{reveal('คนรีวิวและภาพเปิด');}):null),
      fold('รายละเอียดสินค้า',product),reviewerPanel(planning),fold('บทและฉาก',plan),
      fold('ข้อความตอนตัดต่อ',h('fieldset',{disabled:planning},h('div',{class:'ugc-grid'},
        field('แคปชันสำหรับโพสต์','caption',d.caption,{rows:2,maxlength:500},'textarea'),
        field('ข้อความปุ่มสั่งซื้อ','cta',d.cta,{maxlength:40}),toggled('show_price','แสดงราคา'),toggled('show_promo','แสดงโปรโมชัน')),
        button('บันทึกข้อความตัดต่อ',async()=>{await save();message.textContent='บันทึกแล้ว';}))),
      section('ราคาก่อนผลิต',planning?null:priceBox));
    const imagePending=row.image_job&&!['READY_TO_POST','FAILED','CANCELLED'].includes(row.image_job.status);
    if (planning||imagePending) pollTimer=setTimeout(async()=>{
      if(!active())return;
      try{
        const next=await api(path);
        if(!active())return;
        if(!dirty)reload(next);
        else {
          row={...row,image_job:next.image_job,media:next.media};
          render();
        }
      }
      catch(error){message.textContent=error.message;pollTimer=setTimeout(render,4200);}
    },2400);
    if(!planning)priceView();
  }
  render();
  if(!row.job_id)void modelList();
}
