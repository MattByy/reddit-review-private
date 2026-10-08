/* api/cron/tick.js — the planner's clock, every 15 minutes (vercel.json).
 *
 * Replaces the laptop loop (scenario-dispatch.py poll + link). Each pass:
 *   1. accounts: sync the Engain accounts-beta roster into `accounts`. Never
 *      touches `disclosed`, which only a human sets on /plan.
 *   2. poll: read what Engain published, failed or cancelled, and write it on
 *      engain_tasks, drafts and scenario_acts. An act turning `published` fires
 *      the plan_watch_jobs trigger (027), which plans its reply checks.
 *   3. check_replies: for each due check, read our comment on Reddit. Every
 *      reply from someone who is not us becomes a `draft_followup` job for the
 *      agent. Nothing is written to Reddit here.
 *   4. sequences: advance every open sequence run (_engine.js, migration 029).
 *   5. send: runQueue(), the same sender as /api/dispatch.
 * Every outcome is in the JSON it returns and in activity_log (actor cron/tick).
 */
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
    reddit_username: a.profileUsername || null, niche: a.niche || null, lifecycle: a.lifecycleStatus || null,
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
