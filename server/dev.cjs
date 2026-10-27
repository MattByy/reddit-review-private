#!/usr/bin/env node
// Local dev server: collects and ranks Reddit threads from Engain. Run with `npm run dev`
// (real Engain, needs ENGAIN_API_KEY in .env.local) or `npm run dev:mock` (invented data).
const fs=require('node:fs');
const path=require('node:path');
const http=require('node:http');
const root=path.resolve(__dirname,'..');
for(const f of ['.env.local','.env'])if(fs.existsSync(path.join(root,f)))process.loadEnvFile(path.join(root,f));

const {client}=require('./engain.cjs');
const {open}=require('./store.cjs');
const {collect,ranked,SOURCES}=require('./collect.cjs');

function createApp({mock=false,dbFile,apiKey=process.env.ENGAIN_API_KEY,projectId=process.env.ENGAIN_PROJECT_ID,log=console.log}={}){
  const store=open(dbFile||path.join(root,'.data',mock?'dev-mock.db':'dev.db'));
  const engain=client(mock?{apiKey:'mock',fetchImpl:require('./mock.cjs').mockFetch,limits:false,log}:{apiKey,log});
  const live=new Map();let active=null;

  async function project(){
    if(projectId)return projectId;
    const me=await engain.me();
    if(!me.projects?.length)throw Object.assign(Error('This Engain key has no projects'),{status:409});
    return projectId=me.projects[0].id;
  }
  async function startCollect(input){
    if(active)throw Object.assign(Error('A collection run is already in progress (run '+active+')'),{status:409});
    const pid=await project(),id=store.startRun(input);active=id;live.set(id,{step:'starting'});
    collect(input,{engain,store,projectId:pid,onProgress:p=>live.set(id,p)})
      .then(s=>store.finishRun(id,s),e=>store.finishRun(id,{errors:[e.message]}))
      .finally(()=>{active=null;live.delete(id);log(`collection run ${id} finished`);});
    return {run_id:id};
  }

  const routes={
    'GET /api/status':async()=>({mock,engain_key:mock||!!apiKey,project_id:projectId||null,sources:SOURCES,active_run:active,threads:store.threads().length}),
    'GET /api/projects':async()=>engain.me(),
    'GET /api/balance':async()=>engain.balance(),
    'GET /api/smart-search/history':async()=>engain.smartSearchHistory({projectId:await project(),limit:50}),
    'POST /api/collect':async(_,body)=>startCollect(body||{}),
    'GET /api/runs/:id':async(_,__,id)=>{const r=store.run(id);if(!r)throw Object.assign(Error('No such run'),{status:404});return {...r,progress:live.get(r.id)||null};},
    'GET /api/threads':async q=>ranked(store,q),
    'GET /api/threads/:id':async(_,__,id)=>{const r=ranked(store,{limit:500}).items.find(t=>t.thread_id===id)||null;if(!r)throw Object.assign(Error('Thread not collected'),{status:404});return {...r,body:store.thread(id).body};},
    'GET /api/subreddits':async()=>store.subreddits(),
  };

  async function handle(req,res){
    const u=new URL(req.url,'http://localhost');
    const send=(status,value,type='application/json; charset=utf-8')=>{res.writeHead(status,{'Content-Type':type,'Cache-Control':'no-store'});res.end(type.startsWith('application/json')?JSON.stringify(value,null,1):value);};
    try{
      if(req.method==='GET'&&(u.pathname==='/'||u.pathname==='/index.html'))return send(200,fs.readFileSync(path.join(__dirname,'public/index.html')),'text/html; charset=utf-8');
      const parts=u.pathname.split('/');let route=routes[req.method+' '+u.pathname],param;
      if(!route&&parts.length===4){route=routes[req.method+' '+parts.slice(0,3).join('/')+'/:id'];param=decodeURIComponent(parts[3]);}
      if(!route)return send(404,{error:'Not found'});
      let body=null;
      if(req.method==='POST'){let raw='';for await(const c of req){raw+=c;if(raw.length>1e5)return send(413,{error:'Body too large'});}try{body=raw?JSON.parse(raw):{};}catch{return send(400,{error:'Invalid JSON'});}}
      send(200,await route(Object.fromEntries(u.searchParams),body,param));
    }catch(e){send(e.status&&e.status<600?e.status:500,{error:e.message,engain:e.body});}
  }
  return {handle,store,engain,close:()=>store.close()};
}

if(require.main===module){
  const mock=process.argv.includes('--mock')||process.env.ENGAIN_MOCK==='1';
  const app=createApp({mock}),port=Number(process.env.PORT||3000);
  http.createServer(app.handle).listen(port,'127.0.0.1',()=>{
    console.log(`Thread collector running at http://127.0.0.1:${port}  (${mock?'MOCK Engain data':'live Engain API'})`);
    if(!mock&&!process.env.ENGAIN_API_KEY)console.log('  ENGAIN_API_KEY is missing: add it to .env.local, or use npm run dev:mock');
  });
}

module.exports={createApp};
