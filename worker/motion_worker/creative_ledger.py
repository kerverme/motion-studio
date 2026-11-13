"""Durable reservations. An ambiguous POST is never retried automatically."""
import hashlib, json, math
from psycopg.types.json import Jsonb


class AmbiguousCall(RuntimeError):
    pass


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()


class Ledger:
    def __init__(self, ctx):
        self.ctx, self.db, self.job = ctx, ctx.db, ctx.job

    def reserve(self, key, provider, model, category, payload, cap):
        if not math.isfinite(cap) or cap <= 0:
            raise ValueError('A positive bounded reservation is required')
        with self.db.lock, self.db.conn.transaction():
            c = self.db.conn
            job = c.execute('SELECT status,package FROM jobs WHERE id=%s FOR UPDATE', (self.job['id'],)).fetchone()
            if not job or job['status'] == 'CANCELLED':
                raise RuntimeError('Job cancelled')
            approval = c.execute('SELECT * FROM creative_approvals WHERE job_id=%s', (self.job['id'],)).fetchone()
            if not approval:
                raise RuntimeError('No persisted owner approval')
            old = c.execute('SELECT * FROM creative_calls WHERE job_id=%s AND call_key=%s', (self.job['id'], key)).fetchone()
            if old:
                if old['request_hash'] != digest(payload):
                    raise RuntimeError('Idempotency key changed request')
                if old['status'] in ('complete', 'reconciled') and old['result']:
                    return old
                if old['provider']=='openai' and old.get('provider_id') and old['status'] in ('started','uncertain'):
                    return old  # coding adapter resumes GET of this saved response, never POST
                if old['provider']=='fal' and old.get('provider_id') and old['status'] in ('started','uncertain'):
                    return old  # reverse adapter polls the persisted accepted request; no new POST
                raise AmbiguousCall('Previous request needs reconciliation; will not submit twice')
            rows = c.execute('SELECT category,sum(coalesce(actual_usd,reserved_usd)) AS cost FROM creative_calls WHERE job_id=%s GROUP BY category', (self.job['id'],)).fetchall()
            used = {r['category']: float(r['cost']) for r in rows}
            if sum(used.values()) + cap > float(approval['max_usd']) + 1e-8 or used.get(category, 0) + cap > float(approval['allocations'].get(category, 0)) + 1e-8:
                raise RuntimeError('Approved job/category budget exhausted')
            return c.execute("INSERT INTO creative_calls(job_id,call_key,provider,model,category,request_hash,reserved_usd,status) VALUES(%s,%s,%s,%s,%s,%s,%s,'started') RETURNING *",
                             (self.job['id'], key, provider, model, category, digest(payload), cap)).fetchone()

    def execute(self, key, provider, model, category, payload, cap, call):
        row = self.reserve(key, provider, model, category, payload, cap)
        if row['status'] in ('complete', 'reconciled'):
            return row['result']
        self.db.q("UPDATE creative_calls SET status='started',updated_at=now() WHERE id=%s AND status IN ('reserved','uncertain')", (row['id'],))
        try:
            result = call(row['id'])
            # Result contains durable artifact keys, never temporary signed URLs.
            usage = result.get('usage', {})
            actual = usage.get('verified_usd')
            if actual is not None and (not math.isfinite(actual) or actual < 0):
                raise ValueError('Invalid reconciled cost')
            self.db.q("UPDATE creative_calls SET status='complete',result=%s,usage=%s,actual_usd=%s,provider_id=coalesce(%s,provider_id),updated_at=now() WHERE id=%s",
                      (Jsonb(result), Jsonb(usage), actual, result.get('provider_id'), row['id']))
            if actual is not None and actual > cap:
                self.db.event(self.job['id'], 'Provider actual cost exceeded reservation; further spending blocked by ledger', {'category': category}, 'error')
                raise RuntimeError('Actual provider cost exceeded reserved cap')
            return result
        except Exception as error:
            self.db.q("UPDATE creative_calls SET status='uncertain',error=%s,updated_at=now() WHERE id=%s AND status='started'", (type(error).__name__, row['id']))
            raise


def cached_call(ctx, category, model, payload, cap, generate):
    key = digest({'contract': 1, 'category': category, 'model': model, 'payload': payload})
    # Global claim prevents concurrent jobs charging for identical assets.
    with ctx.db.lock, ctx.db.conn.transaction():
        c = ctx.db.conn
        hit = c.execute('SELECT * FROM creative_cache WHERE cache_key=%s FOR UPDATE', (key,)).fetchone()
        if hit and hit['result'].get('complete'):
            result = hit['result']['value']
            if all(ctx.store.exists(k) for k in result.get('asset_keys', [])):
                return {**result, 'cache_hit': True, 'cache_key': key}
            raise RuntimeError('Cached artifact missing; restore it before requesting paid regeneration')
        if hit and hit['result'].get('owner') != str(ctx.job['id']):
            raise AmbiguousCall('Matching paid asset is already in progress in another job')
        if not hit:
            inserted = c.execute('INSERT INTO creative_cache(cache_key,category,result) VALUES(%s,%s,%s) ON CONFLICT DO NOTHING RETURNING cache_key',
                                 (key, category, Jsonb({'owner': str(ctx.job['id'])}))).fetchone()
            if not inserted:
                raise AmbiguousCall('Matching asset claim won by another job; retry after it finishes')
    result = Ledger(ctx).execute(key, {'coding':'openai','compute':'executor'}.get(category,'elevenlabs'), model, category, payload, cap, generate)
    ctx.db.q('UPDATE creative_cache SET result=%s WHERE cache_key=%s', (Jsonb({'complete': True, 'value': result}), key))
    return {**result, 'cache_hit': False, 'cache_key': key}
