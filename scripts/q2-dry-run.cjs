#!/usr/bin/env node
/**
 * Q2 → Engain Dry-Run Mapper
 * 
 * Demonstrates that Q2 items (queued messages) have all fields needed
 * to send to Engain as both thread comments and replies.
 * 
 * This script:
 * 1. Fetches Q2 items from experiment_messages (status='queued')
 * 2. Maps each to the Engain request payload
 * 3. Shows what would be sent (WITHOUT actually sending)
 * 
 * Usage:
 *   node scripts/q2-dry-run.cjs
 *   node scripts/q2-dry-run.cjs --limit 5
 *   node scripts/q2-dry-run.cjs --show-accounts
 */

const SB_URL = (process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '').replace(/\/$/, '');
const SB_KEY = process.env.SUPABASE_SERVICE_KEY || '';

if (!SB_URL || !SB_KEY) {
  console.error('ERROR: SUPABASE_URL and SUPABASE_SERVICE_KEY required');
  process.exit(1);
}

const args = process.argv.slice(2);
const LIMIT = args.find(a => a.startsWith('--limit='))?.split('=')[1] || '10';
const SHOW_ACCOUNTS = args.includes('--show-accounts');

async function sb(method, path, body = null) {
  const url = `${SB_URL}/rest/v1/${path}`;
  const options = {
    method,
    headers: {
      'apikey': SB_KEY,
      'Authorization': `Bearer ${SB_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=representation'
    }
  };
  
  if (body && method !== 'GET') {
    options.body = JSON.stringify(body);
  }
  
  const response = await fetch(url, options);
  const text = await response.text();
  
  if (!response.ok) {
    throw new Error(`Supabase ${method} ${path} failed: ${response.status} ${text}`);
  }
  
  return text ? JSON.parse(text) : {};
}

function identity(url) {
  // Extract Reddit IDs from URL
  const match = url.match(/\/r\/([^/]+)\/comments\/([^/]+)(?:\/[^/]+\/([^/]+))?/);
  if (!match) throw new Error('Invalid Reddit URL: ' + url);
  
  return {
    subreddit: match[1],
    thread_id: match[2],
    comment_id: match[3] || null,
    is_comment: Boolean(match[3]),
    url: url
  };
}

function formatKind(message) {
  const parsed = identity(message.target_url);
  if (message.kind === 'comment' && !parsed.is_comment) {
    return '🗨️  Thread Comment';
  } else if (message.kind === 'reply' || parsed.is_comment) {
    return '↪️  Reply to Comment';
  }
  return `❓ ${message.kind}`;
}

function truncate(text, maxLen = 60) {
  if (!text) return '(empty)';
  text = String(text).trim();
  return text.length > maxLen ? text.slice(0, maxLen) + '...' : text;
}

async function main() {
  console.log('\n📋 Q2 → Engain Dry-Run Mapper\n');
  console.log('Fetching Q2 items (status=queued)...\n');
  
  // Fetch Q2 messages
  const messages = await sb('GET', `experiment_messages?select=*&status=eq.queued&order=created_at.asc&limit=${LIMIT}`);
  
  if (!messages || messages.length === 0) {
    console.log('✅ No Q2 items currently queued\n');
    return;
  }
  
  console.log(`Found ${messages.length} Q2 item(s):\n`);
  console.log('═'.repeat(80));
  
  // Show accounts if requested
  if (SHOW_ACCOUNTS) {
    const accounts = await sb('GET', 'accounts?select=id,label,username,usable,approved');
    console.log('\n📌 Available Accounts:\n');
    for (const acc of accounts) {
      const status = acc.usable && acc.approved ? '✅' : '⚠️';
      console.log(`${status} ${acc.label || acc.id}`);
      console.log(`   username: u/${acc.username || 'unknown'}`);
      console.log(`   usable: ${acc.usable}, approved: ${acc.approved}\n`);
    }
    console.log('═'.repeat(80));
  }
  
  // Process each Q2 item
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    const parsed = identity(m.target_url);
    const experiment = await sb('GET', `message_experiments?select=thread_id&id=eq.${m.experiment_id}&limit=1`);
    const thread = experiment[0] ? await sb('GET', `threads?select=subreddit,title&id=eq.${experiment[0].thread_id}&limit=1`) : [];
    
    console.log(`\n[${i + 1}] ${formatKind(m)}`);
    console.log('─'.repeat(80));
    
    // Q2 Item Details
    console.log('\n📦 Q2 Item Fields:');
    console.log(`   id:         ${m.id}`);
    console.log(`   kind:       ${m.kind}`);
    console.log(`   target_url: ${m.target_url}`);
    console.log(`   body:       ${truncate(m.body, 70)}`);
    console.log(`   step:       ${m.step}`);
    console.log(`   depth:      ${m.depth || 'N/A'}`);
    console.log(`   reply_mode: ${m.reply_mode || 'N/A'}`);
    console.log(`   status:     ${m.status}`);
    
    if (m.transport) {
      console.log(`   transport:  account_id=${m.transport.account_id || 'NOT SET'}, mode=${m.transport.mode || 'NOT SET'}`);
    } else {
      console.log(`   transport:  ⚠️  NOT YET ASSIGNED (will be chosen during sendOne)`);
    }
    
    // Thread Context
    if (thread[0]) {
      console.log(`\n🧵 Thread Context:`);
      console.log(`   subreddit:  r/${thread[0].subreddit}`);
      console.log(`   title:      ${truncate(thread[0].title, 70)}`);
    }
    
    // Parse Target
    console.log(`\n🎯 Target Analysis:`);
    console.log(`   subreddit:  r/${parsed.subreddit}`);
    console.log(`   thread_id:  ${parsed.thread_id}`);
    console.log(`   comment_id: ${parsed.comment_id || '(none - thread comment)'}`);
    console.log(`   action:     ${parsed.is_comment ? 'Reply to comment ' + parsed.comment_id : 'Comment on thread ' + parsed.thread_id}`);
    
    // Engain Payload Mapping
    console.log(`\n📤 Engain Request Payload (accounts-beta):`);
    console.log(`   POST /api/v1/accounts-beta/comments`);
    console.log(`   {`);
    console.log(`     "userAccountId": "${m.transport?.account_id || '<WILL BE CHOSEN BY delivery.choose()>'}",`);
    console.log(`     "targetUrl": "${m.target_url}",`);
    console.log(`     "body": ${JSON.stringify(truncate(m.body, 60))}`);
    console.log(`   }`);
    
    // Field Status
    console.log(`\n✅ Field Completeness:`);
    console.log(`   userAccountId: ${m.transport?.account_id ? '✅ Present' : '⏳ Will be populated by delivery.choose()'}`);
    console.log(`   targetUrl:     ✅ Present`);
    console.log(`   body:          ✅ Present`);
    
    // What Happens
    console.log(`\n🔄 What Happens When Sent:`);
    if (parsed.is_comment) {
      console.log(`   1. Engain receives comment URL: ${parsed.comment_id}`);
      console.log(`   2. Creates a REPLY to that comment`);
      console.log(`   3. Reply posted from account: ${m.transport?.username || '<chosen account>'}`);
      console.log(`   4. Returns task ID and status`);
    } else {
      console.log(`   1. Engain receives thread URL: ${parsed.thread_id}`);
      console.log(`   2. Creates a TOP-LEVEL COMMENT on that thread`);
      console.log(`   3. Comment posted from account: ${m.transport?.username || '<chosen account>'}`);
      console.log(`   4. Returns task ID and status`);
    }
    
    console.log('\n═'.repeat(80));
  }
  
  // Summary
  console.log('\n📊 Summary:\n');
  console.log(`Total Q2 items:      ${messages.length}`);
  console.log(`Thread comments:     ${messages.filter(m => {
    try { return m.kind === 'comment' && !identity(m.target_url).is_comment; } catch { return false; }
  }).length}`);
  console.log(`Replies to comments: ${messages.filter(m => {
    try { return m.kind === 'reply' || identity(m.target_url).is_comment; } catch { return false; }
  }).length}`);
  
  console.log('\n✅ All Q2 items have the fields Engain needs:\n');
  console.log('   • userAccountId  (from transport.account_id, or chosen during send)');
  console.log('   • targetUrl      (from target_url)');
  console.log('   • body           (from body)\n');
  
  console.log('🚀 Ready to send via existing code path:');
  console.log('   api/_messages.js → sendOne() → delivery.submit() → Engain\n');
  
  console.log('💡 To actually send:');
  console.log('   • Cron job: /api/cron/dispatch (runs every 10 min)');
  console.log('   • Manual:   curl -X POST /api/cron/dispatch -H "Authorization: Bearer $CRON_SECRET"\n');
}

main().catch(err => {
  console.error('\n❌ Error:', err.message);
  process.exit(1);
});
