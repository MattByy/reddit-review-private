// Data for the hosted monitor page, read from the Supabase mirror (server/mirror.cjs).
// Needs the session cookie from /api/login, or an "Everything" (full) API key of the always-on
// computer as a bearer token (lib/auth.js).
// GET /api/monitor             status, Queue 1, Queue 2 and the latest events
// GET /api/monitor?events=1&before=<id>&type=<prefix>   older events (100 per page)
// POST /api/monitor {"kind":"settings","payload":{...}} | {"kind":"run","payload":{"job"}} | {"kind":"fast","payload":{"minutes"}}
//   queues a command for the computer, which picks it up within 10 seconds (server/dev.cjs applyCommand).
const {supabase,who,readJson,reply:send}=require('../lib/auth.js');

// The computer checks commands again; this keeps obvious mistakes off the queue.
const SETTINGS={write_every_minutes:[0,1440],queue2_target:[1,200],send_per_day:[0,500],send_from_hour:[0,23],send_to_hour:[1,24]};
function checkCommand(b){
  const p=b?.payload;
  if(!p||typeof p!=='object')return 'Give a payload';
  if(b.kind==='settings'){
    const keys=Object.keys(p);if(!keys.length)return 'Nothing to change';
    for(const k of keys){if(!SETTINGS[k])return 'Not changeable here: '+k;const n=p[k];if(!Number.isInteger(n)||n<SETTINGS[k][0]||n>SETTINGS[k][1])return `${k} must be a whole number from ${SETTINGS[k][0]} to ${SETTINGS[k][1]}`;}
    return null;
  }
  if(b.kind==='run')return ['writer','sender','threads','comments','tracker'].includes(p.job)?null:'Unknown job';
  if(b.kind==='fast')return Number.isInteger(p.minutes)&&p.minutes>=0&&p.minutes<=60?null:'minutes must be 0 to 60';
  return 'kind must be settings, run or fast';
}

module.exports=async(req,res)=>{
  const reply=(status,body)=>send(res,status,body);
  const db=supabase();
  if(!db)return reply(503,{error:'Not connected yet: set SUPABASE_URL and SUPABASE_SERVICE_KEY on this Vercel project.'});
  try{
    const k=await who(req,db);
    if(!k)return reply(401,{error:'Please sign in'});
    if(k.forbidden)return reply(403,{error:'This needs an "Everything" key; this one is "Prompts only"'});

    if(req.method==='POST'){
      const body=await readJson(req);
      const why=checkCommand(body);if(why)return reply(422,{error:why});
      const [c]=await db('commands',{body:{by:k.name,kind:body.kind,payload:body.payload}});
      return reply(200,{command:c});
    }
    const q=new URL(req.url,'http://x').searchParams;
    const before=Number(q.get('before'))||null,type=(q.get('type')||'').replace(/[^\w.]/g,'');
    const eventsPath=`events?select=id,at,type,message,item_id,queue2_id&order=id.desc&limit=100${before?`&id=lt.${before}`:''}${type?`&type=like.${type}*`:''}`;
    if(q.get('events'))return reply(200,{events:await db(eventsPath)});
    const [status,queue1,queue2,events,commands]=await Promise.all([
      db('status?id=eq.main&select=synced_at,data'),
      db('queue1?select=*&order=position.asc&limit=200'),
      db('queue2?select=*&order=id.desc&limit=300'),
      db(eventsPath),
      db('commands?select=*&order=id.desc&limit=10'),
    ]);
    reply(200,{by:k.name,status:status[0]||null,queue1,queue2,events,commands});
  }catch(e){reply(e.status||502,{error:e.message});}
};
