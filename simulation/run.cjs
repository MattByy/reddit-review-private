// Current implementation report. All Reddit/Engain writes are simulated.
const {run}=require('node:test');
const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..'),output=path.join(root,'reports/reddit-simulation');
const esc=x=>String(x).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
(async()=>{
  const results=[];
  for await(const e of run({files:[path.join(root,'tests/workflow.test.cjs')],concurrency:1})){
    if(['test:pass','test:fail'].includes(e.type))results.push({name:e.data.name,status:e.type==='test:pass'?'passed':'failed',duration_ms:e.data.details.duration_ms,error:e.data.details.error?.message||null});
  }
  const report={at:new Date().toISOString(),mode:'isolated integration simulation',summary:{cases:results.length,passed:results.filter(r=>r.status==='passed').length,failed:results.filter(r=>r.status==='failed').length},
    scope:'Real API handlers and new PostgreSQL migrations. Invented Reddit/Engain responses and local database only. Tests do not prove live publication, LLM decision quality, or production multi-connection locking.',results};
  fs.mkdirSync(output,{recursive:true});fs.writeFileSync(path.join(output,'results.json'),JSON.stringify(report,null,2)+'\n');
  fs.writeFileSync(path.join(output,'index.html'),`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Reddit workflow verification</title>
    <style>body{font:16px/1.5 system-ui;background:#f4f5f7;color:#152235;margin:0}main{max-width:1000px;margin:auto;padding:24px}h1{font-size:32px}section{background:white;padding:20px;border:1px solid #d9dee7;border-radius:12px;margin:18px 0}.metrics{display:flex;gap:16px;flex-wrap:wrap}.metric{padding:14px;background:#edf3f6;border-radius:8px}table{width:100%;border-collapse:collapse}td,th{text-align:left;padding:10px;border-bottom:1px solid #ddd;vertical-align:top}.passed{color:#075f3a}.failed{color:#a81c25}input{box-sizing:border-box;width:100%;padding:12px;font:inherit}small{color:#4e596b}</style>
    <main><h1>Reddit workflow verification</h1><p>Fresh sessions, durable jobs, observable publication.</p><div class="metrics"><div class="metric">${report.summary.cases} scenarios</div><div class="metric passed">${report.summary.passed} passed</div><div class="metric failed">${report.summary.failed} failed</div></div>
    <section><b>What this proves</b><p>${esc(report.scope)}</p><small>Generated ${esc(report.at)}. This replaces the earlier defect-reproduction report.</small></section>
    <section><h2>Three schedules</h2><table><tr><th>Schedule</th><th>Responsibility</th></tr><tr><td>Tick · every 15 minutes</td><td>Sync, reconcile, poll posts and comments, verify Reddit visibility, discover replies, advance jobs and send approved work.</td></tr><tr><td>Agent · hourly</td><td>Bootstrap, claim, find threads or draft, checkpoint, file or complete.</td></tr><tr><td>Pullback · hourly</td><td>Request cancellation and retain the confirmed or unresolved outcome.</td></tr></table></section>
    <section><h2>Tested behavior</h2><label for="filter">Filter scenarios</label><input id="filter" placeholder="Try cancellation, nested, lease…"><table><thead><tr><th>Scenario</th><th>Result</th></tr></thead><tbody>${results.map(r=>`<tr class="case"><td>${esc(r.name)}${r.error?`<details><summary>Error</summary>${esc(r.error)}</details>`:''}</td><td class="${r.status}">${r.status}</td></tr>`).join('')}</tbody></table></section>
    <section><h2>Live readiness</h2><p>Engain read-only checks succeeded on 2026-10-06. The current key has no scoring project, and inspected failed/cancelled tasks supplied no reason. Deployment, an eligible attributed account and a controlled publishing destination are still required for a live publishing test.</p></section>
    <script>document.querySelector('#filter').addEventListener('input',e=>{for(const row of document.querySelectorAll('.case'))row.hidden=!row.textContent.toLowerCase().includes(e.target.value.toLowerCase())});</script></main></html>`);
  console.log(JSON.stringify(report.summary));if(report.summary.failed)process.exitCode=1;
})().catch(e=>{console.error(e);process.exitCode=1;});
