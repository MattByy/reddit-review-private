#!/usr/bin/env node
// Local server: collects and ranks Reddit threads from Engain and serves a work queue to agents.
// `npm run dev` (live Engain, needs ENGAIN_API_KEY in .env.local) or `npm run dev:mock` (invented data).
const fs=require('node:fs');
const path=require('node:path');
const http=require('node:http');
const {timingSafeEqual,createHash,randomInt}=require('node:crypto');
const root=path.resolve(__dirname,'..');
for(const f of ['.env.local','.env'])if(fs.existsSync(path.join(root,f)))process.loadEnvFile(path.join(root,f));

const {client}=require('./engain.cjs');
const {open}=require('./store.cjs');
const {collect,SOURCES}=require('./collect.cjs');
const queue=require('./queue.cjs');
const writer=require('./writer.cjs');
const tracker=require('./tracker.cjs');
const bench=require('./bench.cjs');
const {mirror}=require('./mirror.cjs');

const LOOPBACK=new Set(['127.0.0.1','::1','::ffff:127.0.0.1']);
// A tunnel (ngrok, Cloudflare, Tailscale Funnel) or the Vercel proxy connects from this machine too,
// but adds a forwarding header: such a request came from elsewhere and needs a key.
const FORWARDED=['x-forwarded-for','forwarded','cf-connecting-ip','x-real-ip','tailscale-user-login','ngrok-trace-id'];
const isLocal=req=>LOOPBACK.has(req.socket?.remoteAddress)&&!FORWARDED.some(h=>req.headers?.[h]);
const digest=s=>createHash('sha256').update(String(s)).digest();
const bearer=(req,secret)=>timingSafeEqual(digest(String(req.headers?.authorization||'').replace(/^Bearer\s+/i,'')),digest(secret));
const fail=(status,message)=>{throw Object.assign(Error(message),{status});};

function createApp({mock=false,dbFile,apiKey=process.env.ENGAIN_API_KEY,projectId=process.env.ENGAIN_PROJECT_ID,
  agentKey=process.env.AGENT_API_KEY,cronSecret=process.env.CRON_SECRET,openrouter={},supabase={},log=console.log,
  // Update & restart from the hosted page; tests pass fakes. git(args) returns stdout and throws on failure.
  git=args=>require('node:child_process').execFileSync('git',args,{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:60000}).trim(),
  // How the server restarts itself (restartMode below); the entry point at the bottom passes the real one.
  restart=null}={}){
  const canRestart=!!restart;
  // Writer settings; tests pass {fetchImpl,apiKey,featherlessKey}. Defaults come from the environment.
  const writerOpts={...openrouter};
  const llmKeys=()=>({openrouter:writerOpts.apiKey??process.env.OPENROUTER_API_KEY,featherless:writerOpts.featherlessKey??process.env.FEATHERLESS_API_KEY});
  const store=open(dbFile||path.join(root,'.data',mock?'dev-mock.db':'dev.db'));
  // Console lines also go to the activity log; `say` prints only, for lines that log their own event.
  const say=log;log=m=>{say(m);store.event('server.log',String(m));};
  const keepDays=Number(process.env.LOG_KEEP_DAYS)||30;store.pruneEvents(keepDays);
  writer.backfillSlugs(store);
  let commit=null;try{commit=git(['rev-parse','--short','HEAD']);}catch{}
  const server={commit,started_at:new Date().toISOString(),can_restart:canRestart,restart_mode:restart?.mode??null};
  // The code on disk can be newer than what runs (pulled but not restarted); the page shows the difference.
  const diskCommit=()=>{try{return git(['rev-parse','--short','HEAD']);}catch{return null;}};
  store.event('server.started',`Server started (${mock?'mock':'live'} Engain${commit?', commit '+commit:''})`,{mock,keep_log_days:keepDays,commit,can_restart:canRestart});
  const engain=client(mock?{apiKey:'mock',fetchImpl:require('./mock.cjs').mockFetch,limits:false,log}:{apiKey,log});
  const live=new Map();let active=null,projectName=null;
  // Model tests run in the background; one drafting pass per test at a time.
  const benchBusy=new Set();
  function startBench(id,what,fn){
    if(benchBusy.has(id+what))return false;benchBusy.add(id+what);
    fn().catch(e=>log(`model test ${id} ${what} failed: ${e.message}`)).finally(()=>benchBusy.delete(id+what));return true;
  }
  const draftBench=id=>startBench(id,'draft',()=>bench.draftRun(store,id,{keys:llmKeys(),fetchImpl:writerOpts.fetchImpl,concurrency:Number(process.env.BENCH_CONCURRENCY)||4,log}));
  for(const id of bench.init(store.db))draftBench(id);

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
    store.event('collect.started',`Collection run ${id} started`,{run_id:id,input});
    const done=collect(input,{engain,store,projectId:pid,onProgress:p=>live.set(id,p)})
      .then(s=>{try{s.queue=queue.refreshQueue(store,{addThreads}).summary;}catch(e){s.errors.push('queue refresh: '+e.message);}store.finishRun(id,s);return s;},
        e=>{const s={errors:[e.message]};store.finishRun(id,s);return s;})
      .then(s=>{store.event(s.errors?.length?'collect.errors':'collect.finished',`Collection run ${id} finished: ${s.added||0} threads added, ${s.updated||0} updated`+(s.errors?.length?`, ${s.errors.length} errors`:''),{run_id:id,summary:s});return s;})
      .finally(()=>{active=null;live.delete(id);say(`collection run ${id} finished`);});
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
  // Ask Engain about every sent item that has no final status yet (one bulk call per 100).
  jobs.tracker=async()=>{
    const open=store.toCheck().length;
    if(!open)return {action:'none',reason:'Nothing sent is waiting for a final status'};
    const r=await tracker.checkSent(store,engain,await project(),{log});
    return {action:'checked',...r};
  };
  // Auto-send: one item per run, spread over the day by the scheduler (queue.senderDelay). Sends a
  // ready Queue 2 draft, else drafts the next Queue 1 item and sends that. Off while send_per_day is 0.
  const sendable=i=>i&&i.send_status==='ready'&&!i.approved_at&&i.message_source!=='random'&&!['skipped','truncated','failed'].includes(i.write_status)
    // Our accounts can't post replies, so a reply whose turn is ours waits.
    &&!(i.status!=='thread'&&i.next_delivery?.next==='dedicated');
  const notSendable=i=>!i?'Not in Queue 2':sendable(i)?null:i.send_status!=='ready'?'Already '+i.send_status:i.approved_at?'Already approved'
    :i.message_source==='random'?'No draft yet':['skipped','truncated','failed'].includes(i.write_status)?'Draft '+i.write_status:'Waits for our accounts, which cannot post replies';
  jobs.sender=async()=>{
    const cfg=queue.settings(store),w=queue.sendWindow(cfg);
    if(!cfg.send_per_day)return {action:'off',reason:'Auto-send is off (send_per_day is 0)'};
    if(!w.open)return {action:'waiting',reason:`Outside sending hours (${cfg.send_from_hour}:00-${cfg.send_to_hour}:00 Warsaw time)`};
    const today=store.sentSince(w.day_start).length;
    if(today>=cfg.send_per_day)return {action:'none',reason:`Sent ${today} today (max ${cfg.send_per_day})`};
    const errors=[];
    for(let tries=0;tries<3;tries++){
      let item=queue.queue2List(store).items.find(sendable);
      if(!item){
        const r=queue.claimNext(store,'auto-sender');
        if(!r.queue2)return {action:'none',reason:'Queue 1 is empty',errors};
        try{await writer.writeQueue2(store,r.queue2.queue2_id,writerOpts);}catch(e){errors.push(`draft #${r.queue2.queue2_id}: ${e.message}`);}
        item=queue.queue2Item(store,r.queue2.queue2_id);
        if(!sendable(item))continue;
      }
      try{
        const s=await routes['POST /api/agent/queue2/:id/approve'](null,{approved_by:'auto-sender'},String(item.queue2_id));
        return {action:'sent',queue2_id:item.queue2_id,kind:item.status,mode:s.queue2?.delivery_mode??null,sent_today:today+1,max:cfg.send_per_day,errors};
      }catch(e){errors.push(`#${item.queue2_id}: ${e.message}`);}
    }
    return {action:'none',reason:'Nothing could be sent in 3 tries',errors};
  };
  // Writer: every write_every_minutes, the next Queue 1 item is drafted into Queue 2 (never sent).
  // It rests while Queue 2 already holds queue2_target drafts ready to send. 0 turns it off.
  jobs.writer=async()=>{
    const cfg=queue.settings(store);
    if(!cfg.write_every_minutes&&!fast())return {action:'off',reason:'The writer is off (write_every_minutes is 0)'};
    const waiting=queue.queue2List(store).items.filter(sendable).length;
    if(waiting>=cfg.queue2_target)return {action:'none',reason:`Queue 2 has ${waiting} drafts ready (target ${cfg.queue2_target})`};
    // A draft whose model call failed (a timeout, an outage) still holds its placeholder; write it
    // again before taking a new item, up to 3 failed tries each, so placeholders don't pile up.
    const failures=id=>store.db.prepare("select count(*) n from events where type='llm.error' and queue2_id=?").get(id).n;
    const stranded=queue.queue2List(store).items.find(i=>i.send_status==='ready'&&i.message_source==='random'&&[null,'failed'].includes(i.write_status)&&failures(i.queue2_id)<3);
    const r=stranded?{queue2:{queue2_id:stranded.queue2_id,kind:stranded.status}}:queue.claimNext(store,'writer');
    if(!r.queue2)return {action:'none',reason:'Queue 1 is empty'};
    const id=r.queue2.queue2_id;
    try{await writer.writeQueue2(store,id,writerOpts);}catch(e){return {action:'failed',queue2_id:id,retry:!!stranded,reason:e.message};}
    const item=queue.queue2Item(store,id);
    return {action:item?item.write_status:'skipped',queue2_id:id,retry:!!stranded,kind:r.queue2.kind??item?.status??null,model:item?.model??null,ready:waiting+(sendable(item)?1:0)};
  };
  // Supabase mirror (server/mirror.cjs), every minute while the scheduler runs. Off without its keys.
  // Logs only when it starts failing or recovers, not every minute.
  const mir=mirror(supabase);
  async function syncMirror(){
    if(!mir)return {action:'off',reason:'SUPABASE_URL and SUPABASE_SERVICE_KEY (or SUPABASE_SECRET_SERVICE_ROLE) are not set'};
    const was=store.kv('mirror_last');
    try{
      const r=await mir.sync(store,{jobs:jobStatus(),server:{...server,disk_commit:diskCommit()},fast_until:fastUntil>Date.now()?new Date(fastUntil).toISOString():null});
      await sendSnapshots();await mir.scrub();store.setKv('mirror_last',{ok:true,...r});
      if(was&&!was.ok)log('Supabase mirror working again');
      return {action:'synced',...r};
    }catch(e){
      store.setKv('mirror_last',{ok:false,at:new Date().toISOString(),error:e.message});
      if(!was||was.ok||was.error!==e.message)log('Supabase mirror failed: '+e.message);
      return {action:'failed',reason:e.message};
    }
  }
  // Commands from the hosted page (via the commands table): change settings, run a job now, remove a
  // Queue 2 draft, or fast
  // mode, in which the writer runs every minute and the mirror syncs every 10 s so the page shows
  // it live. Sending is never faster than auto-send allows. Commands older than 15 minutes expire,
  // so nothing surprising happens when the computer comes back after a long time offline.
  const REMOTE_SETTINGS=['write_every_minutes','queue2_target','send_per_day','send_from_hour','send_to_hour'];
  const REMOTE_JOBS=['writer','sender','threads','comments','tracker'];
  // The hosted Prompts page: its reads come from snapshots, its changes arrive as "api" commands.
  const REMOTE_API=/^\/api\/(prompts(\/(weights|preview|try))?|prompt-variants(\/[\w-]+(\/delete)?)?|keys(\/[\w-]+\/revoke)?|models)$/;
  const SNAPSHOTS=['GET /api/prompts','GET /api/keys','GET /api/models'],PAGES=['GET /prompts','GET /docs/prompts-api'];
  // A route called from inside, as the computer itself would (so it is local and logged).
  async function internal(method,url,body){
    let status,type,out;
    const req=(async function*(){if(body!=null)yield JSON.stringify(body);})();
    Object.assign(req,{method,url,socket:{remoteAddress:'127.0.0.1'},headers:{}});
    await handle(req,{writeHead(s,h){status=s;type=h?.['Content-Type']||'';},end(v){out=String(v??'');}});
    return {status,type,body:out};
  }
  let pagesSent=false;
  async function sendSnapshots(){
    const keys=[...SNAPSHOTS,...(pagesSent?[]:PAGES)],rows=[];
    for(const k of keys){const [m,u]=k.split(' '),r=await internal(m,u);if(r.status===200)rows.push({key:k,type:r.type,body:r.body});}
    await mir.putSnapshots(rows);pagesSent=true;
  }
  let fastUntil=0,commandsBusy=false;
  const fast=()=>fastUntil>Date.now();
  async function applyCommand(c){
    const by=`hosted page (${String(c.by||'?').slice(0,40)})`,p=c.payload||{};
    if(Date.now()-Date.parse(c.at)>15*60000)return ['expired',{reason:'Older than 15 minutes when the computer saw it'}];
    if(c.kind==='settings'){
      const bad=Object.keys(p).filter(k=>!REMOTE_SETTINGS.includes(k));if(bad.length)fail(422,'Not changeable from the hosted page: '+bad.join(', '));
      const before=queue.settings(store),after=queue.saveSettings(store,p);
      const changed=Object.fromEntries(Object.keys(p).filter(k=>before[k]!==after[k]).map(k=>[k,[before[k],after[k]]]));
      store.event('settings.changed',`Settings changed by ${by}: `+(Object.entries(changed).map(([k,[a,b]])=>`${k} ${a} -> ${b}`).join(', ')||'nothing new'),{by,changed});
      replan('writer');replan('sender');
      return ['done',{changed}];
    }
    if(c.kind==='run'){
      if(!REMOTE_JOBS.includes(p.job))fail(422,'Unknown job: '+p.job);
      return ['done',await runJob(p.job,by)];
    }
    // Remove an unsent draft from Queue 2 (its Queue 1 item does not come back).
    if(c.kind==='discard'){
      const id=Number(p.queue2_id);if(!Number.isInteger(id))fail(422,'queue2_id must be a number');
      const r=await internal('POST',`/api/agent/queue2/${id}/discard`,{});
      if(r.status!==200)fail(r.status,JSON.parse(r.body||'{}').error||'Could not remove it');
      return ['done',{removed:id}];
    }
    // Send an unsent draft back to the front of Queue 1.
    if(c.kind==='requeue'){
      const id=Number(p.queue2_id);if(!Number.isInteger(id))fail(422,'queue2_id must be a number');
      const r=await internal('POST',`/api/agent/queue2/${id}/requeue`,{});
      if(r.status!==200)fail(r.status,JSON.parse(r.body||'{}').error||'Could not send it back');
      return ['done',{requeued:id}];
    }
    // Several Queue 2 items at once: remove, back to Queue 1 (keeping their order at the front), send,
    // or retry (a failed send goes back into Queue 2).
    // send with all:true sends everything ready. Items that cannot be sent are skipped with the reason.
    if(c.kind==='batch'){
      const action=p.action;if(!['discard','requeue','send','retry'].includes(action))fail(422,'action must be discard, requeue, send or retry');
      let ids=p.all?(action==='send'?queue.queue2List(store).items.filter(sendable).map(i=>i.queue2_id):fail(422,'all works only with send')):(Array.isArray(p.queue2_ids)?p.queue2_ids.map(Number):[]);
      if(!p.all&&(!ids.length||ids.some(n=>!Number.isInteger(n))))fail(422,'queue2_ids must be a list of numbers');
      if(ids.length>200)fail(422,'At most 200 at a time');
      // Each one sent back goes above the last, so the last is moved first and the list keeps its order.
      if(action==='requeue')ids=[...ids].reverse();
      const done=[],skipped=[];
      for(const id of ids){
        if(action==='send'){const why=notSendable(queue.queue2Item(store,id));if(why){skipped.push({queue2_id:id,reason:why});continue;}}
        const r=await internal('POST',`/api/agent/queue2/${id}/${action==='send'?'approve':action}`,action==='send'?{approved_by:by}:{});
        if(r.status===200)done.push(id);else skipped.push({queue2_id:id,reason:JSON.parse(r.body||'{}').error||'HTTP '+r.status});
      }
      store.event('queue2.batch',`${by}: ${action} ${done.length} of ${ids.length}${skipped.length?`, ${skipped.length} skipped`:''}`,{by,action,done,skipped});
      return ['done',{action,done:done.length,skipped}];
    }
    // Edit a Queue 2 draft by hand (it is sent as written; the writer leaves it alone).
    if(c.kind==='edit'){
      const id=Number(p.queue2_id);if(!Number.isInteger(id))fail(422,'queue2_id must be a number');
      const r=await internal('POST',`/api/agent/queue2/${id}`,{message:p.message});
      if(r.status!==200)fail(r.status,JSON.parse(r.body||'{}').error||'Could not save it');
      return ['done',{edited:id}];
    }
    // Update: fetch main and check it is a fast-forward; the merge runs after the command is marked done.
    // When server/ changes, watch mode restarts the server on its own.
    if(c.kind==='update'){
      git(['fetch','origin','main']);
      const from=git(['rev-parse','--short','HEAD']),to=git(['rev-parse','--short','origin/main']);
      if(from===to)return ['done',{from,to,commits:0,note:'Already up to date'}];
      try{git(['merge-base','--is-ancestor','HEAD','origin/main']);}catch{fail(409,`Not a fast-forward: this computer has commits that are not on GitHub (${from}). Nothing changed.`);}
      if(git(['status','--porcelain','--untracked-files=no']))fail(409,'This computer has uncommitted changes to tracked files. Nothing changed.');
      const commits=Number(git(['rev-list','--count','HEAD..origin/main'])),files=git(['diff','--name-only','HEAD','origin/main']).split('\n').filter(Boolean);
      const restarts=canRestart&&files.some(f=>f.startsWith('server/'));
      // Watch mode restarts on its own when server/ changes; any other mode is restarted here.
      store.event('server.update',`Updating ${from} -> ${to} (${commits} commits) for ${by}${restarts?'; the server restarts':''}`,{by,from,to,commits,files});
      return ['done',{from,to,commits,restarts,note:restarts?'Updated; the server restarts now':files.some(f=>f.startsWith('server/'))?'Updated, but this server cannot restart itself: restart npm run dev by hand':'Updated; no server code changed, so no restart'},
        async()=>{
          try{git(['merge','--ff-only','origin/main']);}catch(e){store.event('server.update_failed',`Update to ${to} failed: ${e.message}`,{from,to,error:e.message});return;}
          if(restarts&&restart.mode!=='watch')await restart();
        }];
    }
    if(c.kind==='restart'){
      if(!canRestart)fail(409,'This server cannot restart itself');
      store.event('server.restart',`Restart requested by ${by}`,{by});
      return ['done',{note:'Restarting'},async()=>restart()];
    }
    if(c.kind==='api'){
      const method=String(p.method||'GET').toUpperCase(),u=new URL(String(p.path||''),'http://x');
      if(!['GET','POST'].includes(method)||!REMOTE_API.test(u.pathname))fail(422,'Not reachable from the hosted page: '+method+' '+u.pathname);
      const r=await internal(method,u.pathname+u.search,method==='POST'?(p.body??{}):null);
      // The page reloads right after a change, so its snapshots must already show it.
      if(method==='POST')await sendSnapshots().catch(e=>log('snapshots failed: '+e.message));
      return ['done',{status:r.status,type:r.type,body:r.body}];
    }
    if(c.kind==='fast'){
      const min=Number(p.minutes);if(!Number.isInteger(min)||min<0||min>60)fail(422,'minutes must be 0 to 60');
      fastUntil=min?Date.now()+min*60000:0;
      store.event('fast_mode.'+(min?'started':'stopped'),min?`Fast mode for ${min} min, started by ${by}`:`Fast mode stopped by ${by}`,{by,minutes:min});
      replan('writer');replan('mirror');
      return ['done',{fast_until:min?new Date(fastUntil).toISOString():null}];
    }
    fail(422,'Unknown command: '+c.kind);
  }
  async function processCommands(){
    if(!mir||commandsBusy)return {action:'skipped'};
    commandsBusy=true;
    try{
      const list=await mir.pending();
      for(const c of list){
        let status,result,after;
        try{[status,result,after]=await applyCommand(c);}catch(e){status='failed';result={error:e.message};}
        // An api command's answer can hold a new key's secret: the log keeps only its status.
        store.event('command.'+status,`Hosted page command #${c.id} (${c.kind}${c.kind==='api'?' '+c.payload?.method+' '+c.payload?.path:''}) ${status}`,
          {id:c.id,kind:c.kind,payload:c.kind==='api'?{method:c.payload?.method,path:c.payload?.path}:c.payload,by:c.by,result:c.kind==='api'?{status:result?.status}:result});
        await mir.finish(c.id,status,result);
        // Steps that restart the server run only once the command is marked done, so it never runs twice.
        if(after){await syncMirror();await after();return {action:'checked',commands:1,restarting:true};}
      }
      if(list.length)await syncMirror();
      return {action:'checked',commands:list.length};
    }catch(e){return {action:'failed',reason:e.message};}
    finally{commandsBusy=false;}
  }
  const running={};
  // source says who started it: the scheduler, a cron call, the dashboard or fast mode ("fast_mode #3").
  async function runJob(name,source='schedule'){
    const by=source==='schedule'?'':` (${source})`;
    if(running[name]){store.event('job.skipped',`Job ${name} skipped${by}: already running`,{job:name,source});return {action:'skipped',reason:name+' job is already running'};}
    running[name]=true;const started=new Date().toISOString();
    store.event('job.started',`Job ${name} started${by}`,{job:name,source});
    try{
      const result=await jobs[name]();
      store.setKv('job_'+name,{started,finished:new Date().toISOString(),result});say(`job ${name}: ${result.action}${result.reason?' ('+result.reason+')':''}`);
      store.event('job.finished',`Job ${name}${by}: ${result.action}${result.reason?' ('+result.reason+')':''}`,{job:name,source,ms:Date.now()-Date.parse(started),result});
      return result;
    }catch(e){store.setKv('job_'+name,{started,finished:new Date().toISOString(),error:e.message});say(`job ${name} failed: ${e.message}`);
      store.event('job.failed',`Job ${name}${by} failed: ${e.message}`,{job:name,source,error:e.message,status:e.status??null,engain:e.body??null});throw e;}
    finally{running[name]=false;}
  }
  // In-process schedule; intervals are read from the queue settings before every run.
  const timers={},next={};
  // plans[name] = [nextDelay, run]; replan(name) runs it again soon, for a change made from the hosted page.
  const plans={};
  const plan=(name,nextDelay,delay,run=()=>runJob(name).catch(()=>{}))=>{
    plans[name]=[nextDelay,run];clearTimeout(timers[name]);
    next[name]=new Date(Date.now()+delay).toISOString();
    timers[name]=setTimeout(async()=>{await run();plan(name,nextDelay,nextDelay(),run);},delay);
  };
  const replan=(name,delay=1000)=>{if(plans[name])plan(name,plans[name][0],delay,plans[name][1]);};
  function startScheduler(){
    const every=key=>()=>queue.settings(store)[key]*60000;
    plan('comments',every('comments_every_minutes'),3000);
    plan('threads',every('threads_every_minutes'),8000);
    plan('tracker',every('tracker_every_minutes'),5000);
    plan('sender',()=>queue.senderDelay(queue.settings(store)),20000);
    if(mir){
      plan('mirror',()=>fast()?10000:60000,2000,syncMirror);
      plan('commands',()=>3000,5000,processCommands);
    }
    plan('writer',()=>fast()?60000:(queue.settings(store).write_every_minutes||10)*60000,30000);
    const c=queue.settings(store);log(`jobs scheduled: comments every ${c.comments_every_minutes} min, threads every ${c.threads_every_minutes} min, sent-status checker every ${c.tracker_every_minutes} min, `+
      (c.write_every_minutes?`writer every ${c.write_every_minutes} min, `:'writer off, ')+(c.send_per_day?`auto-send ${c.send_per_day} a day between ${c.send_from_hour}:00 and ${c.send_to_hour}:00 Warsaw time`:'auto-send off'));
  }
  const jobSource=body=>body?.source?String(body.source).slice(0,40):'cron';
  const jobStatus=()=>Object.fromEntries(Object.keys(jobs).map(n=>[n,{running:!!running[n],next_run:next[n]||null,last:store.kv('job_'+n)}]));

  // Engain still flags refunded accounts isReadyForSelection, but they have no Reddit username and
  // a lifecycle other than active, and Engain refuses them ("Account is not ready for commenting").
  const canPost=a=>!!a.isReadyForSelection&&a.lifecycleStatus==='active'&&!!a.username;
  // A random ready account of ours that has not commented in this item's thread yet.
  async function pickAccount(item){
    const pid=await project();
    let list;
    try{list=(await engain.v2Accounts(pid)).accounts||[];}
    catch(e){if(e.status===403||e.status===404)fail(409,`Your own accounts are not available to this key (HTTP ${e.status}), so this first comment was not sent.`);throw e;}
    const ready=list.filter(canPost);
    if(!ready.length)fail(409,'None of your own accounts is ready to post, so this first comment was not sent.');
    for(let i=ready.length-1;i>0;i--){const j=randomInt(i+1);[ready[i],ready[j]]=[ready[j],ready[i]];}
    for(const a of ready){
      let c=null;
      try{c=await engain.v2ThreadCheck(a.userAccountId,{projectId:pid,threadUrl:item.thread_url||item.url});}catch(e){log('thread check failed for '+a.userAccountId+': '+e.message);}
      if(!c?.exists){
        store.event('account.picked',`Picked account ${a.username||a.userAccountId} for ${item.item_id}`,{queue2_id:item.id,item_id:item.item_id,account:a.userAccountId,username:a.username||null,ready:ready.length});
        return {...a,username:a.username?String(a.username).replace(/^u\//,''):null};
      }
      store.event('account.skipped',`Account ${a.username||a.userAccountId} already commented in this thread`,{queue2_id:item.id,item_id:item.item_id,account:a.userAccountId});
    }
    fail(409,`All ${ready.length} of your ready accounts already commented in this thread.`);
  }

  // The item and prompt for /api/prompts/preview and /try. Item: {"queue2_id"} or {"item_id"} from
  // Queue 1, else the first Queue 1 item of the type. Prompt: {"variant_id"}, {"text"} or {"style"}.
  function tryTarget(body){
    let entry;
    if(body?.queue2_id!=null){const r=store.queue2(body.queue2_id);if(!r)fail(404,'No such queue 2 entry');entry={kind:r.kind,url:r.url,thread_url:r.thread_url,title:r.title,item:r.item};}
    else{
      const v=body?.variant_id?writer.findVariant(store,body.variant_id):null,type=body?.type||v?.type||'thread';
      const items=queue.queueView(store,{history:0}).items,x=body?.item_id?items.find(i=>i.item_id===body.item_id):items.find(i=>i.kind===type);
      if(!x)fail(404,body?.item_id?'That item is not in Queue 1':`Queue 1 has no ${type} item to try this on`);
      entry={kind:x.kind,url:x.url,thread_url:x.thread_url,title:x.thread?.title||null,item:{item_id:x.item_id,thread:x.thread,comment:x.comment,mention:x.mention}};
    }
    const variant=body?.variant_id?writer.findVariant(store,body.variant_id).variant:null;
    const text=variant?.text??body?.text??(body?.style==='default'?writer.DEFAULT_PROMPTS:writer.NATURAL_PROMPTS)[entry.kind];
    if(typeof text!=='string'||!text.trim())fail(422,'Give variant_id, text or style');
    return {entry,variant,prompt:writer.render(text,writer.variables(entry,store,text))};
  }

  // Per type: each prompt's target %, drafts, sends and Engain outcomes, with shares and rates.
  // Prompts that were deleted but still have drafts are listed with deleted:true.
  function promptStats(){
    const rows=store.variantStats(),skips=store.variantSkips(),out={};
    for(const [type,list] of Object.entries(writer.variants(store))){
      const mine=rows.filter(r=>r.kind===type),pct=(a,b)=>b?Math.round(a/b*1000)/10:null;
      const sum=k=>mine.reduce((a,r)=>a+(r[k]||0),0),drafted=sum('drafted'),published=sum('published'),sent=sum('sent');
      const entries=[...list.map(v=>({id:v.id,slug:v.slug,name:v.name,weight:v.weight,deleted:false})),
        ...mine.filter(r=>!list.some(v=>v.id===r.id)).sort((x,y)=>String(x.name).localeCompare(String(y.name))).map(r=>({id:r.id,slug:r.slug,name:r.name,weight:0,deleted:true}))];
      out[type]={drafted,sent,published,prompts:entries.map(e=>{e.slug=e.slug??mine.find(r=>r.id===e.id)?.slug??null;
        const r=mine.find(r=>r.id===e.id)||{drafted:0,sent:0,published:0,removed:0,failed:0,cancelled:0,pending:0,sent_pool:0,sent_dedicated:0,waiting:0,last_written_at:null};
        const not_published=r.removed+r.failed+r.cancelled;
        return {...e,drafted:r.drafted,skipped:skips[e.id]||0,waiting:r.waiting,not_sent:r.drafted-r.sent-r.waiting,sent:r.sent,sent_pool:r.sent_pool,sent_dedicated:r.sent_dedicated,
          published:r.published,pending:r.pending,not_published,removed:r.removed,failed:r.failed,cancelled:r.cancelled,last_written_at:r.last_written_at,
          share_of_drafts:pct(r.drafted,drafted),share_of_published:pct(r.published,published),publish_rate:pct(r.published,r.sent),removal_rate:pct(r.removed,r.sent)};
      })};
    }
    return out;
  }

  const routes={
    // Agent: take the next item off the queue. POST because every call removes an item.
    // Moves #1 of queue 1 into queue 2 with body.message, or a random placeholder message.
    // With {"write":true}, OpenRouter then drafts the message from the item's prompt (never sends).
    'POST /api/agent/task':async(_,body)=>{
      const r=queue.claimNext(store,body?.agent?String(body.agent).slice(0,80):null,{message:body?.message});
      if(body?.write&&r.queue2){
        try{await writer.writeQueue2(store,r.queue2.queue2_id,writerOpts);}catch(e){r.write_error=e.message;}
        r.queue2=queue.queue2Item(store,r.queue2.queue2_id)||{queue2_id:r.queue2.queue2_id,write_status:'skipped',discarded:true};
      }
      return r;
    },
    'POST /api/agent/queue2/:id/write':async(_,__,id)=>{await writer.writeQueue2(store,id,writerOpts);return queue.queue2Item(store,id)||{queue2_id:Number(id),write_status:'skipped',discarded:true};},
    // Approve and send in one step. Routing is automatic unless body.mode is given: pool and our
    // own accounts take turns in a thread (queue.threadDelivery). Our first post there goes from a
    // random ready account of ours (Engain v2) that has not commented in the thread, the next through
    // the pool, and so on. Our accounts cannot post replies (v2), so a reply whose turn is
    // ours is refused rather than sent through the pool.
    'POST /api/agent/queue2/:id/approve':async(_,body,id)=>{
      const item=store.queue2(id);if(!item)fail(404,'No such queue 2 entry');
      if(item.message_source==='random'||['skipped','truncated'].includes(item.write_status))fail(422,item.write_status==='truncated'?'This message is cut off. Rewrite or edit it first.':'There is no real message to approve. Write one first.');
      if(item.send_status&&item.send_status!=='ready')fail(409,'Only a ready item can be approved');
      let mode=body?.mode,userAccountId=body?.userAccountId,override=body?.override,account=null;
      // From here on a failure takes the item out of Queue 2 into the send log (Retry puts it back).
      const notSent=(e,reason)=>{
        if(!e.logged){
          store.failQueue2Send(id,reason,e.message);
          store.event('send.failed',`Queue 2 #${id}: not sent: ${e.message}`,{queue2_id:Number(id),item_id:item.item_id,kind:item.kind,mode:mode??null,account:userAccountId??null,
            url:item.url,reason,error:e.message,status:e.status??null,engain:e.body??null});
          e.logged=true;
        }
        throw e;
      };
      if(!mode){
        const turn=queue.threadDelivery(store,item.thread_id);
        store.event('delivery.chosen',`Queue 2 #${id}: ${turn.first?`our first post in this thread came from ${turn.first==='pool'?'the pool':'our accounts'}`:'nothing of ours in this thread yet'}, so this one goes via ${turn.next==='pool'?'the pool':'our accounts'}`,
          {queue2_id:Number(id),item_id:item.item_id,thread_id:item.thread_id,...turn});
        if(turn.next==='dedicated'){
          if(item.kind!=='thread')notSent(Object.assign(Error('This thread started from the pool, so this reply should come from one of your accounts, but Engain does not let your own accounts post replies.'),{status:409}),'Turn of our accounts; they cannot reply');
          try{account=await pickAccount(item);}catch(e){notSent(e,'No account to post from');}
          mode='dedicated';userAccountId=account.userAccountId;override={...override,thread_check:true};
        }
        else mode='pool';
      }
      if(!store.approveQueue2(id,body?.approved_by?String(body.approved_by).slice(0,80):'dashboard'))fail(409,'Only a ready item can be approved');
      store.event('queue2.approved',`Queue 2 #${id}: approved by ${body?.approved_by||'dashboard'}, sending via ${mode}`,{queue2_id:id,item_id:item.item_id,approved_by:body?.approved_by||'dashboard',mode,account:userAccountId??null,message:item.message});
      const {sendQueue2}=require('./send-queue2.cjs');
      let sent;
      try{sent=await sendQueue2({id,mode,userAccountId,posterAccount:body?.posterAccount,override},{engain,store,projectId:await project(),log});}
      catch(e){notSent(e,e.status?`Engain ${e.status}`:'Not sent');}
      return {...sent,account:account&&{id:account.userAccountId,username:account.username||null,niche:account.niche||null},queue2:queue.queue2Item(store,id)};
    },
    // Prompt variants per type with their percentages, and how each one has done so far.
    'GET /api/prompts':async()=>({max_prompts:writer.MAX_PROMPTS,variants:writer.variants(store),stats:promptStats(),defaults:writer.DEFAULT_PROMPTS,natural:writer.NATURAL_PROMPTS,variables:writer.VARIABLES,
      model:writerOpts.model||process.env.OPENROUTER_MODEL||writer.DEFAULT_MODEL,openrouter_key:!!llmKeys().openrouter,featherless_key:!!llmKeys().featherless,shortlist:bench.SHORTLIST}),
    // API keys. The secret is returned once, on create. scope: "prompts" (default) or "full".
    'GET /api/keys':async()=>({keys:store.apiKeys()}),
    'GET /api/keys/me':async(_,__,___,who)=>({by:who?.by??null,key:who?.key?{id:who.key.id,name:who.key.name,scope:who.key.scope,prefix:who.key.prefix}:null}),
    'POST /api/keys':async(_,body)=>{
      const name=String(body?.name??'').trim(),scope=body?.scope??'prompts';
      if(!name||name.length>60)fail(422,'Give the key a name (up to 60 characters), e.g. "prompt agent"');
      if(!['prompts','full'].includes(scope))fail(422,'scope must be prompts or full');
      const k=store.createApiKey({name,scope});store.event('key.created',`API key "${name}" created (${scope})`,{id:k.id,name,scope,prefix:k.prefix});
      return k;
    },
    'POST /api/keys/:id/revoke':async(_,__,id)=>{const k=store.apiKey(id)||fail(404,'No such key');if(!store.revokeApiKey(id))fail(409,'That key is already revoked');
      store.event('key.revoked',`API key "${k.name}" revoked`,{id,name:k.name});return store.apiKey(id);},
    // Replace one type's prompt list: {"type":"thread","variants":[{"id"?,"name","text","weight"}]} (weights add up to 100).
    'POST /api/prompts':async(_,body)=>({type:body?.type,variants:writer.saveVariants(store,body?.type,body?.variants)}),
    // One prompt at a time. Add: {"type","name","text"? or "style":"natural"|"default","provider","model","temperature"} (starts at 0%).
    'POST /api/prompt-variants':async(_,body)=>writer.addVariant(store,body),
    'GET /api/prompt-variants/:id':async(_,__,id)=>{const f=writer.findVariant(store,id);return {type:f.type,variant:f.variant};},
    // Change any of name, text, provider, model, temperature. Percentages go through /api/prompts/weights.
    'POST /api/prompt-variants/:id':async(_,body,id)=>writer.updateVariant(store,id,body),
    'POST /api/prompt-variants/:id/delete':async(_,__,id)=>writer.deleteVariant(store,id),
    // {"type":"thread","weights":{"<id or name>":60,"<id or name>":40}}; prompts not named go to 0%.
    'POST /api/prompts/weights':async(_,body)=>writer.setWeights(store,body?.type,body?.weights),
    // The prompt exactly as a model would get it, filled in with a real item. No model call.
    'POST /api/prompts/preview':async(_,body)=>{const t=tryTarget(body);return {type:t.entry.kind,item:t.entry,prompt:t.prompt};},
    // One draft from a prompt and model on a real item, without saving it anywhere or sending it.
    'POST /api/prompts/try':async(_,body)=>{
      const t=tryTarget(body),provider=body?.provider||t.variant?.provider||'openrouter';
      const model=body?.model||t.variant?.model||(provider==='openrouter'?writerOpts.model||process.env.OPENROUTER_MODEL||writer.DEFAULT_MODEL:fail(422,'Give a Featherless model'));
      const temperature=body?.temperature!=null?Number(body.temperature):t.variant?.temperature??0.7;
      const r=await writer.complete({provider,model,prompt:t.prompt,temperature,maxTokens:provider==='featherless'?3000:1500,keys:llmKeys(),fetchImpl:writerOpts.fetchImpl})
        .catch(e=>{store.event('llm.try_error',`Prompt try: ${provider} ${model} failed: ${e.message}`,{provider,model,prompt:t.prompt,error:e.message});throw e;});
      store.event('llm.try',`Prompt try: ${provider} ${model} answered in ${r.latency_ms} ms (not saved)`,{provider,model,temperature,prompt:t.prompt,text:r.text,finish_reason:r.finish_reason,latency_ms:r.latency_ms,usage:r.usage});
      return {type:t.entry.kind,item:t.entry,provider,model,temperature,prompt:t.prompt,text:r.text,finish_reason:r.finish_reason,latency_ms:r.latency_ms,
        skipped:/^skip\.?$/i.test(r.text),disclosure:writer.checkDisclosure(r.text),flags:bench.flags(r.text).list};
    },
    // Models: the shortlist, plus a search of Featherless's public list with ?q=.
    'GET /api/models':async q=>({default_openrouter_model:writerOpts.model||process.env.OPENROUTER_MODEL||writer.DEFAULT_MODEL,shortlist:bench.SHORTLIST,
      keys:{openrouter:!!llmKeys().openrouter,featherless:!!llmKeys().featherless},...(q.q?{featherless:await bench.searchModels(q.q)}:{})}),
    // Model test: the same Queue 1 items drafted by several models, compared blind. Never posts.
    'GET /api/bench':async()=>({runs:bench.runList(store),shortlist:bench.SHORTLIST,styles:Object.fromEntries(Object.entries(bench.STYLES).map(([k,v])=>[k,v.label])),
      saved_prompts:[...new Set(Object.values(writer.variants(store)).flat().map(v=>v.name))],keys:{openrouter:!!llmKeys().openrouter,featherless:!!llmKeys().featherless}}),
    'GET /api/bench/models':async q=>bench.searchModels(q.q),
    // {"name","threads":12,"comments":8,"contestants":[{"provider","model","prompt":"natural","temperature":0.8}]}
    'POST /api/bench':async(_,body)=>{const id=bench.createRun(store,body,queue.queueView(store,{history:0}));draftBench(id);return bench.runView(store,id);},
    'GET /api/bench/:id':async(_,__,id)=>bench.runView(store,Number(id)),
    'GET /api/bench/:id/compare':async(_,__,id)=>({run:bench.runView(store,Number(id)),items:bench.compare(store,Number(id))}),
    'POST /api/bench/:id/pick':async(_,body,id)=>bench.pick(store,Number(id),body),
    // Engain rule-check scores (authenticity, Pangram AI detection, removal risk). Reads only.
    'POST /api/bench/:id/score':async(_,__,id)=>{const v=bench.runView(store,Number(id)),pid=await project();
      startBench(v.id,'score',()=>bench.scoreRun(store,engain,pid,v.id,{log}));return {started:true};},
    'POST /api/bench/:id/resume':async(_,__,id)=>{const v=bench.runView(store,Number(id));
      store.db.prepare("update bench_drafts set status='pending' where run_id=? and status='failed'").run(v.id);
      store.db.prepare("update bench_runs set status='running',finished_at=null where id=?").run(v.id);draftBench(v.id);return bench.runView(store,v.id);},
    'GET /api/agent/queue2':async q=>queue.queue2List(store,q),
    'POST /api/agent/queue2/:id/retry':async(_,__,id)=>queue.retryQueue2(store,id),
    'POST /api/agent/queue2/:id/requeue':async(_,__,id)=>queue.returnToQueue1(store,id),
    'GET /api/agent/send-log':async q=>queue.sendLog(store,q),
    'GET /api/agent/queue2/:id':async(_,__,id)=>queue.queue2Item(store,id)||fail(404,'No such queue 2 entry'),
    // Throw away an unsent Queue 2 entry (its Queue 1 item does not come back).
    'POST /api/agent/queue2/:id/discard':async(_,__,id)=>{const item=store.queue2(id);if(!store.discardQueue2(id))fail(409,'Only an existing, unsent entry can be discarded');
      store.event('queue2.discarded',`Queue 2 #${id} discarded`,{queue2_id:id,item_id:item?.item_id??null,message:item?.message??null});return {ok:true,discarded:Number(id)};},
    'POST /api/agent/queue2/:id':async(_,body,id)=>queue.setQueue2Message(store,id,body?.message),
    'POST /api/agent/queue2/:id/send':async(_,body,id)=>{
      const {sendQueue2}=require('./send-queue2.cjs');
      return sendQueue2({id,mode:body?.mode,userAccountId:body?.userAccountId,posterAccount:body?.posterAccount,override:body?.override},
        {engain,store,projectId:await project(),log});
    },
    'POST /api/agent/queue2/:id/poll':async(_,__,id)=>{
      const {pollQueue2Status}=require('./send-queue2.cjs');
      return pollQueue2Status(id,{engain,store,log});
    },
    'POST /api/agent/queue2/:id/override':async(_,body,id)=>{
      if(!body?.field||!['thread_check_override'].includes(body.field))fail(422,'field must be thread_check_override');
      store.setQueue2Override(id,body.field,!!body.value);
      return {ok:true,id:Number(id),field:body.field,value:!!body.value};
    },
    // Our dedicated Reddit accounts (Engain API v2) usable in this project. Accounts that are not
    // ready to post are listed with usable:false. Without access Engain answers 403.
    'GET /api/agent/beta-accounts':async()=>{
      try{
        const r=await engain.v2Accounts(await project());
        return {available:true,accounts:(r.accounts||[]).map(a=>({userAccountId:a.userAccountId,username:a.username?String(a.username).replace(/^u\//,''):null,
          displayName:a.displayName||null,niche:a.niche||null,lifecycleStatus:a.lifecycleStatus||null,isKarmaBuilding:!!a.isKarmaBuilding,usable:canPost(a)}))};
      }catch(e){if(e.status===403||e.status===404)return {available:false,accounts:[],reason:`Dedicated accounts are not available to this API key (HTTP ${e.status}${e.body?.error?.code?' '+e.body.error.code:''}).`};throw e;}
    },
    'GET /api/agent/project-id':async()=>({projectId:await project()}),
    'GET /api/agent/queue':async()=>{const v=queue.queueView(store,{history:0});return {count:v.count,items:v.items.map(({item_id,kind,position,score})=>({item_id,kind,position,score}))};},
    // Cron: the two jobs. They wait for the work to finish (a thread collection takes minutes).
    'POST /api/cron/threads':async(_,body)=>runJob('threads',jobSource(body)),
    'POST /api/cron/comments':async(_,body)=>runJob('comments',jobSource(body)),
    'POST /api/cron/tracker':async(_,body)=>runJob('tracker',jobSource(body)),
    'POST /api/cron/sender':async(_,body)=>runJob('sender',jobSource(body)),
    'POST /api/cron/writer':async(_,body)=>runJob('writer',jobSource(body)),
    'POST /api/cron/mirror':async()=>syncMirror(),
    'POST /api/cron/commands':async()=>processCommands(),
    'GET /api/mirror':async()=>({configured:!!mir,last:store.kv('mirror_last')}),
    // The tracking list and its counts over the last ?days= days (default 7, 0 = all time).
    'GET /api/sent':async q=>tracker.sentView(store,{days:q.days??7}),
    'GET /api/send-log':async q=>queue.sendLog(store,q),
    'POST /api/cron/check-published':async(_,body)=>runJob('comments',jobSource(body)),
    // Cron: a full collection regardless of queue size, or {collect:false} to only refresh.
    'POST /api/cron/refresh':async(_,body)=>{
      const {collect:doCollect=true,...opts}=body||{};
      if(!doCollect)return {refreshed:queue.refreshQueue(store).summary};
      if(active)return {started:false,reason:'Collection run '+active+' is still in progress'};
      const {run_id}=await beginCollect(opts);return {started:true,run_id};
    },
    'GET /api/jobs':async()=>jobStatus(),
    // The activity log, newest first. Filters: type (llm, send, queue, job... or an exact type),
    // item_id, queue2_id, q (text), since (ISO date), before_id (paging), limit (max 2000).
    'GET /api/logs':async q=>{const items=store.events(q);return {count:items.length,next_before_id:items.length?items[items.length-1].id:null,items};},
    'GET /api/logs/types':async()=>({keep_days:keepDays,types:store.eventTypes()}),
    // Fast mode runs in the dashboard; it reports here so its start, cycles and stop are logged.
    // {"event":"started"|"cycle"|"stopped","cycle":3,"results":{...},"error":"...","reason":"..."}
    'POST /api/fast-mode':async(_,body)=>{
      const ev=body?.event;if(!['started','cycle','stopped'].includes(ev))fail(422,'event must be started, cycle or stopped');
      const n=Number(body.cycle)||null,data={cycle:n,interval_seconds:Number(body.interval_seconds)||30,results:body.results??undefined,error:body.error??undefined,reason:body.reason??undefined};
      const msg=ev==='started'?`Fast mode started (every ${data.interval_seconds}s)`:ev==='stopped'?`Fast mode stopped after ${n||0} cycles`+(body.reason?` (${body.reason})`:''):
        body.error?`Fast mode cycle #${n} failed: ${body.error}`:`Fast mode cycle #${n} done`+(body.results?.queued!=null?`: ${body.results.queued} in Queue 1`:'');
      const id=store.event(ev==='cycle'&&body.error?'fast.cycle_error':'fast.'+ev,msg,data);
      if(ev!=='cycle')store.setKv('fast_mode',{on:ev==='started',at:new Date().toISOString(),cycles:n});
      return {ok:true,event_id:id};
    },
    // For agents (AGENT_API_KEY from another machine). The same log as /api/logs, plus a summary
    // of what is happening: event counts, recent failures, jobs, fast mode and queue sizes.
    'GET /api/agent/logs':async q=>{const items=store.events(q);return {count:items.length,next_before_id:items.length?items[items.length-1].id:null,items};},
    'GET /api/agent/logs/types':async()=>({keep_days:keepDays,types:store.eventTypes()}),
    'GET /api/agent/logs/summary':async q=>{
      const minutes=Math.max(1,Math.min(Number(q.minutes)||60,43200)),since=new Date(Date.now()-minutes*60000).toISOString();
      const q2=store.queue2(),last=store.events({limit:1})[0]||null;
      return {since,minutes,counts:Object.fromEntries(store.eventTypes(since).map(t=>[t.type,t.n])),
        recent_errors:store.events({errors:true,since,limit:Math.min(Number(q.errors)||20,200)}),
        latest:store.events({since,limit:Math.min(Number(q.latest)||30,200)}).map(({id,at,type,message,item_id,queue2_id})=>({id,at,type,message,item_id,queue2_id})),
        jobs:jobStatus(),fast_mode:store.kv('fast_mode'),last_event_at:last?.at??null,
        queues:{queue1:store.queued().length,queue2_ready:q2.filter(r=>(r.send_status||'ready')==='ready').length,sent_waiting_for_status:store.toCheck().length}};
    },
    'GET /api/published':async()=>queue.publishedList(store),
    // Where one of our Engain tasks came from (Queue 2 entry, prompt slug, model, sent, statuses); 404 if not sent from here.
    'GET /api/agent/origin/:id':async(_,__,id)=>queue.originFor(store,id)||fail(404,'This task was not sent from Queue 2'),
    'GET /api/our-comments':async q=>{
      const rows=store.ourTasks(q.verdict||undefined),counts={};
      for(const r of store.ourTasks())counts[r.verdict]=(counts[r.verdict]||0)+1;
      const lim=Math.min(Number(q.limit)||200,1000);
      return {counts,total:rows.length,items:rows.slice(0,lim).map(r=>({...r,history:store.taskEvents(r.task_id)}))};
    },

    // Every route, for anyone driving this from a script. Full guide: docs/API.md.
    'GET /api':async()=>({guide:'docs/API.md',auth:agentKey?'Authorization: Bearer <AGENT_API_KEY> (not needed on this machine for dashboard routes)':'This machine only (set AGENT_API_KEY to allow remote calls)',
      routes:Object.keys(routes).sort((a,b)=>a.split(' ')[1].localeCompare(b.split(' ')[1]))}),
    'GET /api/status':async()=>{
      if(!projectId&&(mock||apiKey))await project().catch(()=>{});
      return {mock,engain_key:mock||!!apiKey,project_id:projectId||null,project_name:projectName,sources:SOURCES,active_run:active,
        threads:store.threads().length,comments:store.comments().length,published:store.published().length,queued:store.queued().length,agent_auth:!!agentKey,cron_auth:!!cronSecret};
    },
    'GET /api/settings':async()=>queue.settings(store),
    'POST /api/settings':async(_,body)=>queue.saveSettings(store,body),
    'GET /api/queue':async q=>queue.queueView(store,q),
    'POST /api/queue/refresh':async(_,body)=>queue.refreshQueue(store,{reset:!!body?.reset}).summary,
    'POST /api/queue/fresh-start':async(_,body)=>queue.setCommentsSince(store,body?.since),
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
  // called from another machine. The other API routes answer this machine freely and another
  // machine with AGENT_API_KEY. The dashboard page itself is this machine only.
  // API keys made on the Prompts page (gnk_…): scope "prompts" reaches only the prompt routes,
  // "full" everything AGENT_API_KEY reaches except the cron routes. Returns who is calling.
  const PROMPT_ROUTES=/^\/api\/(prompts(\/|$)|prompt-variants(\/|$)|models$|keys\/me$)/;
  function authorize(req,pathname){
    const local=isLocal(req);
    const token=String(req.headers?.authorization||'').replace(/^Bearer\s+/i,'').trim();
    if(token.startsWith('gnk_')){
      const k=store.apiKeyFor(token);
      if(!k)fail(401,'Unknown or revoked API key');
      if(pathname.startsWith('/api/cron/'))fail(403,'API keys cannot run cron jobs; use CRON_SECRET');
      if(k.scope!=='full'&&!PROMPT_ROUTES.test(pathname))fail(403,`The key "${k.name}" can only manage prompts (scope: prompts). See /docs/prompts-api`);
      if(k.scope!=='full'&&pathname.startsWith('/api/keys')&&pathname!=='/api/keys/me')fail(403,'Only a full key, AGENT_API_KEY or this machine can manage keys');
      return {by:'key:'+k.name,key:k};
    }
    if(pathname.startsWith('/api/keys')&&pathname!=='/api/keys/me'&&!local&&!(agentKey&&bearer(req,agentKey)))fail(401,'Managing keys needs this machine, AGENT_API_KEY or a full key');
    const secret=pathname.startsWith('/api/agent/')?agentKey:pathname.startsWith('/api/cron/')?cronSecret:undefined;
    if(pathname.startsWith('/api/agent/')||pathname.startsWith('/api/cron/')){
      if(secret){if(!bearer(req,secret))fail(401,'Missing or wrong bearer token');}
      else if(!local)fail(401,(pathname.startsWith('/api/agent/')?'AGENT_API_KEY':'CRON_SECRET')+' must be set to accept remote calls');
    }else if(!local){
      // Everything else is the dashboard's API: from another machine it needs AGENT_API_KEY or an API key.
      if(!agentKey)fail(403,'The dashboard API only answers on this machine (set AGENT_API_KEY or use an API key to allow remote calls)');
      if(!bearer(req,agentKey))fail(401,'Missing or wrong bearer token');
    }
    return {by:local&&!token?'dashboard':'agent_api_key'};
  }

  function logged(route,method,pathname,who){
    return async(q,body,param,ctx)=>{
      const started=Date.now(),ref={queue2_id:/\/queue2\/\d+/.test(pathname)?Number(param):undefined};
      try{
        const out=await route(q,body,param,ctx);
        if(method==='POST')store.event('http.request',`${method} ${pathname} -> 200 in ${Date.now()-started} ms`,{...ref,method,path:pathname,status:200,ms:Date.now()-started,body,by:who?.by});
        return out;
      }catch(e){
        store.event('http.error',`${method} ${pathname} -> ${e.status||500}: ${e.message}`,{...ref,method,path:pathname,query:q,status:e.status||500,ms:Date.now()-started,body,error:e.message,engain:e.body??null,stack:e.status?undefined:e.stack});
        throw e;
      }
    };
  }

  async function handle(req,res){
    const u=new URL(req.url,'http://localhost');
    const send=(status,value,type='application/json; charset=utf-8')=>{res.writeHead(status,{'Content-Type':type,'Cache-Control':'no-store'});res.end(type.startsWith('application/json')?JSON.stringify(value,null,1):value);};
    try{
      if(req.method==='GET'&&(u.pathname==='/'||u.pathname==='/index.html')){
        if(!isLocal(req))fail(403,'The dashboard only answers on this machine');
        return send(200,fs.readFileSync(path.join(__dirname,'public/index.html')),'text/html; charset=utf-8');
      }
      // The Prompts page holds no data itself, so it is served to anyone; its API calls need a key
      // from another machine. The agent docs are public too.
      if(req.method==='GET'&&(u.pathname==='/prompts'||u.pathname==='/prompts.html'))return send(200,fs.readFileSync(path.join(__dirname,'public/prompts.html')),'text/html; charset=utf-8');
      if(req.method==='GET'&&u.pathname==='/docs/prompts-api')return send(200,fs.readFileSync(path.join(root,'docs/PROMPTS-API.md')),'text/markdown; charset=utf-8');
      // Exact path first, then patterns with one :id segment anywhere (…/queue2/:id/send).
      let route=routes[req.method+' '+u.pathname],param;
      if(!route){
        const parts=u.pathname.split('/');
        for(let i=3;i<parts.length&&!route;i++){
          const key=req.method+' '+[...parts.slice(0,i),':id',...parts.slice(i+1)].join('/');
          if(routes[key]){route=routes[key];param=decodeURIComponent(parts[i]);}
        }
      }
      if(!route)return send(404,{error:'Not found'});
      const who=authorize(req,u.pathname);
      // Every action (POST) is logged with its body and outcome; reads are logged only when they fail.
      route=logged(route,req.method,u.pathname,who);
      let body=null;
      if(req.method==='POST'){let raw='';for await(const c of req){raw+=c;if(raw.length>1e5)return send(413,{error:'Body too large'});}try{body=raw?JSON.parse(raw):{};}catch{return send(400,{error:'Invalid JSON'});}}
      send(200,await route(Object.fromEntries(u.searchParams),body,param,who));
    }catch(e){send(e.status&&e.status<600?e.status:500,{error:e.message,engain:e.body});}
  }
  return {handle,store,engain,runJob,startScheduler,close:()=>{for(const t of Object.values(timers))clearTimeout(t);store.close();}};
}

// How this process restarts itself, for the hosted page's Restart and Update buttons:
// - watch: `npm run dev` runs under node --watch-path=server, which restarts on any change in server/.
// - exit: under pm2 or systemd, exit and let them start it again.
// - respawn: otherwise start the same command again, detached, 2 s later (so the two never overlap),
//   with its output in .data/server.log, and exit.
function restartMode(getListener){
  const mode=process.env.WATCH_REPORT_DEPENDENCIES?'watch':(process.env.pm_id!=null||process.env.INVOCATION_ID)?'exit':'respawn';
  const restart=async()=>{
    if(mode==='watch')return fs.writeFileSync(path.join(__dirname,'.restart'),new Date().toISOString());
    await new Promise(z=>{const l=getListener();l?l.close(()=>z()):z();setTimeout(z,3000);});
    if(mode==='respawn'){
      const {spawn}=require('node:child_process'),out=fs.openSync(path.join(root,'.data','server.log'),'a');
      const cmd=[process.execPath,...process.execArgv,...process.argv.slice(1)].map(a=>`'${String(a).replace(/'/g,`'\\''`)}'`).join(' ');
      spawn('/bin/sh',['-c','sleep 2; exec '+cmd],{cwd:process.cwd(),env:process.env,detached:true,stdio:['ignore',out,out]}).unref();
    }
    process.exit(mode==='exit'?1:0);
  };
  return Object.assign(restart,{mode});
}

if(require.main===module){
  const mock=process.argv.includes('--mock')||process.env.ENGAIN_MOCK==='1';
  const host=process.env.HOST||'127.0.0.1',port=Number(process.env.PORT||3000);
  if(!LOOPBACK.has(host)&&host!=='localhost'&&(!process.env.AGENT_API_KEY||!process.env.CRON_SECRET)){
    console.error('Refusing to listen on '+host+': set AGENT_API_KEY and CRON_SECRET first.');process.exit(1);
  }
  let listener=null;
  const app=createApp({mock,restart:restartMode(()=>listener)});
  listener=http.createServer(app.handle).listen(port,host,()=>{
    console.log(`Thread collector running at http://${host}:${port}  (${mock?'MOCK Engain data':'live Engain API'})`);
    if(!mock&&!process.env.ENGAIN_API_KEY)console.log('  ENGAIN_API_KEY is missing: add it to .env.local, or use npm run dev:mock');
    // JOBS=off leaves scheduling to an outside cron calling /api/cron/threads and /api/cron/comments.
    if(process.env.JOBS==='off')console.log('  Scheduled jobs are off (JOBS=off)');else app.startScheduler();
  });
}

module.exports={createApp,restartMode};
