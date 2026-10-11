// The actual message queue and login with local SQL/API handlers; no external network.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {Harness,COPY}=require('./workflow-harness.cjs');
const {randomBytes,createHash}=require('node:crypto');
let browserLib;
for(const candidate of [process.env.SIMULATION_PLAYWRIGHT_PATH,'playwright-core',path.resolve(__dirname,'../../../geonode-strategy/dashboard/node_modules/playwright-core')].filter(Boolean)){try{browserLib=require(candidate);break;}catch{}}
if(!browserLib)throw Error('Set SIMULATION_PLAYWRIGHT_PATH to playwright-core');
const root=path.resolve(__dirname,'..');
(async()=>{
  const h=await new Harness().init(),browser=await browserLib.chromium.launch({channel:'chrome',headless:true});
  try{
    await h.thread();
    await h.sql("update workflow_state set value='{\"enabled\":true}' where key='message_workflow'");
    const setupToken=randomBytes(32).toString('base64url'),password='browser test password for dashboard';
    await h.sql("update dashboard_admin set setup_token_hash=$1,setup_expires_at=now()+interval '1 hour'",[createHash('sha256').update(setupToken).digest('hex')]);
    const page=await browser.newPage({viewport:{width:1280,height:950}}),errors=[],requests=[];let dispatches=0;
    page.setDefaultTimeout(7000);page.on('pageerror',e=>errors.push(e.message));
    page.on('dialog',d=>{errors.push('Unexpected browser dialog: '+d.message());d.dismiss();});
    const handle=async route=>{
      const req=route.request(),url=new URL(req.url());
      const answer=(data,status=200,headers={})=>route.fulfill({status,contentType:'application/json',headers,body:JSON.stringify(data)});
      if(url.pathname==='/api/session'){
        const result=await h.call(h.session,'/api/session',req.method()==='POST'?req.postDataJSON():undefined,req.method(),null,{...await req.allHeaders(),host:url.host});
        return answer(result.body,result.status,result.headers);
      }
      if(url.pathname==='/api/messages'){
        assert.equal(req.headers().authorization,undefined);const body=req.method()==='POST'?req.postDataJSON():undefined;
        const result=await h.call(h.messagesHandler,'/api/messages',body,req.method(),null,{...await req.allHeaders(),host:url.host});
        if(body?.action==='start'){
          requests.push(body);
          if(requests.length===1)return answer({error:'Simulated lost response. Retry the same request.'},503);
        }
        return answer(result.body,result.status);
      }
      if(url.pathname==='/api/dispatch'){dispatches++;return answer({results:[]});}
      if(url.pathname.startsWith('/rest/v1/')){
        assert.equal(req.method(),'GET','Browser writes must go through the operator API');
        const table=url.pathname.split('/rest/v1/')[1];
        if(['plan_timeline','script_review_state','thread_activity','posting_queue','edit_lessons','reject_lessons'].includes(table))return answer([]);
        const result=await h.rest(url,{method:'GET'});return route.fulfill({status:result.status,contentType:'application/json',body:await result.text()});
      }
      if(url.pathname==='/assets/config.js')return route.fulfill({contentType:'application/javascript',body:"window.SB_URL='https://db.test';window.SB_KEY='fixture';"});
      const file=path.join(root,/^\/(login|plan|review)$/.test(url.pathname)?url.pathname+'.html':url.pathname);
      if(url.hostname==='fixture.test'&&fs.existsSync(file)&&fs.statSync(file).isFile())return route.fulfill({path:file});
      return route.fulfill({status:404,body:''});
    };
    await page.route('**/*',handle);
    await page.goto('https://fixture.test/plan.html');
    await page.waitForURL('**/login?*');
    await page.goto('https://fixture.test/login#setup='+setupToken);
    await page.waitForFunction(()=>document.querySelector('h1').textContent==='Choose your password');
    assert.equal(new URL(page.url()).hash,'','Setup token is removed from browser history');
    await page.locator('#password').fill(password);await page.locator('#confirm').fill(password);await page.locator('#submit').click();
    await page.waitForURL(/\/plan(?:#queue)?$/);
    const sessionCookie=(await page.context().cookies()).find(c=>c.name==='__Host-reddit_admin');
    assert.equal(sessionCookie.httpOnly,true);assert.equal(sessionCookie.secure,true);assert.equal(sessionCookie.sameSite,'Strict');
    assert.ok(sessionCookie.expires>Date.now()/1000+29*86400);
    assert.equal(await page.evaluate(()=>document.cookie.includes('__Host-reddit_admin')),false);
    const form=page.locator('#start-experiment');await form.waitFor();
    await page.locator('#strategy option[value="question"]').waitFor({state:'attached'});
    assert.equal(await page.locator('[name=account],[name=account_a],[name=account_b]').count(),0);
    assert.equal(await page.getByRole('button',{name:/approve/i}).count(),0);
    assert.equal(await page.locator('#max-messages').inputValue(),'6');assert.equal(await page.locator('#max-depth').inputValue(),'4');
    await page.locator('#thread').selectOption('abc123');await page.locator('#strategy').selectOption('question');await page.locator('#start-button').click();
    await page.waitForFunction(()=>document.querySelector('#start-status').textContent.includes('Simulated lost response'));
    await page.locator('#start-button').click();await page.locator('.experiment-card').waitFor();
    assert.equal(requests.length,2);assert.equal(requests[0].request_id,requests[1].request_id);
    assert.equal(requests[0].max_messages,6);assert.equal(requests[0].max_depth,4);
    assert.equal((await h.sql('select count(*)::int n from message_experiments'))[0].n,1);
    assert.equal(await page.locator('.message').count(),1,'Future replies are not planned in advance');
    assert.match(await page.locator('.message').innerText(),/In writing queue/);
    await page.locator('.message-editor summary').click();await page.locator('.message-editor textarea').fill('Which response fields do you need?');await page.locator('[data-edit]').click();
    await page.waitForFunction(()=>document.querySelector('.message .message-body').textContent==='Which response fields do you need?');
    assert.match(await page.locator('.message').innerText(),/No brand mention/);
    // Drive two publications through the real handlers; the third turn must offer placement.
    const finishCurrent=async()=>{
      await h.db.exec("update message_publications set created_at=now()-interval '2 days'; update experiment_messages set decision_due_at=now(),next_check_at=null;");
      const sent=await h.messages.dispatch();assert.equal(sent[0]?.state,'submitted',JSON.stringify(sent));
      const [m]=await h.sql('select * from experiment_messages order by step desc limit 1'),task=h.vendor.find(t=>t._id===m.task_id),cid='m'+m.step;
      task.status='published';task.resultUrl='https://www.reddit.com/r/test/comments/abc123/example/'+cid+'/';
      const parent=m.kind==='reply'?'t1_'+h.reader.identity(m.target_url).comment_id:'t3_abc123';
      h.reddit.get('abc123')[1].data.children.push(h.comment(cid,m.body,parent,[],'geonode_test'));
      await h.messages.verify(m,task.resultUrl);await page.locator('#refresh').click();
    };
    await finishCurrent();await page.waitForFunction(()=>document.querySelectorAll('.message').length===2);
    const second=page.locator('.message').nth(1);assert.match(await second.innerText(),/First follow-up: reply to the opening/);
    assert.equal(await second.locator('[name=reply-mode]').count(),0);
    await second.locator('.message-editor summary').click();await second.locator('textarea').fill('Check missing fields separately from empty fields.');await second.locator('[data-edit]').click();
    await page.waitForFunction(()=>document.querySelectorAll('.message .message-body')[1].textContent.includes('Check missing'));
    await finishCurrent();await page.waitForFunction(()=>document.querySelectorAll('.message').length===3);
    const third=page.locator('.message').nth(2);await third.locator('.message-editor summary').click();
    assert.equal(await third.locator('[name=reply-mode]').inputValue(),'','A branch is not chosen in advance');
    await third.locator('[name=reply-mode]').selectOption('sibling');await third.locator('textarea').fill('Geonode team here: retain a raw response when comparing parsing requirements.');
    const suggestion=await third.locator('[name=content-action]').inputValue(),chosen=suggestion==='help'?'method':'help';
    await third.locator('[name=content-action]').selectOption(chosen);await third.locator('[data-edit]').click();
    await third.getByText('Explain why this context needs a different content action',{exact:true}).waitFor();
    await third.locator('[name=action-override]').fill('The parent asks for a concrete comparison.');await third.locator('[data-edit]').click();
    await page.waitForFunction(()=>document.querySelectorAll('.message')[2].textContent.includes('Reply to message 1 · Level 2 · Sibling'));
    const [selected]=await h.sql('select * from experiment_messages order by step desc limit 1');assert.equal(selected.reply_mode,'sibling');assert.equal(selected.depth,2);assert.equal(selected.content_action,chosen);assert.equal(selected.action_override_reason,'The parent asks for a concrete comparison.');
    await finishCurrent();await page.waitForFunction(()=>document.querySelector('.experiment-head').textContent.includes('Monitoring for 7 days'));
    assert.equal(await page.locator('.message').count(),3);assert.equal(await page.locator('.message-editor').count(),0);
    await page.locator('#tab-strategies').click();assert.equal(await page.locator('#strategies .card').count(),5);
    await page.locator('#tab-results').click();assert.match(await page.locator('#panel-results').innerText(),/Pending, stopped and delivery-blocked/);
    assert.equal(await page.locator('#action-results tr').count(),3);await page.locator('#action-basis').selectOption('chosen');assert.equal(await page.locator('#action-results tr').count(),3);
    await page.locator('#tab-queue').click();await page.screenshot({path:'/tmp/reddit-experiments-desktop.png',fullPage:true});
    await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth),false);
    await page.screenshot({path:'/tmp/reddit-experiments-mobile.png',fullPage:true});
    await page.locator('[data-stop]').click();await page.locator('.experiment-card').waitFor({state:'detached'});await page.locator('#filter').selectOption('stopped');await page.locator('.experiment-card').waitFor();
    assert.match(await page.locator('.experiment-card').innerText(),/Stopped in dashboard/);
    await page.goto('https://fixture.test/review.html');await page.waitForURL('**/plan#queue');await page.locator('#start-experiment').waitFor();
    assert.equal(dispatches,0,'No browser approval or manual publication step');
    const saved=await page.context().storageState(),restored=await browser.newContext({storageState:saved}),tab=await restored.newPage();
    await tab.route('**/*',handle);await tab.goto('https://fixture.test/plan');await tab.locator('#start-experiment').waitFor();
    assert.match(tab.url(),/\/plan$/,'A restored browser session opens without another password');
    await tab.locator('[data-sign-out]').click();await tab.waitForURL('**/login');
    await page.reload();await page.waitForURL('**/login?*');
    await page.locator('#password').fill('wrong');await page.locator('#submit').click();await page.getByText('Incorrect password.',{exact:true}).waitFor();
    await page.locator('#password').fill(password);await page.locator('#submit').click();await page.waitForURL(/\/plan(?:#queue)?$/);
    await restored.close();
    assert.deepEqual(errors,[]);
    console.log(JSON.stringify({password_setup:true,remembered_session:true,logout_revoked_other_tabs:true,no_api_key_prompt:true,no_account_selectors:true,retry_same_experiment:true,one_message_at_a_time:true,mobile_overflow:false,no_approval_buttons:true,edit_and_stop:true,legacy_review_redirect:true,first_reply_forced:true,sibling_parent_saved:true,brand_stops_writing:true,seven_day_monitoring:true,page_errors:0}));
  }finally{await browser.close();await h.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
