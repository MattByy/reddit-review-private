(async()=>{
  if(window.adminReady&&!await window.adminReady)return;
  const $=id=>document.getElementById(id),requests=new Map();let offset=0,next=null;
  const labels={min_age_hours:'Minimum age (hours)',max_age_days:'Maximum age (days)',min_comments:'Minimum comments',min_score:'Minimum score',min_relevance:'Provider relevance (0–1)',provider_fresh_hours:'Provider freshness (hours)',reddit_fresh_minutes:'Context freshness (minutes)'};
  const message=text=>{$('library-status').textContent=text;};
  const post=body=>window.operatorCall('/api/library',body);
  async function load(){
    try{
      const q=new URLSearchParams({offset,limit:50,q:$('library-search').value,kind:$('library-kind').value,scope:$('library-scope').value});
      const response=await fetch('/api/library?'+q,{credentials:'same-origin',cache:'no-store'}),data=await response.json();if(!response.ok)throw Error(data.error||'Library unavailable');
      next=data.next_offset;$('library-previous').disabled=offset===0;$('library-next').disabled=next==null;$('library-page').textContent='Page '+(offset/50+1)+' · '+data.items.length+' threads';
      const state=data.collector?.value;
      $('collector-state').textContent=(state?.last_collected_at?'Last collection: '+new Date(state.last_collected_at).toLocaleString():'No collection has completed yet')+(state?.last_error?' · '+state.last_error:' · Scheduled hourly');
      $('library-settings').innerHTML=Object.entries(labels).map(([key,label])=>`<label>${label}<input class="field" type="number" step="${key==='min_relevance'?'0.05':'1'}" name="${key}" value="${esc(data.settings[key])}" required></label>`).join('')+'<button class="btn" type="submit">Save settings</button>';
      $('library-items').innerHTML=data.items.map(r=>`<article class="card library-card" data-thread="${esc(r.thread_id)}"><h2><a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.title||r.thread_id)}</a></h2><p class="small muted">r/${esc(r.subreddit)} · ${esc(r.kind.replaceAll('_',' '))} · ${r.selection.age_hours==null?'Age unknown':Math.floor(r.selection.age_hours/24)+' days old'} · ${r.selection.num_comments??'Unknown'} comments · score ${r.selection.score??'unknown'} · relevance ${r.relevance??'unknown'}</p><b>${esc(r.selection.status.replaceAll('_',' '))}</b><p class="small">${esc(r.selection.reasons.join(' · ')||'Current basic filters passed. Assess whether a useful, permitted contribution remains.')}</p><p class="small muted">Provider collected: ${esc(new Date(r.last_collected_at).toLocaleString())} · Context checked: ${r.reddit_checked_at?esc(new Date(r.reddit_checked_at).toLocaleString()):'not yet'}</p><div class="library-actions"><button class="btn small" data-refresh="${esc(r.thread_id)}">Refresh from Engain</button><button class="btn small" data-queue="work" ${r.selection.eligible?'':'disabled'}>Queue first message</button></div></article>`).join('')||'<div class="card">No threads on this page. Sync Engain or change the search.</div>';
      $('library-items').querySelectorAll('[data-refresh]').forEach(b=>b.addEventListener('click',()=>run(b,async()=>{const row=await post({action:'refresh',thread_id:b.dataset.refresh});message(row.selection.eligible?'Current thread passes the basic filters.':row.selection.reasons.join('; '));await load();})));
      $('library-items').querySelectorAll('[data-queue]').forEach(b=>b.addEventListener('click',()=>run(b,async()=>{
        const id=b.closest('[data-thread]').dataset.thread,lane=b.dataset.queue,key=id+':'+lane;
        if(!requests.has(key))requests.set(key,crypto.randomUUID());
        const e=await post({action:'queue',thread_id:id,queue_lane:lane,request_id:requests.get(key),strategy:lane==='test'?'direct':null,max_messages:lane==='test'?1:6,max_depth:lane==='test'?1:4});
        message('Queued thread '+e.id+'. The first message is ready for the writer.');await load();
      })));
    }catch(e){message(e.message);}
  }
  async function run(button,fn){button.disabled=true;try{await fn();}catch(e){message(e.message);}finally{button.disabled=false;}}
  $('collect-library').addEventListener('click',ev=>run(ev.currentTarget,async()=>{message('Collecting both Engain feeds…');const r=await post({action:'collect'});message(r.deferred||'Collected '+r.feeds.reduce((n,f)=>n+f.imported,0)+' feed entries. No writing jobs created.');await load();}));
  $('search-library').addEventListener('click',()=>{offset=0;load();});$('library-search').addEventListener('keydown',ev=>{if(ev.key==='Enter'){offset=0;load();}});
  $('library-scope').addEventListener('change',()=>{offset=0;load();});
  $('library-next').addEventListener('click',()=>{if(next!=null){offset=next;load();}});$('library-previous').addEventListener('click',()=>{offset=Math.max(0,offset-50);load();});
  $('library-settings').addEventListener('submit',ev=>{ev.preventDefault();run(ev.submitter,async()=>{await post({action:'settings',settings:Object.fromEntries([...new FormData(ev.target)].map(([k,v])=>[k,Number(v)]))});message('Selection settings saved.');await load();});});
  await load();
})();
