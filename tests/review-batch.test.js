const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const html = fs.readFileSync('review.html', 'utf8');
// Execute the shipped handlers with a small DOM adapter. Browser integration
// is covered separately by review-browser.py, not claimed by these tests.
class Element {
  constructor() { this.listeners = {}; this.hidden = false; this.disabled = false; this.classList = {add(){},remove(){}}; this.body = {}; }
  addEventListener(name, fn) { (this.listeners[name] ||= []).push(fn); }
  async fire(name) { for (const fn of this.listeners[name] || []) await fn({target:this}); }
  set innerHTML(value) {
    this.html = value;
    this.boxes = [...value.matchAll(/<input type="checkbox" data-draft-id="([^"]+)"([^>]*)>/g)].map(m => {
      const cb = new Element(); cb.dataset = {draftId:m[1]}; cb.disabled = /disabled/.test(m[2]); cb.checked = /checked/.test(m[2]); return cb;
    });
  }
  get innerHTML() { return this.html; }
  querySelector(s) { if (s === '.body') return this.body; throw Error('unexpected selector ' + s); }
  querySelectorAll(s) {
    if (s === 'button[data-more]') return [];
    if (s.startsWith('input[')) return (this.boxes || []).filter(c => !s.includes(':not(:disabled)') || !c.disabled);
    throw Error('unexpected selector ' + s);
  }
}
function harness() {
  const elements = Object.fromEntries(['batch-eligibility','batch-section','ws','batch-open','batch-grid','batch-select-all','batch-total','batch-count','batch-approve-btn','batch-cancel','batch-status'].map(id => [id,new Element()]));
  const calls=[];
  const context = { Set, console, document:{}, accounts:[{id:'acct',active:true,disclosed:true,disclosure_line:'(Operated by Fixture Team)'}],
    drafts:Array.from({length:3}, (_,i)=>({id:'d'+i,kind:'comment',body:'Fixture narrative (Operated by Fixture Team)',account_id:i===2?null:'acct'})), checks:{},
    $:id=>elements[id], esc:String, stateChip:()=>'', scoreChip:()=>'', stratChip:()=>'', cleanTitle:String, threadTitle:d=>d.id,threadSub:()=> 'testing',
    runChecks:()=>({hardFail:false}),select:()=>{},setCounts:()=>{},showEmpty:()=>{},renderSend:async()=>{},flash:()=>{},describe:()=>'',errText:e=>e.message,
    ICON:{check:'',x:''},confirm:()=>true, rpc:async(name,args)=>{calls.push({name,args});return context.results || args.p_draft_ids.map(draft_id=>({draft_id,error:null}));},
    dispatch:async()=>{calls.push({name:'dispatch'});return {};}
  };
  vm.createContext(context);
  vm.runInContext(html.split('/* ── batch approve ')[1].split('/* ── tabs ')[0].replace(/^.*?\*\//s,'') +
    '\nglobalThis.testAPI={showBatchMode,renderBatchGrid,updateBatchUI,get selected(){return [...batchSelected]},get drafts(){return drafts}};', context);
  return {elements,context,calls,api:context.testAPI};
}
test('Select All selects eligible visible rows, deselects, and does not accumulate handlers', async()=>{
  const {elements:e,api}=harness();
  api.showBatchMode(true); api.renderBatchGrid(); api.renderBatchGrid();
  assert.equal(e['batch-select-all'].listeners.change.length,1);
  const all=e['batch-select-all']; all.checked=true; await all.fire('change');
  assert.deepEqual(Array.from(api.selected),['d0','d1']); assert.equal(e['batch-approve-btn'].disabled,false);
  const first=e['batch-grid'].boxes[0]; first.checked=false; await first.fire('change');
  assert.equal(all.indeterminate,true); assert.equal(all.checked,false);
  all.checked=false; await all.fire('change'); assert.equal(api.selected.length,0); assert.equal(e['batch-approve-btn'].disabled,true);
});
test('rerender prunes stale selection and all-blocked grid disables Select All',async()=>{
  const {elements:e,api,context}=harness(); api.showBatchMode(true);
  e['batch-select-all'].checked=true; await e['batch-select-all'].fire('change');
  context.drafts.forEach(d=>d.account_id=null); api.renderBatchGrid();
  assert.equal(api.selected.length,0); assert.equal(e['batch-select-all'].disabled,true);
});
test('partial bulk success keeps failures selected and retry does not reapprove successes',async()=>{
  const {elements:e,api,context,calls}=harness(); api.showBatchMode(true);
  e['batch-select-all'].checked=true; await e['batch-select-all'].fire('change');
  context.results=[{draft_id:'d0',error:null},{draft_id:'d1',error:'parent changed'}];
  await e['batch-approve-btn'].fire('click');
  assert.deepEqual(Array.from(api.selected),['d1']); assert.equal(e['batch-status'].hidden,false);
  assert.match(e['batch-status'].body.innerHTML,/parent changed/);
  assert.equal(calls.filter(c=>c.name==='dispatch').length,1);
  context.results=[{draft_id:'d1',error:null}]; await e['batch-approve-btn'].fire('click');
  assert.deepEqual(Array.from(calls.filter(c=>c.name==='approve_draft_batch')[1].args.p_draft_ids),['d1']);
});
test('RPC failure is visible, retains selection and allows retry without dispatch',async()=>{
  const {elements:e,api,context,calls}=harness(); api.showBatchMode(true);
  e['batch-select-all'].checked=true; await e['batch-select-all'].fire('change');
  context.rpc=async()=>{throw Error('migration missing')}; await e['batch-approve-btn'].fire('click');
  assert.equal(e['batch-status'].hidden,false); assert.match(e['batch-status'].body.innerHTML,/migration missing/);
  assert.equal(api.selected.length,2); assert.equal(e['batch-approve-btn'].disabled,false); assert.equal(calls.length,0);
  assert.doesNotMatch(html.match(/<div id="batch-status"[^>]+>/)[0],/display\s*:\s*none/);
});
test('in-flight batch prevents duplicate submission',async()=>{
  const {elements:e,api,context}=harness(); api.showBatchMode(true);
  e['batch-select-all'].checked=true; await e['batch-select-all'].fire('change');
  let resolve; let count=0; context.rpc=()=>{count++; return new Promise(r=>resolve=r)};
  const pending=e['batch-approve-btn'].fire('click'); await e['batch-approve-btn'].fire('click');
  assert.equal(count,1); assert.equal(e['batch-grid'].inert,true);
  resolve([{draft_id:'d0',error:null},{draft_id:'d1',error:null}]); await pending;
  assert.equal(e['batch-grid'].inert,false);
});
test('three narrative fixtures contain 4, 5 and 3 ordered disclosed segments',()=>{
 const fixtures=JSON.parse(fs.readFileSync('tests/fixtures/review-scripts.json'));
 assert.deepEqual(fixtures.map(f=>f.segments.length),[4,5,3]);
 for(const f of fixtures) for(const [i,s] of f.segments.entries()) {
   assert.equal(s.run_id,f.id); assert.equal(s.seq,i+1); assert.equal(s.depends_on,i||null);
   assert.match(s.body,/TEST FIXTURE/); assert.match(s.body,/Operated by Fixture Team/);
 }
});
test('Sending refresh failure does not roll back successful review or keep approved rows selectable',async()=>{
 const {elements:e,api,context,calls}=harness(); api.showBatchMode(true);
 e['batch-select-all'].checked=true; await e['batch-select-all'].fire('change');
 context.renderSend=async()=>{throw Error('refresh offline')};
 await e['batch-approve-btn'].fire('click');
 assert.equal(api.selected.length,0); assert.equal(e['batch-grid'].boxes.length,1);
 assert.match(e['batch-status'].body.innerHTML,/Approved 2/);
 assert.match(e['batch-status'].body.innerHTML,/refresh offline/);
 assert.equal(calls.filter(c=>c.name==='dispatch').length,1);
});
