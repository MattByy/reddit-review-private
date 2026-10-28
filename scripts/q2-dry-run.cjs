#!/usr/bin/env node
/**
 * Queue2 → Engain Dry-Run Mapper (CORRECTED)
 * 
 * Reads the local dev server's queue2 SQLite table and shows what WOULD be sent
 * to Engain for each item, WITHOUT actually sending anything.
 * 
 * This script:
 * 1. Opens the dev server's SQLite database (.data/dev.db or .data/dev-mock.db)
 * 2. Fetches all queue2 items
 * 3. Maps each to the Engain request payload
 * 4. REFUSES to map placeholder messages (message_source='random')
 * 5. Shows what's missing (userAccountId, disclosure, etc.)
 * 
 * Usage:
 *   node scripts/q2-dry-run.cjs
 *   node scripts/q2-dry-run.cjs --db .data/dev.db
 *   node scripts/q2-dry-run.cjs --limit 5
 *   node scripts/q2-dry-run.cjs --show-placeholders
 */

const path = require('node:path');
const fs = require('node:fs');

const args = process.argv.slice(2);
const DB_PATH = args.find(a => a.startsWith('--db='))?.split('=')[1] || 
                path.join(__dirname, '..', '.data', 'dev.db');
const LIMIT = parseInt(args.find(a => a.startsWith('--limit='))?.split('=')[1]) || 100;
const SHOW_PLACEHOLDERS = args.includes('--show-placeholders');

// Check if database exists
if (!fs.existsSync(DB_PATH)) {
  console.error(`\n❌ Database not found: ${DB_PATH}`);
  console.error('\nMake sure the dev server has run at least once:');
  console.error('  npm run dev');
  console.error('  # or');
  console.error('  npm run dev:mock\n');
  process.exit(1);
}

const {DatabaseSync} = require('node:sqlite');

function truncate(text, maxLen = 60) {
  if (!text) return '(empty)';
  text = String(text).trim();
  return text.length > maxLen ? text.slice(0, maxLen) + '...' : text;
}

function formatKind(kind) {
  const icons = {thread: '🧵', comment: '💬', mention: '↪️'};
  const labels = {
    thread: 'Thread Comment (top-level)',
    comment: 'Reply to Our Comment',
    mention: 'Reply to Competitor Mention'
  };
  return `${icons[kind] || '❓'} ${labels[kind] || kind}`;
}

function analyzeUrl(url) {
  if (!url) return {valid: false, type: 'missing', reason: 'URL is null or empty'};
  
  // Reddit URL format: /r/{sub}/comments/{thread_id}/{slug}/{comment_id}/
  const match = url.match(/\/r\/([^/]+)\/comments\/([^/]+)(?:\/[^/]+\/([^/]+))?/);
  
  if (!match) {
    return {valid: false, type: 'invalid', reason: 'Not a valid Reddit URL format'};
  }
  
  const [, subreddit, threadId, commentId] = match;
  
  if (commentId) {
    return {
      valid: true,
      type: 'comment',
      subreddit,
      threadId,
      commentId,
      action: 'Reply to comment ' + commentId,
      engainAction: 'POST /api/v1/accounts-beta/comments (reply)'
    };
  } else {
    return {
      valid: true,
      type: 'thread',
      subreddit,
      threadId,
      action: 'Comment on thread ' + threadId,
      engainAction: 'POST /api/v1/accounts-beta/comments (thread comment)'
    };
  }
}

function checkDisclosure(message) {
  // Simple check: does message mention GeoNode?
  const hasGeoNode = /geonode/i.test(message);
  const hasDisclosure = /\b(disclosure|disclaimer|affiliated|work\s+for|employed\s+by|represent)\b/i.test(message);
  
  if (!hasGeoNode) {
    return {ok: false, reason: 'No GeoNode mention found'};
  }
  
  if (!hasDisclosure) {
    return {ok: false, reason: 'GeoNode mentioned but no disclosure language'};
  }
  
  return {ok: true, reason: 'Contains GeoNode mention and disclosure keywords'};
}

function analyzeGaps(item, urlAnalysis, disclosure) {
  const gaps = [];
  
  // Critical gaps
  if (item.message_source === 'random') {
    gaps.push('❌ BLOCKER: Placeholder message (message_source=random) - CANNOT SEND');
  }
  
  if (!disclosure.ok) {
    gaps.push(`❌ BLOCKER: ${disclosure.reason} - transparency violation`);
  }
  
  // Missing required fields
  gaps.push('❌ MISSING: userAccountId (which Engain account to post from)');
  gaps.push('❌ MISSING: projectId (may be in config but not in item)');
  
  // Missing safety gates
  gaps.push('⚠️  NO CHECK: Duplicate send protection (no status tracking)');
  gaps.push('⚠️  NO CHECK: Rate limiting (45min global / 24h per subreddit)');
  gaps.push('⚠️  NO CHECK: Thread already engaged (one account per thread)');
  gaps.push('⚠️  NO CHECK: Parent still exists (for replies)');
  gaps.push('⚠️  NO CHECK: Engain rule validation');
  gaps.push('⚠️  NO CHECK: Forbidden phrases ("85,000", "we own the network")');
  
  return gaps;
}

function main() {
  console.log('\n📋 Queue2 → Engain Dry-Run Mapper\n');
  console.log(`Database: ${DB_PATH}\n`);
  
  const db = new DatabaseSync(DB_PATH);
  
  // Fetch queue2 items
  const items = db.prepare('SELECT * FROM queue2 ORDER BY id DESC LIMIT ?').all(LIMIT);
  
  if (!items || items.length === 0) {
    console.log('✅ No items in queue2\n');
    console.log('To create queue2 items:');
    console.log('  1. Start the dev server: npm run dev');
    console.log('  2. Run a collection: POST http://127.0.0.1:3000/api/collect');
    console.log('  3. Claim an item: POST http://127.0.0.1:3000/api/agent/task\n');
    db.close();
    return;
  }
  
  console.log(`Found ${items.length} queue2 item(s):\n`);
  console.log('═'.repeat(80));
  
  let sendable = 0;
  let blocked = 0;
  
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    
    try {
      item.item = JSON.parse(item.item);
    } catch (e) {
      item.item = {error: 'Failed to parse item JSON'};
    }
    
    const isPlaceholder = item.message_source === 'random';
    const urlAnalysis = analyzeUrl(item.url);
    const disclosure = checkDisclosure(item.message);
    const gaps = analyzeGaps(item, urlAnalysis, disclosure);
    
    const canSend = !isPlaceholder && disclosure.ok && urlAnalysis.valid;
    
    if (canSend) sendable++;
    else blocked++;
    
    // Skip placeholders unless --show-placeholders
    if (isPlaceholder && !SHOW_PLACEHOLDERS) {
      continue;
    }
    
    console.log(`\n[${i + 1}] ${formatKind(item.kind)} ${canSend ? '' : '🚫'}`);
    console.log('─'.repeat(80));
    
    // Queue2 Item Details
    console.log('\n📦 Queue2 Item:');
    console.log(`   ID:             ${item.id}`);
    console.log(`   item_id:        ${item.item_id}`);
    console.log(`   kind:           ${item.kind}`);
    console.log(`   url:            ${item.url || '(null)'}`);
    console.log(`   thread_url:     ${item.thread_url || '(null)'}`);
    console.log(`   title:          ${truncate(item.title, 60) || '(null)'}`);
    console.log(`   message:        ${truncate(item.message, 70)}`);
    console.log(`   message_source: ${item.message_source} ${isPlaceholder ? '⚠️  PLACEHOLDER' : '✅'}`);
    console.log(`   created_by:     ${item.created_by || '(null)'}`);
    console.log(`   created_at:     ${item.created_at}`);
    
    // URL Analysis
    console.log(`\n🎯 Target Analysis:`);
    if (urlAnalysis.valid) {
      console.log(`   ✅ URL Format: Valid Reddit ${urlAnalysis.type} URL`);
      console.log(`   Subreddit:     r/${urlAnalysis.subreddit}`);
      console.log(`   Thread ID:     ${urlAnalysis.threadId}`);
      if (urlAnalysis.commentId) {
        console.log(`   Comment ID:    ${urlAnalysis.commentId}`);
      }
      console.log(`   Action:        ${urlAnalysis.action}`);
      console.log(`   Engain:        ${urlAnalysis.engainAction}`);
    } else {
      console.log(`   ❌ URL Format: ${urlAnalysis.reason}`);
    }
    
    // Disclosure Check
    console.log(`\n🔍 Disclosure Check:`);
    if (disclosure.ok) {
      console.log(`   ✅ ${disclosure.reason}`);
    } else {
      console.log(`   ❌ ${disclosure.reason}`);
    }
    
    // Engain Payload
    console.log(`\n📤 Engain Request Payload (IF sent):`);
    console.log(`   POST /api/v1/accounts-beta/comments`);
    console.log(`   {`);
    console.log(`     "userAccountId": "<MISSING - MUST BE PROVIDED>",`);
    console.log(`     "targetUrl": "${item.url || '<MISSING>'}",`);
    console.log(`     "body": ${JSON.stringify(truncate(item.message, 50))}`);
    console.log(`   }`);
    
    // Gaps
    console.log(`\n⚠️  Gaps & Missing Safety Gates:`);
    for (const gap of gaps) {
      console.log(`   ${gap}`);
    }
    
    // Send Status
    console.log(`\n🚦 Send Status:`);
    if (isPlaceholder) {
      console.log(`   ❌ BLOCKED: Placeholder message cannot be sent`);
      console.log(`   Action:     Replace with real message via:`);
      console.log(`               POST /api/agent/queue2/${item.id} {"message":"..."}`);
    } else if (!disclosure.ok) {
      console.log(`   ❌ BLOCKED: ${disclosure.reason}`);
      console.log(`   Action:     Add GeoNode disclosure to message`);
    } else if (!urlAnalysis.valid) {
      console.log(`   ❌ BLOCKED: Invalid URL format`);
    } else {
      console.log(`   ⚠️  READY FOR URL/BODY: Has valid URL and non-placeholder message`);
      console.log(`   ❌ CANNOT SEND: Missing userAccountId and safety gates`);
      console.log(`   Next Steps: Add account selection, status tracking, and safety enforcement`);
    }
    
    console.log('\n═'.repeat(80));
  }
  
  // Summary
  console.log(`\n📊 Summary:\n`);
  console.log(`Total items:          ${items.length}`);
  console.log(`Blocked (placeholder): ${items.filter(i => i.message_source === 'random').length}`);
  console.log(`Blocked (no disclosure): ${items.filter(i => i.message_source !== 'random' && !checkDisclosure(i.message).ok).length}`);
  console.log(`Has valid URL + message: ${sendable}`);
  console.log(`Missing safety gates:  ${items.length} (all items)`);
  
  console.log(`\n✅ URL Formats by Kind:`);
  const byKind = {thread: 0, comment: 0, mention: 0};
  items.forEach(i => byKind[i.kind] = (byKind[i.kind] || 0) + 1);
  console.log(`   thread  (🧵 thread comment):     ${byKind.thread || 0}`);
  console.log(`   comment (💬 reply to our post):  ${byKind.comment || 0}`);
  console.log(`   mention (↪️  reply to competitor): ${byKind.mention || 0}`);
  
  console.log(`\n❌ Critical Gaps (ALL items):`);
  console.log(`   • No userAccountId (cannot choose posting account)`);
  console.log(`   • No status tracking (can send duplicates)`);
  console.log(`   • No rate limiting (can exceed Reddit/Engain limits)`);
  console.log(`   • No safety gates (transparency, rules, duplicate checks)`);
  
  console.log(`\n🔧 Recommended Next Steps:\n`);
  console.log(`1. Replace placeholder messages:`);
  console.log(`   POST http://127.0.0.1:3000/api/agent/queue2/:id {"message":"real message"}`);
  console.log(``);
  console.log(`2. Add accounts-beta methods to server/engain.cjs`);
  console.log(``);
  console.log(`3. Create server/send-queue2.cjs with:`);
  console.log(`   - Placeholder rejection (message_source === 'random')`);
  console.log(`   - Disclosure check (requires GeoNode mention)`);
  console.log(`   - Account parameter (userAccountId required)`);
  console.log(`   - Status tracking (sent_at, engain_task_id, status columns)`);
  console.log(``);
  console.log(`4. DO NOT auto-send until all safety gates are ported\n`);
  
  if (!SHOW_PLACEHOLDERS && items.some(i => i.message_source === 'random')) {
    console.log(`💡 Use --show-placeholders to see placeholder items\n`);
  }
  
  db.close();
}

try {
  main();
} catch (err) {
  console.error('\n❌ Error:', err.message);
  console.error(err.stack);
  process.exit(1);
}
