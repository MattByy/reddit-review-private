const {sb,engain}=require('./_db.js');
const {identity}=require('./_reddit.js');
const {conversation,providerMode,fromOpportunity,readable}=require('./_context.js');
const {randomUUID}=require('node:crypto');
const enc=encodeURIComponent,now=()=>new Date().toISOString();
const DEFAULTS={min_age_hours:6,max_age_days:60,min_comments:5,min_score:1,min_relevance:0.6,provider_fresh_hours:24,reddit_fresh_minutes:60};
function fail(status,message){const e=Error(message);e.status=status;throw e;}
function number(v){return typeof v==='number'&&Number.isFinite(v)?v:null;}
function normalize(item,projectId){
  const p=item.postContent||{},id=identity(p.url);
  if(id.comment_id||String(item.redditPostId||'').replace(/^t3_/,'').toLowerCase()!==id.thread_id)throw Error('Opportunity URL does not match its thread ID');
  if(!['new_opportunities','seo_opportunities'].includes(item.type))throw Error('Unknown opportunity type');
  const timestamp=number(p.createdUtc),r=number(item.relevance);
  return {thread_id:id.thread_id,url:id.url,subreddit:id.subreddit,title:String(p.title||'').slice(0,1000),body:String(p.content||'').slice(0,40000),
    opportunity_id:item.id,project_id:projectId,kind:item.type,posted_at:timestamp&&timestamp>0?new Date(timestamp*1000).toISOString():null,
    score:Number.isInteger(p.score)?p.score:null,num_comments:Number.isInteger(p.numComments)?p.numComments:null,
    relevance:r==null||r<0||r>100?null:r>1?r/100:r,provider_reasons:Array.isArray(item.reasons)?item.reasons:[],last_collected_at:now()};
}
async function settings(){const [r]=await sb('GET','workflow_state?select=value&key=eq.thread_library_config');return {...DEFAULTS,...r?.value};}
async function saveSettings(input){
  const ranges={min_age_hours:[0,8760],max_age_days:[1,3650],min_comments:[0,1000000],min_score:[-10000,1000000],min_relevance:[0,1],provider_fresh_hours:[1,168],reddit_fresh_minutes:[1,1440]};
  for(const [key,value] of Object.entries(input)){if(!ranges[key]||!Number.isFinite(value)||value<ranges[key][0]||value>ranges[key][1])fail(422,'Invalid library setting: '+key);}
  const value={...await settings(),...input};if(value.min_age_hours>value.max_age_days*24)fail(422,'Minimum age cannot exceed maximum age');
  await sb('POST','workflow_state?on_conflict=key',[{key:'thread_library_config',value,updated_at:now()}],'resolution=merge-duplicates,return=minimal');return value;
}
function assess(row,config,observation=null,{includeExisting=false,at=Date.now()}={}){
  const reasons=[],o=observation||row.reddit_observation,t=o?.ok?o.thread:null;
  const posted=t?.created_utc!=null?new Date(t.created_utc*1000).toISOString():row.posted_at;
  const age=posted?(at-Date.parse(posted))/3600000:null;
  const comments=t?.num_comments??row.num_comments,score=t?.score??row.score;
  if(age==null||!Number.isFinite(age))reasons.push('Thread age is unknown');
  else if(age<config.min_age_hours)reasons.push('Younger than the configured range');else if(age>config.max_age_days*24)reasons.push('Older than the configured range');
  if(comments==null)reasons.push('Comment count is unknown');else if(comments<config.min_comments)reasons.push('Below the minimum discussion size');
  if(score==null)reasons.push('Score is unknown');else if(score<config.min_score)reasons.push('Below the minimum score');
  if(row.relevance==null||row.relevance<config.min_relevance)reasons.push('Below the minimum provider relevance or unscored');
  const candidate=reasons.length===0;
  if(!includeExisting&&row.has_experiment)reasons.push('Already in the message queue; inspect existing work');
  if(!row.last_collected_at||at-Date.parse(row.last_collected_at)>config.provider_fresh_hours*3600000)reasons.push('Provider data needs refresh');
  if(!observation&&row.refresh_error)reasons.push(row.refresh_error);
  const checked=observation?.observed_at||row.reddit_checked_at;
  if(!o?.ok||!checked||at-Date.parse(checked)>config.reddit_fresh_minutes*60000)reasons.push(providerMode()?'Refresh the Engain thread context':'Fresh Reddit context is required');
  else{
    if(!readable(o))reasons.push('Thread is removed, locked or archived');
    if(t.over_18)reasons.push('Adult thread excluded');
    if(t.num_comments==null||t.score==null||t.created_utc==null)reasons.push('Fresh engagement or age data is incomplete');
  }
  return {candidate,eligible:reasons.length===0,reasons,age_hours:age,num_comments:comments,score,
    status:reasons.length===0?'ready':row.has_experiment&&!includeExisting?'already_used':!candidate?'outside_filters':'needs_refresh',
    note:'Ready means current basic filters passed. The writer must still assess community rules, relevance, attribution and whether an answer adds value.'};
}
async function item(id){const [r]=await sb('GET','thread_library_entries?select=*&thread_id=eq.'+enc(id));if(!r)fail(404,'Thread is not in the library');return r;}
async function list(input={}){
  const limit=Math.max(1,Math.min(parseInt(input.limit,10)||50,100)),offset=Math.max(0,parseInt(input.offset,10)||0),config=await settings();
  const kind=input.kind;if(kind&&!['new_opportunities','seo_opportunities'].includes(kind))fail(422,'Unknown feed');
  const q=String(input.q||'').replace(/[*,()]/g,' ').trim().slice(0,120);
  const scope=input.scope||'candidates';if(!['all','candidates'].includes(scope))fail(422,'Use candidates or all scope');
  const filters=scope==='all'?'':'&posted_at=gte.'+enc(new Date(Date.now()-config.max_age_days*86400000).toISOString())+'&posted_at=lte.'+enc(new Date(Date.now()-config.min_age_hours*3600000).toISOString())+'&num_comments=gte.'+config.min_comments+'&score=gte.'+config.min_score+'&relevance=gte.'+config.min_relevance+'&has_experiment=eq.false';
  const rows=await sb('GET','thread_library_entries?select=*&order=relevance.desc.nullslast,posted_at.desc,thread_id&limit='+(limit+1)+'&offset='+offset+filters+
    (kind?'&kind=eq.'+enc(kind):'')+(q?'&or=(title.ilike.'+enc('*'+q+'*')+',subreddit.ilike.'+enc('*'+q+'*')+')':''));
  const [collector]=await sb('GET','workflow_state?select=value,updated_at&key=eq.thread_collector');
  return {settings:config,collector:collector||null,items:rows.slice(0,limit).map(r=>({...r,selection:assess(r,config)})),next_offset:rows.length>limit?offset+limit:null,offset,limit};
}
async function refresh(id){
  const old=await item(id),attempted=now();
  try{
    if(!old.opportunity_id)throw Error('No provider opportunity ID is available');
    const response=await engain('GET','/api/v1/opportunities/'+enc(old.opportunity_id));
    if(response.status>=300)throw Error('Engain opportunity refresh returned '+response.status);
    const current=normalize(response.json.opportunity||response.json,old.project_id);
    if(current.thread_id!==id)throw Error('Provider returned a different thread');
    const observation=providerMode()?fromOpportunity(current):await conversation(current.url);
    await sb('POST','thread_library?on_conflict=thread_id',[{...current,reddit_observation:observation,reddit_checked_at:observation.ok?observation.observed_at:null,refresh_attempted_at:attempted,refresh_error:observation.ok?null:observation.reason}],'resolution=merge-duplicates,return=minimal');
  }catch(e){await sb('PATCH','thread_library?thread_id=eq.'+enc(id),{refresh_attempted_at:attempted,refresh_error:String(e.message).slice(0,300)},'return=minimal');}
  const r=await item(id);return {...r,selection:assess(r,await settings())};
}
async function currentEligibility(id,observation){
  const [row]=await sb('GET','thread_library?select=*&thread_id=eq.'+enc(id));
  return row?assess(row,await settings(),observation,{includeExisting:true}):null;
}
async function queue(id,input){
  if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(input.request_id||''))fail(422,'A stable request UUID is required.');
  // Preserve exact start idempotency even if the candidate changes afterward.
  if(input.request_id){const [existing]=await sb('GET','message_experiments?select=id&thread_id=eq.'+enc(id)+'&id=eq.'+enc(input.request_id));
    if(existing)return require('./_messages.js').start({...input,thread_id:id});}
  const r=await refresh(id);if(!r.selection.eligible)fail(409,r.selection.reasons.join('; '));
  await sb('POST','threads?on_conflict=id',[{id:r.thread_id,url:r.url,title:r.title,subreddit:r.subreddit,score:r.selection.score,num_comments:r.selection.num_comments,posted_at:r.posted_at,
    locked:false,archived:false,screened_at:now(),screen_source:'thread-library',discovery:{source:'engain',opportunity_id:r.opportunity_id,kind:r.kind}}],'resolution=merge-duplicates,return=minimal');
  return require('./_messages.js').start({...input,thread_id:id});
}
async function collect(deadline=Date.now()+45000){
  const token=randomUUID();if(!await sb('POST','rpc/claim_thread_collector',{p_token:token}))return {deferred:'Collection already running'};
  let state={};
  try{
    const [saved]=await sb('GET','workflow_state?select=value&key=eq.thread_collector');state=saved?.value||{};
    const caps=await require('./_delivery.js').capabilities();if(!caps.project_id)throw Error('An accessible Engain project is required for collection');
    if(state.project_id!==caps.project_id)state={project_id:caps.project_id,cursors:{}};
    state.cursors||={};const feeds=[];
    for(const kind of ['new_opportunities','seo_opportunities']){
      if(Date.now()>=deadline)break;
      // Always revisit the newest page; large backlogs must not hide new threads.
      const backlog=state.cursors[kind];
      for(const cursor of backlog?[null,backlog]:[null]){
      if(Date.now()>=deadline)break;
      const params={projectId:caps.project_id,type:kind,sortBy:'date_newest',numItems:100};if(cursor)params.cursor=cursor;
      const response=await engain('GET','/api/v1/opportunities',undefined,params);
      if(response.status>=300)throw Error('Engain '+kind+' collection returned '+response.status);
      if(!Array.isArray(response.json?.opportunities))throw Error('Invalid opportunity feed response');
      const unique=new Map();let rejected=0;for(const raw of response.json.opportunities){try{const r=normalize(raw,caps.project_id);unique.set(r.thread_id,r);}catch{rejected++;}}
      const rows=[...unique.values()];if(rows.length)await sb('POST','thread_library?on_conflict=thread_id',rows,'resolution=merge-duplicates,return=minimal');
      if(!response.json.isDone&&!response.json.continueCursor)throw Error('Incomplete opportunity page has no continuation cursor');
      if(cursor||!backlog)state.cursors[kind]=response.json.isDone?null:response.json.continueCursor;
      state.last_error=null;state.last_collected_at=now();state.feeds=feeds;
      feeds.push({kind,page:cursor?'backlog':'newest',imported:rows.length,rejected,cycle_complete:!!response.json.isDone});
      await sb('POST','workflow_state?on_conflict=key',[{key:'thread_collector',value:state,updated_at:now()}],'resolution=merge-duplicates,return=minimal');
      }
    }
    return {feeds,posting_performed:false,writing_jobs_created:0};
  }catch(e){state.last_error=String(e.message).slice(0,300);state.last_attempt_at=now();await sb('POST','workflow_state?on_conflict=key',[{key:'thread_collector',value:state,updated_at:now()}],'resolution=merge-duplicates,return=minimal');throw e;}
  finally{await sb('POST','rpc/release_thread_collector',{p_token:token});}
}
module.exports={DEFAULTS,normalize,assess,settings,saveSettings,list,refresh,queue,collect,currentEligibility};
