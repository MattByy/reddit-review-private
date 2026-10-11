const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const {Harness}=require('./workflow-harness.cjs');
async function setup(t){const h=await new Harness().init();t.after(()=>h.close());h.project=true;await h.sql("update workflow_state set value='{\"enabled\":true}' where key='message_workflow'");await h.thread();return h;}
async function start(h,strategy='question',id='abc123'){const r=await h.api('/threads/'+id+'/queue',{request_id:randomUUID(),strategy,max_messages:6});assert.equal(r.status,200,JSON.stringify(r));return r.body.experiment;}
async function current(h,e){return (await h.sql('select * from experiment_messages where experiment_id=$1 order by step desc limit 1',[e.id]))[0];}
async function dueWriter(h,e){await h.sql('update experiment_messages set decision_due_at=now() where experiment_id=$1',[e.id]);await h.sql("update jobs set due_at=now() where id in (select job_id from experiment_messages where experiment_id=$1)",[e.id]);}
async function claim(h,e){await dueWriter(h,e);const r=await h.api('/jobs/claim',{agent:'tree-writer',kinds:['write'],limit:5});assert.equal(r.status,200);const j=r.body.jobs.find(j=>j.payload.experiment_id===e.id);assert.ok(j,JSON.stringify(r));return j;}
async function file(h,j,reply_mode,body){return h.api('/messages/'+j.message.id,{agent:'tree-writer',claim_token:j.claim_token,reply_mode,body,rationale:'This contribution answers the selected parent; brand relevance assessed separately.'});}
async function publish(h,e,mode,body){
  const j=await claim(h,e);assert.equal(j.actionable,true,JSON.stringify(j));const filed=await file(h,j,mode,body);assert.equal(filed.status,200,JSON.stringify(filed));
  await h.sql("update message_publications set created_at=now()-interval '2 days'");await h.sql('update experiment_messages set next_check_at=null');
  const sent=await h.messages.dispatch();assert.equal(sent[0]?.state,'submitted',JSON.stringify(sent));
  const m=await current(h,e),task=h.vendor.find(t=>t._id===m.task_id),id='m'+m.step;
  task.status='published';task.redditUrl='https://www.reddit.com/r/test/comments/abc123/example/'+id+'/';
  const parent=m.kind==='reply'?'t1_'+h.reader.identity(m.target_url).comment_id:'t3_abc123';
  h.reddit.get('abc123')[1].data.children.push(h.comment(id,m.body,parent,[],'provider_writer'));
  await h.messages.verify(m,task.redditUrl);return (await h.sql('select * from experiment_messages where id=$1',[m.id]))[0];
}
test('equal opening allocation and balanced reply suggestions count assignments, not successful survivors',async t=>{
  const h=await setup(t);
  for(let i=0;i<50;i++){
    const id=i?'bal'+i.toString(36):'abc123';await h.thread(id);
    const r=await h.api('/threads/'+id+'/queue',{request_id:randomUUID()});assert.equal(r.status,200);
    const e=r.body.experiment,m=await current(h,e);assert.equal(e.max_messages,6);assert.equal(e.max_depth,4);
    const body=e.strategy_id==='direct'?'Geonode team here: compare the output format.':'Which output fields are required?';
    await h.messages.change({action:'edit',message_id:m.id,expected_body:null,body});
    await h.sql("update experiment_messages set task_id=$2,status='submitted' where id=$1",[m.id,'balance-'+i]);
    await h.rpc('observe_experiment_message',{p_message_id:m.id,p_visibility:'visible',p_url:'https://www.reddit.com/r/test/comments/'+id+'/example/pub/',p_evidence:{author:'writer'},p_reason:null});
  }
  const opening=await h.sql("select suggested_action,count(*)::int n from experiment_messages where step=1 group by suggested_action");
  assert.equal(opening.length,5);assert.ok(opening.every(r=>r.n===10));
  const followup=await h.sql("select suggested_action,count(*)::int n from experiment_messages where step=2 group by suggested_action");
  assert.equal(followup.length,5);assert.ok(followup.every(r=>r.n===8));
  const stats=(await h.messages.rows()).actions.filter(r=>r.stage==='first_reply'&&r.basis==='suggested');assert.equal(stats.length,5);
  assert.ok(stats.every(s=>s.assigned===8&&s.written===0&&s.published===0&&s.pending===8&&s.publication_percent===null));
});
test('four-level ceiling allows only siblings; the sixth message exhausts even an entirely unbranded path',async t=>{
  const h=await setup(t),e=await start(h);
  for(const [i,mode] of ['opening','reply','chain','chain'].entries())await publish(h,e,mode,'Useful contribution '+i+'.');
  const j=await claim(h,e);assert.equal(j.actionable,true,JSON.stringify(j));assert.deepEqual(j.parent_options.map(o=>o.reply_mode),['sibling']);
  assert.equal(j.context.source_observation.target.body,'Useful contribution 3.');
  assert.deepEqual(j.decision_context.limits,{max_messages:6,max_depth:4,messages_already_published:4,current_message:5,messages_remaining_including_this:2,last_message:false});
  assert.equal((await file(h,j,'chain','Too deep.')).status,422);
  await assert.rejects(h.rpc('file_experiment_message',{p_message_id:j.message.id,p_agent:'tree-writer',p_token:j.claim_token,p_body:'Too deep.',p_rationale:'Test depth fence',p_context:{},p_reply_mode:'chain'}),/Maximum reply depth/);
  await assert.rejects(h.messages.change({action:'edit',message_id:j.message.id,expected_body:null,body:'Still too deep.',reply_mode:'chain'}),/Maximum reply depth/);
  assert.equal((await current(h,e)).body,null,'Rejected choices roll back the entire filing');
  await h.sql("update jobs set status='planned',claim_token=null where id=$1",[j.id]);
  await publish(h,e,'sibling','An additional point on the same parent.');
  const last=await claim(h,e);assert.equal(last.decision_context.limits.last_message,true);
  await h.sql("update jobs set status='planned',claim_token=null where id=$1",[last.id]);
  await publish(h,e,'sibling','A final useful point without a brand.');
  assert.deepEqual((await h.sql('select depth from experiment_messages where experiment_id=$1 order by step',[e.id])).map(m=>m.depth),[1,2,3,4,4,4]);
  assert.equal((await h.sql('select status from message_experiments where id=$1',[e.id]))[0].status,'exhausted');
  assert.equal((await current(h,e)).step,6);
});
test('a one-level experiment stops after its unbranded opening and limit parameters are idempotent',async t=>{
  const h=await setup(t),input={request_id:randomUUID(),strategy:'question',max_depth:1};
  const result=await h.api('/threads/abc123/queue',input);assert.equal(result.status,200);const e=result.body.experiment;
  assert.equal((await h.api('/threads/abc123/queue',input)).body.experiment.id,e.id);
  assert.equal((await h.api('/threads/abc123/queue',{...input,max_depth:4})).status,400);
  await publish(h,e,'opening','Which fields are missing?');
  const [after]=await h.sql('select * from message_experiments where id=$1',[e.id]);assert.equal(after.status,'exhausted');assert.match(after.reason,/depth limit/);
  assert.equal((await current(h,e)).step,1);
  assert.equal((await h.api('/threads/abc123/queue',{request_id:randomUUID(),max_messages:18})).status,422);
});
test('context overrides require a reason; humanizer provenance preserves brand and does not relabel on retry',async t=>{
  const h=await setup(t),e=await start(h);await publish(h,e,'opening','Which fields are required?');const j=await claim(h,e);
  const action=j.message.suggested_action==='help'?'method':'help';
  const input={agent:'tree-writer',claim_token:j.claim_token,reply_mode:'reply',content_action:action,body:'Geonode team here: compare missing fields before retrying.',rationale:'Address the selected parent.'};
  const route='/messages/'+j.message.id;
  assert.equal((await h.api(route,input)).status,400);
  const good={...input,action_override_reason:'The parent asks for a concrete comparison.',draft_body:'Geonode team here: first compare the missing fields, then retry.',humanization:{tool:'test-humanizer',meaning_preserved:true}};
  const changedBrand={...good,body:'Compare missing fields before retrying.'};assert.equal((await h.api(route,changedBrand)).status,400);
  assert.equal((await h.api(route,{...good,humanization:{tool:'test-humanizer',meaning_preserved:false}})).status,400);
  const saved=await h.api(route,good);assert.equal(saved.status,200,JSON.stringify(saved));
  assert.equal(saved.body.message.content_action,action);assert.equal(saved.body.message.draft_body,good.draft_body);assert.equal(saved.body.message.humanization.source,'agent_reported');
  assert.equal((await h.api(route,good)).status,200);
  assert.equal((await h.api(route,{...good,content_action:j.message.suggested_action})).status,400);
  const stats=(await h.messages.rows()).actions;const actual=stats.find(s=>s.stage==='first_reply'&&s.basis==='chosen'&&s.action===action);
  assert.equal(actual.written,1);assert.equal(actual.published,0);assert.equal(actual.overrides,1);assert.equal(actual.pending,1);
  assert.equal(j.decision_context.content_actions.length,5);assert.ok(j.decision_context.content_actions.every(a=>a.target_percent===20));
  const boot=(await h.api('/bootstrap')).body;assert.equal(boot.protocol_version,5);assert.ok(boot.capabilities.automatic_tasks.includes('provider polling'));
});
test('50 initial threads stay independent; an unbranded publication returns once with its URL and a future due time',async t=>{
  const h=await setup(t),e=await start(h);for(let i=1;i<50;i++){const id='q'+i.toString(36);await h.thread(id);await start(h,'question',id);}
  assert.equal((await h.sql('select count(*)::int n from experiment_messages'))[0].n,50);assert.equal((await h.sql('select count(*)::int n from experiment_messages where step>1'))[0].n,0);
  const j=(await h.api('/jobs/claim',{agent:'tree-writer',kinds:['write'],limit:1})).body.jobs[0];assert.equal(j.message.experiment_id,e.id);
  assert.equal((await file(h,j,'opening','Which response fields are required?')).status,200);await h.messages.dispatch();let m=await current(h,e);
  const url='https://www.reddit.com/r/test/comments/abc123/example/m1/';h.reddit.get('abc123')[1].data.children.push(h.comment('m1',m.body,'t3_abc123',[],'provider_writer'));
  await h.messages.verify(m,url);await h.messages.verify(m,url);
  const next=await current(h,e);assert.equal(next.step,2);assert.equal(next.previous_message_id,m.id);assert.equal(next.target_url,url);assert.equal(next.parent_message_id,null);assert.equal(next.body,null);
  assert.ok(Date.parse(next.decision_due_at)>Date.now()+23*3600000);
  const claimed=await h.api('/jobs/claim',{agent:'another-writer',kinds:['write'],limit:5});assert.ok(claimed.body.jobs.length);assert.ok(claimed.body.jobs.every(j=>j.payload.experiment_id!==e.id));
  assert.equal((await h.sql('select count(*)::int n from experiment_messages'))[0].n,51);
});
test('first follow-up is forced; later explicit sibling/chain decisions create 1,2,2,3,3,4 with exact parents',async t=>{
  const h=await setup(t),e=await start(h);const first=await publish(h,e,'opening','Which output fields are required?');
  let j=await claim(h,e);assert.deepEqual(j.parent_options.map(c=>c.reply_mode),['reply']);assert.equal(j.source_message.reddit_url,first.reddit_url);
  assert.equal((await file(h,j,'sibling','A separate point.')).status,422);assert.equal((await file(h,j,'wait','A separate point.')).status,422);
  // Return this claimed job to its durable queue so the helper can resume it.
  await h.sql("update jobs set status='planned',claim_token=null where id=$1",[j.id]);
  await publish(h,e,'reply','Compare the field types before transforming the response.');
  j=await claim(h,e);assert.deepEqual(j.parent_options.map(c=>[c.reply_mode,c.parent_step,c.depth]),[['chain',2,3],['sibling',1,2]]);
  assert.equal((await file(h,j,undefined,'Another useful point.')).status,422);
  await h.sql("update jobs set status='planned',claim_token=null where id=$1",[j.id]);
  await publish(h,e,'sibling','Also retain an unmodified response for comparison.');
  await publish(h,e,'chain','Keep its timestamp alongside the response.');
  await publish(h,e,'sibling','Redact credentials before sharing that saved response.');
  await publish(h,e,'chain','Geonode team here: compare the expected parser fields before choosing an integration.');
  const messages=await h.sql('select * from experiment_messages where experiment_id=$1 order by step',[e.id]);assert.deepEqual(messages.map(m=>m.depth),[1,2,2,3,3,4]);
  assert.deepEqual(messages.map(m=>messages.find(p=>p.id===m.parent_message_id)?.step||0),[0,1,1,3,3,5]);
  assert.equal(h.vendor[2].url,first.reddit_url);assert.equal(h.vendor[4].url,messages[2].reddit_url);assert.equal(h.vendor[5].url,messages[4].reddit_url);
  assert.equal((await h.sql('select status from message_experiments where id=$1',[e.id]))[0].status,'monitoring');assert.equal(messages.length,6);
  const rows=await h.messages.rows();assert.equal(rows.shapes[0].depths,'1,2,2,3,3,4');assert.equal(rows.shapes[0].parents,'0,1,1,3,3,5');assert.equal(rows.shapes[0].successes,0);
});
test('an unpublished or removed third message cannot generate a fourth or fifth',async t=>{
  const h=await setup(t),e=await start(h);await publish(h,e,'opening','Which format do you need?');await publish(h,e,'reply','The field types determine the parsing step.');
  const j=await claim(h,e);assert.equal((await file(h,j,'chain','Record a sample value for each field.')).status,200);
  await h.sql("update message_publications set created_at=now()-interval '2 days'");await h.messages.dispatch();const latest=await current(h,e);assert.equal(latest.status,'submitted');
  await h.messages.tick();assert.equal((await current(h,e)).step,3);h.vendor.at(-1).status='mod_removed';await h.sql('update experiment_messages set next_check_at=null');await h.messages.tick();
  assert.equal((await current(h,e)).step,3);assert.equal((await current(h,e)).status,'removed');assert.equal((await h.sql('select status from message_experiments where id=$1',[e.id]))[0].status,'removed');
});
test('a sibling still stops if the latest source is removed, even when its chosen parent survives',async t=>{
  const h=await setup(t),e=await start(h);await publish(h,e,'opening','Which data is missing?');await publish(h,e,'reply','Check a raw response before changing the parser.');
  const j=await claim(h,e);assert.equal((await file(h,j,'sibling','Compare the response shape too.')).status,200);
  await h.sql("update message_publications set created_at=now()-interval '2 days'");h.reddit.get('abc123')[1].data.children.find(c=>c.data.id==='m2').data.body='[removed]';
  const before=h.vendor.length;assert.equal((await h.messages.dispatch())[0].state,'removed');assert.equal(h.vendor.length,before);assert.equal((await current(h,e)).status,'stopped');
});
test('changing only the reply parent during checks invalidates a pending send',async t=>{
  const h=await setup(t),e=await start(h);const first=await publish(h,e,'opening','Which response shape is expected?');await publish(h,e,'reply','Start by inspecting the raw fields.');
  const j=await claim(h,e),body='Check empty fields separately from missing fields.';assert.equal((await file(h,j,'chain',body)).status,200);
  await h.sql("update message_publications set created_at=now()-interval '2 days'");const selected=await current(h,e),original=global.fetch;let edited=false;
  global.fetch=async(url,options)=>{if(!edited&&String(url).endsWith('/api/v1/rule-check')){edited=true;await h.messages.change({action:'edit',message_id:selected.id,expected_body:body,body,reply_mode:'sibling',expected_parent_message_id:selected.parent_message_id});}return original(url,options);};
  const n=h.vendor.length;await h.messages.dispatch();global.fetch=original;assert.equal(h.vendor.length,n);assert.equal((await current(h,e)).parent_message_id,first.id);
  await h.sql('update experiment_messages set next_check_at=null');await h.messages.dispatch();assert.equal(h.vendor.length,n+1);assert.equal(h.vendor.at(-1).url,first.reddit_url);
});
test('brand publication stops writing; only a fresh visible check after seven days confirms success',async t=>{
  const h=await setup(t),e=await start(h,'direct'),m=await publish(h,e,'opening','Geonode team here: compare the returned fields with your parser requirements.');
  let [state]=await h.sql('select * from message_experiments where id=$1',[e.id]);assert.equal(state.status,'monitoring');assert.equal(state.success_at,null);assert.equal((await current(h,e)).step,1);
  const thread=h.reddit.get('abc123');await h.sql("update message_experiments set monitor_until=now()-interval '1 minute' where id=$1",[e.id]);await h.sql("update experiment_messages set monitor_until=now()-interval '1 minute',next_check_at=null where id=$1",[m.id]);
  h.reddit.set('abc123',new Response('{}',{status:403}));await h.messages.tick();assert.equal((await h.sql('select status from message_experiments where id=$1',[e.id]))[0].status,'monitoring');
  h.reddit.set('abc123',thread);await h.sql('update experiment_messages set next_check_at=null');await h.messages.tick();
  [state]=await h.sql('select * from message_experiments where id=$1',[e.id]);assert.equal(state.status,'succeeded');assert.ok(state.success_at);assert.ok((await current(h,e)).monitor_complete_at);
  assert.equal((await h.sql("select successes from message_experiment_results where strategy_id='direct'"))[0].successes,1);
});
test('removal during seven-day monitoring is a failed outcome, not a retained success',async t=>{
  const h=await setup(t),e=await start(h,'direct');await publish(h,e,'opening','Geonode team here: inspect a sample response first.');h.vendor[0].status='automod_removed';await h.sql('update experiment_messages set next_check_at=null');await h.messages.tick();
  const [state]=await h.sql('select * from message_experiments where id=$1',[e.id]);assert.equal(state.status,'removed');assert.equal(state.success_at,null);
  const [stats]=await h.sql("select * from message_experiment_results where strategy_id='direct'");assert.equal(stats.brand_mentions,1);assert.equal(stats.successes,0);assert.equal(stats.success_percent,'0.0');
});
test('migration preserves published history and requeues old pending replies with fresh ownership',async t=>{
  let completedId,pendingId,bodyBefore,oldToken;
  const h=await new Harness().init({beforeQueueDecisions:async db=>{
    for(const [id,finish] of [['old111',true],['old222',false]]){
      await db.sql('insert into threads(id,url,title,subreddit) values($1,$2,$3,$4)',[id,'https://www.reddit.com/r/test/comments/'+id+'/title/','Existing thread','test']);
      const e=await db.rpc('start_message_experiment',{p_thread_id:id,p_strategy:'question',p_request_id:randomUUID(),p_max_messages:6});
      const [opening]=await db.sql('select * from experiment_messages where experiment_id=$1',[e.id]);
      await db.sql("update experiment_messages set status='visible',body='Existing question?',contains_brand=false,task_id=$2,reddit_url=$3,verified_at=now()-interval '8 days' where id=$1",[opening.id,'old-task-'+id,'https://www.reddit.com/r/test/comments/'+id+'/title/root/']);
      await db.rpc('advance_message_experiment',{p_experiment_id:e.id});
      const [next]=await db.sql('select * from experiment_messages where experiment_id=$1 and step=2',[e.id]);
      if(finish){completedId=e.id;bodyBefore='Geonode team here: existing response.';await db.sql("update experiment_messages set status='visible',body=$2,contains_brand=true,task_id='old-brand-task',reddit_url=$3,verified_at=now()-interval '8 days' where id=$1",[next.id,bodyBefore,'https://www.reddit.com/r/test/comments/'+id+'/title/brand/']);await db.rpc('advance_message_experiment',{p_experiment_id:e.id});}
      else{pendingId=next.id;oldToken=randomUUID();await db.sql("update jobs set status='claimed',claimed_by='old-writer',claim_token=$2,lease_until=now()+interval '30 minutes' where id=$1",[next.job_id,oldToken]);}
    }
  }});t.after(()=>h.close());
  const [e]=await h.sql('select * from message_experiments where id=$1',[completedId]);assert.equal(e.status,'monitoring');assert.equal(e.success_at,null);assert.ok(Date.parse(e.monitor_until)<Date.now());
  const [m]=await h.sql('select * from experiment_messages where experiment_id=$1 and step=2',[completedId]);assert.equal(m.body,bodyBefore);assert.equal(m.task_id,'old-brand-task');assert.equal(m.reply_mode,'reply');assert.equal(m.depth,2);assert.equal(m.parent_message_id,m.previous_message_id);
  const [pending]=await h.sql('select * from experiment_messages where id=$1',[pendingId]);assert.equal(pending.parent_message_id,null);assert.equal(pending.depth,null);assert.equal(pending.reply_mode,null);assert.ok(pending.previous_message_id);
  const [job]=await h.sql('select * from jobs where id=$1',[pending.job_id]);assert.equal(job.status,'planned');assert.equal(job.claim_token,null);
  const [rights]=await h.sql("select has_function_privilege('anon','choose_experiment_parent(uuid,text)','EXECUTE') callable,has_table_privilege('anon','message_shape_results','SELECT') readable");assert.equal(rights.callable,false);assert.equal(rights.readable,false);
});
test('three unreadable old threads do not starve later due messages',async t=>{
  const h=await setup(t);
  for(let i=1;i<=4;i++){
    const id='s'+i;await h.thread(id);const e=await start(h,'question',id),m=await current(h,e);
    await h.messages.change({action:'edit',message_id:m.id,expected_body:null,body:'Which output fields are needed for sample '+i+'?'});
    if(i<4)h.reddit.set(id,new Response('{}',{status:403}));
  }
  assert.equal((await h.messages.dispatch()).length,3);assert.equal(h.vendor.length,0);
  await h.sql('update experiment_messages set next_check_at=now() where next_check_at is not null');
  await h.messages.dispatch();assert.equal(h.vendor.length,1);assert.match(h.vendor[0].content,/sample 4/);
});
