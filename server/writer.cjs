// Writes Queue 2 messages with OpenRouter or Featherless. Each item type has its own prompts; they are
// stored in settings, shown and edited on the dashboard, and the exact filled-in prompt is saved
// with every draft. There is no hidden system prompt: what you see is what the model receives.
const {checkDisclosure}=require('./send-queue2.cjs');
const {randomBytes}=require('node:crypto');

const DEFAULT_MODEL='anthropic/claude-sonnet-5.5';
// Both are OpenAI-style chat APIs; only the address, key and model names differ.
const PROVIDERS={
  openrouter:{label:'OpenRouter',url:'https://openrouter.ai/api/v1/chat/completions',key:'OPENROUTER_API_KEY'},
  featherless:{label:'Featherless',url:'https://api.featherless.ai/v1/chat/completions',key:'FEATHERLESS_API_KEY'},
};
const VARIABLES={
  thread:['subreddit','title','body','url','style_examples'],
  comment:['subreddit','title','body','url','our_comment','our_comment_url','style_examples'],
  mention:['subreddit','title','body','url','their_comment','brand','style_examples'],
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
// "Natural" prompts: one person typing in the thread rather than a brand writing a reply. Offered
// on the Prompts tab and in the model test; the defaults above stay as they are.
const NATURAL_PROMPTS={
  thread:`You're replying in a Reddit thread in r/{{subreddit}}. You work at Geonode (proxies and web-scraping infrastructure) and you're writing as yourself: someone who knows this stuff, typing a quick comment.

Thread title: {{title}}
Thread text:
{{body}}

How people in these threads write (for tone only; don't copy their content, names or claims):
{{style_examples}}

Write one comment:
- Answer this thread's specific problem the way you'd answer a friend. Usually 1 to 4 sentences.
- Plain words and contractions. No lists, headings, links, emojis, em-dashes or sign-offs. Don't open with praise or sympathy ("Great question", "Sounds frustrating") and don't summarize the post.
- Say once, plainly, that you work at Geonode (those words, so nobody can miss it), somewhere in the middle or end. Don't start the comment with it, and don't replace it with "we at Geonode".
- Mention Geonode's product only if it really fits, and never as the only option.
- Don't claim anything you haven't been told: no "I had the same issue", no "we've helped clients", no customers, numbers or results.
- Don't pretend to be an independent user and don't knock competitors.

If you have nothing genuinely useful to say, reply with exactly: SKIP

Output only the comment.`,
  comment:`Earlier you left this comment in a Reddit thread in r/{{subreddit}}. You work at Geonode (proxies and web-scraping infrastructure).

Thread title: {{title}}
Thread text:
{{body}}

Your earlier comment:
{{our_comment}}

How people in these threads write (for tone only; don't copy their content, names or claims):
{{style_examples}}

Write a short follow-up under your own comment, as the same person coming back with one more thought:
- Add one useful detail or answer your first comment left open. Don't repeat it. 1 to 3 sentences.
- Plain words and contractions, the way people actually type. Start however you naturally would, not with a stock phrase. No lists, links, emojis, em-dashes or sign-offs.
- Say once, plainly, that you work at Geonode (those words), not "we at Geonode".
- Never write as a different person agreeing with the first comment.
- Don't claim anything you haven't been told: no experiences, customers, numbers or results.

If there's nothing useful to add, reply with exactly: SKIP

Output only the reply.`,
  mention:`Someone in r/{{subreddit}} wrote a comment that mentions {{brand}}. You work at Geonode (proxies and web-scraping infrastructure) and you're replying as yourself.

Thread title: {{title}}

Their comment:
{{their_comment}}

How people in these threads write (for tone only; don't copy their content, names or claims):
{{style_examples}}

Write one reply:
- Respond to their actual point, like a person in the thread. 1 to 3 sentences, plain words, contractions.
- No lists, links, emojis, em-dashes or sign-offs, and no opening praise.
- Say once, plainly, that you work at Geonode (those words), not "we at Geonode".
- Be fair to {{brand}}: no attacks or comparisons you can't back up.
- Don't claim anything you haven't been told: no experiences, customers, numbers or results.

If there's nothing useful to add, reply with exactly: SKIP

Output only the reply.`,
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
    const provider=v.provider||'openrouter';
    if(!PROVIDERS[provider])fail(422,`Prompt "${name}": provider must be openrouter or featherless`);
    const model=String(v.model??'').trim();
    if(model&&(model.length>200||!/^[\w.\-\/:@]+$/.test(model)))fail(422,`Prompt "${name}": "${model.slice(0,60)}" is not a model name`);
    if(provider==='featherless'&&!model)fail(422,`Prompt "${name}": pick a Featherless model`);
    let temperature=v.temperature===''||v.temperature==null?null:Number(v.temperature);
    if(temperature!=null&&!(temperature>=0&&temperature<=2))fail(422,`Prompt "${name}": temperature must be from 0 to 2`);
    let id=typeof v.id==='string'&&/^v_[\w-]{1,40}$/.test(v.id)?v.id:'v_'+randomBytes(5).toString('hex');
    if(ids.has(id))id='v_'+randomBytes(5).toString('hex');
    ids.add(id);
    return {id,name,text:v.text,weight,...(provider!=='openrouter'?{provider}:{}),...(model?{model}:{}),...(temperature!=null?{temperature}:{})};
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
// {{style_examples}} is filled only when a prompt uses it (store given).
function variables(entry,store,template=''){
  const it=entry.item||{},t=it.thread||{};
  const v={subreddit:t.subreddit||it.comment?.subreddit||'',title:t.title||entry.title||'',body:clip(t.body,4000)||'(no text)',url:entry.url||''};
  if(entry.kind==='comment')Object.assign(v,{our_comment:clip(it.comment?.content,3000),our_comment_url:it.comment?.reddit_url||entry.url||''});
  if(entry.kind==='mention')Object.assign(v,{their_comment:clip(it.mention?.body,3000),brand:it.mention?.brand||''});
  if(store&&template.includes('{{style_examples}}'))v.style_examples=styleExamples(store,v.subreddit);
  return v;
}
// Two or three real comments people wrote (the mention comments Engain collects), preferring the
// same subreddit. They show tone only; comments that mention Geonode are left out.
function styleExamples(store,subreddit,n=3){
  const rows=store.db.prepare(`select body from comments where length(body) between 60 and 500 and body not like '%geonode%'
    order by (lower(subreddit)=lower(?)) desc, random() limit ?`).all(subreddit||'',n);
  return rows.length?rows.map(r=>'- "'+String(r.body).replace(/\s+/g,' ').trim()+'"').join('\n'):'(no examples collected yet)';
}
const render=(template,vars)=>template.replace(/\{\{(\w+)\}\}/g,(m,k)=>k in vars?String(vars[k]):m);

// Some models answer in quote marks or with their reasoning in <think> tags; keep just the text.
function cleanText(t){
  t=String(t??'').replace(/<think>[\s\S]*?<\/think>/gi,'').trim();
  const m=t.match(/^"([^"]+)"$/);return m?m[1].trim():t;
}
// One chat call, one user message (no hidden system prompt). keys: {openrouter, featherless}.
async function complete({provider='openrouter',model,prompt,temperature=0.7,maxTokens=1500,keys={},fetchImpl=fetch}){
  const p=PROVIDERS[provider];if(!p)fail(422,'Unknown provider '+provider);
  if(!keys[provider])fail(503,`${p.key} is not set (add it to .env.local)`);
  const body={model,messages:[{role:'user',content:prompt}],max_tokens:maxTokens,temperature};
  // Hybrid thinking models (Qwen3.x) then answer straight away; other models ignore it.
  if(provider==='featherless')body.chat_template_kwargs={enable_thinking:false};
  const started=Date.now();
  for(let attempt=0;;attempt++){
    const r=await fetchImpl(p.url,{method:'POST',headers:{Authorization:'Bearer '+keys[provider],'Content-Type':'application/json',...(provider==='openrouter'?{'X-Title':'Geonode thread collector'}:{})},
      body:JSON.stringify(body),signal:AbortSignal.timeout(120000)});
    const j=await r.json().catch(()=>null);
    // Featherless answers 429 when the plan's concurrency is in use; wait and try again.
    if(r.status===429&&attempt<4){await new Promise(z=>setTimeout(z,(attempt+1)*(fetchImpl===fetch?5000:1)));continue;}
    if(!r.ok)throw Error(j?.error?.message||`${p.label} ${r.status}`);
    const c=j?.choices?.[0],text=cleanText(c?.message?.content);
    // Reasoning models (GLM, MiniMax) think first; a small token limit can end before the answer.
    if(!text)throw Error(p.label+' returned an empty message'+(c?.message?.reasoning||c?.message?.reasoning_content?' (only reasoning; the token limit ran out before the answer)':''));
    return {text,finish_reason:c.finish_reason??null,latency_ms:Date.now()-started,usage:j.usage??null};
  }
}

// Drafts (or redrafts) one Queue 2 entry with its prompt's provider and model. Never sends anything.
async function writeQueue2(store,id,{apiKey=process.env.OPENROUTER_API_KEY,featherlessKey=process.env.FEATHERLESS_API_KEY,model:defaultModel=process.env.OPENROUTER_MODEL||DEFAULT_MODEL,fetchImpl=fetch}={}){
  const entry=store.queue2(id);
  if(!entry)fail(404,'No such queue 2 entry');
  if(entry.send_status&&entry.send_status!=='ready')fail(409,'Already '+entry.send_status+'; it can no longer be rewritten');
  const variant=chooseVariant(store,entry),provider=variant.provider||'openrouter',model=variant.model||defaultModel;
  const keys={openrouter:apiKey,featherless:featherlessKey};
  if(!keys[provider])fail(503,`${PROVIDERS[provider].key} is not set (add it to .env.local)`);
  const prompt=render(variant.text,variables(entry,store,variant.text)),pv={prompt_variant_id:variant.id,prompt_variant_name:variant.name,provider};
  let res;
  // Some Featherless models reason before answering and need room for both.
  try{res=await complete({provider,model,prompt,temperature:variant.temperature??0.7,maxTokens:provider==='featherless'?3000:1500,keys,fetchImpl});}
  catch(e){
    store.setQueue2Draft(id,{write_status:'failed',write_error:String(e.message).slice(0,500),prompt_used:prompt,model,provider});
    fail(502,'Writing failed: '+e.message);
  }
  // A message cut off at the token limit is kept for reading but can never be approved.
  if(res.finish_reason==='length'){
    store.setQueue2Draft(id,{...pv,message:res.text,prompt_used:prompt,model,write_status:'truncated',write_error:'The model hit the length limit and the message is cut off. Rewrite or edit it.'});
    return store.queue2(id);
  }
  const skipped=/^skip\.?$/i.test(res.text);
  store.setQueue2Draft(id,{...pv,message:skipped?'SKIP: the model found nothing useful to add.':res.text,prompt_used:prompt,model,write_status:skipped?'skipped':'written'});
  return store.queue2(id);
}

module.exports={DEFAULT_PROMPTS,NATURAL_PROMPTS,DEFAULT_MODEL,PROVIDERS,VARIABLES,TYPES,variants,saveVariants,chooseVariant,variables,styleExamples,render,cleanText,complete,writeQueue2,checkDisclosure};
