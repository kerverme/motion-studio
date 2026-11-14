# Prompt A / B — OpenAI Sol 6.1

เป้าหมายของเจ้าของ 14 พฤศจิกายน 2026: เลือกช่วงคลิป เช่น 0–15 วินาที รับ prompt ตามต้นฉบับก่อน จากนั้นเปลี่ยนเฉพาะตัวละครและสถานที่ หน้าหลักอยู่ที่ https://video.cloudbath.co/ เครื่องมือผลิตวิดีโอเดิมเก็บอยู่ในส่วนเพิ่มเติม

## สิ่งที่ระบบทำ

1. วัดเวลาและขอบเขตช็อตในเครื่อง เลือกช่วงยาวไม่เกิน 15 วินาที ตัดภาพตัวอย่าง คลิปพร้อมเสียง และเสียง WAV เฉพาะช่วงโดยไม่เรียก LLM
2. ตรวจราคาและสิทธิ์เข้าถึงโมเดล เมื่อเจ้าของยืนยันจึงให้ Sol สร้าง **Prompt A** จากภาพ และ GPT-Transcribe ถอดบทพูดจากเสียงช่วงที่เลือก เก็บภาษาต้นฉบับ A เดิมที่ยังไม่มีบทพูดใช้คำอธิบายภาพเดิมได้โดยจ่ายเฉพาะค่าถอดเสียง
3. เลือกตัวละครหลักแล้วพิมพ์ไอเดีย เช่น `young man` ให้ Sol ออกแบบรูปลักษณ์กับชุดที่เหมาะกับเรื่อง หลังดูราคาและยืนยันจึงสร้าง **Prompt B** อีกทางหนึ่งคือแก้ Character prompt / สถานที่เองแล้วบันทึก B ฟรี โครงท่าทาง เวลา กล้อง แสง อุปกรณ์ และบทพูดคงเดิม ตัวละครอื่นไม่เปลี่ยน เก็บแต่ละเวอร์ชันแยกกัน
4. คัดลอกหรือดาวน์โหลด prompt ไปใช้กับโมเดลสร้างวิดีโอ การทำ prompt ในหน้านี้ไม่ได้เรียกสร้างวิดีโออัตโนมัติ

โครงคำสั่งใน B เหมือน A ตรวจด้วย hash และเทียบข้อความ แต่ **ไม่มีโมเดล text-to-video ที่รับประกันวิดีโอเหมือนต้นฉบับ 100% จากข้อความเพียงอย่างเดียว** เมื่อเปลี่ยนร่างกายหรือโครงสถานที่ อาจทำท่าเดิมไม่ได้ ต้องอ่านเงื่อนไขความเข้ากันได้และตรวจผลจริง

## ข้อมูลที่ Sol ได้อ่าน

`gpt-6.1-sol` รับภาพได้ แต่ไม่รับ native video/audio ตามเอกสารที่ตรวจ 14 พฤศจิกายน 2026: https://developers.openai.com/api/docs/models/gpt-6.1-sol

ส่งภาพประมาณ 2 ภาพต่อวินาที และภาพต้น/กลาง/ท้ายของแต่ละช็อต สูงสุด 64 ภาพ ภาพมี frame index และ timestamp จริง หากเกินให้เลือกช่วงสั้นลง ไม่ลดภาพเงียบ ๆ ขอบเขตช่วงจะเลื่อนไปเฟรมที่เริ่มตรงหรือหลังเวลาที่เลือก และแสดงเวลาจริง ไม่เปลี่ยน shot boundaries ต้นฉบับ ภาพส่งย่อด้านยาวไม่เกิน 768 px คลิป preview รุ่นใหม่มีเสียง ส่งเฉพาะเสียงช่วงที่เลือกไป OpenAI Transcriptions แยกจาก Sol ไม่ส่งวิดีโอทั้งไฟล์ไปโมเดล

การตีความการเคลื่อนไหวระหว่างภาพอาจผิด จึงแสดงเป็นร่างจาก AI ต้องตรวจ ไม่ใช่ prompt ดั้งเดิม ไม่ใช่ผลที่เจ้าของตรวจแล้ว ID ตัวละครต่อเนื่องภายในช่วงที่เลือก การถอดคนละช่วงยังไม่ได้ยืนยันว่าเป็นตัวละครเดียวกันข้ามช่วง

## ตั้งค่าบน Railway เท่านั้น

Motion API และ Motion worker ใช้ตัวแปรเดียวกัน:

```text
OPENAI_API_KEY=<existing server secret>
MOTION_REVERSE_BRAIN_MODEL=gpt-6.1-sol
MOTION_REVERSE_OPENAI_RATE_JSON=<reviewed JSON price snapshot>
MOTION_REVERSE_TRANSCRIBE_MODEL=gpt-transcribe
MOTION_REVERSE_TRANSCRIBE_RATE_JSON=<reviewed duration price snapshot>
```

Worker ใช้ reference `${{motion-api.OPENAI_API_KEY}}` เพื่อใช้ key เดียวกับ API ไม่มี secret ใหม่ใน repository หรือเบราว์เซอร์ Re:Video ไม่จำเป็นต้องมี OpenAI key เพราะเรียก Motion ผ่าน private bridge ช่องกรอก API keys ถูกถอดจาก UI และ settings POST เดิมถูกปิดด้วย 403 ข้อมูลเก่าไม่ถูกลบ

Price snapshot ปัจจุบัน: USD/1M tokens input 2, cache-write reserve 2.5, output 10 ตรวจจากหน้า model ข้างต้น ณ `2026-11-14T06:00:00Z` หมดอายุ `2026-11-21T06:00:00Z` ผู้ดูแลต้องตรวจราคาใหม่และเปลี่ยน JSON บนทั้ง API/worker หากหมดอายุ ระบบไม่ยอมออกใบราคา ใช้ default service tier และสำรอง long-context surcharge ตามเอกสาร ไม่มี OpenRouter ในเส้นทางนี้

ใบราคาใช้ token estimate แบบเผื่อไว้ ไม่ใช่ยอด invoice ส่งจริงหลังอนุมัติเท่านั้น เก็บ token usage และยอดคำนวณแยกจาก invoice

## โครงสร้างและความทนทาน

Re:Video UI → authenticated same-origin bridge → Motion API/Postgres → Motion queue/worker → OpenAI frames + selected-audio transcription → immutable Prompt A → optional character design → slot-only Prompt B

- Migration `029_reverse_prompt_pairs.sql` เพิ่ม selections และ versions; `030_reverse_prompt_audio.sql` เพิ่ม audio evidence แยกจาก visual evidence จึงไม่แก้หลักฐานของใบราคาเดิม
- Routes: `POST prompt-range`, `GET prompts`, `POST prompt-quote`, `POST prompt-character-quote`, `POST prompt-remake` ภายใต้ `/app/api/reverse/projects/:id/`; ใช้ `approve` และ `resume` เดิม
- ผูกใบราคากับ source/evidence/model/system/schema/key/price/expiry ก่อนบันทึกอนุมัติใน ledger เดิม
- หนึ่ง submission หนึ่ง POST; มี response ID แล้วติดตามด้วย GET เท่านั้น; ถ้าไม่ทราบผล POST จะบล็อกการส่งซ้ำ
- เก็บ response ดิบแบบเข้ารหัสก่อนตรวจ schema; refusal/incomplete ไม่ถูกแทนด้วยข้อความจำลอง
- OpenAI background response storage เปิดเพื่อ resume; ใช้นโยบายเก็บข้อมูลตามผู้ให้บริการ
- แคชคำขอเดิมเพื่อไม่คิดเงินซ้ำ ข้อมูลเวลา/หลักฐาน/Prompt A ไม่ถูกเขียนทับ
- Rollback กลับ commit ก่อนหน้าได้โดยเก็บ migration/tables และข้อมูลเก่าไว้ ไม่ต้องลบ key หรือ volume

## การตรวจสอบ

API: typecheck และ 149 tests ผ่าน รวม quote/approval/idempotency, private access, stale price, immutable motion และ unknown slots

Worker: 57 tests ผ่าน / 1 skipped / 13 subtests; หลังปรับข้อความ uncertainty รัน targeted 3 tests ผ่าน รวม FFmpeg จริง, frame PTS, Python/JS hash parity, POST timeout และ GET-only resume

Re:Video: 525 tests ผ่าน / 6 skipped หลังแก้ expiry ของข้อมูลราคาจำลองใน tests เท่านั้น กฎราคาจริงไม่เปลี่ยน

UI: Chromium ทดสอบโหมดหลัก 10 checks และเครื่องมือเดิม 10 checks ผ่าน มี desktop/mobile, ไม่มี key fields, ไม่อนุมัติค่าใช้จ่ายเอง, ไม่ให้คัดลอก B ที่ยังไม่บันทึก, A และคำสั่งการเคลื่อนไหวคงเดิม ทั้งหมดเป็น HTTP fixtures ไม่ใช่หลักฐานคุณภาพการอ่านวิดีโอของ AI

ยังไม่ทดสอบ paid OpenAI inference หรือ paid video generation ในรอบพัฒนานี้ ต้องแยกผล production free smoke กับผลโมเดลจริง ดู DEPLOYMENT_PROMPT_AB_TH.md หลัง deploy

## สถานะระหว่างทำงาน (14 พฤศจิกายน 2026)

หน้าเว็บแสดงแถบเคลื่อนไหว เปอร์เซ็นต์ตามรายการที่ทำเสร็จ ขั้นตอนปัจจุบัน จำนวนภาพ และเวลาที่ผ่านไปทุกวินาที เวลาเริ่ม/จบและสถานะเก็บที่เซิร์ฟเวอร์ จึงดูต่อหลัง reload ได้

`GET /projects/:id/progress` ส่งเฉพาะ metadata ของงานและเวลาเซิร์ฟเวอร์ ไม่แนบ analysis, source, provider payload หรือผลวิเคราะห์ซ้ำ หน้าเว็บอ่านทุก 2.5 วินาทีระหว่างทำงาน และแก้เฉพาะส่วนสถานะ ไม่สร้างตัวเล่นวิดีโอใหม่หรือเขียนทับช่องที่กำลังแก้

Worker บันทึก `jobs.stage_results._reverse_progress` โดยไม่เปลี่ยน schema: อ่านไฟล์ → วัดเฟรม → ดึงภาพ → บันทึกภาพทีละภาพ → เตรียม/บันทึก preview → บันทึกช่วงที่เลือก เปอร์เซ็นต์คือจำนวนรายการสำเร็จหารด้วยรายการทั้งหมด ไม่ใช่เวลาที่เหลือหรือความเร็วของ AI

ช่วง OpenAI กำลังคิดไม่มีเปอร์เซ็นต์จากผู้ให้บริการ จะแสดงการรอผลพร้อมเวลาจริงและติดตาม response ID เดิม เมื่อเชื่อมต่อขัดข้อง จะลองอ่านสถานะอีกครั้ง ไม่ส่งคำขอสร้างงานเพิ่ม งานเสร็จแสดง 100% และหยุดนาฬิกา งานล้มเหลวแสดงข้อผิดพลาด โดยยังต้องใช้กฎ resume/approval เดิม

การเตรียมภาพยังใช้ FFmpeg กับขอบเขต/หลักฐานจาก rea-video จริง ส่วน Capsule ใช้ในเครื่องมือวางแผนเพิ่มเติม ไม่ต้องรันซ้ำเพื่อแสดงความคืบหน้าหรือแทนค่าตัวละคร/สถานที่

## บทพูดและตัวละครหลัก (14 พฤศจิกายน 2026, รอบแก้ไขเพิ่มเติม)

- สาเหตุเดิม: Sol อ่านภาพอย่างเดียว และ prompt compiler เขียน “No added … dialogue.” ตอนนี้ถอดเสียงด้วย GPT-Transcribe แล้วแนบบทพูดเดิมไว้ใน A และ B พร้อมล็อก hash รวมเสียง ไม่เดาคำพูดจากภาพ
- GPT-Transcribe ตามเอกสารปัจจุบันมีราคา $0.0045/นาที: https://developers.openai.com/api/docs/models/gpt-transcribe ตรวจ 14 พ.ย. 2026 ใช้ JSON transcript กับ languages ไม่ส่งพารามิเตอร์ word timestamps ที่รุ่นนี้ไม่รองรับ
- เวลาเป็นขอบเขตคลิปเสียงที่วัดจริง **ไม่ใช่เวลารายคำ** ผู้พูดยังเป็น unknown ไม่จับคู่กับ C1 จากการเดา การถอดเสียงอาจผิดจากดนตรี/เสียงรบกวน ต้องฟังตรวจ ผลไม่ใช่ voice clone หรือ lip sync
- โมเดล Whisper/SenseVoice ใน upstream ไม่ได้ถูกใช้ถอดเสียงในโหมดนี้ (SenseVoice ที่ pin ไว้ไม่รองรับภาษาไทย) rea-video ยังใช้แยกฉาก/เก็บหลักฐานจริง; Sol อ่านภาพและแต่งตัวละคร; GPT-Transcribe อ่านเสียง
- เสียง WAV mono 16 kHz เก็บแบบเข้ารหัส พร้อม SHA256 และเวลาเทียบต้นฉบับ รักษา offset เสียงกับภาพ รวมกรณี audio track เริ่มช้า
- การเพิ่มเสียงให้ A เก่าสร้างเวอร์ชันลูก ไม่แก้ A/B เก่า ไม่วิเคราะห์ภาพซ้ำ แคชเสียงผูกกับ source/model/audio/key โดยไม่ใช้ parent-version เป็นเหตุให้เสียเงินซ้ำ
- ASR เป็น synchronous POST ถ้าผลไม่แน่ชัดจะหยุดรอตรวจสอบ ไม่ส่งซ้ำ และไม่มี response ID ที่ตามผลได้เหมือน Responses API
- ตัวละครหลักเริ่มจากช่องที่ถูกอ้างถึงบ่อยสุด ผู้ใช้เปลี่ยนได้ ไม่อ้างว่า AI ยืนยันบทบาทหลักแล้ว AI ออกแบบ appearance + clothing (เสื้อ กางเกง รองเท้า ฯลฯ) จากเนื้อเรื่อง/สถานที่/ท่าทางและเงื่อนไข รักษาตัวละครอื่นและบทพูดเดิม รายละเอียดชุดเป็นความคิดสร้างสรรค์ใหม่ ไม่ใช่หลักฐานต้นฉบับ
- พิมพ์ไอเดียไม่มีค่าใช้จ่าย กดออกแบบจะเห็นราคา/โมเดล/ข้อมูลที่ส่งก่อนยืนยัน แก้ข้อความหลังขอราคาทำให้ใบราคาใน UI ใช้ต่อไม่ได้; การแก้ช่องตัวละครเองยังฟรี
- Deploy API/migration ก่อน worker ใหม่; API บล็อกเตรียมเสียง/ออกแบบตัวละครถ้า heartbeat ยังเป็น worker รุ่นเก่า แล้วค่อยอัปเดต Re:Video

ทดสอบด้วย FFmpeg จริงและ HTTP fixtures เท่านั้นในรอบพัฒนา ไม่มี paid inference หรือ paid generation และไม่ถือข้อความจำลองเป็นหลักฐานคุณภาพ ASR/LLM จริง รายงาน deployment แยกตรวจ service, audio SHA/duration/private access และ model availability โดยไม่กดยืนยันค่าใช้จ่ายแทนผู้ใช้
