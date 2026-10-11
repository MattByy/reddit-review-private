const test=require('node:test'),assert=require('node:assert/strict');
const {checkPool}=require('../scripts/pool-check.cjs');
const env={AGENT_API_KEY:'fixture-agent-secret',AGENT_BASE_URL:'https://app.example/api/agent'};
const bootstrap={protocol_version:5,workflow:'message_experiments'};
const pool={available:true,mode:'pool',has_project:true};
const response=value=>new Response(JSON.stringify(value));

test('pool check uses exactly two authenticated GET requests and never exposes the key',async()=>{
  const calls=[];
  const result=await checkPool({env,fetchImpl:async(url,options)=>{calls.push({url,options});return response(url.endsWith('/bootstrap')?bootstrap:pool);}});
  assert.equal(result.ok,true);assert.equal(result.posting_performed,false);
  assert.deepEqual(calls.map(c=>c.url),[env.AGENT_BASE_URL+'/bootstrap',env.AGENT_BASE_URL+'/delivery']);
  for(const {options} of calls){assert.equal(options.method,'GET');assert.equal(options.body,undefined);assert.equal(options.redirect,'error');assert.equal(options.headers.Authorization,'Bearer '+env.AGENT_API_KEY);}
  assert.ok(!JSON.stringify(result).includes(env.AGENT_API_KEY));
  assert.match(result.configuration_note,/does not verify/);
});

test('missing credentials and unsafe base URLs stop before any request',async()=>{
  let calls=0;const fetchImpl=async()=>{calls++;throw Error('unexpected network');};
  assert.equal((await checkPool({env:{},fetchImpl})).ok,false);
  for(const base of ['http://public.example/api/agent','https://user:pass@app.example/api/agent','https://app.example/api/agent?key=secret','https://app.example/api/agent#fragment','https://app.example/wrong','file:///api/agent']){
    assert.equal((await checkPool({env:{...env,AGENT_BASE_URL:base},fetchImpl})).ok,false);
  }
  assert.equal(calls,0);
});

test('old protocol stops before probing delivery',async()=>{
  let calls=0;const result=await checkPool({env,fetchImpl:async()=>{calls++;return response({protocol_version:2});}});
  assert.equal(result.ok,false);assert.equal(calls,1);assert.match(result.checks[0].detail,/protocol 5/);
});

test('private mode and unavailable or incomplete pooled capability fail instead of falling back',async()=>{
  for(const delivery of [{...pool,mode:'private'},{...pool,available:false},{...pool,has_project:false},{}]){
    const result=await checkPool({env,fetchImpl:async url=>response(url.endsWith('/bootstrap')?bootstrap:delivery)});
    assert.equal(result.ok,false);assert.equal(result.checks.at(-1).name,'pooled_delivery');
  }
});

test('authentication failures, malformed JSON and network failures produce bounded safe diagnostics',async()=>{
  for(const fetchImpl of [async()=>new Response('private detail',{status:401}),async()=>new Response('not JSON'),async()=>{throw Error(env.AGENT_API_KEY);},async()=>response(null)]){
    const result=await checkPool({env,fetchImpl});assert.equal(result.ok,false);
    assert.ok(!JSON.stringify(result).includes(env.AGENT_API_KEY));assert.ok(!JSON.stringify(result).includes('private detail'));
  }
});
