// Every 15 minutes: observe message outcomes, advance verified experiments,
// dispatch queued text, and keep the discovery worker supplied with durable jobs.
const { runQueue, sb, engain, logger } = require("../_send.js");
const {randomUUID}=require("crypto");
const { runEngine } = require("../_engine.js");

const ACTOR = "cron/tick";
const log = logger(ACTOR);
const now = () => new Date().toISOString();


async function syncAccounts() {
  const { status, json } = await engain("GET", "/api/v1/accounts-beta/accounts");
  if (status >= 300) return { ok: false, status };
  const rows = (json.accounts || []).map(a => ({ id: a.userAccountId, label: a.label || a.displayName || null,
    reddit_username: a.profileUsername?.trim().replace(/^u\//i,'') || null, niche: a.niche || null, lifecycle: a.lifecycleStatus || null,
    usable: a.usable ?? null, synced_at: now() }));
  if (rows.length) await sb("POST", "accounts?on_conflict=id", rows, "resolution=merge-duplicates,return=minimal");
  return { ok: true, synced: rows.length };
}

const monitor=require('../_monitor.js');
module.exports = async function handler(req, res) {
  const out = (status, obj) => { res.setHeader("Content-Type", "application/json"); res.setHeader("Cache-Control", "no-store"); res.statusCode = status; res.end(JSON.stringify(obj, null, 2)); };
  const secret = process.env.CRON_SECRET || "";
  if (!secret || String(req.headers.authorization || "") !== `Bearer ${secret}`) return out(401, { error: "cron secret missing or wrong" });
  const token=randomUUID();
  if(!await sb('POST','rpc/acquire_workflow_clock',{p_token:token}))return out(200,{ok:true,deferred:'Another tick owns the lease'});
  const report = {}, deadline=Date.now()+45000;
  const messages=require('../_messages.js');
  if(await messages.enabled()){
    try{
      const result=await messages.tick(deadline);
      // Previously submitted work remains observable without creating legacy replies.
      if(Date.now()<deadline){await monitor.reconcile();result.archive=await monitor.poll(deadline);await monitor.verifyRecent(deadline,false);}
      await sb('POST','rpc/ensure_finder_job',{});
      await log('message_tick',result);return out(200,{ok:true,workflow:'message_experiments',...result});
    }catch(e){return out(500,{error:e.message});}
    finally{await sb('POST','rpc/release_workflow_clock',{p_token:token});}
  }
  const phases=[['accounts',syncAccounts],['reconcile',monitor.reconcile],['poll',()=>monitor.poll(deadline)],
    ['verify',()=>monitor.verifyRecent(deadline)],['check_replies',()=>monitor.checkJobs(deadline)],
    ['sequences',()=>runEngine(deadline)],['finder',()=>sb('POST','rpc/ensure_finder_job',{})],
    ['send',async()=>(await runQueue(ACTOR,deadline)).body]];
  for(const [name,fn] of phases){
    if(Date.now()>=deadline){report[name]={deferred:'tick time budget'};continue;}
    try{report[name]=await fn();}catch(e){report[name]={error:String(e.message).slice(0,300)};}
  }
  await sb('POST','rpc/release_workflow_clock',{p_token:token});
  await log("tick", report);
  return out(200, { ok: !Object.values(report).some(v=>v?.error||v?.ok===false||v?.results?.some(r=>r.error)), ...report });
};
