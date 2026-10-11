// Executes the production handlers and migrations in disposable PGlite databases.
// All external calls terminate in Harness.fetch. Agent decisions and humanizer
// output are illustrative fixtures, not LLM or humanizer-service executions.
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const {Harness}=require('../tests/workflow-harness.cjs');
const clone=value=>JSON.parse(JSON.stringify(value));
const BRAND='Geonode team here. Compare one successful response with one error response and handle their schemas separately.';
const QUESTION='Is the problem missing fields, or fields arriving with the wrong type?';
class Scenario {
  constructor(id,title,description){Object.assign(this,{id,title,description,steps:[],checks:[],elapsed:0,traffic:[],wake:0});}
  async init(){
    for(const name of ['ENGAIN_PROJECT_ID','ENGAIN_PRIVATE_ACCOUNT_ID','ENGAIN_DELIVERY'])delete process.env[name];
    this.h=await new Harness().init();this.h.project=true;
    await this.h.sql("update workflow_state set value='{\"enabled\":true}' where key='message_workflow'");
    await this.h.thread();
    this.h.reddit.get('abc123')[0].data.children[0].data.title='How should I compare API responses before changing my parser?';
    this.h.reddit.get('abc123')[0].data.children[0].data.selftext='Some fields disappear when a request fails. I need a useful way to compare successful and error responses.';
    const fetch=this.h.fetch.bind(this.h);
    global.fetch=async(url,options={})=>{
      const u=new URL(url),entry={system:u.hostname==='api.engain.io'?'Engain':'Reddit',method:options.method||'GET',url:String(url),request:options.body?JSON.parse(options.body):null};
      try{let response=await fetch(url,options);
        // The documented pooled creation response uses id; task lookups use _id.
        if(u.hostname==='api.engain.io'&&entry.method==='POST'&&/^\/api\/v1\/tasks\/(comment|reply)$/.test(u.pathname)&&response.status<300){
          const task=await response.json();response=new Response(JSON.stringify({id:task._id,status:task.status}),{status:response.status,headers:{'Content-Type':'application/json'}});
        }
        if(u.hostname!=='db.test'){entry.status=response.status;entry.response=await response.clone().json().catch(()=>null);this.traffic.push(entry);}return response;}
      catch(e){if(u.hostname!=='db.test')this.traffic.push({...entry,error:e.message});throw e;}
    };
    return this;
  }
  async state(){
    const experiments=await this.h.sql('select id,thread_id,strategy_id,status,current_step,max_messages,max_depth,success_step,success_at,reason from message_experiments order by created_at,id');
    const messages=await this.h.sql('select id,experiment_id,step,status,body,reply_mode,depth,parent_message_id,previous_message_id,suggested_action,content_action,action_override_reason,contains_brand,task_id,reddit_url,verified_at,last_visibility,reason,humanization from experiment_messages order by created_at,step');
    const jobs=await this.h.sql("select id,status,attempts,claimed_by,checkpoint,blocked_reason from jobs where kind='write' order by created_at");
    const attempts=await this.h.sql('select message_id,state,task_id,reason from message_publications order by created_at');
    return {experiments,messages,jobs,attempts,engain_tasks:clone(this.h.vendor),metrics:{experiments:experiments.length,messages:messages.length,verified:messages.filter(m=>m.verified_at).length,provider_tasks:this.h.vendor.length,successes:experiments.filter(e=>e.success_at).length}};
  }
  async step(actor,title,narrative,run){
    const cursor=this.traffic.length,result=run?await run():null;
    this.steps.push({number:this.steps.length+1,elapsed_minutes:this.elapsed,actor,title,narrative,result:clone(result??null),traffic:clone(this.traffic.slice(cursor)),state:clone(await this.state())});
    return result;
  }
  check(description,value){assert.ok(value,description);this.checks.push(description);}
  async api(route,body){const r=await this.h.api(route,body);return {request:{method:body===undefined?'GET':'POST',path:'/api/agent'+route,body:body||null},status:r.status,response:r.body};}
  async current(){return (await this.h.sql('select * from experiment_messages where experiment_id=$1 order by step desc limit 1',[this.experiment.id]))[0];}
  async start(strategy='question',extra={}){
    const result=await this.step('queue','One opening enters the queue','Only message 1 exists. Replies will be created after a verified unbranded publication.',()=>this.api('/threads/abc123/queue',{request_id:randomUUID(),strategy,...extra}));
    assert.equal(result.status,200);this.experiment=result.response.experiment;return this.experiment;
  }
  async advance(minutes,label){
    this.elapsed+=minutes;
    await this.step('clock',label||'Advance the simulation clock',`Compress ${minutes} minutes by aging timestamps in this local database and the fake provider. No real time is skipped in production; intermediate polling ticks are omitted.`,async()=>{
      const columns=await this.h.sql("select table_name,column_name from information_schema.columns where table_schema='public' and table_name in ('experiment_messages','message_experiments','message_publications','jobs','engain_tasks') and data_type='timestamp with time zone'");
      const tables={};for(const row of columns)(tables[row.table_name]||=[]).push(row.column_name);
      for(const [table,fields] of Object.entries(tables))await this.h.sql('update '+table+' set '+fields.map(f=>f+'='+f+'-make_interval(mins=>$1)').join(','),[minutes]);
      for(const task of this.h.vendor)for(const field of ['creationDate','createdAt'])if(task[field])task[field]=new Date(Date.parse(task[field])-minutes*60000).toISOString();
      return {compressed_minutes:minutes};
    });
  }
  async awaken(limit=1,label){
    this.agent='demo-writer-'+(++this.wake);
    const result=await this.step('agent',label||'A fresh writer wakes up','The writer loads bootstrap, then claims due writing jobs. It has no prior conversational memory. Discovery jobs belong to a separate worker in this replay.',async()=>{
      const bootstrap=await this.api('/bootstrap'),claim=await this.api('/jobs/claim',{agent:this.agent,kinds:['write'],limit});
      assert.equal(bootstrap.response.protocol_version,5);assert.equal(claim.status,200);return {bootstrap,claim};
    });
    this.job=result.claim.response.jobs[0]||null;return this.job;
  }
  async draft(mode,body,action,rationale){
    const job=this.job;assert.ok(job?.actionable,'Writer needs a due, actionable job');
    const chosen=action||job.message.suggested_action;
    const override=chosen!==job.message.suggested_action?'The current parent is better served by '+chosen+' than the suggested '+job.message.suggested_action+'.':null;
    await this.step('agent','Choose this turn only',rationale,async()=>({decision:{message:job.message.step,reply_mode:mode,content_action:chosen,suggested_action:job.message.suggested_action,action_override_reason:override,mentions_geonode:/\bgeonode\b/i.test(body)},context_received:job.decision_context,parent_options:job.parent_options}));
    const draft='For this case, '+body;
    await this.step('humanizer','Example humanizer step — simulated','A local fixture removes the introductory filler. No external humanizer is connected or called; this step illustrates its place in the workflow.',async()=>({tool:'simulation-humanizer-stub',draft,final:body,brand_preserved:/\bgeonode\b/i.test(draft)===/\bgeonode\b/i.test(body)}));
    const filed=await this.step('agent','File the final text and decision','The agent saves one message through our API and finishes its job. The agent does not call Engain directly.',()=>this.api('/messages/'+job.message.id,{agent:this.agent,claim_token:job.claim_token,reply_mode:mode,content_action:chosen,action_override_reason:override,body,rationale,draft_body:draft,humanization:{tool:'simulation-humanizer-stub',meaning_preserved:true,simulation:true}}));
    assert.equal(filed.status,200,JSON.stringify(filed));return filed.response.message;
  }
  async tick(title='Automatic cron runs',narrative='The server observes provider tasks, verifies Reddit evidence, updates the queue and submits eligible saved text. No writing agent runs in this step.'){
    return this.step('server',title,narrative,async()=>{
      const r=await this.h.call(require('../api/cron/tick.js'),'/api/cron/tick',undefined,'GET','test-cron');assert.equal(r.status,200,JSON.stringify(r));
      return {request:{method:'GET',path:'/api/cron/tick'},status:r.status,response:r.body};
    });
  }
  async publish(message){
    const m=message||await this.current(),task=this.h.vendor.find(t=>t._id===m.task_id);assert.ok(task,'Expected an accepted provider task');
    await this.step('fixture','Engain reports publication; Reddit exposes the comment','These are invented provider and Reddit responses. Our saved message remains unverified until the next cron observes them.',async()=>{
      const id='m'+m.step,url='https://www.reddit.com/r/test/comments/abc123/example/'+id+'/';task.status='published';
      if(m.transport.mode==='private')task.resultUrl=url;else task.redditUrl=url;
      this.h.reddit.get('abc123')[1].data.children.push(this.h.comment(id,m.body,m.kind==='reply'?'t1_'+this.h.reader.identity(m.target_url).comment_id:'t3_abc123',[],m.transport.mode==='private'?'geonode_test':'provider_writer'));
      return {task_id:m.task_id,status:'published',comment_url:url};
    });
    await this.advance(31,'Next visibility polling checkpoint');await this.tick('Cron saves and verifies the Reddit URL');
    const [saved]=await this.h.sql('select * from experiment_messages where id=$1',[m.id]);assert.ok(saved.verified_at);return saved;
  }
  async writeAndPublish(mode,body,action,rationale){await this.awaken();await this.draft(mode,body,action,rationale);await this.tick('Cron checks and submits the saved message');return this.publish();}
  async finish(outcome){
    this.outcome=outcome;this.final=await this.state();this.status='passed';return {id:this.id,title:this.title,description:this.description,outcome,status:this.status,checks:this.checks,steps:this.steps,final:this.final};
  }
}
async function runScenario(id,title,description,run){const s=await new Scenario(id,title,description).init();try{return await run(s);}finally{await s.h.close();}}
async function runAll(onCase=()=>{}){
  const results=[];const add=async(...args)=>{const r=await runScenario(...args);results.push(r);onCase({id:r.id,steps:r.steps.length,outcome:r.outcome});};
  await add('direct','Brand in message 1 → seven-day success','The automatic clock owns everything after the writer files one direct opening.',async s=>{
    await s.start('direct');await s.writeAndPublish('opening',BRAND,'direct','The opening is assigned a direct mention. Give a factual, attributed answer to the thread.');
    s.check('A verified brand mention enters monitoring and creates no reply',(await s.state()).experiments[0].status==='monitoring'&&(await s.state()).messages.length===1);
    await s.awaken();s.check('No writing job remains after the brand mention',s.job===null);
    await s.advance(7*24*60+1,'Seven-day final checkpoint');await s.tick('Cron performs the final fresh visibility check');
    s.check('Fresh visibility after the seven-day deadline confirms success',(await s.state()).experiments[0].status==='succeeded');
    return s.finish('Succeeded after one message and a fresh seven-day check.');
  });
  await add('branch','Question → reply → sibling → chain','Each choice is made at a later wake-up, using the newly published URL and current discussion.',async s=>{
    await s.start();await s.writeAndPublish('opening',QUESTION,'question','Ask which failure case the thread is discussing. Do not mention Geonode in this opening.');
    await s.awaken();s.check('A fresh publication is scheduled rather than immediately claimable',s.job===null);
    await s.advance(24*60+1,'The next reply becomes due');
    await s.writeAndPublish('reply','Keep one raw response and compare it with the parsed output; missing fields and wrong types need different checks.','help','Only a reply to message 1 is available. Offer the next practical check without a brand mention.');
    await s.advance(24*60+1,'The next decision becomes due');
    await s.writeAndPublish('sibling','Also capture the status code: an error response may have a different structure.','context','This is a separate point about the original missing-field question, so reply to message 1 beside message 2.');
    await s.advance(24*60+1,'Another queue turn becomes due');
    await s.writeAndPublish('chain',BRAND,'direct','This develops message 3 about error-response schemas, so chain beneath it and include a factual, attributed mention.');
    const messages=(await s.state()).messages;s.check('Observed levels are 1,2,2,3',messages.map(m=>m.depth).join(',')==='1,2,2,3');
    s.check('The sibling targets message 1, and the final chain targets message 3',messages[2].parent_message_id===messages[0].id&&messages[3].parent_message_id===messages[2].id);
    s.check('Only four provider tasks exist',s.h.vendor.length===4);return s.finish('Brand verified in message 4; monitoring, with no message 5.');
  });
  await add('removed','Message 3 is removed before verification','A provider removal stops the experiment before any dependent fourth or fifth message can exist.',async s=>{
    await s.start();await s.writeAndPublish('opening',QUESTION,'question','Clarify the relevant failure case.');await s.advance(24*60+1);
    await s.writeAndPublish('reply','Retain a raw error response for comparison.','help','Reply to the opening with a useful diagnostic step.');await s.advance(24*60+1);
    await s.awaken();await s.draft('chain','Redact credentials before sharing that response.','help','Develop the prior response safely without a brand mention.');await s.tick();
    await s.step('fixture','Engain reports mod_removed','The reason below is supplied by the fake provider, not inferred by the application.',async()=>{Object.assign(s.h.vendor.at(-1),{status:'mod_removed',statusMessage:'Simulation: moderator removed this comment.'});return clone(s.h.vendor.at(-1));});
    await s.advance(31);await s.tick('Cron records removal and stops the experiment');await s.awaken();
    const state=await s.state();s.check('Removed third message creates neither message 4 nor 5',state.experiments[0].status==='removed'&&state.messages.length===3&&s.job===null);
    return s.finish('Stopped at message 3; removal recorded, no dependent replies.');
  });
  await add('limits','Chain reaches level 4; siblings consume the remaining budget','Hard depth and message limits stop an unbranded experiment without forcing a mention.',async s=>{
    await s.start();const texts=[QUESTION,'Compare a raw response with its parsed version.','Keep the status code beside that sample.','Separate error-response fields from success-response fields.','Check missing fields separately from fields with null values.','Use a small saved sample to check the parser before expanding the test.'];
    for(let i=0;i<6;i++){
      if(i)await s.advance(24*60+1,'Next message becomes due');await s.awaken();
      if(i===4){s.check('Only sibling is offered at depth 4',s.job.parent_options.length===1&&s.job.parent_options[0].reply_mode==='sibling');
        const rejected=await s.step('agent','Attempting a fifth level is rejected','Even a client that ignores the allowed choices cannot file an extra-deep chain.',()=>s.api('/messages/'+s.job.message.id,{agent:s.agent,claim_token:s.job.claim_token,reply_mode:'chain',body:'This should not be filed.'}));s.check('The server rejects the forbidden chain',rejected.status===422);}
      await s.draft(i===0?'opening':i===1?'reply':i<4?'chain':'sibling',texts[i],i===0?'question':'help',i<4?'Develop the latest useful point without a brand mention.':'At the depth limit, contribute a separate useful point to the parent as a sibling.');await s.tick();await s.publish();
    }
    await s.awaken();const state=await s.state();s.check('Exactly six messages, at levels 1,2,3,4,4,4',state.messages.map(m=>m.depth).join(',')==='1,2,3,4,4,4');
    s.check('No seventh message or writer job is created',state.experiments[0].status==='exhausted'&&s.job===null);return s.finish('Exhausted at six messages; no brand was forced, no level 5.');
  });
  await add('rate-limit','Engain returns 429 → automatic retry','A definite rate-limit response retries the same saved text without asking the writer to regenerate it.',async s=>{
    await s.start('direct');await s.awaken();await s.draft('opening',BRAND,'direct','Answer with a relevant attributed mention.');s.h.vendorMode='rate-limit';await s.tick('Engain rejects this submission with HTTP 429');
    s.check('429 creates no provider task',s.h.vendor.length===0);s.check('The message stays queued for a scheduled retry',(await s.current()).status==='queued');
    await s.awaken();s.check('The writer has nothing to redraft',s.job===null);await s.advance(16,'The retry becomes due');s.h.vendorMode='normal';await s.tick('Cron retries the same saved text');await s.publish();
    s.check('Only one accepted provider task exists',s.h.vendor.length===1);return s.finish('One accepted task after retry; brand enters monitoring.');
  });
  await add('lost-response','Engain accepts, but our connection times out','An unknown outcome is reconciled using saved labels, exact content and target before any repeat submission.',async s=>{
    await s.start('direct');await s.awaken();await s.draft('opening',BRAND,'direct','Prepare one relevant attributed answer.');s.h.vendorMode='lost-response';await s.tick('Connection fails after Engain accepts');
    s.check('The local message is uncertain while the provider has one task',(await s.current()).status==='unknown'&&s.h.vendor.length===1);
    await s.advance(3,'Reconciliation becomes eligible');s.h.vendorMode='normal';await s.tick('Cron finds the matching task in Engain');
    s.check('Reconciliation attaches the original task ID',(await s.current()).task_id===s.h.vendor[0]._id&&s.h.vendor.length===1);await s.publish();
    const submits=s.traffic.filter(x=>x.method==='POST'&&new URL(x.url).pathname==='/api/v1/tasks/comment');s.check('No duplicate submission was made',submits.length===1);
    return s.finish('Recovered the original Engain task; no duplicate comment.');
  });
  await add('reddit-unreadable','Engain says published; Reddit returns 403','A provider status and a returned URL are not sufficient to create the next reply.',async s=>{
    await s.start();await s.awaken();await s.draft('opening',QUESTION,'question','Ask a useful question.');await s.tick();const m=await s.current(),listing=clone(s.h.reddit.get('abc123'));
    await s.step('fixture','Provider supplies a URL, but Reddit refuses the read','Simulate a published task and an unreadable Reddit response. This is not classified as a removal.',async()=>{s.h.vendor[0].status='published';s.h.vendor[0].redditUrl='https://www.reddit.com/r/test/comments/abc123/example/m1/';s.h.reddit.set('abc123',new Response('{}',{status:403}));return {provider_status:'published',reddit_status:403};});
    await s.advance(31);await s.tick('Cron preserves the URL and records unknown visibility');
    const unread=await s.current();s.check('The URL is saved without falsely verifying publication',!!unread.reddit_url&&!unread.verified_at&&unread.last_visibility==='unknown');s.check('No follow-up exists while visibility is unknown',(await s.state()).messages.length===1);
    await s.awaken();s.check('No writing work is claimable',s.job===null);
    await s.step('fixture','Reddit becomes readable again','The exact body and expected parent are now present in the fake response.',async()=>{listing[1].data.children.push(s.h.comment('m1',m.body,'t3_abc123',[],'provider_writer'));s.h.reddit.set('abc123',listing);return {reddit_status:200};});
    await s.advance(31);await s.tick('Cron verifies the existing URL and creates one future reply');
    s.check('Recovery creates exactly one follow-up',(await s.current()).step===2&&s.h.vendor.length===1);return s.finish('No advancement during 403; one reply scheduled after verification recovers.');
  });
  await add('rule-failure','Engain rule check fails → text is held','This exposes the current handling of a revision need rather than presenting an idealized rewrite loop.',async s=>{
    await s.start('direct');await s.awaken();await s.draft('opening',BRAND,'direct','File an attributed answer so the provider check can evaluate it.');
    s.h.ruleVerdict={verdict:'fail',removalRisk:85,summary:'Simulation: this community does not allow this promotional contribution.'};await s.tick('Engain rule check returns fail');await s.awaken();
    s.check('Failed rule check never reaches the posting endpoint',s.h.vendor.length===0&&(await s.current()).status==='held');s.check('No automatic rewrite job currently exists',s.job===null);
    return s.finish('Needs attention: held for revision. Automatic agent rewrite requeue is not implemented.');
  });
  await add('private','Private delivery uses the same message queue','When no pooled project is available, the server selects an available private account and uses the existing accounts-beta contract.',async s=>{
    s.h.project=false;await s.start('direct');await s.writeAndPublish('opening',BRAND,'direct','The writer prepares the message without selecting an account.');
    const m=await s.current();s.check('Private routing is selected automatically',m.transport.mode==='private');s.check('Private rule-check limitation is recorded explicitly',m.rule_check.verdict==='skipped'&&m.rule_check.source==='no_project');
    s.check('Provider publication URL is stored and verified',!!m.reddit_url&&!!m.verified_at);return s.finish('Private comment verified; same monitoring workflow, no account approvals.');
  });
  await add('missing-humanizer','The agent has no humanizer configured','A missing dependency is reported honestly; a raw draft is not labeled as humanized.',async s=>{
    await s.start();await s.awaken();const job=s.job;
    await s.step('agent','Save the missing-tool blocker','The worker follows its instructions and reports a missing humanizer. This is a tooling blocker, not a request for publication approval.',()=>s.api('/jobs/'+job.id+'/complete',{agent:s.agent,claim_token:job.claim_token,status:'blocked',result:{reason:'No humanizer tool is configured in this agent environment.'}}));
    await s.tick('Cron reflects the writer blocker on the message');await s.awaken();s.check('No text or fake humanizer record is filed',(await s.current()).body===null&&(await s.current()).humanization===null);s.check('No Engain task exists',s.h.vendor.length===0);
    return s.finish('Needs configuration: no posting until the writer has its humanizer.');
  });
  await add('restart','Writer crashes; a fresh session resumes its checkpoint','Durable jobs and leases let a new agent continue without giving an expired agent permission to file.',async s=>{
    await s.start();await s.awaken();const previous=clone(s.job),oldAgent=s.agent;
    await s.step('agent','Checkpoint before interruption','Only the checkpoint persists; no text has been sent to Engain.',()=>s.api('/jobs/'+previous.id+'/checkpoint',{agent:s.agent,claim_token:previous.claim_token,checkpoint:{draft:QUESTION,next_step:'Run humanizer and file this opening.'}}));
    await s.advance(31,'The abandoned lease expires');await s.awaken(1,'A new writer session resumes the job');
    s.check('The new session receives the saved checkpoint',s.job.checkpoint.draft===QUESTION);s.check('Reclaim issues a new ownership token',s.job.claim_token!==previous.claim_token);
    const stale=await s.step('agent','The expired session tries to file','The server rejects the stale token; only the new owner may finish the message.',()=>s.api('/messages/'+previous.message.id,{agent:oldAgent,claim_token:previous.claim_token,reply_mode:'opening',body:QUESTION}));s.check('Stale filing is rejected',stale.status===409);
    await s.draft('opening',QUESTION,'question','Resume the saved question, prepare the final text and file with the new lease.');await s.tick();s.check('Only one provider task is created',s.h.vendor.length===1);
    return s.finish('Resumed from the checkpoint; stale worker rejected, one submission.');
  });
  await add('allocation','50 queued threads → 10 suggestions per opening strategy','Allocation is balanced before outcomes exist; it is not a claim about publication or success rates.',async s=>{
    await s.step('queue','Queue 50 independent threads','Each thread gets one opening. The server assigns an underused opening strategy.',async()=>{
      for(let i=0;i<50;i++){const id=i?'queue'+i.toString(36):'abc123';await s.h.thread(id);const r=await s.h.api('/threads/'+id+'/queue',{request_id:randomUUID()});assert.equal(r.status,200);}
      return {allocation:await s.h.sql('select strategy_id,count(*)::int assigned from message_experiments group by strategy_id order by strategy_id')};
    });
    const counts=await s.h.sql('select strategy_id,count(*)::int n from message_experiments group by strategy_id');s.check('Five strategies each receive 10 openings',counts.length===5&&counts.every(c=>c.n===10));
    await s.awaken(3);const claimed=(await s.state()).jobs.filter(j=>j.status==='claimed');s.check('One writer claims three due openings; the other 47 remain queued',claimed.length===3);
    s.check('No future conversations or provider tasks have been created',(await s.state()).messages.every(m=>m.step===1)&&s.h.vendor.length===0);return s.finish('20% opening allocation; 3 jobs claimed, 47 pending, zero posts.');
  });
  await add('empty','Writer wakes up with no due work','An empty claim ends the invocation. There is no wait action or placeholder comment.',async s=>{
    await s.awaken();s.check('Empty queue returns zero jobs',s.job===null);s.check('No Engain traffic is needed',s.traffic.filter(c=>c.system==='Engain').length===0);return s.finish('Writer exits. The scheduler controls the next wake-up.');
  });
  return results;
}
module.exports={runAll};
