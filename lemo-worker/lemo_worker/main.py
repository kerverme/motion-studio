import json, os, signal, threading, time
from http.server import BaseHTTPRequestHandler, HTTPServer
from motion_worker import config, pipeline
from motion_worker.db import DB, Heartbeat
from motion_worker.storage import get_storage
from .catalog import enabled, GATES
from .render import stage_render, preflight

STOP=threading.Event()


class Health(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200);self.send_header('Content-Type','application/json');self.end_headers()
        self.wfile.write(json.dumps({'service':'lemo-worker','enabled':enabled(),'blocked_gates':[k for k in GATES if os.environ.get(k)!='true']}).encode())
    def log_message(self,*args):pass


def run(ctx):
    preflight(ctx)
    stages=[('GENERATING_AUDIO',pipeline.stage_audio),('BUILDING_TIMELINE',pipeline.stage_timeline),('RENDERING',stage_render),('QUALITY_CHECK',pipeline.stage_qa),('UPLOADING_DRIVE',pipeline.stage_upload)]
    for name,fn in stages:
        if name in ctx.r:continue
        ctx.db.status(ctx.job,name,name,pipeline.PROGRESS[name],name)
        result=fn(ctx);ctx.db.save_stage(ctx.job,name,result)
    result=ctx.r['UPLOADING_DRIVE']
    ctx.db.q('UPDATE jobs SET result=%s WHERE id=%s',(json.dumps(result),ctx.job['id']))
    ctx.db.status(ctx.job,'READY_TO_POST','READY_TO_POST',1,'Lemo ready for owner review')
    ctx.db.release(ctx.job)


def main():
    signal.signal(signal.SIGTERM,lambda *_:STOP.set());signal.signal(signal.SIGINT,lambda *_:STOP.set())
    threading.Thread(target=HTTPServer(('0.0.0.0',int(os.environ.get('PORT','8080'))),Health).serve_forever,daemon=True).start()
    db=None;store=None
    while not STOP.is_set():
        if not enabled():STOP.wait(5);continue
        if db is None:db=DB();store=get_storage()
        job=db.one("""UPDATE jobs SET locked_by=%s,locked_until=now()+interval '10 minutes',attempts=attempts+1
          WHERE id=(SELECT id FROM jobs WHERE kind='lemo' AND status NOT IN ('READY_TO_POST','FAILED','CANCELLED')
          AND (locked_until IS NULL OR locked_until<now()) ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *""",('lemo:'+config.WORKER_ID,))
        if not job:STOP.wait(3);continue
        heartbeat=Heartbeat(db,job['id'],'lemo:'+config.WORKER_ID);heartbeat.start()
        try:run(pipeline.Ctx(db,store,job))
        except Exception as error:db.fail(job,str(error),True)
        finally:heartbeat.stop.set();heartbeat.join(timeout=2)


if __name__=='__main__':main()
