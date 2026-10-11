const {test}=require('node:test');
const assert=require('node:assert/strict');
const {randomBytes,createHash,randomUUID}=require('node:crypto');
const {Harness}=require('./workflow-harness.cjs');
const password='a long dashboard test password';
const originHeaders={origin:'https://fixture.test',host:'fixture.test','content-type':'application/json','x-forwarded-for':'192.0.2.1'};
async function setup(t){
  const h=await new Harness().init();t.after(()=>h.close());
  const token=randomBytes(32).toString('base64url');
  await h.sql("update dashboard_admin set setup_token_hash=$1,setup_expires_at=now()+interval '1 hour'",[createHash('sha256').update(token).digest('hex')]);
  const request=(body,headers={},method='POST')=>h.call(h.session,'/api/session',body,method,null,{...originHeaders,...headers});
  return {h,token,request};
}
const cookie=result=>result.headers['set-cookie'].split(';')[0];
test('password setup is private and single-use; only a hashed credential and token are stored',async t=>{
  const {h,token,request}=await setup(t);
  for(const table of ['dashboard_admin','dashboard_sessions','dashboard_login_limits']){
    assert.equal((await h.sql('select has_table_privilege(\'anon\',$1,\'select\') allowed',[table]))[0].allowed,false);
    assert.equal((await h.sql('select has_table_privilege(\'authenticated\',$1,\'update\') allowed',[table]))[0].allowed,false);
  }
  assert.equal((await h.sql("select has_function_privilege('anon','setup_dashboard_admin(text,text)','execute') allowed"))[0].allowed,false);
  assert.equal((await request({action:'setup',password,setup_token:randomBytes(32).toString('base64url')})).status,401);
  assert.equal((await request({action:'setup',password:'2005',setup_token:token})).status,422);
  const results=await Promise.all([request({action:'setup',password,setup_token:token}),request({action:'setup',password,setup_token:token})]);
  assert.equal(results.filter(r=>r.status===200).length,1,JSON.stringify(results));
  const result=results.find(r=>r.status===200);
  assert.match(result.headers['set-cookie'],/HttpOnly; SameSite=Strict/);assert.match(result.headers['set-cookie'],/Max-Age=2592000; Secure/);
  const [admin]=await h.sql('select * from dashboard_admin');assert.match(admin.password_hash,/^scrypt:/);assert.ok(!admin.password_hash.includes(password));assert.equal(admin.setup_token_hash,null);
  const [session]=await h.sql('select * from dashboard_sessions');assert.notEqual(session.token_hash,cookie(result).split('=')[1]);
  assert.equal((await request({action:'setup',password,setup_token:token})).status,401);
  assert.equal((await request(undefined,{cookie:cookie(result)},'GET')).body.authenticated,true);
  assert.equal((await request({action:'login',password:'2005'})).status,401,'The old public page code grants no access');
  assert.equal((await request({action:'login',password})).status,200);
});
test('one dashboard session starts runs and edits drafts without an operator key',async t=>{
  const {h,token,request}=await setup(t);await h.thread();
  await h.sql("insert into accounts(id,label,reddit_username,usable) values('account-b','B','geonode_b',true)");
  const logged=await request({action:'setup',password,setup_token:token}),headers={...originHeaders,cookie:cookie(logged)};
  const act=body=>h.call(h.operator,'/api/operator',body,'POST',null,headers);
  const run=await act({rpc:'start_playbook_run',args:{p_sequence_id:'bdb2d105-817b-4e40-8849-9f93a7d00001',p_thread_id:'abc123',p_account_a:'test-account',p_account_b:'account-b',p_request_id:randomUUID()}});
  assert.equal(run.status,200,JSON.stringify(run));
  const draft=await h.file();
  const stopped=await act({rpc:'update_queued_draft',args:{p_draft_id:draft.id,p_action:'stop',p_body:null,p_account_id:null}});
  assert.equal(stopped.status,200);assert.equal(stopped.body.status,'rejected');
  assert.equal(h.vendor.length,0);
});
test('anonymous, cross-origin, forged and expired sessions cannot authorize writes',async t=>{
  const {h,token,request}=await setup(t),logged=await request({action:'setup',password,setup_token:token});
  const headers={...originHeaders,cookie:cookie(logged)},act=extra=>h.call(h.operator,'/api/operator',{},'POST',null,{...headers,...extra});
  assert.equal((await act({cookie:''})).status,401);
  assert.equal((await act({origin:'https://attacker.test'})).status,401);
  assert.equal((await act({origin:undefined})).status,401);
  assert.equal((await act({cookie:'__Host-reddit_admin='+randomBytes(32).toString('base64url')})).status,401);
  assert.equal((await request({action:'login',password},{origin:'https://attacker.test'})).status,403);
  assert.equal((await h.call(h.dispatch,'/api/dispatch',{},'POST',null,{...headers,origin:'https://attacker.test'})).status,401);
  assert.equal((await act({})).status,422,'Authorized request reaches normal action validation');
  await h.sql("update dashboard_sessions set expires_at=now()-interval '1 second'");
  assert.equal((await act({})).status,401);
  assert.equal((await request(undefined,headers,'GET')).body.authenticated,false);
  assert.equal((await h.call(h.operator,'/api/operator',{},'POST','test-operator')).status,422,'Server API credentials still work');
});
test('sign-out revokes the session on the server even when its old cookie is replayed',async t=>{
  const {h,token,request}=await setup(t),logged=await request({action:'setup',password,setup_token:token}),headers={cookie:cookie(logged)};
  const loggedOut=await request({action:'logout'},headers);
  assert.equal(loggedOut.status,200);assert.match(loggedOut.headers['set-cookie'],/Max-Age=0/);
  assert.equal((await request(undefined,headers,'GET')).body.authenticated,false);
  assert.equal((await h.sql('select count(*)::int n from dashboard_sessions'))[0].n,0);
});
test('failed login attempts are throttled across requests and the limit expires',async t=>{
  const {h,token,request}=await setup(t);await request({action:'setup',password,setup_token:token});
  for(let i=0;i<9;i++)assert.equal((await request({action:'login',password:'wrong'})).status,401);
  assert.equal((await request({action:'login',password})).status,429);
  await h.sql("update dashboard_login_limits set window_start=now()-interval '16 minutes'");
  assert.equal((await request({action:'login',password})).status,200);
});
test('expired setup links fail without setting a password or issuing a session',async t=>{
  const {h,token,request}=await setup(t);await h.sql("update dashboard_admin set setup_expires_at=now()-interval '1 second'");
  assert.equal((await request({action:'setup',password,setup_token:token})).status,401);
  assert.equal((await h.sql('select password_hash from dashboard_admin'))[0].password_hash,null);
  assert.equal((await h.sql('select count(*)::int n from dashboard_sessions'))[0].n,0);
});
