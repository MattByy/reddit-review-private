const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const {Harness}=require('./workflow-harness.cjs');
const modes=['direct','question','context','help','method'];
async function setup(t){const h=await new Harness().init();t.after(()=>h.close());h.project=true;await h.sql("update workflow_state set value='{\"enabled\":true}' where key='message_workflow'");return h;}
async function start(h,id,input={}){
  await h.thread(id);const body={request_id:randomUUID(),...input},r=await h.api('/threads/'+id+'/queue',body);
  assert.equal(r.status,200,JSON.stringify(r));
  const [message]=await h.sql('select * from experiment_messages where experiment_id=$1',[r.body.experiment.id]);return {message,body,experiment:r.body.experiment};
}
async function config(h,enabled_actions){return h.call(h.messagesHandler,'/api/messages',{action:'configure_writer',enabled_actions},'POST','test-operator');}

test('five independent queue items get five modes; request retries, refreshes and fixed/test choices do not consume slots',async t=>{
  const h=await setup(t),items=[];
  for(let i=0;i<5;i++){
    const id='mode'+i,item=await start(h,id);items.push(item);
    assert.equal((await h.api('/threads/'+id+'/queue',item.body)).status,200);
    if(i===1){
      assert.equal((await start(h,'fixed1',{strategy:'help'})).message.writer_assignment.source,'fixed');
      assert.equal((await start(h,'test1',{strategy:'direct',queue_lane:'test',max_messages:1,max_depth:1})).message.writer_assignment.source,'test');
    }
  }
  assert.deepEqual(items.map(i=>i.message.suggested_action).sort(),[...modes].sort());
  assert.equal(new Set(items.map(i=>i.message.writer_assignment.cycle_id)).size,1);
  assert.deepEqual(items.map(i=>i.message.writer_assignment.position),[1,2,3,4,5]);
  const j=(await h.api('/jobs/claim',{agent:'writer',kinds:['write'],limit:1})).body.jobs[0];
  const refreshed=await h.api('/jobs/'+j.id+'/context',{agent:'writer',claim_token:j.claim_token});
  assert.deepEqual(refreshed.body.writer_environment,j.writer_environment);
  const next=await start(h,'mode5');assert.equal(next.message.writer_assignment.position,1);
  assert.notEqual(next.message.writer_assignment.cycle_id,items[0].message.writer_assignment.cycle_id);
  const writer=(await h.api('/writer')).body;assert.equal(writer.rotation.target_percent,20);assert.match(writer.startup_prompt,/automatically approves/);
  const unauth=await h.call(h.agent,'/api/agent/writer',undefined,'GET',null);assert.equal(unauth.status,401);
});

test('four configured modes get equal 25% cycles; saved assignments stay unchanged and identical settings do not reset a cycle',async t=>{
  const h=await setup(t),old=await start(h,'old1');
  const response=await config(h,modes.slice(1));assert.equal(response.status,200);assert.equal(response.body.writer.rotation.target_percent,25);
  const items=[];
  for(let i=0;i<8;i++){
    items.push((await start(h,'four'+i)).message);
    assert.equal((await config(h,[...modes.slice(1)].reverse())).status,200);
  }
  for(const group of [items.slice(0,4),items.slice(4)]){
    assert.deepEqual(group.map(m=>m.suggested_action).sort(),modes.slice(1).sort());
    assert.deepEqual(group.map(m=>m.writer_assignment.position),[1,2,3,4]);
    assert.ok(group.every(m=>m.writer_assignment.target_percent===25));
  }
  const unchanged=await h.messages.getMessage(old.message.id);assert.deepEqual(unchanged.writer_assignment,old.message.writer_assignment);
  for(const invalid of [[],['help','help'],['unknown'],[null]])assert.notEqual((await config(h,invalid)).status,200);
  const forbidden=await h.call(h.messagesHandler,'/api/messages',{action:'configure_writer',enabled_actions:['help']},'POST','test-agent');assert.equal(forbidden.status,401);
  const [rights]=await h.sql("select has_function_privilege('anon','next_message_action()','EXECUTE') allocate,has_function_privilege('anon','configure_message_writer(text[])','EXECUTE') configure");
  assert.equal(rights.allocate,false);assert.equal(rights.configure,false);
});

test('filing five contextual messages automatically approves each and sends final text through server delivery',async t=>{
  const h=await setup(t),items=[];
  for(let i=0;i<5;i++){
    items.push(await start(h,'send'+i));
    const comment=h.comment('reader'+i,'I need the field types for send'+i+'.','t3_send'+i);
    comment.data.link_id='t3_send'+i;h.reddit.get('send'+i)[1].data.children.push(comment);
  }
  const jobs=(await h.api('/jobs/claim',{agent:'one-writer',kinds:['write'],limit:5})).body.jobs;
  assert.equal(jobs.length,5);
  for(const j of jobs){
    assert.equal(j.actionable,true);assert.equal(j.writer_environment.assignment.mode,j.message.suggested_action);
    assert.match(j.writer_environment.prompt,new RegExp(j.message.suggested_action));
    assert.equal(j.context.observation.thread.body,'How can I compare output?');
    assert.equal(j.context.observation.comments[0].body,'I need the field types for '+j.experiment.thread_id+'.');
    const body=(j.message.suggested_action==='direct'?'Geonode team here: ':'')+'Compare the response fields for '+j.experiment.thread_id+'.';
    const input={agent:'one-writer',claim_token:j.claim_token,reply_mode:'opening',content_action:j.message.suggested_action,body,draft_body:body,humanization:{tool:'agent:self-edit',meaning_preserved:true},rationale:'Responds to the thread question about comparing output.'};
    const filed=await h.api('/messages/'+j.message.id,input);assert.equal(filed.status,200,JSON.stringify(filed));
    const m=filed.body.message;assert.equal(m.status,'queued');assert.ok(m.approved_at);assert.equal(m.approved_by,'one-writer');
    assert.equal(m.content_action,j.message.suggested_action);assert.equal(m.context.partial,true);assert.deepEqual(m.context.comments,j.context.observation.comments);
    const retry=await h.api('/messages/'+m.id,input);assert.equal(retry.status,200);assert.equal(retry.body.message.approved_at,m.approved_at);
    const [job]=await h.sql('select status from jobs where id=$1',[j.id]);assert.equal(job.status,'done');
  }
  assert.equal(h.vendor.length,0,'Filing does not send outside the durable delivery queue');
  // Real send handler, mocked provider: every approved row reaches Engain once.
  for(let i=0;i<5;i++){
    await h.sql("update message_publications set created_at=now()-interval '2 days'");
    await h.sql('update experiment_messages set next_check_at=null');
    await h.messages.dispatch();
  }
  assert.equal(h.vendor.length,5);
  const rows=await h.messages.rows();assert.ok(rows.messages.every(m=>m.task_id&&m.approved_at&&m.content_action));
  for(const m of rows.messages)assert.equal(h.vendor.find(v=>v._id===m.task_id).content,m.body);
  await h.messages.dispatch();assert.equal(h.vendor.length,5);
});

test('unreadable or changed context cannot approve a message; failed starts roll back rotation',async t=>{
  const h=await setup(t),item=await start(h,'stale1',{strategy:'help'});
  const j=(await h.api('/jobs/claim',{agent:'writer',kinds:['write'],limit:1})).body.jobs[0];
  h.reddit.get('stale1')[0].data.children[0].data.locked=true;
  const result=await h.api('/messages/'+item.message.id,{agent:'writer',claim_token:j.claim_token,body:'Inspect the response fields.',content_action:'help'});
  assert.equal(result.status,409);const m=await h.messages.getMessage(item.message.id);assert.equal(m.approved_at,null);assert.equal(m.body,null);
  const first=await start(h,'roll1');
  const fail=await h.api('/threads/roll1/queue',{request_id:randomUUID()});assert.notEqual(fail.status,200);
  const next=await start(h,'roll2');assert.equal(next.message.writer_assignment.position,2);assert.equal(next.message.writer_assignment.cycle_id,first.message.writer_assignment.cycle_id);
});

test('a provider rate limit preserves the writer approval and mode on the eventual retry',async t=>{
  const h=await setup(t),item=await start(h,'retry1',{strategy:'help'});
  const j=(await h.api('/jobs/claim',{agent:'original-writer',kinds:['write'],limit:1})).body.jobs[0];
  const filed=await h.api('/messages/'+item.message.id,{agent:'original-writer',claim_token:j.claim_token,body:'Inspect the field types before parsing.',content_action:'help'});
  assert.equal(filed.status,200);h.vendorMode='rate-limit';
  assert.equal((await h.messages.dispatch())[0].state,'waiting_rate_limit');
  const waiting=await h.messages.getMessage(item.message.id);assert.equal(waiting.status,'queued');
  assert.equal(Date.parse(waiting.approved_at),Date.parse(filed.body.message.approved_at));assert.equal(waiting.approved_by,'original-writer');
  h.vendorMode='normal';await h.sql('update experiment_messages set next_check_at=null');
  assert.equal((await h.messages.dispatch())[0].state,'submitted');
  const sent=await h.messages.getMessage(item.message.id);assert.equal(sent.approved_at,waiting.approved_at);assert.equal(sent.content_action,'help');
  assert.equal(h.vendor.length,1);
});

test('upgrade preserves old queued text, mode and unknown historical approval times',async t=>{
  let original;
  const h=await new Harness().init({beforeWriterRotation:async db=>{
    await db.sql("insert into threads(id,url,title,subreddit) values('legacy1','https://www.reddit.com/r/test/comments/legacy1/example/','Old question','test')");
    const e=await db.rpc('start_message_experiment',{p_thread_id:'legacy1',p_strategy:'help',p_request_id:randomUUID()});
    const [m]=await db.sql('select * from experiment_messages where experiment_id=$1',[e.id]);
    original=await db.rpc('edit_experiment_message',{p_message_id:m.id,p_body:'Existing checked text.',p_expected_body:null});
  }});t.after(()=>h.close());
  const m=await h.messages.getMessage(original.id);assert.equal(m.body,original.body);assert.equal(m.content_action,original.content_action);assert.equal(m.status,'queued');
  assert.equal(m.writer_assignment,null);assert.equal(m.approved_at,null);
});
