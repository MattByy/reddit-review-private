#!/usr/bin/env node
// Setup autonomous sending with Featherless MiniMax-M3 model
// Run: node scripts/setup-autonomous.js

const http = require('node:http');

const API = process.env.API || 'http://127.0.0.1:3000';
const AGENT_KEY = process.env.AGENT_API_KEY;

if (!AGENT_KEY) {
  console.error('Set AGENT_API_KEY in .env.local and restart the server first.');
  process.exit(1);
}

const post = async (path, body) => {
  return new Promise((resolve, reject) => {
    const url = new URL(path, API);
    const req = http.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${AGENT_KEY}`
      }
    }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        const result = JSON.parse(data);
        if (res.status >= 400) reject(new Error(result.error || `HTTP ${res.status}`));
        else resolve(result);
      });
    });
    req.on('error', reject);
    req.write(JSON.stringify(body));
    req.end();
  });
};

const get = async (path) => {
  return new Promise((resolve, reject) => {
    const url = new URL(path, API);
    http.get(url, {
      headers: { 'Authorization': `Bearer ${AGENT_KEY}` }
    }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        const result = JSON.parse(data);
        if (res.status >= 400) reject(new Error(result.error || `HTTP ${res.status}`));
        else resolve(result);
      });
    }).on('error', reject);
  });
};

async function setup() {
  console.log('Setting up autonomous sending with Featherless MiniMax-M3...\n');

  // 1. Check server status
  console.log('1. Checking server status...');
  const status = await get('/api/status');
  console.log(`   Server: ${status.project_name || 'Geonode'} (${status.mock ? 'MOCK' : 'live'})`);
  console.log(`   Queue 1: ${status.queued} items\n`);

  // 2. Get current prompts
  console.log('2. Reading current prompts...');
  const prompts = await get('/api/prompts');
  
  // 3. Add Featherless MiniMax-M3 prompt for thread type
  console.log('3. Adding Featherless MiniMax-M3 prompt (thread type)...');
  try {
    const threadPrompt = await post('/api/prompt-variants', {
      type: 'thread',
      name: 'Natural MiniMax',
      style: 'natural',
      provider: 'featherless',
      model: 'MiniMaxAI/MiniMax-M3',
      temperature: 0.8
    });
    console.log(`   Created: "${threadPrompt.variant.name}" (${threadPrompt.variant.id})`);
    console.log(`   Provider: Featherless, Model: MiniMaxAI/MiniMax-M3\n`);
  } catch (e) {
    if (e.message.includes('already exists') || e.status === 409) {
      console.log('   Prompt already exists, skipping\n');
    } else throw e;
  }

  // 4. Add Featherless MiniMax-M3 prompt for comment type
  console.log('4. Adding Featherless MiniMax-M3 prompt (comment type)...');
  try {
    const commentPrompt = await post('/api/prompt-variants', {
      type: 'comment',
      name: 'Natural MiniMax',
      style: 'natural',
      provider: 'featherless',
      model: 'MiniMaxAI/MiniMax-M3',
      temperature: 0.8
    });
    console.log(`   Created: "${commentPrompt.variant.name}" (${commentPrompt.variant.id})`);
    console.log(`   Provider: Featherless, Model: MiniMaxAI/MiniMax-M3\n`);
  } catch (e) {
    if (e.message.includes('already exists') || e.status === 409) {
      console.log('   Prompt already exists, skipping\n');
    } else throw e;
  }

  // 5. Set percentages (50/50 split between Default and Natural MiniMax)
  console.log('5. Setting prompt percentages (50% Default, 50% Natural MiniMax)...');
  
  // Get current prompt IDs
  const threadVariants = prompts.variants.thread;
  const commentVariants = prompts.variants.comment;
  
  const defaultThreadId = threadVariants.find(v => v.name === 'Default')?.id;
  const minimaxThreadId = threadVariants.find(v => v.name === 'Natural MiniMax')?.id;
  const defaultCommentId = commentVariants.find(v => v.name === 'Default')?.id;
  const minimaxCommentId = commentVariants.find(v => v.name === 'Natural MiniMax')?.id;

  // Set thread weights
  await post('/api/prompts/weights', {
    type: 'thread',
    weights: {
      [defaultThreadId || 'Default']: 50,
      [minimaxThreadId || 'Natural MiniMax']: 50
    }
  });
  console.log('   Thread prompts: 50% Default (OpenRouter), 50% Natural MiniMax (Featherless)');

  // Set comment weights
  await post('/api/prompts/weights', {
    type: 'comment',
    weights: {
      [defaultCommentId || 'Default']: 50,
      [minimaxCommentId || 'Natural MiniMax']: 50
    }
  });
  console.log('   Comment prompts: 50% Default (OpenRouter), 50% Natural MiniMax (Featherless)\n');

  // 6. Configure queue settings for autonomous operation
  console.log('6. Configuring queue settings for autonomous operation...');
  const currentSettings = await get('/api/settings');
  const autonomousSettings = {
    ...currentSettings,
    queue_target: 50,
    threads_every_minutes: 10,
    comments_every_minutes: 30,
    tracker_every_minutes: 10,
    thread_collect_minutes: 60,
    comment_limit: 20,
    comment_position: 5
  };
  
  await post('/api/settings', autonomousSettings);
  console.log('   Queue target: 50 items');
  console.log('   Threads job: every 10 minutes');
  console.log('   Comments job: every 30 minutes');
  console.log('   Tracker job: every 10 minutes\n');

  // 7. Check jobs status
  console.log('7. Checking scheduled jobs...');
  const jobs = await get('/api/jobs');
  Object.entries(jobs).forEach(([name, info]) => {
    const status = info.running ? 'running' : (info.next_run ? `next ${new Date(info.next_run).toLocaleTimeString()}` : 'not scheduled');
    console.log(`   ${name}: ${status}`);
  });
  console.log('');

  // 8. Summary
  console.log('✅ Autonomous sending setup complete!\n');
  console.log('What happens next:');
  console.log('  • Threads job collects new Reddit threads every 10 min');
  console.log('  • Comments job checks published comments every 30 min');
  console.log('  • Tracker job monitors sent items every 10 min');
  console.log('  • Queue 1 fills with ranked threads and comments');
  console.log('  • Queue 2 drafts messages with 50% OpenRouter / 50% Featherless MiniMax-M3');
  console.log('  • Approve Queue 2 items to auto-send to Reddit\n');
  
  console.log('Manual approval flow (current):');
  console.log('  1. GET /api/agent/queue2 - review drafted items');
  console.log('  2. POST /api/agent/queue2/:id/approve - approve and send\n');

  console.log('For fully autonomous sending (no manual approval):');
  console.log('  Add auto-approve logic to the comments job or create a cron job that:');
  console.log('  - Claims Queue 1 items → POST /api/agent/task?write=true');
  console.log('  - Auto-approves ready drafts → POST /api/agent/queue2/:id/approve');
  console.log('  See scripts/auto-approve.js for a reference implementation.\n');
}

setup().catch(e => {
  console.error('\nSetup failed:', e.message);
  process.exit(1);
});