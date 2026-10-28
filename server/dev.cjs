#!/usr/bin/env node
// Local server: collects and ranks Reddit threads from Engain and serves a work queue to agents.
// `npm run dev` (live Engain, needs ENGAIN_API_KEY in .env.local) or `npm run dev:mock` (invented data).
const fs=require('node:fs');
const path=require('node:path');
const http=require('node:http');
const {timingSafeEqual,createHash}=require('node:crypto');
const root=path.resolve(__dirname,'..');
for(const f of ['.env.local','.env'])if(fs.existsSync(path.join(root,f)))process.loadEnvFile(path.join(root,f));

const {client}=require('./engain.cjs');
const {open}=require('./store.cjs');
const {collect,SOURCES}=require('./collect.cjs');
const queue=require('./queue.cjs');

const LOOPBACK=new Set(['127.0.0.1','::1','::ffff:127.0.0.1']);
const digest=s=>createHash('sha256').update(String(s)).digest();
const bearer=(req,secret)=>timingSafeEqual(digest(String(req.headers?.authorization||'').replace(/^Bearer\s+/i,'')),digest(secret));
const fail=(status,message)=>{throw Object.assign(Error(message),{status});};

function createApp({mock=false,dbFile,apiKey=process.env.ENGAIN_API_KEY,projectId=process.env.ENGAIN_PROJECT_ID,
  agentKey=process.env.AGENT_API_KEY,cronSecret=process.env.CRON_SECRET,log=console.log}={}){
  const store=open(dbFile||path.join(root,'.data',mock?'dev-mock.db':'dev.db'));
  const engain=client(mock?{apiKey:'mock',fetchImpl:require('./mock.cjs').mockFetch,limits:false,log}:{apiKey,log});
  const live=new Map();let active=null,projectName=null;

  async function project(){
    if(projectId)return projectId;
    // The key reaches several workspaces' projects; default to Geonode's.
    const me=await engain.me();
    if(!me.projects?.length)fail(409,'This Engain key has no projects');
    const p=me.projects.find(p=>/geonode/i.test(p.name))||me.projects[0];projectName=p.name;
    return projectId=p.id;
  }
  // One collection at a time. Returns the run ID at once and `done`, which settles with the
  // summary after the queue has been refreshed.
  async function beginCollect(input,{addThreads=true}={}){
    if(active)fail(409,'A collection run is already in progress (run '+active+')');
    active='starting';
    let pid;try{pid=await project();}catch(e){active=null;throw e;}
    const id=store.startRun(input);active=id;live.set(id,{step:'starting'});
    const done=collect(input,{engain,store,projectId:pid,onProgress:p=>live.set(id,p)})
      .then(s=>{try{s.queue=queue.refreshQueue(store,{addThreads}).summary;}catch(e){s.errors.push('queue refresh: '+e.message);}store.finishRun(id,s);return s;},
        e=>{const s={errors:[e.message]};store.finishRun(id,s);return s;})
      .finally(()=>{active=null;live.delete(id);log(`collection run ${id} finished`);});
    return {run_id:id,done};
  }

  // The two scheduled jobs. Each is also an HTTP route for an outside cron.
  const jobs={
    // Fill the queue with threads only when it holds fewer than queue_target items. Stored
    // threads are used while they are fresh; older than thread_collect_minutes, Engain is asked first.
    async threads(){
      const cfg=queue.settings(store),before=store.queued().length;
      if(before>=cfg.queue_target)return {action:'none',reason:`Queue has ${before} items (target ${cfg.queue_target})`,queued:before};
      const last=store.kv('last_thread_collection');
      let collected=null;
      if(!last||Date.now()-Date.parse(last)>cfg.thread_collect_minutes*60000){
        if(active)return {action:'waiting',reason:'Collection run '+active+' is in progress',queued:before};
        const {run_id,done}=await beginCollect({sources:['opportunities','mentions','smart_search','tasks'],mention_brands:cfg.mention_comments?undefined:'own'});
        const s=await done;
        if((s.added||0)+(s.updated||0)>0)store.setKv('last_thread_collection',new Date().toISOString());
        collected={run_id,threads_added:s.added||0,threads_updated:s.updated||0,errors:s.errors||[]};
      }
      const r=queue.refreshQueue(store);
      return {action:'filled',before,queued:store.queued().length,added_threads:r.summary.added_threads,collected};
    },
    // Read our Engain tasks: record every status change (approved, disapproved, ...), insert
    // newly published comments at comment_position and drop queued comments that were removed.
    async comments(){
      if(active)return {action:'waiting',reason:'Collection run '+active+' is in progress (it also checks our comments)'};
      const {run_id,done}=await beginCollect({sources:['tasks'],enrich:false},{addThreads:false});
      const s=await done;
      return {action:'checked',run_id,published_new:s.published_new||0,task_statuses:s.task_statuses,status_changes:s.status_changes||[],
        added_comments:s.queue?.added_comments??0,removed_from_queue:s.queue?.removed??0,queued:store.queued().length,errors:s.errors||[]};
    },
  };
  const running={};
  async function runJob(name){
    if(running[name])return {action:'skipped',reason:name+' job is already running'};
    running[name]=true;const started=new Date().toISOString();
    try{
      const result=await jobs[name]();
      store.setKv('job_'+name,{started,finished:new Date().toISOString(),result});log(`job ${name}: ${result.action}${result.reason?' ('+result.reason+')':''}`);
      return result;
    }catch(e){store.setKv('job_'+name,{started,finished:new Date().toISOString(),error:e.message});log(`job ${name} failed: ${e.message}`);throw e;}
    finally{running[name]=false;}
  }
  // In-process schedule; intervals are read from the queue settings before every run.
  const timers={},next={};
  function startScheduler(){
    const plan=(name,minutesKey,delay)=>{
      next[name]=new Date(Date.now()+delay).toISOString();
      timers[name]=setTimeout(async()=>{
        await runJob(name).catch(()=>{});
        plan(name,minutesKey,queue.settings(store)[minutesKey]*60000);
      },delay);
    };
    plan('comments','comments_every_minutes',3000);
    plan('threads','threads_every_minutes',8000);
    log('jobs scheduled: comments every '+queue.settings(store).comments_every_minutes+' min, threads every '+queue.settings(store).threads_every_minutes+' min');
  }
  const jobStatus=()=>Object.fromEntries(Object.keys(jobs).map(n=>[n,{running:!!running[n],next_run:next[n]||null,last:store.kv('job_'+n)}]));

  const routes={
    // Agent: take the next item off the queue. POST because every call removes an item.
    // Moves #1 of queue 1 into queue 2 with body.message, or a random placeholder message.
    'POST /api/agent/task':async(_,body)=>queue.claimNext(store,body?.agent?String(body.agent).slice(0,80):null,{message:body?.message}),
    'GET /api/agent/queue2':async()=>queue.queue2List(store),
    'POST /api/agent/queue2/:id':async(_,body,id)=>queue.setQueue2Message(store,id,body?.message),
    'GET /api/agent/queue':async()=>{const v=queue.queueView(store,{history:0});return {count:v.count,items:v.items.map(({item_id,kind,position,score})=>({item_id,kind,position,score}))};},
    // Cron: the two jobs. They wait for the work to finish (a thread collection takes minutes).
    'POST /api/cron/threads':async()=>runJob('threads'),
    'POST /api/cron/comments':async()=>runJob('comments'),
    'POST /api/cron/check-published':async()=>runJob('comments'),
    // Cron: a full collection regardless of queue size, or {collect:false} to only refresh.
    'POST /api/cron/refresh':async(_,body)=>{
      const {collect:doCollect=true,...opts}=body||{};
      if(!doCollect)return {refreshed:queue.refreshQueue(store).summary};
      if(active)return {started:false,reason:'Collection run '+active+' is still in progress'};
      const {run_id}=await beginCollect(opts);return {started:true,run_id};
    },
    'GET /api/jobs':async()=>jobStatus(),
    'GET /api/published':async()=>queue.publishedList(store),
    'GET /api/our-comments':async q=>{
      const rows=store.ourTasks(q.verdict||undefined),counts={};
      for(const r of store.ourTasks())counts[r.verdict]=(counts[r.verdict]||0)+1;
      const lim=Math.min(Number(q.limit)||200,1000);
      return {counts,total:rows.length,items:rows.slice(0,lim).map(r=>({...r,history:store.taskEvents(r.task_id)}))};
    },

    'GET /api/status':async()=>{
      if(!projectId&&(mock||apiKey))await project().catch(()=>{});
      return {mock,engain_key:mock||!!apiKey,project_id:projectId||null,project_name:projectName,sources:SOURCES,active_run:active,
        threads:store.threads().length,comments:store.comments().length,published:store.published().length,queued:store.queued().length,agent_auth:!!agentKey,cron_auth:!!cronSecret};
    },
    'GET /api/settings':async()=>queue.settings(store),
    'POST /api/settings':async(_,body)=>queue.saveSettings(store,body),
    'GET /api/queue':async q=>queue.queueView(store,q),
    'POST /api/queue/refresh':async(_,body)=>queue.refreshQueue(store,{reset:!!body?.reset}).summary,
    'POST /api/queue/:id':async(_,body,id)=>queue.setStatus(store,id,body?.status,body?.note),
    'GET /api/comments':async q=>queue.commentList(store,q),
    'GET /api/threads':async q=>queue.threadList(store,q),
    'GET /api/threads/:id':async(_,__,id)=>{const t=queue.evaluate(store).threadById[id];if(!t)fail(404,'Thread not collected');return t;},
    'GET /api/subreddits':async()=>store.subreddits(),
    'GET /api/projects':async()=>engain.me(),
    'GET /api/balance':async()=>engain.balance(),
    'GET /api/smart-search/history':async()=>engain.smartSearchHistory({projectId:await project(),limit:50}),
    'POST /api/collect':async(_,body)=>{const {run_id}=await beginCollect(body||{});return {run_id};},
    'GET /api/runs/:id':async(_,__,id)=>{const r=store.run(id);if(!r)fail(404,'No such run');return {...r,progress:live.get(r.id)||null};},
  };

  // Agent and cron routes need their bearer secret when one is configured, and always when
  // called from another machine. Everything else (the dashboard) answers loopback only.
  function authorize(req,pathname){
    const local=LOOPBACK.has(req.socket?.remoteAddress);
    const secret=pathname.startsWith('/api/agent/')?agentKey:pathname.startsWith('/api/cron/')?cronSecret:undefined;
    if(pathname.startsWith('/api/agent/')||pathname.startsWith('/api/cron/')){
      if(secret){if(!bearer(req,secret))fail(401,'Missing or wrong bearer token');}
      else if(!local)fail(401,(pathname.startsWith('/api/agent/')?'AGENT_API_KEY':'CRON_SECRET')+' must be set to accept remote calls');
    }else if(!local)fail(403,'The dashboard API only answers on this machine');
  }

  async function handle(req,res){
    const u=new URL(req.url,'http://localhost');
    const send=(status,value,type='application/json; charset=utf-8')=>{res.writeHead(status,{'Content-Type':type,'Cache-Control':'no-store'});res.end(type.startsWith('application/json')?JSON.stringify(value,null,1):value);};
    try{
      if(req.method==='GET'&&(u.pathname==='/'||u.pathname==='/index.html')){
        if(!LOOPBACK.has(req.socket?.remoteAddress))fail(403,'The dashboard only answers on this machine');
        return send(200,fs.readFileSync(path.join(__dirname,'public/index.html')),'text/html; charset=utf-8');
      }
      const parts=u.pathname.split('/');let route=routes[req.method+' '+u.pathname],param;
      if(!route&&parts.length>=4){route=routes[req.method+' '+parts.slice(0,-1).join('/')+'/:id'];param=decodeURIComponent(parts.at(-1));}
      if(!route)return send(404,{error:'Not found'});
      authorize(req,u.pathname);
      let body=null;
      if(req.method==='POST'){let raw='';for await(const c of req){raw+=c;if(raw.length>1e5)return send(413,{error:'Body too large'});}try{body=raw?JSON.parse(raw):{};}catch{return send(400,{error:'Invalid JSON'});}}
      send(200,await route(Object.fromEntries(u.searchParams),body,param));
    }catch(e){send(e.status&&e.status<600?e.status:500,{error:e.message,engain:e.body});}
  }
  return {handle,store,engain,runJob,startScheduler,close:()=>{for(const t of Object.values(timers))clearTimeout(t);store.close();}};
}

if(require.main===module){
  const mock=process.argv.includes('--mock')||process.env.ENGAIN_MOCK==='1';
  const host=process.env.HOST||'127.0.0.1',port=Number(process.env.PORT||3000);
  if(!LOOPBACK.has(host)&&host!=='localhost'&&(!process.env.AGENT_API_KEY||!process.env.CRON_SECRET)){
    console.error('Refusing to listen on '+host+': set AGENT_API_KEY and CRON_SECRET first.');process.exit(1);
  }
  const app=createApp({mock});
  http.createServer(app.handle).listen(port,host,()=>{
    console.log(`Thread collector running at http://${host}:${port}  (${mock?'MOCK Engain data':'live Engain API'})`);
    if(!mock&&!process.env.ENGAIN_API_KEY)console.log('  ENGAIN_API_KEY is missing: add it to .env.local, or use npm run dev:mock');
    // JOBS=off leaves scheduling to an outside cron calling /api/cron/threads and /api/cron/comments.
    if(process.env.JOBS==='off')console.log('  Scheduled jobs are off (JOBS=off)');else app.startScheduler();
  });
}

module.exports={createApp};
