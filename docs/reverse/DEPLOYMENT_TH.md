# ผลการติดตั้งและ deploy — 13 พฤศจิกายน 2026

ติดตั้ง source จริงของ rea-video และ Capsule Cinema ใน Python environments แยกกัน เชื่อมผ่าน Motion API/worker เดิม และ deploy ครบสามบริการแล้ว รายงานนี้ **ยังไม่รับรอง full acceptance**: การพิสูจน์คุณภาพ Reverse Prompt จาก Gemini ของจริงรอ owner approval ก่อนเรียก paid API

## เปิดใช้งาน

- [Re:Video Studio](https://video.cloudbath.co/) — ผ่าน Cloudflare owner login เดิม
- [Motion Studio](https://studio.cloudbath.co/app)
- เปิดโปรเจกต์ → Original → Customize → Generate: ดูฉากต้นฉบับ แก้ตัวละคร/สถานที่/การกระทำ/กล้อง แล้วดูราคาและลองเฉพาะฉากที่เลือก
- รายการ Fal ณ checkpoint มี 120 T2V endpoints; Motion มี 59 presets ที่พร้อมตาม capability/ราคาในชุดข้อมูลที่ตรวจ รุ่นที่ยังไม่รองรับหรือราคาไม่สดจะถูกบล็อก ระบบเดิมของ Re:Video ยังคงอยู่
- Vision และการสร้างภาพ/วิดีโอ/เสียงมีค่าใช้จ่ายแยกกัน ใน adapter นี้ Vision/Planner ใช้ Fal key เดิม ไม่ต้องเพิ่ม OpenRouter API

## Runtime ที่ deploy จริง

| บริการ | Commit | Deployment | ผล |
|---|---|---|---|
| Motion API | [9b65b98](https://github.com/kerverme/motion-studio/commit/9b65b98b4959b98b5a7836ffaac848fe6e028f46) | fe7f6ad2-7d46-4bae-92f5-80e50a9acbc0 | SUCCESS |
| Motion worker | commit เดียวกับ API | 964acd5c-dcc4-453b-a72b-b6033cff019b | SUCCESS |
| Re:Video | [b969b6c](https://github.com/kerverme/stream-house-explore/commit/b969b6cca561461d09a7348d465088eabde8cae6) | 0519d00f-05a8-4635-b62f-cc43dbf00b66 | SUCCESS |

ทั้งสอง repos ใช้ branch `codex/reverse-capsule-20261113` ไม่แก้ main Railway pin runtime ตามตาราง ส่วน commit เอกสารหลังจากนั้นไม่ทำให้ deploy ใหม่

Upstream ที่ติดตั้งจริง: rea-video 0.1.0 `ab8580e38a1255425b0d3b481866590766932079` และ capsule-cinema 2.0.0 `97229260c96ee8a3fb37db83027bbc1aefd8f073` ทั้งคู่ Apache-2.0 มี LICENSE/SKILL และ CLI/API ใช้งานได้

## หลักฐาน

- วิดีโอสาธารณะของ upstream: 10 ฉาก วัดจากเฟรมจริง มีภาพอ้างอิงต้นฉบับ 30 ภาพ และ VIDEO.md ผ่าน upstream validator
- Production upload/queue/storage/readback สำเร็จ เข้าถึง private asset โดยไม่ล็อกอินได้ 401
- Capsule สร้าง recipe/production plan จริงสองเวอร์ชัน แยกกฎ reusable ออกจากข้อมูลเฉพาะวิดีโอ และรักษาเวอร์ชันเก่า
- Re:Video regression **525 passed / 6 skipped**; Motion API **145 passed + typecheck**; worker **54 passed / 1 skipped / 13 subtests**
- แพตช์ container formats ตรวจเพิ่ม: bridge **11 passed**, worker integration **10 passed**; API 145 ผ่านซ้ำ
- Chromium **10 checks ผ่าน**: ลำดับสามขั้น แก้เฉพาะฉาก คงฉากอื่น quote หนึ่งฉาก ไม่มี auto approval และมือถือไม่ล้นจอ ใช้ HTTP fixtures จึงไม่ใช่หลักฐานคุณภาพโมเดล
- Assembly ใช้ FFmpeg จริง ตรวจลำดับภาพ จำนวนเฟรม เวลา เสียง และเส้นทางซับจาก alignment ด้วยสื่อทดสอบสังเคราะห์ ไม่ใช่หนังที่สร้างจาก paid provider
- Startup ของ Re:Video ตรวจไฟล์เดิม **26 รายการ** source/export/proof checksum ตรงเดิม volume `/data` เดิม และ Cloudflare Access เดิมยังทำงาน
- Motion health 200; Notion sync เดิม 24/24 ไม่มี error ไม่มี paid provider request ใหม่ในงานนี้

อ่าน [หลักฐาน acceptance](ACCEPTANCE.md), [ข้อมูล deployment ที่ตรวจได้](evidence/final-deployment.json), [สถาปัตยกรรม/API/migration/rollback](README_TH.md) และ [architecture audit](ARCHITECTURE_AUDIT_TH.md)

## สิ่งที่ยังต้องพิสูจน์

1. ให้ Gemini ดู shot 2 ของวิดีโอตัวอย่างจริงและตรวจว่าบรรยายตัวละคร เหตุการณ์ กล้อง และ English Reverse Prompt ถูกต้อง ใบราคาล่าสุดแยกไว้ใน [pending quote](evidence/vision-quote-pending.json) ต้อง refresh เมื่อหมดอายุและได้รับ owner approval ก่อนส่ง
2. การสร้างภาพ วิดีโอ เสียง planner และ visual QA แบบ paid ต้องมีใบราคา/การอนุมัติแยกตามคำขอ ยังไม่ได้อ้างว่า live generation ผ่าน
3. Browser walkthrough หลัง owner login จริงยังไม่ได้ทำ การทดสอบ UI อัตโนมัติใช้ localhost; production ตรวจ auth gate, API, runtime, storage, persistence จริง
4. โมเดลไม่รับประกันตัวละครเหมือนทุกเฟรม งานยาว/ซับซ้อนและทุกรุ่นยังต้องทดสอบเพิ่มเติม

การแยกฉากและวัด metadata ใช้เครื่องมือ ไม่จำเป็นต้องเสีย LLM tokens ส่วนการให้ AI เข้าใจภาพและเขียน prompt มีค่าบริการ และการสร้างวิดีโอใหม่มีค่าใช้จ่ายอีกส่วนหนึ่ง

## ย้อนกลับ

หยุดรับ reverse jobs ใหม่และรอ/ยกเลิกงานที่กำลังทำก่อนย้อน worker ใช้บริการ/volume เดิม pin commit ก่อนหน้า เก็บ PostgreSQL tables, ledger, ciphertext และ storage key ไว้ ห้ามลบตารางหรือส่ง provider POST ที่สถานะไม่แน่นอนซ้ำ ดูรายละเอียดใน README
