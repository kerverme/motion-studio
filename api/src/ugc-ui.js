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
async function createUgc(product={}){
  const result=await draftPost(ugcPath+'/drafts',product);
  if(result?.id){localStorage.setItem('ms.ugc.draft',result.id);go('ugc');}
}

async function renderUgc(config,drafts){
  const session=++ugcSession;
  const active=()=>S.view==='ugc' && session===ugcSession && root.isConnected;
  const root=h('section',{}), message=h('p',{role:'status'}), work=h('div',{});
  const pick=ugcSelect([['','เลือกร่าง'],...drafts.map(d=>[d.id,(d.name||'ร่างสินค้า')+(d.job_status?' · '+(ugcState[d.job_status]||d.job_status):'')])],
    localStorage.getItem('ms.ugc.draft')||'',id=>{if(id){localStorage.setItem('ms.ugc.draft',id);go('ugc');}},'ร่าง UGC');
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
  root.append(h('h1',{},'UGC AI'),h('div',{class:'row'},button('สร้างร่างสินค้า',()=>createUgc(),false,true),pick),message,work);
  const id=pick.value;
  if (!id) {work.append(h('p',{},'สร้างร่างเพื่ออัปโหลดรูปหรือ MP4 ของสินค้า หรือเลือกสินค้าจาก Notion'));return;}
  const path=ugcPath+'/drafts/'+id;
  let row;
  try {row=await api(path);}
  catch(error){if(active())message.textContent=error.message;return;}
  if(!active())return;
  let d=structuredClone(row.document);
  let dirty=false;
  let quote=row.quote;
  let confirmed=false;
  let models=[];
  let modelsLoading=false;
  const modelPanel=h('div',{class:'ugc-grid'});
  let imported=null;
  let quoteTimer;
  const priceBox=h('div',{});
  function set(key,value){
    const target=key.includes('.')?d[key.split('.')[0]]:d;
    target[key.split('.').at(-1)]=value;
    invalidate();
  }
  function invalidate(){dirty=true;quote=null;confirmed=false;priceView();}
  async function save(){
    if (!dirty) return;
    const submitted=JSON.stringify(d);
    row={...row,...await api(path,{method:'PATCH',body:JSON.stringify({revision:row.revision,document:JSON.parse(submitted)})})};
    dirty=JSON.stringify(d)!==submitted;
    if(dirty)throw Error('ร่างถูกแก้ระหว่างบันทึก กรุณาบันทึกอีกครั้ง');
  }
  function field(label,key,value,attrs={},tag='input'){
    const node=h(tag,attrs,tag==='textarea'?value:null);
    if(tag==='input')node.value=value;
    node.addEventListener('input',()=>set(key,attrs.type==='number' ? Number(node.value) : node.value));
    return h('label',{},label,node);
  }
  function reload(next){row={...row,...next};d=structuredClone(row.document);quote=row.quote;dirty=false;render();}
  async function modelList(){
    modelsLoading=true;render();
    try {models=(await api(ugcPath+'/models')).models;}
    catch(error){if(active())message.textContent=error.message;}
    finally {modelsLoading=false;if(active())renderModels();}
  }
  function renderModels(){
    const chosen=models.find(x=>x.id===d.endpoint);
    const options=models.filter(x=>x.available||x.id===d.endpoint).map(x=>[x.id,x.name]);
    if(!chosen&&d.endpoint)options.unshift([d.endpoint,d.endpoint]);
    const resolutions=(chosen?.available?chosen.resolutions:[d.resolution].filter(Boolean)).map(x=>[x,x]);
    const rate=chosen?.rates?.find(x=>x.resolution===d.resolution);
    put(modelPanel,
      h('label',{},'โมเดลวิดีโอ fal.ai',ugcSelect([['','เลือกโมเดล'],...options],d.endpoint,v=>{
        set('endpoint',v);
        const model=models.find(x=>x.id===v);
        set('resolution',model?.resolutions.find(x=>x===d.resolution)||model?.resolutions[0]||'');
        renderModels();
      },'โมเดลวิดีโอ')),
      h('label',{},'ความละเอียดภาพจาก fal',ugcSelect([['','เลือกความละเอียด'],...resolutions],d.resolution,v=>{
        set('resolution',v);renderModels();
      },'ความละเอียดภาพจาก fal')),
      rate?h('div',{},h('p',{},ugcUSD(rate.unit_usd)+' / '+(/^seconds?$/i.test(rate.unit)?'วินาที':'ครั้ง')+
        (rate.image_usd?' · '+ugcUSD(rate.image_usd)+' / รูป':'')),
        h('a',{class:'sub',href:chosen.source_url,target:'_blank',rel:'noopener'},'ตรวจเรต '+ugcDate(chosen.checked_at))):
        h('p',{class:'sub'},chosen?.reason||(modelsLoading?'กำลังตรวจรุ่นและราคา…':'เลือกโมเดลและความละเอียดเพื่อดูเรต')),
      button(modelsLoading?'กำลังตรวจ catalog…':'ตรวจโมเดลที่ใช้ได้',modelList,modelsLoading));
  }
  function mediaOptions(){
    return [['','เลือกสื่อ'],...row.media.map((m,i)=>[m.id,(m.kind==='image'?'รูป':'วิดีโอ')+' '+(i+1)])];
  }
  const section=(title,...kids)=>h('section',{class:'ugc-block'},h('h2',{},title),kids);
  function priceView(){
    clearTimeout(quoteTimer);
    if(!active())return;
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
        x.generation_seconds,x.billing_quantity+' '+(/^seconds?$/i.test(x.billing_unit)?'วิ':x.billing_unit),ugcUSD(x.unit_usd),
        q.reused.includes(x.slot)?'ใช้ไฟล์เดิม':ugcUSD(x.estimated_usd)]);
      const table=h('table',{class:'ugc-price'},h('thead',{},h('tr',{},['ฉาก','โมเดล','ความละเอียด','ในคลิป (วิ)','ส่ง fal (วิ)','หน่วยประเมิน','USD/หน่วย','ฉาก (USD)'].map(x=>h('th',{scope:'col'},x)))),
        h('tbody',{},rows.map(line=>h('tr',{},line.map(cell=>h('td',{},cell))))));
      const expiresIn=Date.parse(q.expires_at)-Date.now();
      const expired=expiresIn<=0;
      if(!expired)quoteTimer=setTimeout(priceView,expiresIn+50);
      contents.push(h('h3',{},'คลิป '+q.input.duration+' วิ · 1080 × 1920'),
        rows.length?table:h('p',{},'ใช้สื่อสินค้าจริงทุกฉาก'),
        q.fal.some(item=>item.billed_seconds>item.generation_seconds)?
          h('p',{class:'sub'},'ใบราคาของฉากที่มีวินาทีเผื่อใช้ความยาวผลลัพธ์ที่ประเมินไว้ ค่าจริงขึ้นกับวิดีโอที่ fal ส่งกลับ'):null,
        h('p',{},'fal.ai '+ugcUSD(q.fal_usd)+' · เสียง '+q.voice_model+' '+ugcUSD(q.eleven_usd)+' · ตัดต่อ '+ugcUSD(q.editing_usd)),
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
    const hasPrev=index>0,hasNext=index<d.scenes.length-1;
    const edit=(key,value)=>{shot[key]=value;invalidate();};
    const control=(label,key,kind='text')=>{
      const node=h(kind==='textarea'?'textarea':'input',kind==='number'?{type:'number',min:2,max:15}:kind==='textarea'?{rows:2}:{});
      node.value=shot[key];
      node.addEventListener('input',()=>edit(key,kind==='number'?Number(node.value):node.value));
      return h('label',{},label,node);
    };
    const move=offset=>{[d.scenes[index],d.scenes[index+offset]]=[d.scenes[index+offset],shot];invalidate();render();};
    return h('article',{class:'ugc-scene'},h('div',{class:'row'},h('strong',{},'ฉาก '+(index+1)),
      button('ขึ้น',()=>move(-1),!hasPrev),button('ลง',()=>move(1),!hasNext),
      button('นำฉากออก',()=>{d.scenes.splice(index,1);invalidate();render();},d.scenes.length<=2)),
      h('div',{class:'ugc-grid'},
        control('ความยาว (วิ)','seconds','number'),
        h('label',{},'ภาพ',ugcSelect([['original','สื่อจริง · รุ่น โลโก้ แพ็กเกจ'],['fal','ขยับภาพด้วย fal.ai']],shot.mode,v=>edit('mode',v),'ชนิดภาพฉาก '+(index+1))),
        h('label',{},'สื่ออ้างอิง',ugcSelect(mediaOptions(),shot.media_id||'',v=>edit('media_id',v||null),'สื่อฉาก '+(index+1)))),
      index===0?h('p',{},'บทพูดเปิดใช้ Hook ที่เลือก'):control('บทพูดไทย','narration','textarea'),
      control('ซับที่แก้เอง (เว้นว่างเพื่อใช้บทพูด)','subtitle','textarea'),
      control('ภาพและการเคลื่อนไหว','visual','textarea'),control('มุมกล้อง','camera'));
  }
  function addScene(){
    const id=Array.from({length:99},(_,i)=>'shot_'+String(i+1).padStart(2,'0')).find(id=>!d.scenes.some(x=>x.id===id));
    d.scenes.push({id,seconds:d.scenes.length?5:4,narration:'ดูรายละเอียดได้ที่หน้าร้าน',
      subtitle:'',visual:'Show the product in good light',camera:'steady close-up',mode:'original',media_id:row.media[0]?.id||null});
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
          for(const shot of d.scenes) if(!shot.media_id)shot.media_id=imported.media.id;
        }
        invalidate();await save();render();
        message.textContent=imported.warning||'นำเข้าสินค้าแล้ว ตรวจราคาและ URL ก่อนผลิต';
      }),r.next?button('สินค้าหน้าถัดไป',()=>products(r.next)):null);
    }
    return h('details',{},h('summary',{},'เลือกสินค้าจาก Notion'),h('div',{class:'row'},database,
      button('ตั้งค่า mapping',mapping),button('แสดงสินค้า',()=>products())),content);
  }
  let pollTimer;
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
          h('ol',{},job.scenes.map(s=>h('li',{},[s.state==='done'?'ภาพพร้อม':s.state==='rendering'?'กำลังเตรียมภาพ':'รอภาพ',
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
          put(view,job.video?h('div',{},h('video',{class:'ugc-player',controls:true,playsinline:true,preload:'metadata',src:job.video}),
            h('div',{class:'row'},h('a',{class:'btn primary',href:job.download},'ดาวน์โหลด MP4'),
              h('a',{class:'btn',href:job.notes.order_url,target:'_blank',rel:'noopener noreferrer'},'สั่งซื้อ'),
              button('คัดลอกแคปชันและลิงก์',async()=>{await navigator.clipboard.writeText([job.notes.caption,job.notes.order_url].filter(Boolean).join('\n'));message.textContent='คัดลอกแล้ว';})),
            h('textarea',{readonly:true,'aria-label':'แคปชันและ URL สั่งซื้อ',rows:3},[job.notes.caption,job.notes.order_url].filter(Boolean).join('\n'))):null,
            ['READY_TO_POST','FAILED','CANCELLED'].includes(job.status)&&jobId===current?h('div',{class:'row'},
              button('เปิดฉบับแก้ไข',async()=>{await api(path+'/edit',ugcJSON('POST',{job_id:jobId}));go('ugc');}),
              ...job.scenes.flatMap((scene,i)=>scene.mode==='fal'?[button('สร้างฉาก '+(i+1)+' ใหม่',async()=>{
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
    const planning=['queued','submitting','accepted'].includes(row.planning?.state);
    const history=row.history?.filter(x=>x.status==='READY_TO_POST')||[];
    const file=h('input',{type:'file',accept:'image/jpeg,image/png,image/webp,video/mp4'});
    const upload=button('อัปโหลดสื่อ',async()=>{
      const chosen=file.files[0];if(!chosen||chosen.size>32*1024*1024)throw Error('เลือกภาพหรือ MP4 ขนาดไม่เกิน 32 MB');
      const added=await api(path+'/media',{method:'POST',headers:{'content-type':'application/octet-stream'},body:chosen});
      row.media.push(added);
      for(const shot of d.scenes)if(!shot.media_id)shot.media_id=added.id;
      if(d.scenes.length)invalidate();
      render();
    },!config.storage);
    const product=h('fieldset',{disabled:planning},h('div',{class:'ugc-grid'},
      field('ชื่อสินค้า','product.name',d.product.name,{maxlength:140}),
      field('รุ่น','product.variant',d.product.variant,{maxlength:80}),
      field('ราคา (บาท)','product.price',d.product.price,{inputmode:'decimal',maxlength:32}),
      field('โปรโมชัน','product.promo',d.product.promo,{maxlength:100}),
      field('URL สั่งซื้อ','product.order_url',d.product.order_url,{type:'url',maxlength:2048}),
      field('จุดขายที่ร้านยืนยันแล้ว','product.selling_points',d.product.selling_points,{rows:2,maxlength:1400},'textarea')),
      h('label',{},'รูปสินค้า หรือวิดีโอ MP4 (32 MB)',file),upload,
      h('div',{class:'ugc-media'},row.media.map((m,i)=>m.kind==='image'?
        h('img',{src:m.url,alt:'รูปสินค้า '+(i+1)}):h('video',{src:m.url,'aria-label':'วิดีโอสินค้า '+(i+1),controls:true,preload:'metadata'}))),
      notionPanel(),
      row.evidence.length?h('details',{},h('summary',{},'หลักฐานเทรนด์สินค้า'),h('ul',{},row.evidence.map(e=>h('li',{},
        h('a',{href:e.url,target:'_blank',rel:'noopener noreferrer'},e.title||e.url),' · '+e.quote)))):null);
    renderModels();
    const selectedHook=ugcSelect([['','เลือก Hook'],...d.hooks.map(x=>[x,x])],d.hook,v=>{set('hook',v);render();},'Hook ที่ AI เสนอ');
    const plan=h('fieldset',{disabled:planning},
      h('div',{class:'ugc-grid'},
        field('บรีฟภาษาธรรมชาติ','brief',d.brief,{rows:2,maxlength:1600,placeholder:'คนถือรองเท้าพูดกับกล้อง ขายเร็ว เน้นโปรและการจัดส่ง'},'textarea'),
        field('ความยาวรวม (วิ)','duration',d.duration,{type:'number',min:8,max:30}),
        h('label',{},'สมอง OpenAI',ugcSelect([...new Set([d.model,...config.brains])].map(x=>[x,x]),d.model,v=>set('model',v),'สมอง OpenAI')),
        h('label',{},'ระดับการคิด',ugcSelect(['low','medium','high'].map(x=>[x,x]),d.reasoning,v=>set('reasoning',v),'ระดับการคิด'))),
      button('ให้ AI เสนอ 3 Hook และวางฉาก',async()=>{
        await save();
        const result=await draftPost(path+'/suggest',{revision:row.revision});
        reload(result);
      },!config.openai),
      planning?h('p',{role:'status'},'กำลังเขียน Hook และวางฉาก…'):row.planning?.error?h('p',{role:'alert'},row.planning.error):null,
      h('div',{class:'ugc-grid'},h('label',{},'Hook ที่ AI เสนอ',selectedHook),field('Hook ที่จะใช้','hook',d.hook,{maxlength:85})),
      d.scenes.map(editScene),button('เพิ่มฉาก',addScene,d.scenes.length>=10),modelPanel);
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
      section('สินค้า',product),section('Hook และฉาก',plan),
      section('ข้อความตอนตัดต่อ',h('fieldset',{disabled:planning},h('div',{class:'ugc-grid'},
        field('แคปชันสำหรับโพสต์','caption',d.caption,{rows:2,maxlength:500},'textarea'),
        field('ข้อความปุ่มสั่งซื้อ','cta',d.cta,{maxlength:40}),toggled('show_price','แสดงราคา'),toggled('show_promo','แสดงโปรโมชัน')),
        button('บันทึกร่าง',async()=>{await save();message.textContent='บันทึกแล้ว';}))),
      section('ราคาก่อนผลิต',planning?null:priceBox));
    if (planning) pollTimer=setTimeout(async()=>{
      if(!active())return;
      try{const next=await api(path);if(active())reload(next);}
      catch(error){message.textContent=error.message;}
    },2400);
    else priceView();
  }
  if(row.job_id)render();
  else void modelList();
}
