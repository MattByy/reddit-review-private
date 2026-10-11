const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {pathToFileURL}=require('node:url');
let playwright;
for(const candidate of [process.env.SIMULATION_PLAYWRIGHT_PATH,'playwright-core',path.resolve(__dirname,'../../../geonode-strategy/dashboard/node_modules/playwright-core')].filter(Boolean)){try{playwright=require(candidate);break;}catch{}}
if(!playwright)throw Error('Set SIMULATION_PLAYWRIGHT_PATH to an installed playwright-core package');
(async()=>{
  const root=path.resolve(__dirname,'../reports/reddit-simulation'),report=JSON.parse(fs.readFileSync(path.join(root,'results.json')));
  const browser=await playwright.chromium.launch({channel:'chrome',headless:true});
  try{
    const page=await browser.newPage({viewport:{width:1440,height:1080}}),errors=[],network=[];
    page.on('pageerror',e=>errors.push(e.message));await page.route(/^https?:\/\//,r=>{network.push(r.request().url());return r.abort();});
    await page.goto(pathToFileURL(path.join(root,'index.html')).href);
    assert.equal(await page.locator('.case').count(),report.summary.cases);
    let events=0;
    for(const [i,c] of report.cases.entries()){
      await page.locator('[data-case="'+i+'"]').click();assert.equal(await page.locator('#title').textContent(),c.title);
      for(const [j,event] of c.steps.entries()){
        await page.locator('#steps').selectOption(String(j));assert.equal(await page.locator('#event-title').textContent(),event.title);
        assert.equal(await page.locator('#traffic .call').count(),event.traffic.length);events++;
      }
      assert.equal(await page.locator('#next').isDisabled(),true);assert.equal(await page.locator('#checks li').count(),c.checks.length);
      await page.locator('#restart').click();assert.equal(await page.locator('#previous').isDisabled(),true);
      if(c.steps.length>1){await page.locator('#next').click();assert.equal(await page.locator('#steps').inputValue(),'1');await page.locator('#previous').click();assert.equal(await page.locator('#steps').inputValue(),'0');}
    }
    const branch=report.cases.findIndex(c=>c.id==='branch');await page.locator('[data-case="'+branch+'"]').click();await page.locator('#finish').click();
    assert.equal(await page.locator('#tree .node').count(),4);assert.match(await page.locator('#tree').innerText(),/sibling → M1/);
    await page.screenshot({path:path.join(root,'desktop.png'),fullPage:true});
    const hash=new URL(page.url()).hash;await page.reload();assert.equal(new URL(page.url()).hash,hash);assert.equal(await page.locator('#tree .node').count(),4);
    await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    await page.locator('#payload-details summary').click();assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    await page.locator('#payload-details summary').click();await page.screenshot({path:path.join(root,'mobile.png'),fullPage:true});assert.deepEqual(errors,[]);assert.deepEqual(network,[]);
    console.log(JSON.stringify({cases:report.summary.cases,events_checked:events,navigation:'passed',deep_link:'passed',mobile_overflow:false,page_errors:0,external_requests:0}));
  }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
