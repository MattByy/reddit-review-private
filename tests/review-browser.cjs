// Offline browser check of the shipped Review UI. Every request is intercepted.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
let browserLib;
for(const candidate of [process.env.SIMULATION_PLAYWRIGHT_PATH,'playwright-core',path.resolve(__dirname,'../../../geonode-strategy/dashboard/node_modules/playwright-core')].filter(Boolean)){try{browserLib=require(candidate);break;}catch{}}
if(!browserLib)throw Error('Set SIMULATION_PLAYWRIGHT_PATH to playwright-core');
const root=path.resolve(__dirname,'..'),fixtures=JSON.parse(fs.readFileSync(path.join(__dirname,'fixtures/review-scripts.json')));
const f=structuredClone(fixtures[0]);f.segments=f.segments.slice(0,1);
const run={id:f.id,scenario_slug:f.scenario_slug,subreddit:'testing',thread_id:'fixture',status:'open',review_status:'pending',effective_review_status:'pending',segment_count:1,account_id:'acct',started_at:new Date().toISOString()};
const account={id:'acct',label:'Fixture Team',active:true,disclosed:true,usable:true,disclosure_line:'(Geonode team here)'};
const comment={id:'22222222-2222-4222-8222-222222222222',kind:'comment',mode:'comment',status:'pending',body:'A standalone test comment. (Geonode team here)',account_id:'acct',thread_id:'fixture',subreddit:'testing',created_at:new Date().toISOString()};
const segment={id:f.segments[0].draft_id,body:f.segments[0].body.replace('(Operated by Fixture Team)','(Geonode team here)'),kind:'comment',mode:'scenario',status:'pending',thread_id:'fixture'};
(async()=>{
  const browser=await browserLib.chromium.launch({channel:'chrome',headless:true});
  try{
    const page=await browser.newPage({viewport:{width:1280,height:1000}}),errors=[],writes=[];let comments=[comment];
    page.setDefaultTimeout(7000);
    page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept(d.type()==='prompt'?'test-operator':undefined));
    await page.route('**/*',async route=>{
      const req=route.request(),url=new URL(req.url()),q=url.searchParams;
      const answer=data=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(data)});
      if(url.pathname==='/api/operator'){
        assert.equal(req.headers().authorization,'Bearer test-operator');const body=req.postDataJSON();writes.push(body.rpc);
        if(body.rpc==='approve_draft_batch'){comments=[];return answer([{draft_id:comment.id,error:null}]);}
        if(body.rpc==='review_scenario_run'){run.review_status=run.effective_review_status='approved';return answer(run);}
        throw Error('Unexpected operator RPC '+body.rpc);
      }
      if(url.pathname==='/api/dispatch'){assert.equal(req.headers().authorization,'Bearer test-operator');writes.push('dispatch');return answer({results:[]});}
      if(url.pathname.includes('/rest/v1/')){
        assert.equal(req.method(),'GET','Browser must not mutate Supabase directly');const table=url.pathname.split('/rest/v1/')[1];let data=[];
        if(table==='drafts')data=q.get('select')==='id'?[{id:comment.id}]:q.has('id')?[segment]:q.has('status')?[]:[...comments,segment];
        if(table==='accounts')data=[account];
        if(table==='scenario_acts')data=f.segments;
        if(table==='script_review_state')data=[run];
        if(table==='scenarios')data=[{slug:f.scenario_slug,name:'Single useful answer',enabled:true,same_thread_accounts:false,spec:{acts:f.segments}}];
        if(table==='rule_checks')data=[{draft_id:comment.id,verdict:'skipped',removal_risk:null,summary:'No Engain project configured'}];
        if(table==='thread_activity')data=[{thread_id:'fixture',title:'A useful technical question',subreddit:'testing',stage:'draft_pending_review'}];
        return answer(data);
      }
      if(url.pathname==='/assets/config.js')return route.fulfill({contentType:'application/javascript',body:"window.SB_URL='https://fixture.test';window.SB_KEY='public-fixture';"});
      if(url.pathname==='/assets/gate.js')return route.fulfill({contentType:'application/javascript',body:''});
      const file=path.join(root,url.pathname);
      if(url.hostname==='fixture.test'&&fs.existsSync(file)&&fs.statSync(file).isFile())return route.fulfill({path:file});
      return route.fulfill({status:404,body:''});
    });
    await page.goto('https://fixture.test/review.html');
    await page.locator('#batch-open').click();
    await page.waitForSelector('.batch-row');assert.equal(await page.locator('.batch-row').count(),1);
    assert.match(await page.locator('.batch-row').textContent(),/vendor score unavailable/);
    await page.locator('#batch-select-all').check();assert.equal(await page.locator('#batch-approve-btn').isEnabled(),true);
    await page.locator('#batch-approve-btn').click();await page.waitForFunction(()=>document.querySelectorAll('.batch-row').length===0);
    const card=page.locator('.scenario-card');await card.locator('summary').click();
    assert.equal(await card.locator('.scenario-act').count(),1);assert.equal(await card.locator('[data-a="approve-run"]').isEnabled(),true);
    await card.locator('[data-a="approve-run"]').click();await page.waitForFunction(()=>document.querySelector('.scenario-card .badges').textContent.includes('script approved'));
    assert.ok(writes.includes('approve_draft_batch'));assert.ok(writes.includes('review_scenario_run'));assert.ok(writes.includes('dispatch'));assert.deepEqual(errors,[]);
    console.log(JSON.stringify({skipped_score_visible:true,single_act_approved:true,authenticated_mutations:true,direct_database_writes:0,page_errors:0}));
  }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
