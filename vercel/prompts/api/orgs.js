// Organizations, members and invites for the hosted monitor (lib/auth.js has the roles).
// GET  /api/orgs?org=<slug>   your organizations; for an admin of <slug> also its members, open invites
//                             and recent organization changes.
// POST /api/orgs {"action":...}
//   invite {org, role}                  admin: a link valid for 7 days, shown once
//   revoke_invite {org, id}             admin
//   set_role {org, username, role}      admin
//   remove_member {org, username}       admin
//   create_org {name, engain_key, about?, topic_terms?, brand_terms?}            owner
//   update_org {org, name?, about?, topic_terms?, brand_terms?, engain_key?}     admin (not Geonode)
// Adding or changing an organization is done by the always-on computer (an org.* command), which
// checks the Engain key with Engain and keeps it; the key is wiped from Supabase once it is done.
const {randomBytes}=require('node:crypto');
const {sha256,supabase,who,pickOrg,allowed,ROLES,SLUG,readJson,reply:send}=require('../lib/auth.js');

const INVITE_DAYS=7;
const text=(v,max)=>v==null?null:String(v).trim().slice(0,max);
const terms=v=>v==null?undefined:String(v).split(',').map(s=>s.trim()).filter(Boolean).slice(0,40).join(', ');

module.exports=async(req,res)=>{
  const reply=(status,body)=>send(res,status,body);
  const db=supabase();
  if(!db)return reply(503,{error:'Not connected yet: set SUPABASE_URL and SUPABASE_SERVICE_KEY on this Vercel project.'});
  try{
    const me=await who(req,db);
    if(!me||me.via!=='login')return reply(401,{error:'Please sign in'});
    const you={name:me.name,owner:me.owner,orgs:me.orgs.map(o=>({slug:o.slug,name:o.name,role:o.role,about:o.about,brand_terms:o.brand_terms,topic_terms:o.topic_terms}))};
    const orgOf=slug=>SLUG.test(String(slug||''))?me.orgs.find(o=>o.slug===slug)||null:null;

    if(req.method==='GET'){
      const org=pickOrg(req,me);
      if(!org||!allowed(me,org,'admin'))return reply(200,{you,org:org&&{slug:org.slug,name:org.name,role:org.role}});
      const at=new Date().toISOString(),q='org=eq.'+encodeURIComponent(org.slug);
      const [members,invites,changes]=await Promise.all([
        db(`org_members?${q}&select=username,role,added_at,added_by&order=added_at.asc`),
        db(`invites?${q}&used_at=is.null&revoked_at=is.null&expires_at=gt.${at}&select=token_hash,role,created_by,created_at,expires_at&order=created_at.desc`),
        db(`commands?kind=like.org.*&select=id,at,by,kind,payload,status,result&order=id.desc&limit=5`),
      ]);
      return reply(200,{you,org:{slug:org.slug,name:org.name,role:org.role,about:org.about},members,
        invites:invites.map(i=>({id:i.token_hash,role:i.role,created_by:i.created_by,created_at:i.created_at,expires_at:i.expires_at})),
        // Never the Engain key, even while the command waits for the computer.
        changes:changes.filter(c=>me.owner||c.payload?.slug===org.slug).map(c=>({...c,payload:{slug:c.payload?.slug??null,name:c.payload?.name??null}}))});
    }
    if(req.method!=='POST')return reply(405,{error:'GET or POST'});
    const b=await readJson(req),a=b.action;

    if(a==='create_org'){
      if(!me.owner)return reply(403,{error:'Only an owner can add organizations'});
      const name=text(b.name,60),key=text(b.engain_key,300);
      if(!name||name.length<2)return reply(422,{error:'Give the organization a name (2 to 60 characters)'});
      if(!key||key.length<10)return reply(422,{error:'Give the organization\'s Engain API key'});
      const payload={name,engain_key:key,about:text(b.about,200)||'',topic_terms:terms(b.topic_terms)||'',brand_terms:terms(b.brand_terms)||''};
      const [c]=await db('commands',{body:{by:me.name,kind:'org.create',payload,org:'geonode'}});
      return reply(200,{command:{id:c.id,status:c.status},note:'The always-on computer checks the key with Engain and starts the organization within a few seconds.'});
    }

    const org=orgOf(b.org);
    if(!org)return reply(403,{error:'You are not a member of that organization'});
    if(!allowed(me,org,'admin'))return reply(403,{error:`This needs the admin role in ${org.name}; you are ${org.role}`});
    const q='org=eq.'+encodeURIComponent(org.slug);

    if(a==='update_org'){
      if(org.slug==='geonode')return reply(422,{error:'Geonode\'s settings are built into the server'});
      const payload={slug:org.slug};
      for(const [k,max] of [['name',60],['about',200],['engain_key',300]])if(b[k]!=null&&String(b[k]).trim())payload[k]=text(b[k],max);
      for(const k of ['topic_terms','brand_terms'])if(b[k]!=null)payload[k]=terms(b[k]);
      if(Object.keys(payload).length<2)return reply(422,{error:'Nothing to change'});
      const [c]=await db('commands',{body:{by:me.name,kind:'org.update',payload,org:org.slug}});
      return reply(200,{command:{id:c.id,status:c.status}});
    }
    if(a==='invite'){
      if(!ROLES.includes(b.role))return reply(422,{error:'role must be '+ROLES.join(', ')});
      const token=randomBytes(24).toString('base64url'),expires_at=new Date(Date.now()+INVITE_DAYS*86400e3).toISOString();
      await db('invites',{body:{token_hash:sha256(token),org:org.slug,role:b.role,created_by:me.name,expires_at}});
      const host=String(req.headers['x-forwarded-host']||req.headers.host||'');
      return reply(200,{link:`https://${host}/invite?t=${token}`,role:b.role,expires_at,note:'Send this link to the person. It works once, for 7 days.'});
    }
    if(a==='revoke_invite'){
      if(!/^[0-9a-f]{64}$/.test(String(b.id||'')))return reply(422,{error:'id is required'});
      await db(`invites?${q}&token_hash=eq.${b.id}`,{method:'PATCH',body:{revoked_at:new Date().toISOString()}});
      return reply(200,{ok:true});
    }
    if(a==='set_role'||a==='remove_member'){
      const username=text(b.username,60);if(!username)return reply(422,{error:'username is required'});
      const path=`org_members?${q}&username=eq.${encodeURIComponent(username)}`;
      if(a==='set_role'){
        if(!ROLES.includes(b.role))return reply(422,{error:'role must be '+ROLES.join(', ')});
        const r=await db(path,{method:'PATCH',body:{role:b.role}});
        return r.length?reply(200,{ok:true}):reply(404,{error:username+' is not a member of '+org.name});
      }
      const r=await db(path,{method:'DELETE'});
      return r.length?reply(200,{ok:true}):reply(404,{error:username+' is not a member of '+org.name});
    }
    reply(422,{error:'Unknown action'});
  }catch(e){reply(e.status||502,{error:e.message});}
};
