"""Use the price snapshot verified by the API for this same Railway configuration."""
import datetime as dt


def current_rate(configured, ctx=None):
    if not configured:
        return None
    now=dt.datetime.now(dt.timezone.utc)
    def fresh(snapshot):
        return bool(snapshot) and now<dt.datetime.fromisoformat(snapshot['valid_until'].replace('Z','+00:00'))
    if fresh(configured):
        return configured
    if ctx is None:
        return None
    row=ctx.db.one('SELECT data FROM integrations WHERE provider=%s',('reverse_verified_price:'+configured['model'],))
    record=(row or {}).get('data') or {}
    rate=record.get('rate')
    if record.get('configured')!=configured or not fresh(rate):
        return None
    values=lambda obj:{k:v for k,v in obj.items() if k not in ('valid_until','checked_at')}
    return rate if values(rate)==values(configured) else None
