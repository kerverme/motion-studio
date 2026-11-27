import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PGlite} from '@electric-sql/pglite';
import type pg from 'pg';
import {OpenAIReadUnavailable} from './openai-response.js';
import {drainStudioQueue, withStudioPlannerSession, type PlannerDb} from './studio-queue.js';

test('startup recovers accepted work, defers unreadable IDs fairly, and preserves active legacy, deleted and Reverse rows', async t => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(`CREATE TABLE drafts(
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), topic text UNIQUE, status text, creative jsonb, draft jsonb,
    removed_at timestamptz, planner_checkpoint jsonb, error text, log jsonb DEFAULT '[]', created_at timestamptz DEFAULT now(),
    updated_at timestamptz DEFAULT now());
    INSERT INTO drafts(topic,status,planner_checkpoint) VALUES ('accepted','writing','{"version":1}'),('new','queued',null),
      ('legacy-active','researching',null),('legacy-old','writing',null),('deleted','researching','{"version":1}'),
      ('reverse','queued',null),('unknown-intent','writing','{"version":1}');
    UPDATE drafts SET removed_at=now() WHERE topic='deleted';
    UPDATE drafts SET creative='{"reverse_project":"one","quote_id":"two"}' WHERE topic='reverse';
    UPDATE drafts SET updated_at=now()-interval '1 hour' WHERE topic='legacy-old';
    UPDATE drafts SET updated_at=now()-interval '1 minute' WHERE topic='accepted';
    UPDATE drafts SET planner_checkpoint='{"version":1,"wait":{"next_poll_at":9999999999999}}' WHERE topic='unknown-intent'`);
  const q = {query: async (sql:string, args:unknown[]=[]) => {
    const result = await db.query(sql,args);
    return {...result,rowCount:result.affectedRows};
  }} as PlannerDb;
  const topics:string[] = [];
  let canRead = false;
  const generate = async (id:string, connection:PlannerDb) => {
    assert.equal(connection,q);
    const row = (await q.query('SELECT topic FROM drafts WHERE id=$1',[id])).rows[0];
    topics.push(row.topic);
    if (row.topic==='accepted' && !canRead) throw new OpenAIReadUnavailable('poll later');
    if (row.topic==='unknown-intent') throw Error('unconfirmed provider request');
    await q.query("UPDATE drafts SET status='ready' WHERE id=$1",[id]);
  };
  await drainStudioQueue(q,generate);
  assert.deepEqual(topics,['accepted','new']);
  const status = async (topic:string) => (await q.query('SELECT status,error FROM drafts WHERE topic=$1',[topic])).rows[0];
  assert.equal((await status('accepted')).status,'writing');
  assert.equal((await status('legacy-active')).status,'researching');
  assert.equal((await status('legacy-old')).status,'failed');
  assert.equal((await status('deleted')).status,'researching');
  assert.equal((await status('reverse')).status,'queued');
  assert.equal((await status('unknown-intent')).status,'writing');
  await q.query(`UPDATE drafts SET planner_checkpoint=jsonb_set(planner_checkpoint,'{wait,next_poll_at}','0') WHERE topic='unknown-intent'`);
  canRead=true;
  await drainStudioQueue(q,generate);
  assert.deepEqual(topics.slice(2),['unknown-intent','accepted']);
  assert.equal((await status('accepted')).status,'ready');
  assert.equal((await status('unknown-intent')).error,'unconfirmed provider request');
});

test('replicas use only the session holding the lock, release it on failure, and destroy a disconnected client', async () => {
  let owner:EventEmitter|null=null, targetError=false;
  const released:boolean[]=[];
  const pool={connect:async()=>{
    const client=Object.assign(new EventEmitter(),{
      query:async(sql:string)=>{
        if(sql.includes('pg_try_advisory_lock')) {
          const locked=owner===null;
          if(locked)owner=client;
          return {rows:[{locked}]};
        }
        assert.equal(owner,client);
        assert.match(sql,/pg_advisory_unlock/);
        owner=null;return {rows:[]};
      },
      release:(destroy:boolean)=>{released.push(destroy);if(destroy)owner=null;}
    });
    return client;
  }} as unknown as pg.Pool;
  await assert.rejects(withStudioPlannerSession(pool,async first=>{
    assert.equal(first,owner);
    await withStudioPlannerSession(pool,async()=>assert.fail('another replica cannot run while owned'));
    throw Error('work failed');
  }),/work failed/);
  assert.deepEqual(released,[false,false]);
  await withStudioPlannerSession(pool,async connection=>{
    (connection as unknown as EventEmitter).emit('error',new Error('session disconnected'));
    targetError=true;
  });
  assert.equal(targetError,true);
  assert.deepEqual(released,[false,false,true]);
});
