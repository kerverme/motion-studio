# Deploy Prompt A / B — 14 พฤศจิกายน 2026

ปรับ framework และ deploy สำเร็จ เวลา 13:15 น. กรุงเทพฯ หน้าใช้งาน: https://video.cloudbath.co/

## Runtime ที่ใช้งานจริง

| Service | Commit | Deployment | สถานะ |
|---|---|---|---|
| Motion worker | d9a61cdeef6bea4de02d0a4b670452a02257be10 | 26d33ffa-1d1d-4c25-a148-5ff26c3bff33 | SUCCESS |
| Motion API | d9a61cdeef6bea4de02d0a4b670452a02257be10 | 99f54bf2-0b49-44cc-8c1c-ce05c0596d06 | SUCCESS |
| Re:Video UI | 2aaf87ad927df5b2dcc2db4b2ef1af7746814d3a | 08087025-0d70-4ca4-90e1-e451bac1d359 | SUCCESS |

ทั้งสอง repo ใช้ branch `codex/prompt-ab-sol-20261114` และ Railway pin ตาม commit ข้างต้น ไม่ merge เข้า main ของ Re:Video ไม่มีการเปลี่ยน DNS หรือ volume และไม่มี secrets/media source อยู่ในชุด commit นี้

Motion API ใช้ base main `4c0e9ed3ac8ffd61e83a34cfe12e14ce30673ad1` ที่มีงานล่าสุดของผู้ใช้แล้ว Re:Video ใช้ base `2b3e874f42aec75ac7ee9449880f2a2c79c0ad59` จากสายงาน video เดิม

## สิ่งที่ตรวจจริงบน production โดยไม่ใช้ paid inference

- Worker/API รายงาน OpenAI configured และ default `gpt-6.1-sol` ค่า model/rate ตรงกัน
- OpenAI model-access GET ผ่านด้วย key เดิมของระบบ มีใบราคาจริง ไม่มี blockers ไม่ต้องใช้ OpenRouter
- ใช้ public sample ของ rea-video ที่วิเคราะห์อยู่แล้ว เลือกช่วง 0–15 วินาที: 360 decoded frames, 9 ช็อตที่ตัดกับช่วงนั้น, 51 ภาพหลักฐานตามเวลา
- งาน free prepare `4da52919-ec72-4b31-b1a3-3c0068bcffdf` จบ READY_TO_POST การกดช่วงเดิมซ้ำได้ job/selection เดิม
- SHA-256 ของภาพอ่านกลับตรงกับไฟล์ก่อนอัปโหลด ไม่มีสิทธิ์เข้าถึงได้ HTTP 401
- Preview อ่านและ decode ได้ 360 เฟรม ไม่มีเสียง Container รายงาน 14.958333 วินาที (ต่างจากช่วง PTS 15 วินาทีหนึ่งเฟรมที่ 24 fps) เฟรมครบและเวลาในหลักฐานยังอ้างอิงต้นฉบับ ไม่ใช้ container preview ไปเขียนทับขอบเขตช็อต
- Source SHA-256 เดิม `4ca7b6cf2eca6c240a85a3404e958d4410d0e183cde233dcbe8b768bb25d688a` ไม่เปลี่ยน และชุดวิเคราะห์ต้นฉบับยังมี 10 ช็อต
- ใบราคาตัวอย่าง `9ed1ed88-1e8d-438f-af69-bfc30c532337`: ประเมินแบบเผื่อไว้ $0.8152 สำหรับ 51 ภาพ / output limit 16,000 tokens หมดอายุ 14 พ.ย. 2026 เวลา 13:31:27 กรุงเทพฯ ไม่ใช่ยอดที่ถูกเรียกเก็บ ต้องขอราคาใหม่หลังหมดอายุ
- Migration 029 applied; API health HTTP 200; หน้าเว็บยังป้องกันด้วย Cloudflare Access ผู้ไม่มี session ไม่ได้รับหน้าแอป
- Startup persistence smoke ผ่าน ตรวจไฟล์เดิม 26 ไฟล์และ source/export/report hashes เดิมครบ

## Tests และขอบเขตที่ยังไม่พิสูจน์

- Motion API: typecheck ผ่าน, 149 tests ผ่าน
- Motion worker: 57 ผ่าน / 1 skipped / 13 subtests; focused 3 tests ผ่านหลังแก้ uncertainty handling
- Re:Video: full suite 525 ผ่าน / 6 skipped หลังแก้วันหมดอายุของ test fixtures ไม่แตะกฎราคาจริง
- Chromium: primary A/B 10 checks และ legacy workspace 10 checks ผ่าน รวม desktop/mobile, ไม่มี key fields, immutable A/motion, การบันทึก B และไม่มี paid auto-submit

**ยังไม่มี paid OpenAI inference หรือ paid text-to-video ในรอบนี้** จึงยังไม่อ้างว่าความแม่นยำการอ่านคลิปหรือความเหมือนของวิดีโอที่สร้างผ่านการรับรอง UI tests ใช้ HTTP fixtures ส่วนการตัดคลิป/ภาพ/การเก็บไฟล์/ราคา/สิทธิ์โมเดลใช้ production จริง ไม่ได้ทดสอบผ่าน browser session ของเจ้าของบน production

เริ่มใช้จริง: เพิ่มคลิป → เข้า Prompt A/B → เลือกช่วง → ดูราคาถอด A → ยืนยัน → ตรวจ A → เปลี่ยนตัวละคร/สถานที่ → สร้าง B → คัดลอก ไม่มีช่องกรอก key ในเว็บ จัดการผ่าน Railway ตาม PROMPT_AB_TH.md

ข้อจำกัด: Sol รับ timestamped images ไม่ใช่ native video/audio การล็อกคำสั่งใน B ไม่รับประกันภาพ/ท่าทางจากโมเดลสร้างวิดีโอเหมือนต้นฉบับ 100% งานเร็วระหว่างภาพและตัวละครข้ามคนละช่วงต้องตรวจเอง

## Rollback

กลับ pin runtime เดิมได้โดยไม่ลบ migration/tables/volume:

- Motion API: 4e71f076e9e33f0c6a50d960d65a4dc0908d9ced
- Motion worker: 9b65b98b4959b98b5a7836ffaac848fe6e028f46
- Re:Video: b969b6cca561461d09a7348d465088eabde8cae6

เก็บ OPENAI_API_KEY และ private bridge/storage variables เดิมไว้ ไม่ต้องแสดงค่าหรือหมุน key เพื่อ rollback เอกสารหลัง deploy อาจอยู่ commit ที่ใหม่กว่า runtime ที่ pin; ไม่จำเป็นต้อง rebuild เพื่อเอกสารเท่านั้น
