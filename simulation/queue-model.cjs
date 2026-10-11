// An illustrative queue-policy model, deliberately separate from the deployed
// claim_jobs scheduler. No API, credentials, agents or provider calls are used.
const assert=require('node:assert/strict');
const copy=x=>JSON.parse(JSON.stringify(x));
const topics=['Comparing API responses before changing a parser','Missing fields in error responses','Choosing a retry strategy','Checking response formats','Debugging inconsistent status codes','Handling null and absent fields','Comparing proxy integration options','Saving useful request logs','Testing a new parser','Separating success and error schemas'];
function initial(){return {cursor:0,returnSequence:0,threads:Array.from({length:50},(_,i)=>({id:'T'+String(i+1).padStart(2,'0'),title:topics[i%10],age:[3,12,29,5,44,18,55,8,22,36][i%10],score:900-i*13,priority:50-i,state:'new',messages:[],nextStep:1,latest:null,returnSequence:null}))};}
function pattern(state){
  const n=state.threads.filter(t=>t.state==='followup').length;
  return n>=20?['new','followup','followup','followup','followup','followup']:n>=10?['new','followup','followup']:['new','new','followup'];
}
function action(t){return t.state==='new'?'Write opening':t.nextStep===2?'Reply':t.latest?.depth>=4?'Sibling only':'Choose sibling / chain';}
function queue(state){
  const lanes={new:state.threads.filter(t=>t.state==='new').sort((a,b)=>b.priority-a.priority),followup:state.threads.filter(t=>t.state==='followup').sort((a,b)=>a.returnSequence-b.returnSequence)};
  const order=pattern(state),result=[];let cursor=state.cursor%order.length;
  while(lanes.new.length||lanes.followup.length){const preferred=order[cursor],lane=lanes[preferred].length?preferred:preferred==='new'?'followup':'new';const item=lanes[lane].shift();result.push({...copy(item),position:result.length+1,action:action(item),lane});cursor=(cursor+1)%order.length;}
  return result;
}
function submit(state,{brand,mode}={}){
  const item=queue(state)[0];assert.ok(item);const t=state.threads.find(t=>t.id===item.id),step=t.nextStep;
  const mention=brand??(step===1&&(Number(t.id.slice(1))-1)%5===0);
  const placement=step===1?'opening':step===2?'reply':mode||'chain';
  const depth=step===1?1:placement==='sibling'?t.latest.depth:t.latest.depth+1;
  assert.ok(step<=6&&depth<=4);const parent=step===1?null:placement==='sibling'?t.latest.parent:t.latest.step;
  const m={step,depth,parent,mode:placement,mentions:mention,status:'Awaiting publication',url:null};t.messages.push(m);t.pending=m;t.state='awaiting';
  state.cursor=(state.cursor+1)%pattern(state).length;return t.id;
}
function resolve(state,id,result){
  const t=state.threads.find(t=>t.id===id),m=t.messages.find(m=>m.step===t.pending?.step);assert.ok(m);
  if(result==='published'){
    m.status='Published';m.url='https://www.reddit.com/r/example/comments/'+id.toLowerCase()+'/demo/m'+m.step+'/';t.latest=m;
    if(m.mentions)t.state='monitoring';else if(m.step===6)t.state='stopped';else{t.state='followup';t.nextStep=m.step+1;t.returnSequence=++state.returnSequence;}
  }else{m.status='Rejected';t.state='stopped';}
  t.pending=null;
}
function build(){
  const snapshots=[],s=initial();
  function save(id,title,note,focus=null,state=s){
    const counts=Object.fromEntries(['new','followup','awaiting','monitoring','stopped'].map(k=>[k,state.threads.filter(t=>t.state===k).length]));
    assert.equal(Object.values(counts).reduce((a,b)=>a+b,0),50);
    const ordered=queue(state);assert.equal(new Set(ordered.map(t=>t.id)).size,ordered.length);
    for(const t of state.threads){assert.ok(t.messages.length<=6);assert.ok(t.messages.every(m=>m.depth<=4));if(['new','followup'].includes(t.state))assert.ok(!t.pending);}
    snapshots.push({id,title,note,focus,counts,pattern:pattern(state),queue:ordered,threads:copy(state.threads),focusPosition:ordered.find(t=>t.id===focus)?.position||null});
  }
  save('start','50 threads, ready for their first comment','The next item is a thread. Its action is Write opening. Popular, relevant, still-active threads can be days or weeks old.');
  for(let i=0;i<10;i++)submit(s);
  save('written','Ten comments written; publication is still pending','40 new threads remain. Two of the ten drafted comments mention Geonode. Nothing returns to the writing queue just because text was sent.');
  for(const id of ['T01','T02','T03','T04','T07','T08'])resolve(s,id,'published');
  for(const id of ['T05','T06'])resolve(s,id,'rejected');
  save('results','Five published comments return for a reply','40 new threads + 5 follow-ups are ready. T01 mentioned Geonode and is published, so it moves to monitoring. T05 and T06 were rejected; T09 and T10 still await publication.','T02');
  while(queue(s)[0].id!=='T02')submit(s);
  save('reply-next','Next up: reply to T02’s opening','The next item is now a published comment with its URL. The only placement is Reply to message 1. The agent decides whether the new text mentions Geonode.','T02');
  assert.equal(submit(s,{brand:false}),'T02');
  save('reply-sent','The reply was sent without Geonode','T02 leaves the writing queue while the reply awaits publication. The agent picks a different ready item next.','T02');
  resolve(s,'T02','published');
  save('reply-returned','The published reply returns for a placement decision','T02 now says Choose sibling / chain. Four older follow-ups are ahead of it. Its displayed position comes from those follow-ups plus the reserved turns for new threads.','T02');
  let served=0;while(queue(s)[0].id!=='T02'){submit(s,{brand:false,mode:'chain'});served++;}
  save('branch-next','Next up: sibling or chain on T02',served+' other queue turns were served first. The agent can reply under message 2 (chain, level 3), or to message 1 beside message 2 (sibling, level 2).','T02');
  assert.equal(submit(s,{brand:true,mode:'sibling'}),'T02');
  save('mention-sent','Sibling sent · mentions Geonode','The Geonode badge appears immediately on the written message. It is still awaiting publication; a mention alone is not an accepted or successful result.','T02');
  const rejected=copy(s);resolve(rejected,'T02','rejected');
  resolve(s,'T02','published');
  save('mention-published','Mentioned Geonode · published','T02 leaves the writing queue and is monitored for seven days. No additional message is generated. Publication and brand presence are recorded separately.','T02');
  save('mention-rejected','Alternative outcome: mentioned Geonode · rejected','If the same submitted sibling is rejected, it stops here. It does not go back into the writing queue or count as a successful mention.','T02',rejected);
  const removed=copy(s),t=removed.threads.find(t=>t.id==='T02');t.latest.status='Removed after publication';t.messages.at(-1).status=t.latest.status;t.state='stopped';
  save('mention-removed','Alternative outcome: the published mention is removed','A later removal during monitoring is recorded as removed. There is no new branch or replacement reply.','T02',removed);
  const busy=initial();for(let i=0;i<30;i++){const t=busy.threads[i];t.state='followup';t.nextStep=2;t.latest={step:1,depth:1,parent:null,mode:'opening',mentions:false,status:'Published',url:'https://www.reddit.com/r/example/comments/'+t.id.toLowerCase()+'/demo/m1/'};t.messages=[copy(t.latest)];t.returnSequence=++busy.returnSequence;}
  save('busy','Busy queue: 30 follow-ups, 20 untouched threads','Increase follow-up capacity when returning work accumulates. Here the proposal gives one turn to a new thread, then five to follow-ups. New threads still have a reserved turn; returns are served oldest-due first.','T01',busy);
  const normal=snapshots.find(x=>x.id==='results');assert.equal(normal.counts.followup,5);assert.equal(normal.counts.monitoring,1);assert.equal(normal.counts.stopped,2);assert.equal(normal.counts.awaiting,2);
  assert.equal(snapshots.find(x=>x.id==='reply-returned').queue.find(t=>t.id==='T02').action,'Choose sibling / chain');
  assert.equal(snapshots.find(x=>x.id==='mention-rejected').threads.find(t=>t.id==='T02').messages.at(-1).status,'Rejected');
  assert.deepEqual(snapshots.at(-1).queue.slice(0,6).map(t=>t.lane),['new','followup','followup','followup','followup','followup']);
  return {generated_at:new Date().toISOString(),kind:'proposed queue policy; simulated data',snapshots};
}
module.exports={build,queue,pattern};
