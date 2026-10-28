// Model test ("bench"): the same real Queue 1 items drafted by several models and prompts, then
// scored automatically (disclosure, flags, Engain rule-check) and by blind human picks.
// Nothing here posts anything: drafts stay in the bench tables.
const {createHash}=require('node:crypto');
const writer=require('./writer.cjs');
const {checkDisclosure}=require('./send-queue2.cjs');

const fail=(status,message)=>{throw Object.assign(Error(message),{status});};

// Models worth comparing, from the 2026-10-28 research (docs/plan-human-writing-featherless.md).
// Any other Featherless or OpenRouter model id can be added in the form.
const SHORTLIST=[
  {provider:'featherless',model:'LessThanThreeAI/Qwen3.8-27B-Humanlike-Chat-2.0',note:'Fine-tuned to text like a person'},
  {provider:'featherless',model:'moonshotai/Kimi-K2-Instruct-0905',note:'Strong creative writing, fast'},
  {provider:'featherless',model:'moonshotai/Kimi-K3',note:'Newest Kimi'},
  {provider:'featherless',model:'deepseek-ai/DeepSeek-V3.2',note:'Big general model'},
  {provider:'featherless',model:'deepseek-ai/DeepSeek-V4-Pro',note:'Newest DeepSeek'},
  {provider:'featherless',model:'zai-org/GLM-5.3',note:'Newest GLM'},
  {provider:'featherless',model:'Qwen/Qwen3.8-27B',note:'Base of the Humanlike model'},
  {provider:'featherless',model:'MiniMaxAI/MiniMax-M3',note:'Distinct style'},
  {provider:'featherless',model:'SicariusSicariiStuff/Assistant_Pepe_70B',note:'Personality fine-tune, less assistant-like'},
  {provider:'featherless',model:'NousResearch/Hermes-4-70B',note:'Steerable, less assistant tone'},
  {provider:'featherless',model:'Sao10K/L3.3-70B-Euryale-v2.3',note:'Creative/RP fine-tune'},
  {provider:'featherless',model:'nothingiisreal/MN-12B-Celeste-V1.9',note:'Trained on Reddit writing'},
  {provider:'featherless',model:'sam-paech/gemma-3-27b-it-antislop',note:'AI clichés trained out (slow)'},
  {provider:'featherless',model:'mistralai/Mistral-Nemo-Instruct-2407',note:'Small, cheap baseline'},
  {provider:'openrouter',model:writer.DEFAULT_MODEL,note:'Current writer (reference)'},
];
// Built-in prompt styles; saved prompts on the Prompts tab can be used by name too.
const STYLES={natural:{label:'Natural (built-in)',prompts:writer.NATURAL_PROMPTS},default:{label:'Default (built-in)',prompts:writer.DEFAULT_PROMPTS}};

function init(db){
  db.exec(`create table if not exists bench_runs(id integer primary key autoincrement,name text,status text not null,config text not null,
      created_at text not null,finished_at text,score_status text,score_error text);
    create table if not exists bench_drafts(id integer primary key autoincrement,run_id integer not null,item_key text not null,kind text not null,
      subreddit text,item text not null,contestant text not null,provider text not null,model text not null,prompt_name text not null,temperature real,
      prompt_used text,status text not null,text text,error text,finish_reason text,latency_ms integer,flags text,rule_check text,updated_at text);
    create index if not exists bench_drafts_run on bench_drafts(run_id);
    create table if not exists bench_picks(run_id integer not null,item_key text not null,draft_id integer,at text not null,primary key(run_id,item_key));`);
  // A test cannot keep drafting across a restart; finish whatever was left when the server starts.
  return db.prepare("select id from bench_runs where status='running'").all().map(r=>r.id);
}

const j=v=>v==null?null:JSON.parse(v);
const short=m=>String(m).split('/').pop();

// Automatic checks on one draft. "Possible invented claim" catches the experience a model makes up
// ("I had the same issue", "we've helped clients"); it is a hint for the reviewer, not proof.
const INVENTED=/\b(i('ve| have)? (had|ran into|run into|seen|hit|dealt with|been there)|i'm (seeing|having|getting)|same (thing|issue|problem) here|happened to me|we('ve| have) (helped|seen|had|worked with)|our (customers|clients|users)|in my experience)\b/i;
function flags(text){
  const t=String(text||''),low=t.toLowerCase(),words=t.split(/\s+/).filter(Boolean).length;
  const out=[];
  if(!checkDisclosure(t).ok)out.push('no disclosure');
  if(/geonode/.test(low.slice(0,45)))out.push('opens with disclosure');
  if(INVENTED.test(t))out.push('possible invented claim');
  if(/\p{Extended_Pictographic}/u.test(t))out.push('emoji');
  if(/[—–]/.test(t))out.push('em-dash');
  if(/^\s*([-*•]|\d+\.)\s/m.test(t)||/^#/m.test(t))out.push('list or heading');
  if(/https?:\/\//.test(t))out.push('link');
  if(/^(great|good) (question|point)|^sounds (really )?(frustrating|rough)|^(totally|absolutely) (get|understand)/i.test(t.trim()))out.push('stock opener');
  if(words>110)out.push('long');
  return {words,list:out};
}

// Real items from Queue 1 (not claimed: they stay where they are). Spread over subreddits.
function pickItems(queueView,{threads=12,comments=8}){
  const items=queueView.items.filter(x=>x.kind==='thread'?x.thread?.title:x.kind==='comment'?x.comment?.content:false);
  const spread=(kind,n)=>{
    const by={};for(const x of items.filter(x=>x.kind===kind)){const s=(x.thread?.subreddit||x.comment?.subreddit||'?').toLowerCase();(by[s]||=[]).push(x);}
    const lists=Object.values(by),out=[];
    for(let i=0;out.length<n&&lists.some(l=>l.length>i);i++)for(const l of lists)if(l[i]&&out.length<n)out.push(l[i]);
    return out;
  };
  return [...spread('thread',threads),...spread('comment',comments)].map(x=>({key:x.item_id,kind:x.kind,url:x.url,thread_url:x.thread_url,title:x.thread?.title||null,
    subreddit:x.thread?.subreddit||x.comment?.subreddit||'',item:{item_id:x.item_id,thread:x.thread,comment:x.comment}}));
}

function promptFor(store,style,kind){
  if(STYLES[style])return {name:STYLES[style].label,text:STYLES[style].prompts[kind]};
  const saved=writer.variants(store)[kind].find(v=>v.name===style);
  return saved?{name:saved.name,text:saved.text}:{name:STYLES.natural.label+' (no "'+style+'" '+kind+' prompt)',text:writer.NATURAL_PROMPTS[kind]};
}

function cleanContestants(list){
  if(!Array.isArray(list)||!list.length)fail(422,'Pick at least one model');
  if(list.length>20)fail(422,'At most 20 models per test');
  const seen=new Set();
  return list.map((c,i)=>{
    const provider=c?.provider||'featherless';
    if(!writer.PROVIDERS[provider])fail(422,`Model ${i+1}: provider must be openrouter or featherless`);
    const model=String(c?.model??'').trim();
    if(!model||model.length>200||!/^[\w.\-\/:@]+$/.test(model))fail(422,`Model ${i+1}: "${model.slice(0,60)}" is not a model name`);
    const prompt=String(c?.prompt||'natural').slice(0,60);
    const temperature=c?.temperature===''||c?.temperature==null?0.8:Number(c.temperature);
    if(!(temperature>=0&&temperature<=2))fail(422,`Model ${i+1}: temperature must be from 0 to 2`);
    const key=`${provider}:${model}|${prompt}|${temperature}`;
    if(seen.has(key))fail(422,`${short(model)} with the same prompt and temperature is listed twice`);
    seen.add(key);return {provider,model,prompt,temperature,key};
  });
}

function createRun(store,body,queueView){
  const contestants=cleanContestants(body?.contestants);
  const threads=Math.max(0,Math.min(Number(body?.threads??12)|0,40)),comments=Math.max(0,Math.min(Number(body?.comments??8)|0,40));
  const items=pickItems(queueView,{threads,comments});
  if(!items.length)fail(409,'Queue 1 has no thread or comment items to test with. Let the jobs refill it first.');
  const now=new Date().toISOString(),name=String(body?.name||'').trim().slice(0,80)||`Test ${now.slice(0,16).replace('T',' ')}`;
  const db=store.db;
  const run=db.prepare('insert into bench_runs(name,status,config,created_at) values(?,?,?,?)')
    .run(name,'running',JSON.stringify({contestants,threads,comments,items:items.length}),now).lastInsertRowid;
  const ins=db.prepare(`insert into bench_drafts(run_id,item_key,kind,subreddit,item,contestant,provider,model,prompt_name,temperature,prompt_used,status,updated_at)
    values(?,?,?,?,?,?,?,?,?,?,?,'pending',?)`);
  for(const it of items)for(const c of contestants){
    const p=promptFor(store,c.prompt,it.kind),prompt=writer.render(p.text,writer.variables(it,store,p.text));
    ins.run(run,it.key,it.kind,it.subreddit,JSON.stringify(it),c.key,c.provider,c.model,p.name,c.temperature,prompt,now);
  }
  return Number(run);
}

// Drafts everything still pending in a run, a few at a time, then marks the run done.
async function draftRun(store,runId,{keys,fetchImpl=fetch,concurrency=4,log=()=>{}}){
  const db=store.db,set=db.prepare('update bench_drafts set status=?,text=?,error=?,finish_reason=?,latency_ms=?,flags=?,updated_at=? where id=?');
  // In id order each item's drafts come together, so the models take turns and a slow one
  // does not hold up the rest.
  const pending=db.prepare("select * from bench_drafts where run_id=? and status='pending' order by id").all(runId);
  let next=0;
  async function worker(){
    for(;;){
      const d=pending[next++];if(!d)return;
      try{
        const r=await writer.complete({provider:d.provider,model:d.model,prompt:d.prompt_used,temperature:d.temperature,maxTokens:600,keys,fetchImpl});
        const skipped=/^skip\.?$/i.test(r.text),truncated=r.finish_reason==='length';
        set.run(skipped?'skipped':truncated?'truncated':'written',r.text,null,r.finish_reason,r.latency_ms,JSON.stringify(skipped?{words:0,list:[]}:flags(r.text)),new Date().toISOString(),d.id);
      }catch(e){set.run('failed',null,String(e.message).slice(0,500),null,null,null,new Date().toISOString(),d.id);log(`bench ${runId}: ${short(d.model)} failed: ${e.message}`);}
    }
  }
  await Promise.all(Array.from({length:Math.max(1,concurrency)},worker));
  db.prepare("update bench_runs set status='done',finished_at=? where id=?").run(new Date().toISOString(),runId);
}

// Engain rule-check on every written draft: grouped by subreddit, 25 per call. Advisory only;
// it reads the draft and the thread, it does not post.
async function scoreRun(store,engain,projectId,runId,{log=()=>{}}={}){
  const db=store.db;
  db.prepare("update bench_runs set score_status='running',score_error=null where id=?").run(runId);
  const rows=db.prepare("select * from bench_drafts where run_id=? and status='written' and rule_check is null").all(runId);
  const by={};for(const r of rows)(by[r.subreddit||'']||=[]).push(r);
  const save=db.prepare('update bench_drafts set rule_check=? where id=?'),errors=[];
  for(const [sub,list] of Object.entries(by)){
    if(!/^\w{1,21}$/.test(sub)){errors.push(`r/${sub}: not a subreddit name, skipped`);continue;}
    for(let i=0;i<list.length;i+=25){
      const chunk=list.slice(i,i+25);
      const items=chunk.map(r=>{const it=JSON.parse(r.item),t=it.item.thread||{};
        const context={postTitle:t.title||it.title||undefined,postBody:t.body?String(t.body).slice(0,3000):undefined,postUrl:it.thread_url||t.url||undefined};
        return r.kind==='comment'?{key:String(r.id),taskType:'reply',content:r.text,context:{...context,parentComment:String(it.item.comment?.content||'').slice(0,3000)}}
          :{key:String(r.id),taskType:'comment',content:r.text,context};});
      try{
        const res=await engain.ruleCheckBatch({projectId,subreddit:sub,items});
        for(const v of res.verdicts||[])save.run(JSON.stringify(v.verdict||{}),Number(v.key));
      }catch(e){errors.push(`r/${sub}: ${e.message}`);log(`bench ${runId}: rule-check r/${sub} failed: ${e.message}`);}
    }
  }
  db.prepare('update bench_runs set score_status=?,score_error=? where id=?').run(errors.length?'partial':'done',errors.length?errors.join('\n').slice(0,2000):null,runId);
}

// Stable but unguessable order per run, so the position never gives a model away.
const order=(runId,id)=>createHash('sha256').update(runId+':'+id).digest('hex');
const LETTERS='ABCDEFGHIJKLMNOPQRSTUVWXYZ';

// The blind comparison: per item, the drafts as A, B, C... Model names stay hidden until the
// item has a pick.
function compare(store,runId){
  const db=store.db,drafts=db.prepare('select * from bench_drafts where run_id=? order by item_key,id').all(runId);
  const picks=Object.fromEntries(db.prepare('select item_key,draft_id from bench_picks where run_id=?').all(runId).map(p=>[p.item_key,p.draft_id]));
  const items=[];
  for(const d of drafts){
    let it=items.find(x=>x.key===d.item_key);
    if(!it){const src=JSON.parse(d.item),t=src.item.thread||{};
      it={key:d.item_key,kind:d.kind,subreddit:d.subreddit,title:src.title||t.title,url:src.url,body:t.body?String(t.body).slice(0,1500):null,
        our_comment:src.item.comment?.content||null,picked:d.item_key in picks,pick:picks[d.item_key]??null,drafts:[]};items.push(it);}
    it.drafts.push(d);
  }
  for(const it of items){
    it.drafts.sort((a,b)=>order(runId,a.id)<order(runId,b.id)?-1:1);
    it.drafts=it.drafts.map((d,i)=>({id:d.id,label:LETTERS[i]||String(i+1),status:d.status,text:d.text,error:d.error,flags:j(d.flags),rule_check:summary(j(d.rule_check)),
      ...(it.picked?{model:d.model,provider:d.provider,prompt:d.prompt_name,temperature:d.temperature,latency_ms:d.latency_ms}:{})}));
  }
  return items;
}
const summary=v=>v&&{verdict:v.verdict,authenticity_risk:v.authenticityRisk??null,removal_risk:v.removalRisk??null,marketing_risk:v.marketingIntentRisk??null,
  human:v.aiDetection?.fractionHuman??null,ai_prediction:v.aiDetection?.predictionShort??null,advice:v.naturalnessAdvice??null,summary:v.summary??null};

function pick(store,runId,body){
  const db=store.db,key=String(body?.item_key||'');
  if(!db.prepare('select 1 from bench_drafts where run_id=? and item_key=?').get(runId,key))fail(404,'No such item in this test');
  let draft=body?.draft_id==null?null:Number(body.draft_id);
  if(draft!=null&&!db.prepare('select 1 from bench_drafts where id=? and run_id=? and item_key=?').get(draft,runId,key))fail(422,'That draft is not one of this item');
  if(body?.undo){db.prepare('delete from bench_picks where run_id=? and item_key=?').run(runId,key);return {ok:true};}
  db.prepare('insert into bench_picks(run_id,item_key,draft_id,at) values(?,?,?,?) on conflict(run_id,item_key) do update set draft_id=excluded.draft_id,at=excluded.at')
    .run(runId,key,draft,new Date().toISOString());
  return {ok:true};
}

// Per model + prompt: how often it was picked, and the automatic scores.
function leaderboard(store,runId){
  const db=store.db,drafts=db.prepare('select * from bench_drafts where run_id=?').all(runId);
  const picks=db.prepare('select item_key,draft_id from bench_picks where run_id=?').all(runId);
  const pickedItems=new Set(picks.map(p=>p.item_key)),wins={};for(const p of picks)if(p.draft_id!=null)wins[p.draft_id]=1;
  const by={};
  for(const d of drafts){
    const r=by[d.contestant]||={contestant:d.contestant,provider:d.provider,model:d.model,prompt:d.prompt_name,temperature:d.temperature,
      drafts:0,written:0,skipped:0,failed:0,truncated:0,judged:0,picked:0,_auth:[],_human:[],_ai:0,_scored:0,_mkt:[],_rem:[],_words:[],_lat:[],flag_counts:{}};
    r.drafts++;
    if(d.status==='written')r.written++;else if(d.status==='skipped')r.skipped++;else if(d.status==='failed')r.failed++;else if(d.status==='truncated')r.truncated++;
    if(pickedItems.has(d.item_key)){r.judged++;if(wins[d.id])r.picked++;}
    const f=j(d.flags);if(f&&d.status==='written'){r._words.push(f.words);for(const x of f.list)r.flag_counts[x]=(r.flag_counts[x]||0)+1;}
    if(d.latency_ms!=null)r._lat.push(d.latency_ms);
    const v=summary(j(d.rule_check));
    if(v){r._scored++;if(v.authenticity_risk!=null)r._auth.push(v.authenticity_risk);if(v.human!=null)r._human.push(v.human);if(v.ai_prediction==='AI')r._ai++;
      if(v.marketing_risk!=null)r._mkt.push(v.marketing_risk);if(v.removal_risk!=null)r._rem.push(v.removal_risk);}
  }
  const avg=a=>a.length?Math.round(a.reduce((x,y)=>x+y,0)/a.length*10)/10:null,pct=(a,b)=>b?Math.round(a/b*1000)/10:null;
  return Object.values(by).map(r=>({contestant:r.contestant,provider:r.provider,model:r.model,prompt:r.prompt,temperature:r.temperature,
    drafts:r.drafts,written:r.written,skipped:r.skipped,failed:r.failed,truncated:r.truncated,
    judged:r.judged,picked:r.picked,pick_rate:pct(r.picked,r.judged),
    disclosure_kept:pct(r.written-(r.flag_counts['no disclosure']||0),r.written),invented:pct(r.flag_counts['possible invented claim']||0,r.written),
    flag_counts:r.flag_counts,avg_words:avg(r._words),avg_seconds:r._lat.length?Math.round(avg(r._lat)/100)/10:null,
    scored:r._scored,authenticity_risk:avg(r._auth),human_pct:r._human.length?Math.round(avg(r._human)*100):null,ai_pct:pct(r._ai,r._scored),
    marketing_risk:avg(r._mkt),removal_risk:avg(r._rem)}))
    .sort((a,b)=>(b.pick_rate??-1)-(a.pick_rate??-1)||(a.authenticity_risk??999)-(b.authenticity_risk??999));
}

function runView(store,runId){
  const db=store.db,r=db.prepare('select * from bench_runs where id=?').get(runId);
  if(!r)fail(404,'No such test');
  const counts=Object.fromEntries(db.prepare('select status,count(*) n from bench_drafts where run_id=? group by status').all(runId).map(x=>[x.status,x.n]));
  const total=Object.values(counts).reduce((a,b)=>a+b,0);
  const items=db.prepare('select count(distinct item_key) n from bench_drafts where run_id=?').get(runId).n;
  const picked=db.prepare('select count(*) n from bench_picks where run_id=?').get(runId).n;
  const scored=db.prepare('select count(*) n from bench_drafts where run_id=? and rule_check is not null').get(runId).n;
  return {id:r.id,name:r.name,status:r.status,created_at:r.created_at,finished_at:r.finished_at,config:j(r.config),
    progress:{total,pending:counts.pending||0,counts},items,picked,scored,score_status:r.score_status,score_error:r.score_error,leaderboard:leaderboard(store,runId)};
}
const runList=store=>store.db.prepare('select id from bench_runs order by id desc limit 50').all().map(r=>{const v=runView(store,r.id);delete v.leaderboard;return v;});

// Featherless's public model list, cached for an hour, for the model search box.
let catalog=null,catalogAt=0;
async function searchModels(q,{fetchImpl=fetch}={}){
  if(!catalog||Date.now()-catalogAt>3600000){
    // The list answers 404 to Node's default User-Agent, so send our own.
    const r=await fetchImpl('https://api.featherless.ai/v1/models',{headers:{'User-Agent':'geonode-dev-server/1.0'},signal:AbortSignal.timeout(30000)});
    if(!r.ok)fail(502,'Featherless model list: HTTP '+r.status);
    catalog=((await r.json()).data||[]).map(m=>({id:m.id,cost:m.concurrency_cost??null,gated:!!m.is_gated,context:m.context_length??null}));catalogAt=Date.now();
  }
  const words=String(q||'').toLowerCase().split(/\s+/).filter(Boolean);
  return {total:catalog.length,models:(words.length?catalog.filter(m=>words.every(w=>m.id.toLowerCase().includes(w))):[]).slice(0,40)};
}

module.exports={SHORTLIST,STYLES,init,flags,pickItems,createRun,draftRun,scoreRun,compare,pick,leaderboard,runView,runList,searchModels};
