"""Persist measured work progress; never simulate provider percentages or ETA."""
import datetime as dt
from psycopg.types.json import Jsonb


def report(ctx, phase, label, *, completed=None, total=None, detail='', mode='waiting'):
    now = dt.datetime.now(dt.timezone.utc).isoformat()
    state = ctx.job.setdefault('stage_results', {})
    old = state.get('_reverse_progress') or {}
    fraction = None
    if completed is not None and total is not None:
        if not 0 <= completed <= total or total <= 0:
            raise ValueError('Invalid measured progress')
        fraction = completed / total
    value = {'phase': phase, 'label': label, 'detail': detail, 'mode': mode,
             'completed': completed, 'total': total,
             'started_at': old.get('started_at') or now, 'updated_at': now}
    # Cancellation and terminal state remain authoritative. No provider dispatch here.
    ctx.db.q("""UPDATE jobs SET status='RUNNING', stage=%s,
        progress=COALESCE(%s, progress), updated_at=now(),
        stage_results=stage_results || jsonb_build_object('_reverse_progress', %s::jsonb)
        WHERE id=%s AND status NOT IN ('READY_TO_POST','FAILED','CANCELLED')""",
        ('REVERSE_' + phase.upper(), fraction, Jsonb(value), ctx.job['id']))
    state['_reverse_progress'] = value
    return value
