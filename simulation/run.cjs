const fs=require('node:fs'),path=require('node:path');
const {runAll}=require('./message-scenarios.cjs');
const {render}=require('./report.cjs');
const output=path.resolve(__dirname,'../reports/reddit-simulation');
(async()=>{
  const cases=await runAll(result=>console.log(JSON.stringify(result)));
  const report={at:new Date().toISOString(),protocol_version:5,mode:'isolated executable replay',
    scope:{real:['Production agent API handlers','Production cron handler','SQL migrations through 043','Queue, leases, limits and state transitions'],
      simulated:['Reddit threads, comments and HTTP responses','Engain acceptance, status and failure responses','Scripted illustrative writer decisions','A clearly labeled local humanizer fixture','Time compressed by aging local timestamps; intermediate polls omitted'],
      external_requests:0,production_changes:0,real_publications:0,
      note:'This demonstrates behavior, not live Engain delivery, LLM quality, a humanizer integration or publication success rates.'},
    summary:{cases:cases.length,passed:cases.filter(c=>c.status==='passed').length,steps:cases.reduce((n,c)=>n+c.steps.length,0),assertions:cases.reduce((n,c)=>n+c.checks.length,0)},
    findings:[{title:'Rule-check failures need a rewrite path',detail:'An explicit Engain fail holds the message. The writing job is already done, so the next normal writer claim does not pick it up. An automatic revision job is not currently implemented.'},
      {title:'The humanizer still needs configuration',detail:'Successful replays use a labeled local fixture. The missing-tool scenario blocks honestly before filing text. No real humanizer was called.'},
      {title:'A provider publication can still be unverified',detail:'When Reddit returns 403, the URL is saved but no follow-up is created until the exact comment can be verified.'}],cases};
  fs.mkdirSync(output,{recursive:true});
  fs.writeFileSync(path.join(output,'results.json'),JSON.stringify(report,null,2)+'\n');
  fs.writeFileSync(path.join(output,'index.html'),render(report));
  console.log(JSON.stringify({report:path.join(output,'index.html'),...report.summary,external_requests:0,real_publications:0}));
})().catch(e=>{console.error(e.stack||e);process.exitCode=1;});
