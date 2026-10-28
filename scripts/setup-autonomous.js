#!/usr/bin/env node
// Setup autonomous sending with custom prompts
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
  console.log('Setting up autonomous sending with custom prompts...\n');

  // 1. Check server status
  console.log('1. Checking server status...');
  const status = await get('/api/status');
  console.log(`   Server: ${status.project_name || 'Geonode'} (${status.mock ? 'MOCK' : 'live'})`);
  console.log(`   Queue 1: ${status.queued} items\n`);

  // 2. Get current prompts
  console.log('2. Reading current prompts...');
  const prompts = await get('/api/prompts');

  // 3. Create Thread Prompts (60/40 split)
  console.log('3. Creating thread prompts (60/40 split)...');
  
  // 60%: Question-based, no GeoNode mention
  try {
    const threadQuestionPrompt = await post('/api/prompt-variants', {
      type: 'thread',
      name: 'Thread Question - Seeking Advice',
      style: 'natural',
      provider: 'featherless',
      model: 'MiniMaxAI/MiniMax-M3',
      temperature: 0.8,
      instructions: `You're responding to a Reddit thread. Write a thoughtful question that invites discussion and naturally encourages others to share their experiences with tools or services they've used.

**Approach:**
- Start with a brief personal story or observation (2-3 sentences)
- Ask an open-ended question that relates to the thread topic
- Make it feel genuine and conversational
- Keep it to 3-5 sentences total

**What to avoid:**
- Do NOT mention GeoNode or any specific company
- Don't sound promotional or like you're selling anything
- Avoid overly polished language - be natural and slightly informal

**Goal:** The question should be structured so that helpful replies would naturally mention tools, services, or resources they've found useful - creating an opening for others to recommend solutions like proxy providers.

**Tone:** Curious, engaged community member who's done some research and wants to learn from others' experiences.`
    });
    console.log(`   ✓ Created: "${threadQuestionPrompt.variant.name}" (60%)`);
    console.log(`     Provider: Featherless, Model: MiniMaxAI/MiniMax-M3`);
    console.log(`     Focus: Question-based, encourages proxy recommendations\n`);
  } catch (e) {
    if (e.message.includes('already exists') || e.status === 409) {
      console.log('   ✓ Prompt already exists\n');
    } else throw e;
  }

  // 40%: Direct GeoNode mention
  try {
    const threadGeoNodePrompt = await post('/api/prompt-variants', {
      type: 'thread',
      name: 'Thread Response - GeoNode Mention',
      style: 'natural',
      provider: 'featherless',
      model: 'MiniMaxAI/MiniMax-M3',
      temperature: 0.7,
      instructions: `You're responding to a Reddit thread. Write a helpful response that mentions GeoNode as a relevant resource or tool.

**Approach:**
- Acknowledge the thread topic and add your perspective
- Mention GeoNode naturally as part of your experience or recommendation
- Keep it conversational and helpful, not promotional
- 3-5 sentences

**How to mention GeoNode:**
- Reference it as something you've used or found useful
- Connect it to the thread topic in a specific way
- Make it feel like a genuine share, not an advertisement

**Tone:** Knowledgeable community member who's contributing useful information.`
    });
    console.log(`   ✓ Created: "${threadGeoNodePrompt.variant.name}" (40%)`);
    console.log(`     Provider: Featherless, Model: MiniMaxAI/MiniMax-M3`);
    console.log(`     Focus: Direct GeoNode mention in thread response\n`);
  } catch (e) {
    if (e.message.includes('already exists') || e.status === 409) {
      console.log('   ✓ Prompt already exists\n');
    } else throw e;
  }

  // 4. Create Comment Prompt (100%)
  console.log('4. Creating comment prompt (100%)...');
  
  try {
    const commentPrompt = await post('/api/prompt-variants', {
      type: 'comment',
      name: 'Comment Reply - Chill GeoNode Recommendation',
      style: 'natural',
      provider: 'featherless',
      model: 'MiniMaxAI/MiniMax-M3',
      temperature: 0.85,
      instructions: `You're replying to a comment in a Reddit thread. Write a casual, helpful response that mentions GeoNode in a relaxed, nonchalant way.

**Approach:**
- Be the chill guy who doesn't really give a shit but knows his stuff
- Explain what's going on in the thread in a straightforward way
- Drop GeoNode into the conversation naturally - like you're just mentioning it in passing
- Keep it conversational, maybe a bit laid-back
- 3-5 sentences

**How to mention GeoNode:**
- Bring it up as something you happen to use or know about
- Connect it to what the commenter said
- Make it feel effortless, like you're just sharing what works for you
- No hard sell, no enthusiasm overload

**Tone:** Relaxed, knowledgeable, slightly casual - someone who's seen it all and is just offering a helpful perspective without trying too hard.`
    });
    console.log(`   ✓ Created: "${commentPrompt.variant.name}" (100%)`);
    console.log(`     Provider: Featherless, Model: MiniMaxAI/MiniMax-M3`);
    console.log(`     Focus: Chill, nonchalant GeoNode recommendation\n`);
  } catch (e) {
    if (e.message.includes('already exists') || e.status === 409) {
      console.log('   ✓ Prompt already exists\n');
    } else throw e;
  }

  // 5. Set percentages (60/40 split for threads, 100% for comments)
  console.log('5. Setting prompt percentages...');
  
  // Get current prompt IDs
  const threadVariants = prompts.variants.thread;
  const commentVariants = prompts.variants.comment;
  
  // Find the new prompts
  const questionThreadId = threadVariants.find(v => v.name === 'Thread Question - Seeking Advice')?.id;
  const geonodeThreadId = threadVariants.find(v => v.name === 'Thread Response - GeoNode Mention')?.id;
  const commentId = commentVariants.find(v => v.name === 'Comment Reply - Chill GeoNode Recommendation')?.id;
  
  // Set thread weights (60/40)
  await post('/api/prompts/weights', {
    type: 'thread',
    weights: {
      [questionThreadId || 'Thread Question - Seeking Advice']: 60,
      [geonodeThreadId || 'Thread Response - GeoNode Mention']: 40
    }
  });
  console.log('   ✓ Thread prompts: 60% Question (no GeoNode), 40% GeoNode mention');

  // Set comment weights (100%)
  await post('/api/prompts/weights', {
    type: 'comment',
    weights: {
      [commentId || 'Comment Reply - Chill GeoNode Recommendation']: 100
    }
  });
  console.log('   ✓ Comment prompts: 100% Chill GeoNode Recommendation\n');

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
  console.log('   ✓ Queue target: 50 items');
  console.log('   ✓ Threads collection: every 10 minutes');
  console.log('   ✓ Comments check: every 30 minutes');
  console.log('   ✓ Status tracker: every 10 minutes\n');

  // 7. Check jobs status
  console.log('7. Checking scheduled jobs...');
  const jobs = await get('/api/jobs');
  Object.entries(jobs).forEach(([name, info]) => {
    const status = info.running ? 'running' : (info.next_run ? `next ${new Date(info.next_run).toLocaleTimeString()}` : 'not scheduled');
    console.log(`   ${name}: ${status}`);
  });
  console.log('');

  // 8. Summary
  console.log('════════════════════════════════════════════════');
  console.log('SETUP COMPLETE');
  console.log('════════════════════════════════════════════════');
  console.log('\nPrompts configured:');
  console.log('  THREADS (60/40 split):');
  console.log('    • 60% - Thread Question (no GeoNode, encourages recommendations)');
  console.log('    • 40% - Thread Response (GeoNode mention)');
  console.log('\n  COMMENTS (100%):');
  console.log('    • 100% - Comment Reply (chill GeoNode recommendation)');
  console.log('\nAll prompts use: Featherless / MiniMaxAI/MiniMax-M3');
  console.log('\nNext steps:');
  console.log('  1. Monitor Queue 1 filling: GET /api/queue');
  console.log('  2. Run auto-approve: npm run auto-approve');
  console.log('  3. Check prompt performance: GET /api/prompts');
  console.log('\n');
}

// Run
setup().catch(err => {
  console.error('Setup failed:', err.message);
  process.exit(1);
});
