"""Recognize explicit billing rejections without exposing provider response bodies."""
from psycopg.types.json import Jsonb
from .text_video import ApprovalRequired


class ProviderCreditError(ApprovalRequired):
    def __init__(self, provider, before_acceptance):
        self.provider = provider
        self.before_acceptance = before_acceptance
        detail = ('เติมเครดิตหรือปรับวงเงิน แล้วดูราคาและยืนยันใหม่ได้'
                  if before_acceptance else 'มีคำขอที่ผู้ให้บริการรับไว้แล้ว โปรดตรวจรายการเรียกเก็บของงานเดิม')
        super().__init__(f'{provider} แจ้งว่าเครดิตหรือโควตาการใช้งานไม่พอ งานหยุดแล้ว {detail}')


def is_billing_error(status, body):
    if status == 402:
        return True
    if status not in (200, 400, 403, 429) or not isinstance(body, dict):
        return False
    detail = body.get('error') or body.get('detail') or body
    if isinstance(detail, list):
        return any(is_billing_error(status, item) for item in detail if isinstance(item, dict))
    if isinstance(detail, dict):
        codes = (detail.get('code'), detail.get('type'), detail.get('error_type'))
        if any(str(code).lower() in {'insufficient_quota','insufficient_credits','insufficient_balance','billing_hard_limit_reached','exhausted_balance'} for code in codes):
            return True
        detail = detail.get('message') or detail.get('msg') or detail.get('reason')
    message = str(detail or '').lower()
    return any(text in message for text in ('exhausted balance','insufficient balance','insufficient credit','out of credits','billing hard limit','exceeded your current quota'))


def check_billing(response, provider, *, before_acceptance):
    if response.status_code not in (400, 402, 403, 429):
        return
    try:
        body = response.json()
    except ValueError:
        body = {}
    if is_billing_error(response.status_code, body):
        raise ProviderCreditError(provider, before_acceptance)


def record_credit_stop(ctx, error, cache_key, call_key):
    marker = {'provider':error.provider,'rejected_before_acceptance':error.before_acceptance}
    with ctx.db.lock, ctx.db.conn.transaction():
        db = ctx.db.conn
        db.execute("UPDATE jobs SET stage_results=COALESCE(stage_results,'{}'::jsonb)||jsonb_build_object('_reverse_credit',%s::jsonb) WHERE id=%s",
                   (Jsonb(marker),ctx.job['id']))
        if error.before_acceptance:
            db.execute("""UPDATE creative_calls SET status='reconciled',actual_usd=0,error='credit_declined',result=%s,updated_at=now()
                        WHERE job_id=%s AND call_key=%s AND provider_id IS NULL AND status IN ('started','uncertain')""",
                       (Jsonb({'credit_declined':error.provider}), ctx.job['id'],call_key))
            db.execute("DELETE FROM creative_cache WHERE cache_key=%s AND result->>'owner'=%s",
                       (cache_key,str(ctx.job['id'])))
