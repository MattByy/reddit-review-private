// Writes Queue 2 messages with OpenRouter. Each item type has its own prompt; the prompts are
// stored in settings, shown and edited on the dashboard, and the exact filled-in prompt is saved
// with every draft. There is no hidden system prompt: what you see is what the model receives.
const {checkDisclosure}=require('./send-queue2.cjs');

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

const prompts=store=>({...DEFAULT_PROMPTS,...(store.kv('prompts')||{})});
function savePrompts(store,input){
  const next={...prompts(store)};
  for(const [k,v] of Object.entries(input||{})){
    if(!DEFAULT_PROMPTS[k])fail(422,'Unknown prompt type: '+k+' (use thread, comment or mention)');
    if(v===null){next[k]=DEFAULT_PROMPTS[k];continue;}
    if(typeof v!=='string'||!v.trim())fail(422,k+' prompt must be non-empty text');
    if(v.length>12000)fail(422,k+' prompt is longer than 12000 characters');
    next[k]=v;
  }
  store.setKv('prompts',next);return next;
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
  const prompt=render(prompts(store)[entry.kind]||DEFAULT_PROMPTS.thread,variables(entry));
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
      store.setQueue2Draft(id,{message:text,prompt_used:prompt,model,write_status:'truncated',write_error:'The model hit the length limit and the message is cut off. Rewrite or edit it.'});
      return store.queue2(id);
    }
  }catch(e){
    store.setQueue2Draft(id,{write_status:'failed',write_error:String(e.message).slice(0,500),prompt_used:prompt,model});
    fail(502,'Writing failed: '+e.message);
  }
  const skipped=/^skip\.?$/i.test(text);
  store.setQueue2Draft(id,{message:skipped?'SKIP: the model found nothing useful to add.':text,prompt_used:prompt,model,write_status:skipped?'skipped':'written'});
  return store.queue2(id);
}

module.exports={DEFAULT_PROMPTS,DEFAULT_MODEL,VARIABLES,prompts,savePrompts,variables,render,writeQueue2,checkDisclosure};
