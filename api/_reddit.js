// Read-only observation. An inaccessible response is unknown, not proof of removal.
const {request}=require('./_db.js');
const UA='geonode-reddit-agent/2.0 (+https://geonode.com; attributed participation)';
function redditUrl(value){
  const u=new URL(value);
  if(u.protocol!=='https:'||!['reddit.com','www.reddit.com','old.reddit.com'].includes(u.hostname)||u.username||u.password||u.port)throw Error('Expected an HTTPS Reddit permalink');
  u.hostname='www.reddit.com';u.hash='';u.search='';return u;
}
async function permalink(value){
  let u=redditUrl(value);
  for(let i=0;i<3&&/\/s\//.test(u.pathname);i++){
    const r=await request(u.href,{redirect:'manual',headers:{'User-Agent':UA}});
    const next=r.headers.get('location');if(!next)break;u=redditUrl(new URL(next,u).href);
  }
  return u.href.replace(/\/?$/,'/');
}
function identity(value){
  const u=redditUrl(value),m=u.pathname.match(/^\/r\/([a-z0-9_]+)\/comments\/([a-z0-9]+)(?:\/[^/]+)?(?:\/([a-z0-9]+))?\/?$/i);
  if(!m)throw Error('Expected a canonical Reddit thread or comment permalink');
  return {subreddit:m[1],thread_id:m[2].toLowerCase(),comment_id:m[3]?.toLowerCase()||null,url:u.href};
}
function flatten(children,out=[],seen=new Set()){
  for(const node of children||[]){
    if(node.kind!=='t1'||!node.data||seen.has(node.data.id))continue;
    const d=node.data;seen.add(d.id);
    out.push({id:d.id,fullname:d.name||`t1_${d.id}`,parent_id:d.parent_id||null,thread_id:String(d.link_id||'').replace(/^t3_/,''),
      author:d.author||null,body:d.body||'',score:d.score??null,created_utc:d.created_utc??null,edited:d.edited||false,
      permalink:d.permalink?'https://www.reddit.com'+d.permalink:null,depth:null,
      visibility:d.body==='[deleted]'?'deleted':d.body==='[removed]'?'removed':'visible'});
    flatten(d.replies?.data?.children,out,seen);
  }
  const byId=new Map(out.map(m=>[m.fullname,m]));
  for(let i=0;i<out.length+1;i++)for(const m of out){
    if(m.parent_id?.startsWith('t3_'))m.depth=0;
    else if(byId.get(m.parent_id)?.depth!=null)m.depth=byId.get(m.parent_id).depth+1;
  }
  return out;
}
async function conversation(value){
  let url,id;
  try{
    url=await permalink(value);id=identity(url);
    const r=await request(url.replace(/\/$/,'')+'.json?raw_json=1&limit=100&depth=10&context=8',{headers:{'User-Agent':UA},redirect:'error'});
    if(!r.ok)return {ok:false,visibility:'unknown',reason:`Reddit returned ${r.status}`,retryable:[429,500,502,503,504].includes(r.status),url};
    const data=await r.json(),post=(data[0]?.data?.children||[]).find(x=>x.kind==='t3'&&x.data?.id===id.thread_id)?.data;
    if(!post)return {ok:false,visibility:'unknown',reason:'The requested thread was not present in the response',url};
    const thread={id:post.id,url:`https://www.reddit.com/r/${post.subreddit||id.subreddit}/comments/${post.id}/_/`,
      title:post.title||'',body:post.selftext||'',subreddit:post.subreddit||id.subreddit,locked:post.locked===true,archived:post.archived===true,
      removed:post.removed_by_category!=null||post.selftext==='[removed]'||post.selftext==='[deleted]',author:post.author||null};
    const comments=flatten(data[1]?.data?.children),target=id.comment_id?comments.find(c=>c.id===id.comment_id):null;
    if(id.comment_id&&!target)return {ok:false,visibility:'unknown',reason:'Requested parent was not in the returned comment tree',thread,comments,url};
    if(target&&target.thread_id&&target.thread_id!==thread.id)return {ok:false,visibility:'unknown',reason:'Comment belongs to a different thread',url};
    return {ok:true,url,thread,comments,target,visibility:target?target.visibility:thread.removed?'removed':'visible',observed_at:new Date().toISOString(),partial:true};
  }catch(e){return {ok:false,visibility:'unknown',reason:String(e.message).slice(0,200),url:url||String(value)};}
}
async function repliesTo(value,ourUsernames){
  const c=await conversation(value);
  if(!c.ok)return c;
  if(c.visibility!=='visible'||c.thread.removed)return {...c,ok:false,gone:true,reason:'The watched parent is removed or deleted'};
  if(c.thread.locked||c.thread.archived)return {...c,ok:false,gone:true,reason:'The thread is locked or archived'};
  const parent=c.target?.fullname||`t3_${c.thread.id}`;
  const replies=c.comments.filter(m=>m.parent_id===parent&&m.visibility==='visible'&&m.author&&!['[deleted]','automoderator'].includes(m.author.toLowerCase())&&!ourUsernames.has(m.author.toLowerCase()));
  return {...c,comment:c.target||{body:c.thread.body,score:null},replies};
}
module.exports={UA,permalink,identity,conversation,repliesTo,flatten};
