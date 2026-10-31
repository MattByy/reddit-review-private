// Organizations on this computer. Geonode is the default engine (.data/dev.db, ENGAIN_API_KEY from
// .env.local). Every organization added from the hosted page gets its own engine (createApp) with its
// own folder (.data/orgs/<slug>/: database and logs), Engain key, jobs, queues and prompts. The registry, with the
// Engain keys, is .data/orgs.json (mode 600); the keys never go to Supabase.
// Local requests go to Geonode, or to another organization under /o/<slug>/... .
const fs=require('node:fs');
const path=require('node:path');
const writer=require('./writer.cjs');
const {client}=require('./engain.cjs');
const fail=(status,msg)=>{throw Object.assign(Error(msg),{status});};

const GEONODE={slug:'geonode',name:'Geonode',about:'proxies and web-scraping infrastructure'};
// "Zenshield" matches the Engain project "zenshield.com" (letters in order, anything between).
const namedLike=name=>new RegExp(String(name).replace(/[^a-z0-9]/gi,'').split('').join('[^a-z0-9]*'),'i');
const slugify=s=>String(s??'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'').slice(0,40);
const words=v=>(Array.isArray(v)?v:String(v??'').split(',')).map(w=>String(w).trim()).filter(Boolean).slice(0,40);
// A new organization starts with Geonode's prompts (and their models), its own name and product swapped in.
const adapt=(text,o)=>String(text).replace(/proxies and web-scraping infrastructure/g,o.about||'its products').replace(/Geonode/g,o.name).replace(/geonode/g,o.name.toLowerCase());

// createApp: server/dev.cjs. checkKey(apiKey) returns Engain's projects or throws (tests pass a fake).
// sharedKey: Geonode's Engain key (ENGAIN_API_KEY), which an organization may use when it is another
// project of the same Engain account.
function organizations({createApp,dir,mock=false,restart=null,supabase={},log=console.log,checkKey,engines:start=true,sharedKey=process.env.ENGAIN_API_KEY}){
  const file=path.join(dir,'orgs.json');
  const read=()=>{try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch{return {orgs:[]};}};
  const write=reg=>{fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(file+'.tmp',JSON.stringify(reg,null,2)+'\n',{mode:0o600});fs.renameSync(file+'.tmp',file);};
  checkKey=checkKey||(async apiKey=>(await client({apiKey,log}).me()).projects||[]);
  const engines=new Map();let scheduling=false;
  const profile=o=>({slug:o.slug,name:o.name,about:o.about||'',brand_terms:o.brand_terms||[],topic_terms:o.topic_terms||[]});
  const startEngine=o=>{
    const app=createApp({mock,restart,supabase,org:profile(o),apiKey:o.engain_key||sharedKey,projectId:o.project_id||null,
      dbFile:path.join(dir,mock?'orgs-mock':'orgs',o.slug,'dev.db'),log:m=>log(`[${o.slug}] ${m}`)});
    engines.set(o.slug,app);if(scheduling)app.startScheduler();return app;
  };
  const list=()=>[{...GEONODE,brand_terms:'Geonode',topic_terms:'(built in: proxies, scraping, ...)',ready:true},...read().orgs.map(o=>({slug:o.slug,name:o.name,about:o.about||null,
    brand_terms:(o.brand_terms||[]).join(', '),topic_terms:(o.topic_terms||[]).join(', '),ready:engines.has(o.slug),created_at:o.created_at,created_by:o.created_by||null}))];

  const host={
    list,
    // {name, engain_key?, about?, brand_terms?, topic_terms?}: checks the key with Engain first. Without a key
    // it uses Geonode's (another project of the same Engain account); the registry then keeps no key, so
    // it follows ENGAIN_API_KEY.
    async 'org.create'(p,by){
      const name=String(p.name??'').trim();if(name.length<2||name.length>60)fail(422,'Name must be 2 to 60 characters');
      const slug=slugify(p.slug||name),reg=read();
      if(!slug||slug==='geonode'||reg.orgs.some(o=>o.slug===slug))fail(409,`There is already an organization called "${slug}"`);
      const own_key=String(p.engain_key??'').trim(),key=own_key||sharedKey||'';
      if(own_key&&own_key.length<10)fail(422,'That Engain key is too short');
      if(!key)fail(422,'Give the organization\'s Engain API key (Geonode\'s is not set on this computer)');
      let projects;try{projects=await checkKey(key);}catch(e){fail(422,'The Engain key did not work: '+e.message);}
      if(!projects?.length)fail(422,'This Engain key has no projects');
      const own=namedLike(name);
      // The project named like the organization; with Geonode's key there must be one (never Geonode's own).
      const project=projects.find(x=>own.test(x.name||''))||(own_key?projects[0]:null);
      if(!project)fail(422,`Geonode's Engain key has no project named like ${name} (it has: ${projects.map(x=>x.name||x.id).join(', ')}). Give that organization's own key.`);
      const o={slug,name,about:String(p.about??'').trim().slice(0,200),engain_key:own_key||null,project_id:project.id,project_name:project.name||null,
        brand_terms:words(p.brand_terms).length?words(p.brand_terms):[name],topic_terms:words(p.topic_terms),created_at:new Date().toISOString(),created_by:by||null};
      write({...reg,orgs:[...reg.orgs,o]});
      const app=startEngine(o),geo=engines.get('geonode');
      const prompts=geo?writer.variants(geo.store):null;
      if(prompts)app.store.setKv('prompt_variants',Object.fromEntries(Object.entries(prompts).map(([t,l])=>[t,l.map(v=>({...v,text:adapt(v.text,o)}))])));
      app.store.event('org.created',`Organization ${name} added by ${by||'?'} (Engain project ${project.name||project.id})`,{slug,name,project_id:project.id,by});
      log(`organization ${slug} added (Engain project ${project.name||project.id})`);
      app.syncMirror?.().catch(()=>{});
      return {slug,name,project:project.name||project.id,key:own_key?'its own':'Geonode\'s',projects:projects.map(x=>x.name||x.id)};
    },
    // {slug, name?, about?, engain_key?, brand_terms?, topic_terms?}. A new key restarts that engine.
    async 'org.update'(p,by){
      const reg=read(),o=reg.orgs.find(x=>x.slug===p.slug);if(!o)fail(404,'No such organization: '+p.slug);
      const next={...o};
      if(p.name!=null){const n=String(p.name).trim();if(n.length<2||n.length>60)fail(422,'Name must be 2 to 60 characters');next.name=n;}
      if(p.about!=null)next.about=String(p.about).trim().slice(0,200);
      if(p.brand_terms!=null)next.brand_terms=words(p.brand_terms).length?words(p.brand_terms):[next.name];
      if(p.topic_terms!=null)next.topic_terms=words(p.topic_terms);
      const key=p.engain_key!=null?String(p.engain_key).trim():null;
      if(key){let projects;try{projects=await checkKey(key);}catch(e){fail(422,'The Engain key did not work: '+e.message);}
        if(!projects?.length)fail(422,'This Engain key has no projects');
        const pr=projects.find(x=>namedLike(next.name).test(x.name||''))||projects[0];
        next.engain_key=key;next.project_id=pr.id;next.project_name=pr.name||null;}
      write({...reg,orgs:reg.orgs.map(x=>x.slug===o.slug?next:x)});
      const app=engines.get(o.slug);
      if(key&&app){app.close();startEngine(next);}else app?.store.setKv('org',profile(next));
      engines.get(o.slug)?.store.event('org.updated',`Organization ${next.name} changed by ${by||'?'}${key?' (new Engain key)':''}`,{slug:o.slug,by,new_key:!!key});
      return {slug:o.slug,name:next.name,new_key:!!key};
    },
  };

  if(start){
    engines.set('geonode',createApp({mock,restart,supabase,log,host,org:GEONODE}));
    for(const o of read().orgs){try{startEngine(o);}catch(e){log(`organization ${o.slug} could not start: ${e.message}`);}}
  }
  async function handle(req,res){
    const m=/^\/o\/([a-z0-9-]+)(\/.*)?$/.exec(String(req.url).split('?')[0]);
    if(m){
      const app=engines.get(m[1]);
      if(!app){res.writeHead(404,{'Content-Type':'application/json'});return res.end(JSON.stringify({error:'No such organization: '+m[1]}));}
      req.url=(m[2]||'/')+(String(req.url).includes('?')?'?'+String(req.url).split('?').slice(1).join('?'):'');
      return app.handle(req,res);
    }
    return engines.get('geonode').handle(req,res);
  }
  return {engines,host,list,handle,
    startScheduler(){scheduling=true;for(const a of engines.values())a.startScheduler();},
    close(){for(const a of engines.values())a.close();}};
}

module.exports={organizations,slugify,adapt};
