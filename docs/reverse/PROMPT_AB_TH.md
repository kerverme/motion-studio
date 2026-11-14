# Prompt A / B — OpenAI Sol 6.1

เป้าหมายของเจ้าของ 14 พฤศจิกายน 2026: เลือกช่วงคลิป เช่น 0–15 วินาที รับ prompt ตามต้นฉบับก่อน จากนั้นเปลี่ยนเฉพาะตัวละครและสถานที่ หน้าหลักอยู่ที่ https://video.cloudbath.co/ เครื่องมือผลิตวิดีโอเดิมเก็บอยู่ในส่วนเพิ่มเติม

## สิ่งที่ระบบทำ

1. วัดเวลาและขอบเขตช็อตในเครื่อง เลือกช่วงยาวไม่เกิน 15 วินาที ตัดภาพตัวอย่างและคลิปดูตัวอย่างโดยไม่เรียก LLM
2. ตรวจราคาและสิทธิ์เข้าถึงโมเดล เมื่อเจ้าของยืนยันจึงเรียก OpenAI Responses API หนึ่งครั้งเพื่อสร้าง **Prompt A**: ตัวละคร สถานที่ ท่าเริ่ม การกระทำตามเวลา ท่าจบ กล้อง แสง สไตล์ และสิ่งที่ยังไม่แน่ใจ
3. แก้คำอธิบายตัวละคร `[C1]` / สถานที่ `[L1]` เพื่อสร้าง **Prompt B** ด้วยการแทนช่องข้อความ ไม่เรียก LLM เพิ่ม ไม่ให้แก้ท่าทางหรือเวลา เก็บแต่ละเวอร์ชันแยกกัน และคง A เดิม
4. คัดลอกหรือดาวน์โหลด prompt ไปใช้กับโมเดลสร้างวิดีโอ การทำ prompt ในหน้านี้ไม่ได้เรียกสร้างวิดีโออัตโนมัติ

โครงคำสั่งใน B เหมือน A ตรวจด้วย hash และเทียบข้อความ แต่ **ไม่มีโมเดล text-to-video ที่รับประกันวิดีโอเหมือนต้นฉบับ 100% จากข้อความเพียงอย่างเดียว** เมื่อเปลี่ยนร่างกายหรือโครงสถานที่ อาจทำท่าเดิมไม่ได้ ต้องอ่านเงื่อนไขความเข้ากันได้และตรวจผลจริง

## ข้อมูลที่ Sol ได้อ่าน

`gpt-6.1-sol` รับภาพได้ แต่ไม่รับ native video/audio ตามเอกสารที่ตรวจ 14 พฤศจิกายน 2026: https://developers.openai.com/api/docs/models/gpt-6.1-sol

ส่งภาพประมาณ 2 ภาพต่อวินาที และภาพต้น/กลาง/ท้ายของแต่ละช็อต สูงสุด 64 ภาพ ภาพมี frame index และ timestamp จริง หากเกินให้เลือกช่วงสั้นลง ไม่ลดภาพเงียบ ๆ ขอบเขตช่วงจะเลื่อนไปเฟรมที่เริ่มตรงหรือหลังเวลาที่เลือก และแสดงเวลาจริง ไม่เปลี่ยน shot boundaries ต้นฉบับ ภาพส่งย่อด้านยาวไม่เกิน 768 px คลิป preview ไม่มีเสียง ไม่ส่งทั้งคลิปหรือเสียงให้ OpenAI

การตีความการเคลื่อนไหวระหว่างภาพอาจผิด จึงแสดงเป็นร่างจาก AI ต้องตรวจ ไม่ใช่ prompt ดั้งเดิม ไม่ใช่ผลที่เจ้าของตรวจแล้ว ID ตัวละครต่อเนื่องภายในช่วงที่เลือก การถอดคนละช่วงยังไม่ได้ยืนยันว่าเป็นตัวละครเดียวกันข้ามช่วง

## ตั้งค่าบน Railway เท่านั้น

Motion API และ Motion worker ใช้ตัวแปรเดียวกัน:

```text
OPENAI_API_KEY=<existing server secret>
MOTION_REVERSE_BRAIN_MODEL=gpt-6.1-sol
MOTION_REVERSE_OPENAI_RATE_JSON=<reviewed JSON price snapshot>
```

Worker ใช้ reference `${{motion-api.OPENAI_API_KEY}}` เพื่อใช้ key เดียวกับ API ไม่มี secret ใหม่ใน repository หรือเบราว์เซอร์ Re:Video ไม่จำเป็นต้องมี OpenAI key เพราะเรียก Motion ผ่าน private bridge ช่องกรอก API keys ถูกถอดจาก UI และ settings POST เดิมถูกปิดด้วย 403 ข้อมูลเก่าไม่ถูกลบ

Price snapshot ปัจจุบัน: USD/1M tokens input 2, cache-write reserve 2.5, output 10 ตรวจจากหน้า model ข้างต้น ณ `2026-11-14T06:00:00Z` หมดอายุ `2026-11-21T06:00:00Z` ผู้ดูแลต้องตรวจราคาใหม่และเปลี่ยน JSON บนทั้ง API/worker หากหมดอายุ ระบบไม่ยอมออกใบราคา ใช้ default service tier และสำรอง long-context surcharge ตามเอกสาร ไม่มี OpenRouter ในเส้นทางนี้

ใบราคาใช้ token estimate แบบเผื่อไว้ ไม่ใช่ยอด invoice ส่งจริงหลังอนุมัติเท่านั้น เก็บ token usage และยอดคำนวณแยกจาก invoice

## โครงสร้างและความทนทาน

Re:Video UI → authenticated same-origin bridge → Motion API/Postgres → Motion queue/worker → OpenAI → structured immutable Prompt A → deterministic Prompt B

- Migration `029_reverse_prompt_pairs.sql` เพิ่ม selections และ versions เท่านั้น
- Routes: `POST prompt-range`, `GET prompts`, `POST prompt-quote`, `POST prompt-remake` ภายใต้ `/app/api/reverse/projects/:id/`; ใช้ `approve` และ `resume` เดิม
- ผูกใบราคากับ source/evidence/model/system/schema/key/price/expiry ก่อนบันทึกอนุมัติใน ledger เดิม
- หนึ่ง submission หนึ่ง POST; มี response ID แล้วติดตามด้วย GET เท่านั้น; ถ้าไม่ทราบผล POST จะบล็อกการส่งซ้ำ
- เก็บ response ดิบแบบเข้ารหัสก่อนตรวจ schema; refusal/incomplete ไม่ถูกแทนด้วยข้อความจำลอง
- OpenAI background response storage เปิดเพื่อ resume; ใช้นโยบายเก็บข้อมูลตามผู้ให้บริการ
- แคชคำขอเดิมเพื่อไม่คิดเงินซ้ำ ข้อมูลเวลา/หลักฐาน/Prompt A ไม่ถูกเขียนทับ
- Rollback กลับ commit ก่อนหน้าได้โดยเก็บ migration/tables และข้อมูลเก่าไว้ ไม่ต้องลบ key หรือ volume

## การตรวจสอบ

API: typecheck และ 149 tests ผ่าน รวม quote/approval/idempotency, private access, stale price, immutable motion และ unknown slots

Worker: 57 tests ผ่าน / 1 skipped / 13 subtests; หลังปรับข้อความ uncertainty รัน targeted 3 tests ผ่าน รวม FFmpeg จริง, frame PTS, Python/JS hash parity, POST timeout และ GET-only resume

UI: Chromium ทดสอบโหมดหลัก 10 checks และเครื่องมือเดิม 10 checks ผ่าน มี desktop/mobile, ไม่มี key fields, ไม่อนุมัติค่าใช้จ่ายเอง, ไม่ให้คัดลอก B ที่ยังไม่บันทึก, A และคำสั่งการเคลื่อนไหวคงเดิม ทั้งหมดเป็น HTTP fixtures ไม่ใช่หลักฐานคุณภาพการอ่านวิดีโอของ AI

ยังไม่ทดสอบ paid OpenAI inference หรือ paid video generation ในรอบพัฒนานี้ ต้องแยกผล production free smoke กับผลโมเดลจริง ดู DEPLOYMENT_PROMPT_AB_TH.md หลัง deploy
