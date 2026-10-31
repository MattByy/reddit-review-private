// Data for the hosted monitor page, read from the Supabase mirror (server/mirror.cjs).
// Needs the session cookie from /api/login, or an "Everything" (full) API key of the always-on
// computer as a bearer token (lib/auth.js). Everything is about one organization: ?org=<slug>, else
// the gn_org cookie, else the caller's first; commands need the role lib/auth.js NEEDS lists.
// GET /api/monitor             who you are, your organizations, then status, Queue 1, Queue 2 and the latest events
// GET /api/monitor?events=1&before=<id>&type=<prefix>   older events (100 per page)
// POST /api/monitor {"kind":"settings","payload":{...}} | {"kind":"run","payload":{"job"}} | {"kind":"discard","payload":{"queue2_id"}} | {"kind":"requeue","payload":{"queue2_id"}} | {"kind":"batch","payload":{"action","queue2_ids"|"all"}} | {"kind":"edit","payload":{"queue2_id","message"}} | {"kind":"update"} | {"kind":"restart"} | {"kind":"fast","payload":{"minutes"}}
//   queues a command for the computer, which picks it up within a few seconds (server/dev.cjs applyCommand).
const {supabase,who,pickOrg,allowed,NEEDS,readJson,reply:send}=require('../lib/auth.js');

// The computer checks commands again; this keeps obvious mistakes off the queue.
const SETTINGS={write_every_minutes:[0,1440],queue2_target:[1,200],send_per_hour:[0,60],send_from_hour:[0,23],send_to_hour:[1,24]};
function checkCommand(b){
  const p=b?.payload;
  if(!p||typeof p!=='object')return 'Give a payload';
  if(b.kind==='settings'){
    const keys=Object.keys(p);if(!keys.length)return 'Nothing to change';
    for(const k of keys){if(!SETTINGS[k])return 'Not changeable here: '+k;const n=p[k];if(!Number.isInteger(n)||n<SETTINGS[k][0]||n>SETTINGS[k][1])return `${k} must be a whole number from ${SETTINGS[k][0]} to ${SETTINGS[k][1]}`;}
    return null;
  }
  if(b.kind==='run')return ['writer','sender','threads','comments','tracker'].includes(p.job)?null:'Unknown job';
  if(b.kind==='batch'){
    if(!['discard','requeue','send','retry'].includes(p.action))return 'action must be discard, requeue, send or retry';
    if(p.all===true)return p.action==='send'?null:'all works only with send';
    return Array.isArray(p.queue2_ids)&&p.queue2_ids.length>0&&p.queue2_ids.length<=200&&p.queue2_ids.every(Number.isInteger)?null:'queue2_ids must be 1 to 200 numbers';
  }
  if(['update','restart'].includes(b.kind))return null;
  if(b.kind==='edit')return !Number.isInteger(p.queue2_id)?'queue2_id must be a number':typeof p.message!=='string'||!p.message.trim()||p.message.length>10000?'message must be 1 to 10000 characters':null;
  if(['discard','requeue'].includes(b.kind))return Number.isInteger(p.queue2_id)?null:'queue2_id must be a number';
  if(b.kind==='fast')return Number.isInteger(p.minutes)&&p.minutes>=0&&p.minutes<=60?null:'minutes must be 0 to 60';
  return 'kind must be settings, run, discard, requeue, batch, edit, update, restart or fast';
}

module.exports=async(req,res)=>{
  const reply=(status,body)=>send(res,status,body);
  const db=supabase();
  if(!db)return reply(503,{error:'Not connected yet: set SUPABASE_URL and SUPABASE_SERVICE_KEY on this Vercel project.'});
  try{
    const me=await who(req,db);
    if(!me)return reply(401,{error:'Please sign in'});
    if(me.scope!=='full')return reply(403,{error:'This needs an "Everything" key; this one is "Prompts only"'});
    const org=pickOrg(req,me);
    const you={name:me.name,owner:me.owner,orgs:me.orgs.map(o=>({slug:o.slug,name:o.name,role:o.role}))};
    if(!org)return reply(me.orgs.length?403:200,me.orgs.length?{error:'You are not a member of that organization'}:{you,org:null,note:'You are not in any organization yet. Ask an admin for an invite link.'});
    const mine='org=eq.'+encodeURIComponent(org.slug);

    if(req.method==='POST'){
      const body=await readJson(req);
      const why=checkCommand(body);if(why)return reply(422,{error:why});
      const need=NEEDS[body.kind];
      if(!need||!allowed(me,org,need))return reply(403,{error:need==='owner'?'Only an owner can do this':`This needs the ${need} role in ${org.name}; you are ${org.role}`});
      const [c]=await db('commands',{body:{by:me.name,kind:body.kind,payload:body.payload,org:org.slug}});
      return reply(200,{command:c});
    }
    const q=new URL(req.url,'http://x').searchParams;
    const before=Number(q.get('before'))||null,type=(q.get('type')||'').replace(/[^\w.]/g,'');
    const eventsPath=`events?${mine}&select=id,at,type,message,item_id,queue2_id&order=id.desc&limit=100${before?`&id=lt.${before}`:''}${type?`&type=like.${type}*`:''}`;
    if(q.get('events'))return reply(200,{events:await db(eventsPath)});
    const [status,queue1,queue2,events,commands]=await Promise.all([
      db(`status?${mine}&select=synced_at,data&order=synced_at.desc&limit=1`),
      db(`queue1?${mine}&select=*&order=position.asc&limit=200`),
      db(`queue2?${mine}&select=*&order=id.desc&limit=300`),
      db(eventsPath),
      db(`commands?${mine}&select=id,at,by,kind,payload,status,result,done_at&order=id.desc&limit=10`),
    ]);
    reply(200,{by:me.name,you,org:{slug:org.slug,name:org.name,about:org.about,role:org.role},status:status[0]||null,queue1,queue2,events,commands});
  }catch(e){reply(e.status||502,{error:e.message});}
};
