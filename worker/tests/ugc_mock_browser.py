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
    opening.paste(box.resize((214, 298)), (167, 450))
    d.rounded_rectangle((125, 576, 183, 644), radius=22, fill='#b7724d')
    d.rounded_rectangle((365, 583, 425, 650), radius=22, fill='#b7724d')
    opening.save(root/'mock-opening.jpg', quality=93)


def run(base, root):
    fixtures(root)
    with sync_playwright() as playwright:
        chromium = playwright.chromium.launch(executable_path=os.getenv('UGC_CHROMIUM','/usr/bin/chromium'), args=['--no-sandbox'])
        page = chromium.new_page(viewport={'width':1360,'height':1100})
        errors = []
        page.on('pageerror',lambda error:errors.append(str(error)))
        page.add_init_script("localStorage.setItem('ms.view','ugc')")
        page.route('https://fonts.googleapis.com/**',lambda route:route.abort())
        page.goto(base+'/app')
        page.get_by_role('button',name='สร้างร่างสินค้า').click()
        page.get_by_label('ชื่อสินค้า',exact=True).fill('กล่องเกม PS5 After the Tide')
        page.get_by_label('URL สั่งซื้อ',exact=True).fill('https://shop.example/ps5')
        page.get_by_label('ราคา (บาท)',exact=True).fill('1690')
        page.get_by_label('รูปสินค้า หรือวิดีโอ MP4 (32 MB)').set_input_files(root/'ps5-product.png')
        page.get_by_role('button',name='อัปโหลดสื่อ',exact=True).click()
        expect(page.get_by_alt_text('รูปสินค้า 1',exact=True)).to_be_visible()
        expect(page.get_by_text('เลือกคนรีวิวและยืนยันภาพเปิดก่อนคิดราคาวิดีโอ')).to_be_visible()
        assert page.get_by_role('button',name='ยืนยันราคาและเริ่มผลิต').count()==0
        assert page.get_by_label('คนรีวิว',exact=True).locator('option').all_text_contents()==[
            'เลือกคนรีวิว','คลิปคนจริงถือสินค้า','อัปโหลดรูปคนรีวิว','สร้างพิธีกร AI']
        page.get_by_label('คนรีวิว',exact=True).select_option('ai')
        page.get_by_role('button',name='ให้ AI เสนอ 3 Hook และวางฉาก').click()
        expect(page.get_by_role('button',name='เลือกมุม 3',exact=True)).to_be_visible(timeout=12000)
        page.get_by_role('button',name='เลือกมุม 1',exact=True).click()
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

        # The clip path takes the selected timestamp from the original video itself.
        clip=root/'presenter-upload.mp4'
        subprocess.run(['ffmpeg','-v','error','-y','-loop','1','-i',str(root/'mock-opening.jpg'),
            '-vf','scale=180:320','-t','3','-threads','2','-c:v','libx264','-pix_fmt','yuv420p','-movflags','+faststart',str(clip)],check=True)
        page.get_by_role('button',name='สร้างร่างสินค้า').click()
        page.get_by_label('ชื่อสินค้า',exact=True).fill('กล่องเกม PS5 จากคลิปคนจริง')
        page.get_by_label('รูปสินค้า หรือวิดีโอ MP4 (32 MB)').set_input_files(root/'ps5-product.png')
        page.get_by_role('button',name='อัปโหลดสื่อ',exact=True).click()
        expect(page.get_by_alt_text('รูปสินค้า 1',exact=True)).to_be_visible()
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

        page.get_by_text('Text to Video',exact=True).click()
        expect(page.get_by_role('heading',name='Text to Video',exact=True)).to_be_visible()
        expect(page.get_by_label('ความยาวคลิป Text to Video')).to_have_value('60')
        expect(page.get_by_role('button',name='ให้สมองวางบทและแบ่งช็อต')).to_be_enabled()
        assert not errors,errors
        chromium.close()
        print('Chromium UGC passed: product-only gating, three hooks, refreshed image price, approved opening on both fal payloads, MP4, CTA, targeted repair, source clip frame and existing Text to Video UI.')


if __name__=='__main__':
    run(sys.argv[1],Path(sys.argv[2]))
