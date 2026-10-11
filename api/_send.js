/* _send.js — the one sender. dispatch.js (after Approve, and every 15 min) and
 * cron/tick.js both call runQueue(); nothing else talks to the vendor's write
 * endpoints.
 *
 * 027 (2026-10-04), the disclosed pipeline:
 *   - posts ONLY through Engain accounts-beta, from an account a human marked
 *     disclosed on /plan. The shared-pool tasks backend is gone from this path:
 *     you cannot choose its account, so you cannot make its disclosure true.
 *   - every body must carry the disclosure line (_rules.js DISCLOSURE).
 *   - one of our accounts per thread. A second account in the same thread
 *     reads as agreement from a stranger, which is the thing we stopped doing.
 *   - no upvote orders.
 *
 * The gates, every one a refusal:
 *   0. still approved, cleared, not sent back, not gate-failed, not pulled back;
 *      scenario acts also need scenario_context().ready (approval, pace, gap)
 *   1. account: active and disclosed; no other account of ours in the thread
 *   2. the copy rules (_rules.js check(), disclosure included) on the exact bytes
 *   3. a reply's parent is a stranger the reviewer confirmed
 *   4. no byte-identical body already sent on the same thread
 *   5. Engain's rule-check when the key has a project. `fail` blocks. With no
 *      project on the key it is recorded as `skipped`, visibly: the human
 *      already approved the text and gates 1-4 ran.
 */
const { check } = require("./_rules.js");

const SB_URL  = (process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "").replace(/\/$/, "");
const SB_KEY  = process.env.SUPABASE_SERVICE_KEY || "";
const ENG_KEY = process.env.ENGAIN_API_KEY || "";
const MAX_PER_RUN = 3;
const FORBIDDEN = [
  ["owned ip", "never 'owned IPs'"], ["we own the network", "never claim network ownership"], ["own our ips", "never claim IP ownership"],
  ["owned end to end", "never 'owned end to end'"], ["gdpr", "no GDPR claims"], ["dpa available", "no DPA claims"],
  ["85,000", "85,000 is not a real figure"], ["85000", "85,000 is not a real figure"], ["/v1/scrape", "the endpoint is /v1/extract"],
];

const {sb,engain,logger,event}=require('./_db.js');
const {conversation}=require('./_reddit.js');
const workflow=require('./_workflow.js');
// null when the key has no geonode.com project; the rule-check is then skipped.
async function projectId() {
  if (process.env.ENGAIN_PROJECT_ID) return process.env.ENGAIN_PROJECT_ID;
  const { status, json } = await engain("GET", "/api/v1/me");
  if(status>=300)throw Error(`Engain identity unavailable (${status})`);
  if ((json.projects || []).length > 1 && !(json.projects || []).some(x => x.name === "geonode.com"))
    throw new Error("the vendor key has several projects; set ENGAIN_PROJECT_ID");
  const p = (json.projects || []).find(x => x.name === "geonode.com");
  return p ? p.id : null;
}
const enc = encodeURIComponent;
const now = () => new Date().toISOString();
const DEAD = ["cancelled", "canceled", "failed", "removed", "deleted", "rejected", "error"];

// The account a draft posts from: the scenario act's, then the run's, then the draft's own.
async function accountFor(draftId, draftAccount) {
  const acts = await sb("GET", `scenario_acts?select=account_id,run_id&draft_id=eq.${enc(draftId)}&limit=1`);
  let id = acts[0] && acts[0].account_id;
  if (!id && acts[0]) {
    const [run] = await sb("GET", `scenario_runs?select=account_id&id=eq.${enc(acts[0].run_id)}`);
    id = run && run.account_id;
  }
  id = id || draftAccount;
  if (!id) return { id: null };
  const [a] = await sb("GET", `accounts?select=*&id=eq.${enc(id)}`);
  return a || { id, missing: true };
}

async function dispatchOne(d, pid, log) {
  const kind = d.kind || "comment";
  const head = { draft: d.draft_id, thread: d.thread_id, kind, subreddit: d.subreddit };
  const flag = async (where, reasons) => {
    const text = `${where}: ${reasons.join(" | ")}`.slice(0, 2000);
    await sb("PATCH", `drafts?id=eq.${enc(d.draft_id)}`, { gate_failed_at: now(), gate_failure: text }, "return=minimal");
    await log("gate_refused", { draft: d.draft_id, thread: d.thread_id, where, reasons });
    return { ...head, outcome: "refused", where, reasons };
  };

  // gate 0: re-read the row itself
  const [cur] = await sb("GET", `drafts?select=status,send_cleared_at,redirect_pending,gate_failed_at,pullback_requested_at,body,parent_url,parent_confirmed_by,kind,account_id,send_after,sequence_hold,thread_context,thread_id,filing_key,origin_job_id&id=eq.${enc(d.draft_id)}`);
  if (!cur || cur.status !== "approved" || !cur.send_cleared_at || cur.redirect_pending || cur.gate_failed_at || cur.pullback_requested_at)
    return { ...head, outcome: "skipped", why: "state changed since the queue was read" };
  // 028: a queued draft waits for its slot, however early it was approved.
  if (cur.send_after && new Date(cur.send_after) > new Date())
    return { ...head, outcome: "queued", why: `queued until ${cur.send_after}` };
  if (cur.sequence_hold) return { ...head, outcome: "queued", why: "held until its sequence reaches the Send step" };
  const body = cur.body || "";
  const context = await sb("POST", "rpc/scenario_context", { p_draft_id: d.draft_id, p_parent_url: cur.parent_url || null });
  if (context.scenario && !context.pace_ok) return { ...head, outcome: "deferred", why: "pace floor (45m global / 24h subreddit / 20 per UTC day)" };
  if (!context.ready) return { ...head, outcome: "skipped", why: "scenario disabled, not approved, or not due yet" };

  // A playbook assigns its second account to the exact preceding comment.
  const play = await workflow.playbookContext(cur.origin_job_id,cur.account_id,cur.parent_url);
  if (play.playbook && !play.ready) return flag('playbook', [play.reason]);
  // gate 1: an eligible account; cross-account replies follow a saved playbook.
  const acct = await accountFor(d.draft_id, cur.account_id);
  if (!acct.id) return flag("account", ["no account chosen. Pick a disclosed account for the run or draft."]);
  if (acct.missing) return flag("account", [`account ${acct.id} is not in the accounts table`]);
  if (!acct.active) return flag("account", [`${acct.label || acct.id} is inactive`]);
  if(acct.usable!==true)return {...head,outcome:'deferred',why:'Engain reports this account unavailable'};
  if (!acct.approved) return flag("account", [`${acct.label || acct.id} is disabled`]);
  if (d.thread_id) {
    const others = await sb("GET", `engain_tasks?select=id,user_account_id,status&thread_id=eq.${enc(d.thread_id)}&user_account_id=not.is.null&user_account_id=neq.${enc(acct.id)}`);
    const live = others.filter(t => !DEAD.includes(String(t.status || "").toLowerCase()));
    if (live.length && !play.self_reply) return flag("account assignment", [`another account already posted here; use an assigned playbook reply (task ${live[0].id})`]);
  }

  // gate 2: the rules, disclosure included, on the exact bytes
  const low = body.toLowerCase();
  const forb = FORBIDDEN.filter(([p]) => low.includes(p)).map(([p, why]) => `'${p}': ${why}`);
  const v = check(body, { kind, disclosure_line: acct.disclosure_line });
  if (!v.ok || forb.length) return flag("final rule check", [...v.fails, ...forb]);

  // gate 3: the reviewer confirms the reply's intended parent.
  if (kind === "reply") {
    if (!cur.parent_url) return flag("reply", ["no parent_url"]);
    if (!cur.parent_confirmed_by && !context.self_reply) return { ...head, outcome: "skipped", why: "reply parent not confirmed by the reviewer" };
    if (!context.self_reply && !play.self_reply && await sb("POST", "rpc/is_our_url", { p_url: cur.parent_url }))
      return flag("reply target", ["parent is one of our comments without an assigned playbook reply"]);
  }
  if (kind === "post" && !(d.subreddit && d.title)) return flag("post", ["needs subreddit and title"]);

  // Re-read the actual parent immediately before submission. Saved URLs and
  // reviewer snapshots identify intent, not current Reddit availability.
  if(kind!=='post'){
    const observed=await conversation(kind==='reply'?cur.parent_url:d.thread_url);
    if(!observed.ok)return {...head,outcome:'deferred',why:observed.reason};
    if(observed.visibility!=='visible'||observed.thread.removed||observed.thread.locked||observed.thread.archived)
      return flag('Reddit parent',['Parent is removed, deleted, locked or archived']);
    if(observed.thread.id!==d.thread_id)return flag('Reddit parent',['Parent is in a different thread']);
    if(kind==='reply'&&(!observed.target||cur.thread_context?.parent?.body!==observed.target.body)){
      await sb('PATCH',`drafts?id=eq.${enc(d.draft_id)}`,{status:'pending',send_cleared_at:null,parent_confirmed_by:null,
        redirect_pending:true,redirect_note:'Parent context changed. Read the current job/thread context and revise before review.'},'return=minimal');
      return {...head,outcome:'context_changed',why:'Approval invalidated because the reader parent changed'};
    }
  }

  // gate 4: never the same bytes twice on one thread
  if (d.thread_id) {
    const dup = await sb("GET", `engain_tasks?select=id&thread_id=eq.${enc(d.thread_id)}&status=neq.test_artifact&content=eq.${enc(body)}&limit=1`);
    if (dup.length) return flag("dedupe", [`byte-identical body already sent on this thread (task ${dup[0].id})`]);
  }

  // gate 5: Engain's rule-check, when there is a project to run it under
  let verdict = "skipped", rc = { json: {} };
  if (pid) {
    rc = await engain("POST", "/api/v1/rule-check", { projectId: pid, subreddit: d.subreddit, taskType: kind, content: body, mediaKind: "text", context: { postTitle: d.title || "" } });
    if (rc.status === 429) return { ...head, outcome: "deferred", why: "vendor rule-check rate limit (5/min)" };
    verdict = rc.status < 300 ? (rc.json.verdict || "unavailable") : "unavailable";
    if (verdict === "unavailable") return { ...head, outcome: "deferred", why: `vendor rule-check unavailable (${rc.status})` };
  }
  await sb("POST", "rule_checks", [{ draft_id: d.draft_id, subreddit: d.subreddit, verdict, removal_risk: rc.json.removalRisk ?? null,
    violated_rules: rc.json.violatedRules || [], summary: pid ? `send ${now().slice(0, 16)}: ${rc.json.summary || ""}` : "skipped: the vendor key has no project, so Engain's rule-check cannot run" }], "return=minimal");
  if (verdict === "fail") return flag(`Engain rule-check fail, removal risk ${rc.json.removalRisk} of 100`, [rc.json.summary || "", ...(rc.json.violatedRules || [])].filter(Boolean));

  // the vendor call, accounts-beta only
  let endpoint, payload, target;
  if (kind === "post") { endpoint = "/api/v1/accounts-beta/posts"; payload = { userAccountId: acct.id, postType: "text", subreddit: d.subreddit, title: d.title, body }; target = `r/${d.subreddit}`; }
  else { target = kind === "reply" ? cur.parent_url : d.thread_url; endpoint = "/api/v1/accounts-beta/comments"; payload = { userAccountId: acct.id, targetUrl: target, body }; }

  // honour a review made while the checks ran
  const [fresh] = await sb("GET", `drafts?select=status,send_cleared_at,body,parent_url,redirect_pending,gate_failed_at,pullback_requested_at&id=eq.${enc(d.draft_id)}`);
  if (!fresh || fresh.status !== "approved" || !fresh.send_cleared_at || fresh.body !== body || fresh.parent_url !== cur.parent_url ||
      fresh.redirect_pending || fresh.gate_failed_at || fresh.pullback_requested_at)
    return { ...head, outcome: "skipped", why: "approval or text changed before submission" };

  const reserved=await sb('POST','rpc/reserve_publication',{p_draft_id:d.draft_id,p_body:body,p_parent_url:cur.parent_url||null,p_account_id:acct.id});
  if(!reserved.ok)return {...head,outcome:'deferred',why:reserved.reason};
  const attempt=reserved.attempt;
  const record=async(state,reason,extra={})=>{
    await sb('PATCH',`publication_attempts?id=eq.${enc(attempt.id)}`,{state,reason,updated_at:now(),...extra},'return=minimal');
    await event({event_key:`send:${attempt.id}:${state}`,event:state==='accepted'?'submitted':state==='failed'?'submission_failed':'submission_unknown',
      source:'sender',draft_id:d.draft_id,thread_id:d.thread_id,experiment:workflow.experiment(cur.thread_context?.experiment),reason,
      detail:{request_id:cur.filing_key||d.draft_id,subreddit:d.subreddit,attempt_id:attempt.id}});
  };
  try{
    const {status,json:task}=await engain('POST',endpoint,payload);
    const taskId=task.id||task.taskId||task._id;
    if(status>=300||!taskId){
      const uncertain=status>=500||status<300;
      await record(uncertain?'unknown':'failed',`Engain ${status}: ${JSON.stringify(task).slice(0,1000)}`,{vendor_response:task});
      return {...head,outcome:uncertain?'submission_unknown':'vendor_error',status,attempt:attempt.id};
    }
    // Preserve the provider ID even if the following transaction needs retrying.
    await sb('PATCH',`publication_attempts?id=eq.${enc(attempt.id)}`,{task_id:taskId,vendor_response:task,updated_at:now()},'return=minimal');
    await sb('POST','rpc/accept_publication',{p_attempt_id:attempt.id,p_task_id:taskId,p_status:task.status||'pending',p_response:task});
    await record('accepted',null);
    await log(`engain_${kind}_submitted`,{task:taskId,draft:d.draft_id,account:acct.id});
    return {...head,outcome:'sent',task:taskId,attempt:attempt.id,target};
  }catch(e){
    await record('unknown',String(e.message).slice(0,1000)).catch(()=>{});
    return {...head,outcome:'submission_unknown',attempt:attempt.id,why:'Provider outcome must be reconciled before any retry'};
  }

}

/* Send what is approved and cleared, oldest first, at most MAX_PER_RUN. */
async function runQueue(actor,deadline=Date.now()+45000) {
  const messages=require('./_messages.js');
  if(await messages.enabled())return {status:200,body:{ok:true,results:await messages.dispatch(deadline)}};
  const log = logger(actor);
  if (!SB_URL || !SB_KEY) return { status: 503, body: { error: "SUPABASE_URL / SUPABASE_SERVICE_KEY not configured" } };
  if (!ENG_KEY) return { status: 503, body: { error: "ENGAIN_API_KEY not configured on this project: nothing can be sent" } };
  await require('./_automatic.js').prepareQueue(deadline);
  // Drafts queued for later (send_after in the future) are left for their slot.
  // and drafts a sequence is holding until its Send step (029).
  const queued = new Set([
    ...(await sb("GET", `drafts?select=id&send_after=gt.${enc(now())}&status=eq.approved`)),
    ...(await sb("GET", "drafts?select=id&sequence_hold=eq.true&status=eq.approved")),
  ].map(r => r.id));
  const waiting = (await sb("GET", "posting_queue?select=*&send_cleared_at=not.is.null&order=send_cleared_at.asc")).filter(d => !queued.has(d.draft_id));
  if (!waiting.length) return { status: 200, body: { ok: true, cleared: 0, results: [], note: "nothing approved and cleared that is not already sent, refused, held or with the agent" } };
  const queue = waiting.slice(0, MAX_PER_RUN);
  const pid = await projectId();
  const results = [];
  for (const d of queue) {
    if(Date.now()>=deadline)break;
    try { results.push(await dispatchOne(d, pid, log)); }
    catch (e) { results.push({ draft: d.draft_id, thread: d.thread_id, outcome: "error", error: String(e.message).slice(0, 300) }); }
  }
  await log("dispatch_run", { cleared: waiting.length, took: queue.length, rule_check: pid ? "engain" : "skipped (no project)", results });
  return { status: 200, body: { ok: true, cleared: waiting.length, took: queue.length, results,
    note: waiting.length > queue.length ? `${waiting.length - queue.length} more wait for the next run` : undefined } };
}

module.exports = { runQueue, sb, engain, logger };
