"""Opt-in browser acceptance test against the API, PostgreSQL and mock fal worker."""
import os
import subprocess
import sys
from pathlib import Path
from urllib.parse import urlparse

from PIL import Image, ImageDraw, ImageFont
from playwright.sync_api import expect, sync_playwright


def fixtures(root):
    box = Image.new('RGB', (280, 390), '#e8effb')
    d = ImageDraw.Draw(box)
    d.rectangle((6, 6, 274, 382), fill='#183853', outline='#b6dbdc', width=6)
    d.rectangle((12, 12, 268, 62), fill='#f5f6f9')
    d.text((24, 34), 'PS5', font=ImageFont.load_default(size=28), fill='#0b1430', anchor='lm')
    d.polygon([(15, 302), (138, 110), (264, 302)], fill='#3d7880')
    d.ellipse((154, 86, 201, 134), fill='#e5b66c')
    d.text((140, 320), 'AFTER THE TIDE', font=ImageFont.load_default(size=19), fill='white', anchor='mm')
    box.save(root/'ps5-product.png')
    opening = Image.new('RGB', (540, 960), '#cbd8cb')
    d = ImageDraw.Draw(opening)
    d.rectangle((0, 22, 200, 740), fill='#ebefd9')
    d.rounded_rectangle((81, 410, 465, 1000), radius=110, fill='#446057')
    d.ellipse((190, 175, 355, 416), fill='#b7724d')
    d.ellipse((181, 155, 351, 257), fill='#272126')
    d.ellipse((225, 273, 238, 284), fill='#312321')
    d.ellipse((296, 273, 309, 284), fill='#312321')
    d.arc((237, 320, 293, 346), 12, 155, fill='#4d2b2e', width=4)
    opening.crop((115,110,435,430)).save(root/'reviewer-portrait.png')
    opening.paste(box.resize((214, 298)), (167, 450))
    d.rounded_rectangle((125, 576, 183, 644), radius=22, fill='#b7724d')
    d.rounded_rectangle((365, 583, 425, 650), radius=22, fill='#b7724d')
    opening.save(root/'mock-opening.jpg', quality=93)


def assert_new_opening_required(page, base, draft, root, role):
    url=base+'/app/api/ugc/drafts/'+draft
    headers={'x-motion-ui':'1'}
    row=page.request.get(url,headers=headers).json()
    if row.get('job_id'):
        edit=page.request.post(url+'/edit',data={'job_id':row['job_id']},headers=headers)
        assert edit.ok,edit.text()
        row=page.request.get(url,headers=headers).json()
    doc=row['document']
    before=doc['reviewer']['opening_id']
    assert before
    media=page.request.post(url+'/media?role='+role,data=(root/('reviewer-portrait.png' if role=='presenter' else 'ps5-product.png')).read_bytes(),
        headers={**headers,'content-type':'application/octet-stream'})
    assert media.ok
    key='source_id' if role=='presenter' else 'product_media_id'
    doc['reviewer'][key]=media.json()['id']
    # Simulate a stale client sending the old approval and shot references alongside a replacement.
    updated=page.request.patch(url,headers=headers,data={'revision':row['revision'],'document':doc})
    assert updated.ok,updated.text()
    saved=updated.json()
    assert saved['document']['reviewer']['opening_id'] is None
    assert saved['document']['scenes'][0]['media_id'] is None and saved['document']['scenes'][-1]['media_id'] is None
    rejected=page.request.post(url+'/quote',headers=headers,data={'revision':saved['revision'],'product_confirmed':True})
    assert not rejected.ok and 'ภาพเปิด' in rejected.json()['error'],rejected.text()
    return before


def run(base, root):
    fixtures(root)
    with sync_playwright() as playwright:
        chromium = playwright.chromium.launch(executable_path=os.getenv('UGC_CHROMIUM','/usr/bin/chromium'), args=['--no-sandbox'])
        page = chromium.new_page(viewport={'width':1360,'height':1100})
        errors = []
        page.on('pageerror',lambda error:errors.append(str(error)))
        page.add_init_script("if (!localStorage.getItem('ms.view')) localStorage.setItem('ms.view','ugc')")
        page.route('https://fonts.googleapis.com/**',lambda route:route.abort())
        page.goto(base+'/app')
        out=Path(os.getenv('UGC_BROWSER_OUTPUT',str(root)))
        out.mkdir(parents=True,exist_ok=True)
        brief=page.get_by_role('textbox',name='บรีฟคลิป')
        expect(brief).to_be_focused()
        expect(page.get_by_label('ชื่อสินค้า',exact=True)).to_have_count(0)
        video=page.get_by_label('โมเดลวิดีโอ',exact=True)
        default='arena:grok-720'
        alt='fixture/new-speaker/image-to-video'
        expect(video).to_have_value(default)
        baseline=page.request.get(base+'/qa/counters').json()
        page.screenshot(path=str(out/'desktop.png'))
        page.set_viewport_size({'width':390,'height':844})
        page.reload()
        expect(brief).to_be_focused()
        expect(video).to_have_value(default)
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
        page.screenshot(path=str(out/'mobile.png'))
        def catalog(mode):
            assert page.request.post(base+'/qa/catalog-mode',data={'mode':mode}).ok
        def refresh(kind):
            with page.expect_response(lambda r:'/catalog/'+kind+'?refresh=1' in r.url) as pending:
                page.get_by_role('button',name='อัปเดตอันดับและโมเดล' if kind=='video' else 'อัปเดตโมเดล',exact=True).click()
            return pending.value.json()
        catalog('changed')
        refreshed=refresh('video')
        expect(video).to_have_value(default)
        assert len(refreshed['models'])==2
        labels=video.locator('option').all_text_contents()
        assert labels[1].startswith('#1 Missing') and 'ยังไม่มีบน fal.ai' in labels[1]
        assert labels[2].startswith('#2 Grok') and 'xai/grok-imagine-video/v1.5/image-to-video' in labels[2]
        expect(video).to_be_enabled()
        assert video.locator('option').evaluate_all('opts=>opts.slice(1,3).map(o=>o.disabled)')==[True,False]
        assert video.locator('optgroup').last.get_attribute('label')=='แนะนำบน fal.ai'
        assert video.locator('option').last.get_attribute('value')==alt
        for mode,source_key in [('arena-down','arena'),('featured-down','featured'),('index-down','index')]:
            catalog(mode);partial=refresh('video')
            assert partial['stale'] and partial['source_status'][source_key]['error']
            assert partial['source_status'][source_key]['checked_at']==refreshed['source_status'][source_key]['checked_at']
            assert partial['ranked'][0]['rank']==1 and partial['ranked'][1]['available']
            expect(video).to_have_value(default)
            catalog('changed');refreshed=refresh('video')
        video.select_option(alt)
        catalog('down')
        failed=refresh('video')
        assert failed['stale'] and failed['checked_at']==refreshed['checked_at']
        expect(video).to_have_value(alt)
        catalog('removed');refresh('video')
        expect(video).to_have_value(alt)
        catalog('normal');refresh('video')
        expect(video).to_have_value('')
        expect(page.get_by_text('โมเดลที่เลือกใช้ไม่ได้แล้ว',exact=False)).to_be_visible()
        video.select_option(default)
        page.get_by_role('tab',name='คิดไอเดีย').click()
        q=page.get_by_label('คำค้น Shopee')
        expect(q).to_be_focused()
        brain=page.get_by_label('โมเดลคิดไอเดีย',exact=True)
        expect(brain).to_have_value('gpt-6.2-sol')
        catalog('changed');last=refresh('ideas')
        brain.select_option('gpt-7.1-terra')
        catalog('down')
        stale=refresh('ideas')
        assert stale['stale'] and stale['checked_at']==last['checked_at']
        expect(brain).to_have_value('gpt-7.1-terra')
        catalog('normal');refresh('ideas')
        expect(brain).to_have_value('')
        catalog('changed');refresh('ideas')
        brain.select_option('gpt-7.1-terra')
        q.fill('แก้วเก็บความเย็น งบไม่เกิน 500 บาท')
        search=page.get_by_role('button',name='หาไอเดียจาก Shopee')
        search.click()
        cards=page.locator('.ugc-idea-card')
        expect(cards).to_have_count(4,timeout=20000)
        expect(page.get_by_text('เพดาน 25 เครดิต',exact=False)).to_be_visible()
        counters=page.request.get(base+'/qa/counters').json()
        assert counters['fcSearches']==1 and counters['fcReads']==4 and counters['ideaModel']=='gpt-7.1-terra'
        assert counters['jobs']==baseline['jobs']
        original_link=cards.first.get_by_role('link').inner_text()
        page.screenshot(path=str(out/'ideas-mobile.png'))
        catalog('research-down');search.click()
        expect(page.get_by_text('ผลล่าสุดที่มี',exact=False)).to_be_visible(timeout=12000)
        assert cards.first.get_by_role('link').inner_text()==original_link
        assert page.request.get(base+'/qa/counters').json()['fcSearches']==2
        cards.first.get_by_role('button',name='ใช้ไอเดียนี้').click()
        expect(brief).to_be_focused()
        assert 'แก้วเก็บความเย็น' in brief.input_value()
        page.get_by_role('button',name='เตรียมคลิป').click()
        expect(page.get_by_text('เพิ่มรูปสินค้าจริง',exact=True)).to_be_visible(timeout=12000)
        saved=page.url
        page.reload()
        expect(page.get_by_role('heading',name='สรุปร่าง')).to_be_visible()
        page.get_by_text('รายละเอียดสินค้า',exact=True).click()
        expect(page.get_by_label('ชื่อสินค้า',exact=True)).to_have_value('แก้วเก็บความเย็น')
        expect(page.get_by_label('URL สั่งซื้อ',exact=True)).to_have_value('')
        page.get_by_text('หลักฐานเทรนด์สินค้า',exact=True).click()
        expect(page.get_by_role('link',name='แก้วเก็บความเย็น',exact=True)).to_have_attribute('href','https://shopee.co.th/product/22/70')
        page.get_by_role('button',name='กลับหน้าสร้างคลิป').click()
        page.get_by_text('ร่างเก่า',exact=True).click()
        page.get_by_label('ร่าง UGC',exact=True).select_option(saved.split('/')[-1])
        expect(page.get_by_role('heading',name='สรุปร่าง')).to_be_visible()
        page.set_viewport_size({'width':1360,'height':1100})
        page.get_by_role('button',name='กลับหน้าสร้างคลิป').click()
        expect(brief).to_be_focused()
        page.get_by_role('tab',name='คิดไอเดีย').click()
        expect(cards).to_have_count(4)
        cards.first.get_by_role('button',name='ใช้ไอเดียนี้').click()
        expect(brief).to_be_focused()
        assert 'แก้วเก็บความเย็น' in brief.input_value()
        page.get_by_role('button',name='นำออก',exact=True).click()
        page.get_by_text('ร่างเก่า',exact=True).click()
        page.get_by_label('ร่าง UGC',exact=True).select_option(saved.split('/')[-1])
        expect(page.get_by_role('heading',name='สรุปร่าง')).to_be_visible()
        page.get_by_role('button',name='กลับหน้าสร้างคลิป').click()
        catalog('normal')
        brief.fill('ให้ผู้หญิงถือกล่องเกม PS5 After the Tide พูดกับกล้องเป็นภาษาไทย')
        page.get_by_label('แนบรูปหรือคลิปสินค้า').set_input_files(root/'ps5-product.png')
        page.get_by_role('button',name='เตรียมคลิป').click()
        expect(page.get_by_label('บทพูดเปิด',exact=True)).to_be_visible(timeout=12000)
        assert page.request.get(base+'/qa/counters').json()['jobs']==baseline['jobs']
        page.get_by_text('รายละเอียดสินค้า',exact=True).click()
        page.get_by_label('URL สั่งซื้อ',exact=True).fill('https://shop.example/ps5')
        page.get_by_label('ราคา (บาท)',exact=True).fill('1690')
        expect(page.get_by_alt_text('รูปสินค้า 1',exact=True)).to_be_visible()
        page.get_by_text('คนรีวิวและภาพเปิด',exact=True).click()
        expect(page.get_by_label('คนรีวิว',exact=True)).to_have_value('ai')
        picture=page.get_by_label('อัปโหลดรูปคนรีวิว',exact=True)
        picture.set_input_files(root/'reviewer-portrait.png')
        portrait=page.get_by_alt_text('รูปคนรีวิวที่เลือก')
        expect(portrait).to_be_visible()
        uploaded=portrait.get_attribute('src')
        page.get_by_role('button',name='ลบรูปคนรีวิว').click()
        expect(portrait).to_have_count(0)
        selected_draft=page.get_by_label('ร่าง UGC',exact=True).input_value()
        stored=page.request.get(base+'/app/api/ugc/drafts/'+selected_draft,headers={'x-motion-ui':'1'}).json()
        assert all(m['id']!=uploaded.split('/')[-1] for m in stored['media'])
        page.get_by_text('เลือกรูปจาก Notion',exact=True).click()
        page.get_by_label('ค้นหาคนรีวิว',exact=True).fill('มิน')
        page.get_by_role('button',name='ค้นหาคนรีวิว',exact=True).click()
        person=page.get_by_role('button',name='มิน คนรีวิว')
        expect(person).to_be_visible()
        expect(person.locator('img')).to_have_js_property('naturalWidth',320)
        person.locator('xpath=../../..').screenshot(path=str(out/'notion-reviewers.png'))
        person.click()
        expect(portrait).to_be_visible()
        notion_portrait=portrait.get_attribute('src')
        assert notion_portrait!=uploaded and '/qa/r2/ugc-r2/' in notion_portrait
        page.reload()
        page.get_by_text('คนรีวิวและภาพเปิด',exact=True).click()
        expect(portrait).to_have_attribute('src',notion_portrait)
        page.get_by_text('บทและฉาก',exact=True).click()
        expect(page.get_by_role('button',name='เลือกมุม 3',exact=True)).to_be_visible()
        expect(page.get_by_text('ฉาก 1 · คนถือสินค้าเปิดคลิป')).to_be_visible()
        page.get_by_role('button',name='ตรวจราคาภาพเปิด',exact=True).click()
        expect(page.get_by_role('button',name='ยืนยันราคาและเตรียมภาพเปิด')).to_be_visible()
        draft=page.get_by_label('ร่าง UGC',exact=True).input_value()
        call=lambda **kwargs:page.request.post(base+'/qa/run-next?draft='+draft,**kwargs)
        assert call().status==404, 'opening image must not queue before approval'
        assert page.request.post(base+'/qa/image-rate',data={'rate':.16}).ok
        page.get_by_role('button',name='ยืนยันราคาและเตรียมภาพเปิด').click()
        expect(page.get_by_text('ราคาหรือภาพอ้างอิงเปลี่ยน กรุณาขอราคาใหม่')).to_be_visible()
        assert call().status==404
        assert page.request.post(base+'/qa/image-rate',data={'rate':.15}).ok
        page.get_by_role('button',name='ตรวจราคาภาพเปิด',exact=True).click()
        with page.expect_response(lambda res:res.url.endswith('/produce-image') and res.request.method=='POST') as pending:
            page.get_by_role('button',name='ยืนยันราคาและเตรียมภาพเปิด').click()
        approval=pending.value
        repeated=page.request.post(approval.url,data=approval.request.post_data_json,headers={'x-motion-ui':'1'})
        assert repeated.ok and repeated.json()=={'job_id':approval.json()['job_id'],'duplicate':True}
        expect(page.get_by_text('กำลังเตรียมภาพเปิด',exact=True)).to_be_visible()
        image=call(timeout=45000)
        assert image.ok,image.text()
        image_job=image.json()
        assert image_job['calls']==['fal-image']
        refs=image_job['wire'][0]['payload']['image_urls']
        assert len(refs)==2 and refs[1].split('/')[-1]==notion_portrait.split('/')[-1] and refs[0]!=refs[1]
        expect(page.get_by_alt_text('ภาพเปิดคนถือสินค้า',exact=True)).to_be_visible(timeout=12000)
        page.get_by_role('button',name='ยืนยันภาพเปิดนี้',exact=True).click()
        expect(page.get_by_text('ยืนยันภาพเปิดแล้ว',exact=True)).to_be_visible()
        preview=page.get_by_alt_text('ภาพเปิดคนถือสินค้า',exact=True)
        src=preview.get_attribute('src')
        assert preview.evaluate('(img)=>img.complete && img.naturalWidth>0')
        path=urlparse(src).path.removeprefix('/qa/r2/')
        assert image_job['result']['media_id'] in path
        assert page.get_by_label('ความละเอียดภาพจาก fal',exact=True).input_value()=='720p'
        out=Path(os.getenv('UGC_BROWSER_OUTPUT',str(root)))
        out.mkdir(parents=True,exist_ok=True)
        preview.locator('xpath=../..').screenshot(path=out/'approved-opening.png')
        page.get_by_text('ยืนยันว่าราคา โปร จุดขาย และ URL สั่งซื้อเป็นข้อมูลร้านที่ตรวจแล้ว',exact=True).click()
        page.get_by_role('button',name='ตรวจราคา',exact=True).click()
        expect(page.get_by_role('button',name='ยืนยันราคาและเริ่มผลิต')).to_be_visible()
        assert call().status==404,'video must not queue after image approval or price lookup'
        page.get_by_role('button',name='ยืนยันราคาและเริ่มผลิต').click()
        expect(page.get_by_text('รอเข้าคิว',exact=True)).to_be_visible(timeout=10000)
        video=call(timeout=95000)
        assert video.ok,video.text()
        jobs=video.json()
        assert jobs['calls']==['eleven','fal-presenter','fal-presenter'], jobs['calls']
        assert (jobs['result']['duration'],jobs['result']['width'],jobs['result']['height'])==(18,720,1280),jobs['result']
        for item,line in zip(jobs['wire'],['มาดูกล่องเกมนี้กัน','ดูรายละเอียดที่หน้าร้าน']):
            assert item['payload']['image_url']=='https://r2-fixture.invalid/'+path
            assert line in item['payload']['prompt']
        expect(page.get_by_role('link',name='ดาวน์โหลด MP4')).to_be_visible(timeout=12000)
        expect(page.get_by_role('link',name='สั่งซื้อ')).to_have_attribute('href','https://shop.example/ps5')
        page.get_by_label('ปากตรงเสียง ฉาก 1',exact=True).select_option('ต้องแก้')
        page.get_by_role('button',name='บันทึกผลตรวจฉาก 1').click()
        expect(page.get_by_text('ต้องแก้',exact=True).locator('xpath=self::strong')).to_be_visible()
        page.get_by_role('button',name='แก้เฉพาะฉาก 1').click()
        expect(page.get_by_text('ระบบจะสร้างใหม่เฉพาะฉากที่เลือก',exact=False)).to_be_visible()
        page.get_by_text('ยืนยันว่าราคา โปร จุดขาย และ URL สั่งซื้อเป็นข้อมูลร้านที่ตรวจแล้ว',exact=True).click()
        page.get_by_role('button',name='ตรวจราคา',exact=True).click()
        expect(page.get_by_text('ใช้ไฟล์เดิม',exact=True)).to_be_visible()
        assert call().status==404,'scene review and quote do not send another paid job'
        page.get_by_role('button',name='ยืนยันราคาและเริ่มผลิต').click()
        expect(page.get_by_text('รอเข้าคิว',exact=True)).to_be_visible(timeout=10000)
        repaired=call(timeout=90000)
        assert repaired.ok,repaired.text()
        assert repaired.json()['calls']==['fal-presenter']
        expect(page.get_by_role('link',name='ดาวน์โหลด MP4')).to_be_visible(timeout=12000)

        assert_new_opening_required(page,base,draft,root,'presenter')

        # The clip path takes the selected timestamp from the original video itself.
        clip=root/'presenter-upload.mp4'
        subprocess.run(['ffmpeg','-v','error','-y','-loop','1','-i',str(root/'mock-opening.jpg'),
            '-vf','scale=180:320','-t','3','-threads','2','-c:v','libx264','-pix_fmt','yuv420p','-movflags','+faststart',str(clip)],check=True)
        page.get_by_role('button',name='กลับหน้าสร้างคลิป').click()
        brief.fill('คนถือกล่องเกม PS5 จากคลิปคนจริง')
        page.get_by_label('แนบรูปหรือคลิปสินค้า').set_input_files(root/'ps5-product.png')
        page.get_by_role('button',name='เตรียมคลิป').click()
        expect(page.get_by_label('บทพูดเปิด',exact=True)).to_be_visible(timeout=12000)
        page.get_by_text('คนรีวิวและภาพเปิด',exact=True).click()
        page.get_by_label('คนรีวิว',exact=True).select_option('clip')
        page.get_by_label('คลิป MP4 ที่เห็นหน้า มือ และสินค้า').set_input_files(clip)
        page.get_by_role('button',name='อัปโหลดสื่อคนรีวิว').click()
        clip_preview=page.get_by_label('คลิปคนรีวิวสำหรับเลือกเฟรม')
        expect(clip_preview).to_be_visible()
        page.wait_for_function("Number.isFinite(document.querySelector('[aria-label=\"คลิปคนรีวิวสำหรับเลือกเฟรม\"]').duration)")
        clip_preview.evaluate('(video)=>{video.currentTime=1.25}')
        draft=page.get_by_label('ร่าง UGC',exact=True).input_value()
        page.get_by_role('button',name='เลือกเฟรมจากตำแหน่งที่เล่นอยู่').click()
        expect(page.get_by_text('กำลังตัดเฟรมจากคลิป',exact=True)).to_be_visible()
        frame=call(timeout=45000)
        assert frame.ok and frame.json()['calls']==[], frame.text()
        expect(page.get_by_text('เฟรมที่ 1.25 วิ',exact=True)).to_be_visible(timeout=12000)
        page.get_by_role('button',name='ยืนยันภาพเปิดนี้',exact=True).click()
        expect(page.get_by_text('ยืนยันภาพเปิดแล้ว',exact=True)).to_be_visible()

        assert_new_opening_required(page,base,draft,root,'product')
        def no_reviewer_db(route):
            response=route.fetch()
            config=response.json()
            config['notion']['reviewers_enabled']=False
            route.fulfill(response=response,json=config)
        page.route('**/api/ugc/config',no_reviewer_db)
        page.reload()
        page.get_by_text('คนรีวิวและภาพเปิด',exact=True).click()
        expect(page.get_by_text('ยังไม่ได้ตั้งค่าฐานคนรีวิว Notion',exact=True)).to_be_visible()
        expect(page.get_by_role('button',name='เลือกรูปจาก Notion')).to_be_disabled()
        expect(page.get_by_label('อัปโหลดรูปคนรีวิว',exact=True)).to_be_enabled()
        page.unroute('**/api/ugc/config')
        page.get_by_text('Text to Video',exact=True).click()
        expect(page.get_by_role('heading',name='Text to Video',exact=True)).to_be_visible()
        expect(page.get_by_label('ความยาวคลิป Text to Video')).to_have_value('60')
        expect(page.get_by_role('button',name='ให้สมองวางบทและแบ่งช็อต')).to_be_enabled()
        from product_trends_browser import check_product_trends
        check_product_trends(page,base,out)
        assert not errors,errors
        chromium.close()
        print('Chromium verified desktop/mobile UGC, ranked and recommended models, per-source outages, Notion and uploaded portraits, approved fal payloads, MP4 export, Text to Video and deduplicated trend jobs.')


if __name__=='__main__':
    run(sys.argv[1],Path(sys.argv[2]))
