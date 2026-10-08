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
    await page.locator('#filter').fill('nested');assert.ok(await page.locator('.case:visible').count()>0);assert.ok(await page.locator('.case:visible').count()<report.summary.cases);
    await page.locator('#filter').fill('');await page.screenshot({path:path.join(root,'desktop.png'),fullPage:true});
    await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    await page.screenshot({path:path.join(root,'mobile.png'),fullPage:true});assert.deepEqual(errors,[]);assert.deepEqual(network,[]);
    console.log(JSON.stringify({cases:report.summary.cases,filter:'passed',mobile_overflow:false,page_errors:0,external_requests:0}));
  }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
