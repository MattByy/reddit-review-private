(async()=>{
  if(window.adminReady&&!await window.adminReady)return;
  const $=id=>document.getElementById(id);let data,requestId=null,selection=null;
  const statuses={awaiting_draft:'In writing queue',queued:'Queued',held:'Needs attention',submitting:'Submitting',unknown:'Delivery uncertain',submitted:'Waiting on Engain',visible:'Verified visible',removed:'Removed',failed:'Delivery failed',stopped:'Stopped'};
  const providerStatuses={in_review:'Waiting for Engain',in_queue:'Engain is posting',waiting_for_mod_approval:'Waiting for moderator review',waiting_for_parent_comment:'Waiting for parent',published:'Checking Reddit',completed:'Checking Reddit'};
  const tone=s=>['visible','succeeded'].includes(s)?'ok':['removed','failed','blocked'].includes(s)?'bad':['held','unknown'].includes(s)?'warn':'info';
  const percent=(a,b)=>b?(100*a/b).toFixed(1)+'%':'—';
  function tab(name){['queue','results','strategies'].forEach(t=>{$('panel-'+t).hidden=t!==name;$('tab-'+t).setAttribute('aria-selected',String(t===name));});}
  ['queue','results','strategies'].forEach(t=>$('tab-'+t).addEventListener('click',()=>{history.replaceState(null,'','#'+t);tab(t);}));
  tab(['queue','results','strategies'].includes(location.hash.slice(1))?location.hash.slice(1):'queue');
  function threads(){
    const value=$('thread').value,q=$('thread-search').value.toLowerCase(),active=new Set(data.experiments.filter(e=>['active','monitoring'].includes(e.status)).map(e=>e.thread_id));
    $('thread').innerHTML='<option value="">Choose a thread…</option>'+data.threads.filter(t=>!t.locked&&!t.archived&&!active.has(t.id)&&(t.id===value||[t.title,t.subreddit].join(' ').toLowerCase().includes(q))).slice(0,150).map(t=>`<option value="${esc(t.id)}">r/${esc(t.subreddit)} · ${esc(cleanTitle(t.title,t.url))}</option>`).join('');
    $('thread').value=value;
  }
  function draw(){
    const sum=key=>data.stats.reduce((n,s)=>n+Number(s[key]||0),0),finished=sum('finished');
    $('active-count').textContent=data.experiments.filter(e=>['active','monitoring'].includes(e.status)).length;$('success-rate').textContent=percent(sum('successes'),finished);$('success-count').textContent=sum('brand_mentions');$('removal-count').textContent=sum('removals');
    $('strategy-results').innerHTML=data.stats.map(s=>`<tr><td>${esc(s.name)}</td><td>${s.finished}</td><td>${s.successes}</td><td>${s.success_percent==null?'—':s.success_percent+'%'}</td><td>${s.removals}</td><td>${s.later_removals}</td><td>${s.average_replies??'—'}</td><td>${s.active} writing · ${s.monitoring} monitoring</td></tr>`).join('');
    $('depth-results').innerHTML=data.depths.filter(d=>d.submitted||d.successes||d.removals||d.step<=5).map(d=>`<div class="depth-row"><span>Message ${d.step}${d.step===1?' · opening':''}</span><div class="depth-bar"><span style="width:${finished?Math.min(100,100*d.successes/finished):0}%"></span></div><span>${d.successes} successes (${percent(d.successes,finished)}) · ${d.removals} removed</span></div>`).join('');
    $('strategies').innerHTML=data.strategies.map(s=>`<div class="card"><h3>${esc(s.name)}</h3>${chip(s.opening_mentions_brand?'ink':'info',s.opening_mentions_brand?'Names Geonode':'No brand in the opening')}<p class="small muted">${esc(s.brief)}</p></div>`).join('');
    const strategyValue=$('strategy').value;
    $('strategy').innerHTML='<option value="">Balance across the five strategies</option>'+data.strategies.map(s=>`<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('');$('strategy').value=strategyValue;
    threads();
    const names=Object.fromEntries(data.strategies.map(s=>[s.id,s.name])),byThread=Object.fromEntries(data.threads.map(t=>[t.id,t]));
    const actionNames=Object.fromEntries(data.strategies.map(s=>[s.id,s.action_name]));
    $('action-results').innerHTML=(data.actions||[]).filter(a=>a.basis===$('action-basis').value).map(a=>`<tr><td>${esc(a.stage.replaceAll('_',' '))} · ${esc(actionNames[a.action])}</td><td>${a.assigned}</td><td>${a.written}</td><td>${a.published}</td><td>${a.publication_percent==null?'—':a.publication_percent+'%'}</td><td>${a.removed}</td><td>${a.pending}</td><td>${a.overrides}</td></tr>`).join('')||'<tr><td colspan="8">Action results appear as new queue turns are assigned.</td></tr>';
    const filter=$('filter').value;
    const experiments=data.experiments.filter(e=>filter==='all'||filter==='active'&&['active','monitoring'].includes(e.status)||(filter==='stopped'?['stopped','blocked','exhausted'].includes(e.status):filter==='removed'?!!e.removed_at:e.status===filter));
    $('queue-note').textContent='All writing and monitoring queues, plus the latest '+data.history_limit+' finished experiments. Results use the complete test history.';
    const nextDue=e=>{const m=data.messages.find(m=>m.experiment_id===e.id&&m.step===e.current_step);return Date.parse(m?.decision_due_at||e.created_at);};
    if(filter==='active')experiments.sort((a,b)=>nextDue(a)-nextDue(b));
    $('shape-results').innerHTML=(data.shapes||[]).map(s=>`<tr><td>${esc(s.depths.replaceAll(',', ' → '))}</td><td>${esc(s.parents.split(',').map(p=>p==='0'?'Thread':'M'+p).join(' → '))}</td><td>${s.experiments}</td><td>${s.finished}</td><td>${s.successes}</td><td>${s.success_percent==null?'—':s.success_percent+'%'}</td></tr>`).join('')||'<tr><td colspan="6">Sequences appear after publication is verified.</td></tr>';
    $('experiments').innerHTML=experiments.map(e=>{
      const t=byThread[e.thread_id]||{},messages=data.messages.filter(m=>m.experiment_id===e.id).sort((a,b)=>a.step-b.step);
      return `<article class="card experiment-card" data-experiment="${esc(e.id)}"><div class="experiment-head"><div><b><a href="${esc(t.url||'#')}" target="_blank" rel="noopener">${esc(t.title||e.thread_id)}</a></b><div class="experiment-meta">r/${esc(t.subreddit||'—')} · ${esc(names[e.strategy_id])} · ${e.source==='existing_message'?'existing message · ':''}${ago(e.created_at)}</div></div>${chip(tone(e.status),e.status==='succeeded'?(e.removed_at?'7-day success, later removed':'7-day success'):e.status==='monitoring'?'Monitoring for 7 days':e.status)}</div>
      <p class="small muted">Limit: ${e.max_messages} messages · ${e.max_depth} levels. ${Math.max(0,e.max_messages-messages.filter(m=>m.verified_at).length)} messages remaining.</p>
      ${e.success_step?`<p class="small">Geonode verified in message ${e.success_step} · ${e.success_step-1} replies.${e.status==='monitoring'?' No more messages. Final check due '+esc(new Date(e.monitor_until).toLocaleString())+'.':''}</p>`:''}${e.reason?`<p class="message-note">${esc(e.reason)}</p>`:''}
      <div class="message-list">${messages.map(m=>messageCard(m,e,messages)).join('')}</div>
      ${['active','monitoring'].includes(e.status)?`<div class="experiment-actions"><button class="btn small danger" data-stop="${esc(e.id)}">Stop experiment</button><span class="small muted">Each publication determines the next queue turn. The queue controls timing.</span></div>`:''}</article>`;
    }).join('')||'<div class="empty">No experiments in this view. Choose a thread and an opening strategy above to start.</div>';
    $('experiments').querySelectorAll('[data-edit]').forEach(b=>b.addEventListener('click',async()=>{
      const m=data.messages.find(m=>m.id===b.dataset.edit),editor=b.closest('details'),status=editor.querySelector('[role=status]');b.disabled=true;status.textContent='Saving…';
      try{await window.operatorCall('/api/messages',{action:'edit',message_id:m.id,body:editor.querySelector('textarea').value,expected_body:m.body,reply_mode:editor.querySelector('[name=reply-mode]')?.value||null,expected_parent_message_id:m.parent_message_id,content_action:editor.querySelector('[name=content-action]')?.value||null,action_override_reason:editor.querySelector('[name=action-override]')?.value||null});await load();}catch(e){b.disabled=false;status.textContent=e.message;}
    }));
    $('experiments').querySelectorAll('[data-stop]').forEach(b=>b.addEventListener('click',async()=>{b.disabled=true;try{await window.operatorCall('/api/messages',{action:'stop',experiment_id:b.dataset.stop});await load();}catch(e){b.disabled=false;b.textContent=e.message;}}));
  }
  function messageCard(m,e,messages){
    const parent=messages.find(p=>p.id===m.parent_message_id),source=messages.find(p=>p.id===m.previous_message_id),sourceParent=messages.find(p=>p.id===source?.parent_message_id);
    const decided=m.step===1||!!m.reply_mode;
    const title=m.step===1?'1. Opening message':decided?`${m.step}. Reply to message ${parent?.step||'—'}`:`${m.step}. Next queue turn`;
    const label=m.status==='awaiting_draft'&&Date.parse(m.decision_due_at)>Date.now()?'Scheduled for writer':m.status==='submitted'?(providerStatuses[m.provider_status]||statuses[m.status]):m.status==='visible'&&m.last_visibility==='unknown'?'Visibility check pending':statuses[m.status]||m.status;
    const replyChoice=m.step>2&&source?`<label>Where should this message go?<select class="field" name="reply-mode" aria-label="Reply placement"><option value="">Choose an available reply…</option>${source.depth<e.max_depth?`<option value="chain" ${m.reply_mode==='chain'?'selected':''}>Chain — reply to message ${source.step}, level ${source.depth+1}</option>`:''}${sourceParent?.status==='visible'&&source.depth<=e.max_depth?`<option value="sibling" ${m.reply_mode==='sibling'?'selected':''}>Sibling — reply to message ${sourceParent.step}, level ${source.depth}</option>`:''}</select></label>${source.depth>=e.max_depth?'<p class="small muted">Depth limit reached. Only a sibling can fit this turn.</p>':''}`:'';
    const actions=data.strategies.filter(s=>m.step>1||s.id===e.strategy_id),chosen=m.content_action||m.suggested_action;
    const actionChoice=`<label>Content action<select class="field" name="content-action"><option value="">Choose an action…</option>${actions.map(s=>`<option value="${esc(s.id)}" ${chosen===s.id?'selected':''}>${esc(s.action_name)}</option>`).join('')}</select></label>${m.step>1?`<label>Reason if changing the suggestion<input class="field" name="action-override" value="${esc(m.action_override_reason||'')}"></label>`:''}`;
    const level=decided&&m.depth?` · Level ${m.depth}${m.reply_mode==='chain'?' · Chain':m.reply_mode==='sibling'?' · Sibling':''}`:'';
    return `<section class="message" data-message="${esc(m.id)}" style="--depth-offset:${Math.min(3,Math.max(0,(m.depth||1)-1))*12}px"><div class="message-top"><b>${title}${level}</b>${chip(tone(m.status),label)}</div>
      ${source?`<p class="small muted">Returned to the queue from <a href="${esc(source.reddit_url)}" target="_blank" rel="noopener">message ${source.step}</a>. ${m.step===2?'First follow-up: reply to the opening.':!decided?'Choose chain or sibling when this turn is due.':''}</p>`:''}
      ${m.status==='awaiting_draft'?`<div class="small muted">Due: ${esc(new Date(m.decision_due_at).toLocaleString())}</div>`:''}
      ${m.suggested_action?`<p class="small muted">Suggested action: ${esc(data.strategies.find(s=>s.id===m.suggested_action)?.action_name)} · target 20% per action in this stage.${m.step===e.max_messages?' Final message: writing stops after this turn.':''}</p>`:''}
      ${m.content_action?`<div class="small muted">Chosen action: ${esc(data.strategies.find(s=>s.id===m.content_action)?.action_name)}${m.action_override_reason?' · Changed because: '+esc(m.action_override_reason):''}</div>`:''}
      <div class="message-body">${m.body?esc(m.body):'<span class="muted">The writer will decide and draft this message when its queue turn arrives.</span>'}</div>
      <div class="small muted">${m.body?(m.contains_brand?'Contains Geonode':'No brand mention')+' · ':''}${m.reddit_url?`<a href="${esc(m.reddit_url)}" target="_blank" rel="noopener">View on Reddit</a>`:m.kind==='reply'&&decided?`<a href="${esc(m.target_url)}" target="_blank" rel="noopener">Reply target</a>`:'Queued message'}${m.author?' · u/'+esc(m.author):''}</div>
      ${m.rationale?`<details><summary>Decision</summary><p>${esc(m.rationale)}</p></details>`:''}
      ${m.reason?`<div class="message-note">${esc(m.reason)}</div>`:''}${m.cancel_requested_at?`<div class="message-note">${esc(m.cancel_result||'Stop requested. Cancellation depends on Engain delivery status.')}</div>`:''}${m.removal_class?`<div class="small muted">Removal reported as: ${esc(m.removal_class)}</div>`:''}
      ${m.last_checked_at?`<div class="small muted">Last visibility check: ${esc(new Date(m.last_checked_at).toLocaleString())} · ${esc(m.last_visibility||'unknown')}</div>`:''}
      ${m.rule_check?`<details><summary>Engain check: ${esc(m.rule_check.verdict)}${m.rule_check.removalRisk!=null?' · risk '+m.rule_check.removalRisk+'/100':''}</summary><p>${esc(m.rule_check.summary||'No summary provided.')}</p></details>`:''}
      ${e.status==='active'&&['queued','held','awaiting_draft'].includes(m.status)?`<details class="message-editor"><summary>${m.body?'Edit message':'Write this message'}</summary>${replyChoice}${actionChoice}<textarea class="field" rows="5" aria-label="Message text">${esc(m.body||'')}</textarea><button class="btn small" data-edit="${esc(m.id)}">Save message</button><span class="small muted" role="status"></span></details>`:''}</section>`;
  }
  async function load(){
    $('refresh').disabled=true;
    try{const r=await fetch('/api/messages',{credentials:'same-origin',cache:'no-store'});const result=await r.json();if(!r.ok)throw Error(result.error||'Could not load experiments');data=result;draw();}
    catch(e){fail(e,'message experiments');}finally{$('refresh').disabled=false;}
  }
  $('start-experiment').addEventListener('submit',async ev=>{
    ev.preventDefault();const body={action:'start',thread_id:$('thread').value,thread_url:$('thread-url').value,strategy:$('strategy').value||null,max_messages:Number($('max-messages').value),max_depth:Number($('max-depth').value)};
    if(body.thread_url)body.thread_id='';
    if(!body.thread_id&&!body.thread_url){$('start-status').textContent='Choose a thread or paste its Reddit URL.';return;}
    const key=JSON.stringify(body);if(selection!==key){requestId=crypto.randomUUID();selection=key;}
    $('start-button').disabled=true;$('start-status').textContent='Starting…';
    try{await window.operatorCall('/api/messages',{...body,request_id:requestId});requestId=null;selection=null;$('thread-url').value='';$('start-status').textContent='Experiment queued. Its first message is ready for the writer.';$('filter').value='active';await load();}
    catch(e){$('start-status').textContent=e.message;}finally{$('start-button').disabled=false;}
  });
  $('thread-search').addEventListener('input',threads);$('filter').addEventListener('change',draw);$('action-basis').addEventListener('change',draw);$('refresh').addEventListener('click',load);await load();
})();
