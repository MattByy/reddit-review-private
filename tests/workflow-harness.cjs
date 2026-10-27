// Real workflow SQL and handlers; a small PostgREST transport adapter and invented vendor/Reddit responses.
const fs=require('node:fs');
const path=require('node:path');
const {PGlite}=require(process.env.PGLITE_MODULE||'@electric-sql/pglite');
const root=path.resolve(__dirname,'..');
const ident=x=>{if(!/^[a-z_][a-z0-9_]*$/i.test(x))throw Error('Invalid SQL identifier: '+x);return '"'+x+'"';};
const quote=x=>"'"+String(x).replace(/'/g,"''")+"'";
const json=value=>new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json'}});
function field(key){const [a,b]=key.split('->>');return ident(a)+(b?'->>'+quote(b):'');}
function split(value){let depth=0,start=0,parts=[];for(let i=0;i<value.length;i++){if(value[i]==='(')depth++;if(value[i]===')')depth--;if(value[i]===','&&!depth){parts.push(value.slice(start,i));start=i+1;}}return [...parts,value.slice(start)];}
function condition(key,value){
  if(key==='or'||key==='and')return '('+split(value.slice(1,-1)).map(x=>{
    const nested=x.match(/^(or|and)(\(.*\))$/);if(nested)return condition(nested[1],nested[2]);
    const p=x.indexOf('.');return condition(x.slice(0,p),x.slice(p+1));
  }).join(' '+key+' ')+')';
  if(value.startsWith('not.'))return 'NOT ('+condition(key,value.slice(4))+')';
  const dot=value.indexOf('.'),op=value.slice(0,dot),val=value.slice(dot+1),f=field(key);
  if(op==='is')return f+' IS '+(val==='null'?'NULL':val==='true'?'TRUE':'FALSE');
  if(op==='in')return f+' IN ('+split(val.slice(1,-1)).map(quote).join(',')+')';
  const sql={eq:'=',neq:'<>',gte:'>=',gt:'>',lte:'<=',lt:'<',like:'LIKE',ilike:'ILIKE'}[op];
  if(op==='ilike')return f+' ILIKE '+quote(val.replaceAll('*','%'));
  if(!sql)throw Error('Unsupported filter '+value);return f+sql+quote(val);
}
class Harness{
  constructor(){this.db=new PGlite();this.vendor=[];this.reddit=new Map();this.vendorMode='normal';this.calls=[];this.project=false;this.ruleStatus=200;}
  async init(options={}){
    await this.db.exec(fs.readFileSync(path.join(__dirname,'fixtures/workflow-baseline.sql'),'utf8'));
    await this.db.exec(fs.readFileSync(path.join(__dirname,'fixtures/review-baseline.sql'),'utf8'));
    await this.db.exec(`create function scenario_context(p_draft_id uuid,p_parent_url text default null) returns jsonb language sql as $$select '{"ready":true,"scenario":false,"self_reply":false}'::jsonb$$;
      create function scenario_ready(p_draft_id uuid) returns boolean language sql as $$select true$$;
      create function is_our_url(p_url text) returns boolean language sql as $$select exists(select 1 from engain_tasks where reddit_url=p_url)$$;`);
    for(const name of ['035-durable-workflow.sql','036-operator-review.sql','037-verified-status.sql','038-account-playbooks.sql','039-automatic-publishing.sql','040-dashboard-sessions.sql','041-message-experiments.sql','042-queued-message-decisions.sql','043-message-decision-context.sql','044-thread-library.sql','045-writer-rotation.sql','046-live-provider-work.sql']){
      if(name==='041-message-experiments.sql'&&options.beforeMessages)await options.beforeMessages(this);
      if(name==='042-queued-message-decisions.sql'&&options.beforeQueueDecisions)await options.beforeQueueDecisions(this);
      if(name==='043-message-decision-context.sql'&&options.beforeDecisionContext)await options.beforeDecisionContext(this);
      if(name==='045-writer-rotation.sql'&&options.beforeWriterRotation)await options.beforeWriterRotation(this);
      await this.db.exec(fs.readFileSync(path.join(root,'supabase/migrations',name),'utf8'));
    }
    await this.db.exec(`grant select on accounts,threads,drafts,engain_tasks,sequence_runs,scenario_runs,scenario_acts to anon;
      insert into accounts(id,label,reddit_username,active,usable,disclosed) values('test-account','Test account','geonode_test',true,true,true);
      insert into queries(id,q,shape,intent) values('q1','proxy debugging','how','technical help');
      update workflow_state set value='{"automatic":false}' where key='publishing';
      update workflow_state set value='{"enabled":false}' where key='message_workflow';`);
    Object.assign(process.env,{MESSAGE_CONTEXT_SOURCE:options.contextSource||'reddit',SUPABASE_URL:'https://db.test',SUPABASE_SERVICE_KEY:'test-service',ENGAIN_API_KEY:'test-vendor',AGENT_API_KEY:'test-agent',OPERATOR_API_KEY:'test-operator',CRON_SECRET:'test-cron'});
    for(const name of Object.keys(require.cache))if(name.startsWith(root+'/api/'))delete require.cache[name];
    this.originalFetch=global.fetch;global.fetch=this.fetch.bind(this);
    this.agent=require('../api/_agent.js');this.sender=require('../api/_send.js');this.monitor=require('../api/_monitor.js');this.workflow=require('../api/_workflow.js');
    this.reader=require('../api/_reddit.js');this.engine=require('../api/_engine.js');this.operator=require('../api/operator.js');this.dispatch=require('../api/dispatch.js');this.session=require('../api/session.js');this.messages=require('../api/_messages.js');this.messagesHandler=require('../api/messages.js');
    return this;
  }
  async close(){global.fetch=this.originalFetch;await this.db.close();}
  async sql(sql,params=[]){return (await this.db.query(sql,params)).rows;}
  async rpc(name,args){
    const [fn]=await this.sql('select proargnames,proargtypes::regtype[]::text[] types,proretset from pg_proc where proname=$1',[name]);
    if(!fn)throw Error('Missing RPC '+name);
    const keys=Object.keys(args),values=keys.map(k=>{const type=fn.types[fn.proargnames.indexOf(k)];return type==='jsonb'?JSON.stringify(args[k]):args[k];});
    const call=ident(name)+'('+keys.map((k,i)=>ident(k)+' => $'+(i+1)+'::'+fn.types[fn.proargnames.indexOf(k)]).join(',')+')';
    const rows=await this.sql('select to_jsonb('+call+') result',values);return fn.proretset?rows.map(r=>r.result):rows[0]?.result;
  }
  async rest(u,options){
    const route=u.pathname.replace('/rest/v1/',''),sp=u.searchParams,method=options.method||'GET',body=options.body?JSON.parse(options.body):null;
    try{
      if(route.startsWith('rpc/'))return json(await this.rpc(route.slice(4),body));
      const table=ident(route),where=[...sp].filter(([k])=>!['select','order','limit','offset','on_conflict'].includes(k)).map(([k,v])=>condition(k,v));
      const filter=where.length?' WHERE '+where.join(' AND '):'';
      let rows;
      if(method==='GET'){
        const cols=(sp.get('select')||'*').split(',').map(k=>k==='*'?'*':field(k)).join(',');
        const order=sp.get('order')?' ORDER BY '+sp.get('order').split(',').map(k=>{const [f,dir,ns]=k.split('.');return field(f)+(dir==='desc'?' DESC':' ASC')+(ns==='nullslast'?' NULLS LAST':ns==='nullsfirst'?' NULLS FIRST':'');}).join(','):'';
        rows=await this.sql('SELECT '+cols+' FROM '+table+filter+order+(sp.has('limit')?' LIMIT '+Number(sp.get('limit')):'')+(sp.has('offset')?' OFFSET '+Number(sp.get('offset')):''));
      }else if(method==='POST'){
        rows=[];
        for(const row of Array.isArray(body)?body:[body]){
          const keys=Object.keys(row),values=keys.map(k=>row[k]&&typeof row[k]==='object'&&!Array.isArray(row[k])?JSON.stringify(row[k]):row[k]);
          let conflict='';
          if(sp.has('on_conflict'))conflict=' ON CONFLICT ('+sp.get('on_conflict').split(',').map(ident).join(',')+') '+(String(options.headers?.Prefer).includes('ignore-duplicates')?'DO NOTHING':'DO UPDATE SET '+keys.map(k=>ident(k)+'=excluded.'+ident(k)).join(','));
          rows.push(...await this.sql('INSERT INTO '+table+'('+keys.map(ident).join(',')+') VALUES('+keys.map((_,i)=>'$'+(i+1)).join(',')+')'+conflict+' RETURNING *',values));
        }
      }else if(method==='PATCH'){
        const keys=Object.keys(body),values=keys.map(k=>body[k]&&typeof body[k]==='object'&&!Array.isArray(body[k])?JSON.stringify(body[k]):body[k]);
        rows=await this.sql('UPDATE '+table+' SET '+keys.map((k,i)=>ident(k)+'=$'+(i+1)).join(',')+filter+' RETURNING *',values);
      }else if(method==='DELETE')rows=await this.sql('DELETE FROM '+table+filter+' RETURNING *');
      else throw Error('Unsupported database method '+method);
      return json(rows);
    }catch(e){return new Response(JSON.stringify({message:e.message,code:e.code}),{status:400});}
  }
  async fetch(url,options={}){
    const u=new URL(url);this.calls.push({url:String(url),method:options.method||'GET',body:options.body?JSON.parse(options.body):undefined});
    if(u.hostname==='db.test')return this.rest(u,options);
    if(u.hostname==='www.reddit.com'){
      const id=this.reader.identity(u.href.replace(/\.json(?=\?|$)/,'')),listing=this.reddit.get(id.thread_id);
      return listing instanceof Response?listing.clone():listing?json(listing):new Response('{}',{status:404});
    }
    if(u.hostname!=='api.engain.io')throw Error('Network forbidden in tests: '+u.hostname);
    if(u.pathname==='/api/v1/me')return json({projects:this.project?[{id:'project-test',name:'geonode.com'}]:[]});
    if(u.pathname==='/api/v1/opportunities')return this.opportunityFeed?this.opportunityFeed(u):json({opportunities:(this.opportunities||[]).filter(r=>r.type===u.searchParams.get('type')),isDone:true});
    if(u.pathname.startsWith('/api/v1/opportunities/')){const r=(this.opportunities||[]).find(r=>r.id===u.pathname.split('/').pop());return new Response(JSON.stringify(r||{}),{status:r?200:404});}
    if(u.pathname==='/api/v1/accounts-beta/accounts')return json({accounts:[{userAccountId:'test-account',profileUsername:'geonode_test',label:'Test account',usable:true}]});
    if(u.pathname==='/api/v1/rule-check')return new Response(JSON.stringify(this.ruleVerdict||{verdict:'pass',removalRisk:20}),{status:this.ruleStatus});
    if(u.pathname.endsWith('/cancel'))return json({status:'cancelled'});
    if(u.pathname.startsWith('/api/v1/tasks/')&&(options.method||'GET')==='GET'){
      const found=this.vendor.find(t=>t._id===u.pathname.split('/').pop());return new Response(JSON.stringify(found||{}),{status:found?200:404});
    }
    const type=u.pathname.endsWith('/posts')?'post':'comment';
    if((options.method||'GET')==='GET')return json({page:this.vendor.filter(v=>u.pathname==='/api/v1/tasks'||v.type===type),isDone:true});
    const payload=JSON.parse(options.body),task={_id:'vendor-'+(this.vendor.length+1),status:u.pathname.startsWith('/api/v1/tasks/')?'in_review':'pending',type,creationDate:new Date().toISOString(),...payload,...(payload.url?{threadUrl:payload.url}:{})};
    if(this.vendorMode==='rate-limit')return new Response(JSON.stringify({error:'Rate limited'}),{status:429});
    if(this.vendorMode==='reject')return new Response(JSON.stringify({error:'Not accepted'}),{status:422});
    this.vendor.push(task);
    if(this.vendorMode==='lost-response')throw Error('Connection lost after provider accepted');
    return json(task);
  }
  async call(handler,url,body,method='POST',token='test-agent',headers={}){
    let value;const responseHeaders={},res={statusCode:200,setHeader(k,v){responseHeaders[k.toLowerCase()]=v;},end(raw){value=JSON.parse(raw);}};
    await handler({url,method,body,headers:{authorization:token?'Bearer '+token:'',...headers}},res);return {status:res.statusCode,body:value,headers:responseHeaders};
  }
  api(path,body,method=body===undefined?'GET':'POST'){return this.call(this.agent,'/api/agent'+path,body,method);}
  async thread(id='abc123',comments=[]){
    const url=`https://www.reddit.com/r/test/comments/${id}/example/`;
    await this.sql('insert into threads(id,url,title,subreddit) values($1,$2,$3,$4) on conflict(id) do nothing',[id,url,'A technical question','test']);
    this.reddit.set(id,[{data:{children:[{kind:'t3',data:{id,title:'A technical question',selftext:'How can I compare output?',subreddit:'test',author:'reader',locked:false,archived:false}}]}},{data:{children:comments}}]);
    return {id,url};
  }
  comment(id,body,parent='t3_abc123',children=[],author='reader'){
    return {kind:'t1',data:{id,name:'t1_'+id,parent_id:parent,link_id:'t3_abc123',author,body,permalink:`/r/test/comments/abc123/example/${id}/`,replies:{data:{children}}}};
  }
  async approve(id){
    await this.call(this.operator,'/api/operator',{draft_id:id,patch:{parent_confirmed_by:'test reviewer'}},'POST','test-operator');
    const result=await this.call(this.operator,'/api/operator',{rpc:'review_draft',args:{p_draft_id:id,p_action:'approve',p_body:null,p_note:'Local test approval'}},'POST','test-operator');
    if(result.status!==200)throw Error('Approval failed: '+JSON.stringify(result));
    await this.sql('update drafts set sequence_hold=false where id=$1',[id]);
  }
  async file(extra={}){
    const result=await this.api('/drafts',{request_id:'file-1',kind:'comment',thread_id:'abc123',account_id:'test-account',body:COPY,...extra});
    if(result.status!==200)throw Error('Filing failed: '+JSON.stringify(result));return result.body.draft;
  }
}
const COPY='Keep the test small and compare the fields your parser actually needs. Save one response before changing the workflow, then check missing fields and retries separately. Redact credentials before sharing any logs. A successful response is useful only if the output fits your application. (Geonode team here)';
module.exports={Harness,COPY};
