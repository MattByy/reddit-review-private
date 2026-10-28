// Writes Queue 2 messages with OpenRouter. Each item type has its own prompt; the prompts are
// stored in settings, shown and edited on the dashboard, and the exact filled-in prompt is saved
// with every draft. There is no hidden system prompt: what you see is what the model receives.
const {checkDisclosure}=require('./send-queue2.cjs');
const {randomBytes}=require('node:crypto');

const DEFAULT_MODEL='anthropic/claude-sonnet-5.5';
const VARIABLES={
  thread:['subreddit','title','body','url'],
  comment:['subreddit','title','body','url','our_comment','our_comment_url'],
  mention:['subreddit','title','body','url','their_comment','brand'],
};
const DEFAULT_PROMPTS={
  thread:`You are writing a Reddit comment on behalf of Geonode, a company that sells proxies and web-scraping infrastructure. It will be posted publicly in r/{{subreddit}}.

Thread title: {{title}}
Thread text:
{{body}}

Write one comment that:
- Directly helps with what the thread asks or discusses. Be specific and practical.
- Is 2 to 5 sentences of plain, conversational English. No headings, lists, emojis or links.
- States the affiliation in the comment itself, for example "(I work at Geonode)" or "Disclosure: I work for Geonode".
- Mentions Geonode's product only if it is genuinely relevant, and never claims it is the best or only option.
- Does not invent personal experiences, customers, numbers or results.
- Does not pose as an independent user and does not attack competitors.
- Stays on topic and respects the subreddit's rules.

If you cannot write something genuinely useful, reply with exactly: SKIP

Output only the comment text.`,
  comment:`You are writing a short follow-up for Geonode, a company that sells proxies and web-scraping infrastructure. It replies under a comment Geonode already posted in r/{{subreddit}}.

Thread title: {{title}}
Thread text:
{{body}}

Geonode's earlier comment:
{{our_comment}}

Write one reply to that earlier comment that:
- Adds one useful clarification, detail or answer the earlier comment left open. Do not repeat it.
- Reads as the same author following up (for example "One more thing:"), never as a different person agreeing with it.
- Is 1 to 3 sentences of plain, conversational English. No links or emojis.
- States the affiliation, for example "(I work at Geonode)".
- Does not invent personal experiences, customers, numbers or results.

If there is nothing useful to add, reply with exactly: SKIP

Output only the reply text.`,
  mention:`You are writing a Reddit reply on behalf of Geonode, a company that sells proxies and web-scraping infrastructure. It answers someone's comment in r/{{subreddit}} that mentions {{brand}}.

Thread title: {{title}}

Their comment:
{{their_comment}}

Write one reply that:
- Responds helpfully to their actual point or question.
- Is 1 to 4 sentences of plain, conversational English. No links or emojis.
- States the affiliation, for example "(I work at Geonode)".
- Is fair to {{brand}}: no attacks, no unverifiable comparisons.
- Does not invent personal experiences, customers, numbers or results.

If there is nothing useful to add, reply with exactly: SKIP

Output only the reply text.`,
};
const fail=(status,message)=>{throw Object.assign(Error(message),{status});};

// Prompt variants. Each type (thread, comment, mention) has 1-10 prompts with a weight in percent;
// the weights of a type add up to 100. A prompt at 0% is paused. Stored under kv 'prompt_variants'.
const TYPES=Object.keys(DEFAULT_PROMPTS);
const defaultVariant=type=>({id:'v_default_'+type,name:'Default',text:DEFAULT_PROMPTS[type],weight:100});
function variants(store){
  const saved=store.kv('prompt_variants')||{},old=store.kv('prompts')||{};
  return Object.fromEntries(TYPES.map(t=>[t,saved[t]?.length?saved[t]:[{...defaultVariant(t),...(old[t]?{text:old[t]}:{})}]]));
}
function saveVariants(store,type,list){
  if(!TYPES.includes(type))fail(422,'type must be thread, comment or mention');
  if(!Array.isArray(list)||!list.length)fail(422,'Give at least one prompt');
  if(list.length>10)fail(422,'At most 10 prompts per type');
  const ids=new Set();
  const clean=list.map((v,i)=>{
    const name=String(v?.name??'').trim()||'Prompt '+(i+1);
    if(name.length>60)fail(422,`Prompt ${i+1}: name is longer than 60 characters`);
    if(typeof v?.text!=='string'||!v.text.trim())fail(422,`Prompt "${name}": text is required`);
    if(v.text.length>12000)fail(422,`Prompt "${name}": text is longer than 12000 characters`);
    const weight=Number(v.weight);
    if(!Number.isInteger(weight)||weight<0||weight>100)fail(422,`Prompt "${name}": percentage must be a whole number from 0 to 100`);
    let id=typeof v.id==='string'&&/^v_[\w-]{1,40}$/.test(v.id)?v.id:'v_'+randomBytes(5).toString('hex');
    if(ids.has(id))id='v_'+randomBytes(5).toString('hex');
    ids.add(id);return {id,name,text:v.text,weight};
  });
  const total=clean.reduce((a,v)=>a+v.weight,0);
  if(total!==100)fail(422,`The ${type} prompt percentages add up to ${total}%; they must add up to 100%`);
  store.setKv('prompt_variants',{...variants(store),[type]:clean});
  return clean;
}
// Exact split, not a dice roll: the next draft goes to the prompt furthest below its share of all
// drafts of this type so far (60/40 over 10 drafts gives exactly 6 and 4). A redraft keeps the
// prompt it was given, so rewrites do not skew the split.
function chooseVariant(store,entry){
  const list=variants(store)[entry.kind]||variants(store).thread;
  const kept=entry.prompt_variant_id&&list.find(v=>v.id===entry.prompt_variant_id);
  if(kept)return kept;
  const active=list.filter(v=>v.weight>0),counts=store.variantCounts(entry.kind);
  const total=active.reduce((a,v)=>a+(counts[v.id]||0),0)+1;
  let best=null,gap=-Infinity;
  for(const v of active){const g=v.weight/100*total-(counts[v.id]||0);if(g>gap+1e-9){gap=g;best=v;}}
  return best;
}

const clip=(s,n)=>{s=String(s??'').trim();return s.length>n?s.slice(0,n)+'…':s;};
// Values for {{variables}} from the queue item captured when it moved to Queue 2.
function variables(entry){
  const it=entry.item||{},t=it.thread||{};
  const v={subreddit:t.subreddit||it.comment?.subreddit||'',title:t.title||entry.title||'',body:clip(t.body,4000)||'(no text)',url:entry.url||''};
  if(entry.kind==='comment')Object.assign(v,{our_comment:clip(it.comment?.content,3000),our_comment_url:it.comment?.reddit_url||entry.url||''});
  if(entry.kind==='mention')Object.assign(v,{their_comment:clip(it.mention?.body,3000),brand:it.mention?.brand||''});
  return v;
}
const render=(template,vars)=>template.replace(/\{\{(\w+)\}\}/g,(m,k)=>k in vars?String(vars[k]):m);

// Drafts (or redrafts) one Queue 2 entry. Never sends anything.
async function writeQueue2(store,id,{apiKey=process.env.OPENROUTER_API_KEY,model=process.env.OPENROUTER_MODEL||DEFAULT_MODEL,fetchImpl=fetch}={}){
  const entry=store.queue2(id);
  if(!entry)fail(404,'No such queue 2 entry');
  if(entry.send_status&&entry.send_status!=='ready')fail(409,'Already '+entry.send_status+'; it can no longer be rewritten');
  if(!apiKey)fail(503,'OPENROUTER_API_KEY is not set (add it to .env.local)');
  const variant=chooseVariant(store,entry),prompt=render(variant.text,variables(entry)),pv={prompt_variant_id:variant.id,prompt_variant_name:variant.name};
  let text;
  try{
    const r=await fetchImpl('https://openrouter.ai/api/v1/chat/completions',{method:'POST',
      headers:{Authorization:'Bearer '+apiKey,'Content-Type':'application/json','X-Title':'Geonode thread collector'},
      body:JSON.stringify({model,messages:[{role:'user',content:prompt}],max_tokens:1500,temperature:0.7}),signal:AbortSignal.timeout(90000)});
    const j=await r.json().catch(()=>null);
    if(!r.ok)throw Error(j?.error?.message||'OpenRouter '+r.status);
    text=String(j?.choices?.[0]?.message?.content||'').trim();
    if(!text)throw Error('OpenRouter returned an empty message');
    // A message cut off at the token limit is kept for reading but can never be approved.
    if(j.choices[0].finish_reason==='length'){
      store.setQueue2Draft(id,{...pv,message:text,prompt_used:prompt,model,write_status:'truncated',write_error:'The model hit the length limit and the message is cut off. Rewrite or edit it.'});
      return store.queue2(id);
    }
  }catch(e){
    store.setQueue2Draft(id,{write_status:'failed',write_error:String(e.message).slice(0,500),prompt_used:prompt,model});
    fail(502,'Writing failed: '+e.message);
  }
  const skipped=/^skip\.?$/i.test(text);
  store.setQueue2Draft(id,{...pv,message:skipped?'SKIP: the model found nothing useful to add.':text,prompt_used:prompt,model,write_status:skipped?'skipped':'written'});
  return store.queue2(id);
}

module.exports={DEFAULT_PROMPTS,DEFAULT_MODEL,VARIABLES,TYPES,variants,saveVariants,chooseVariant,variables,render,writeQueue2,checkDisclosure};
