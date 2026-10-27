#!/usr/bin/env node
/* scripts/live-check.cjs — Live Engain API diagnostic tool
 *
 * Usage:
 *   node scripts/live-check.cjs              # Read-only: check /me, accounts, comments
 *   node scripts/live-check.cjs --post <URL> # Actually post to the URL
 *   node scripts/live-check.cjs --status <TASK_ID>  # Check status of a task
 *
 * Requires ENGAIN_API_KEY environment variable
 */

require('dotenv').config();
const engain = require('../api/_engain-real.js');

const args = process.argv.slice(2);
const hasPost = args.includes('--post');
const hasStatus = args.includes('--status');

async function main() {
  if (!process.env.ENGAIN_API_KEY) {
    console.error('❌ ENGAIN_API_KEY not set in environment');
    process.exit(1);
  }
  
  console.log('🔍 Engain API Live Check\n');
  console.log('API Key:', process.env.ENGAIN_API_KEY.slice(0, 8) + '...\n');
  
  // Check /me
  console.log('📋 Fetching workspace info (/api/v1/me)...');
  try {
    const me = await engain.getMe();
    if (me.ok) {
      console.log('✅ Workspace:', JSON.stringify(me.json, null, 2));
    } else {
      console.log('❌ Error:', me.status, JSON.stringify(me.json, null, 2));
    }
  } catch (error) {
    console.error('❌ Exception:', error.message);
  }
  
  console.log('\n');
  
  // Check accounts
  console.log('👤 Fetching owned accounts (/api/v1/accounts-beta/accounts)...');
  try {
    const accounts = await engain.getAccounts();
    if (accounts.ok) {
      const accountList = accounts.json.accounts || [];
      console.log(`✅ Found ${accountList.length} account(s):`);
      accountList.forEach((acc, idx) => {
        console.log(`  ${idx + 1}. ${acc.profileUsername || acc.userAccountId}`);
        console.log(`     ID: ${acc.userAccountId}`);
        console.log(`     Usable: ${acc.usable}`);
      });
      
      if (accountList.length === 0) {
        console.log('⚠️  No accounts found. Add owned accounts in Engain dashboard.');
      }
    } else {
      console.log('❌ Error:', accounts.status, JSON.stringify(accounts.json, null, 2));
    }
  } catch (error) {
    console.error('❌ Exception:', error.message);
  }
  
  console.log('\n');
  
  // Check recent comments
  console.log('💬 Fetching recent comments (/api/v1/accounts-beta/comments)...');
  try {
    const comments = await engain.getComments(null, 10);
    if (comments.ok) {
      const commentList = comments.json.page || [];
      console.log(`✅ Found ${commentList.length} recent comment(s):`);
      commentList.forEach((cmt, idx) => {
        const id = cmt.id || cmt._id;
        console.log(`  ${idx + 1}. Task ID: ${id}`);
        console.log(`     Status: ${cmt.status}`);
        console.log(`     Thread: ${cmt.threadUrl}`);
        if (cmt.redditUrl) {
          console.log(`     Reddit: ${cmt.redditUrl}`);
        }
      });
      
      if (commentList.length === 0) {
        console.log('ℹ️  No recent comments');
      }
    } else {
      console.log('❌ Error:', comments.status, JSON.stringify(comments.json, null, 2));
    }
  } catch (error) {
    console.error('❌ Exception:', error.message);
  }
  
  // Check specific task status
  if (hasStatus) {
    const taskIdx = args.indexOf('--status');
    const taskId = args[taskIdx + 1];
    
    if (!taskId) {
      console.error('\n❌ --status requires a task ID');
      process.exit(1);
    }
    
    console.log(`\n🔎 Checking status of task: ${taskId}...`);
    try {
      const result = await engain.getCommentById(taskId);
      if (result.ok) {
        console.log('✅ Task status:');
        console.log(JSON.stringify(result.json, null, 2));
        
        const parsed = engain.parseEngainStatus(result.json.status);
        console.log('\n📊 Parsed status:');
        console.log(`  Job status: ${parsed.jobStatus}`);
        console.log(`  Is final: ${parsed.isFinal}`);
        if (parsed.reason) console.log(`  Reason: ${parsed.reason}`);
      } else {
        console.log('❌ Error:', result.status, JSON.stringify(result.json, null, 2));
      }
    } catch (error) {
      console.error('❌ Exception:', error.message);
    }
  }
  
  // Post if requested
  if (hasPost) {
    const urlIdx = args.indexOf('--post');
    const targetUrl = args[urlIdx + 1];
    
    if (!targetUrl) {
      console.error('\n❌ --post requires a target URL');
      process.exit(1);
    }
    
    console.log(`\n⚠️  LIVE POST MODE - Creating a real comment!\n`);
    console.log(`Target URL: ${targetUrl}`);
    
    // Get first usable account
    const accounts = await engain.getAccounts();
    if (!accounts.ok || !accounts.json.accounts || accounts.json.accounts.length === 0) {
      console.error('❌ No accounts available for posting');
      process.exit(1);
    }
    
    const account = accounts.json.accounts.find(a => a.usable);
    if (!account) {
      console.error('❌ No usable accounts found');
      process.exit(1);
    }
    
    console.log(`Account: ${account.profileUsername} (${account.userAccountId})`);
    
    // Draft body with disclosure
    const testBody = `[GeoNode team member here]\n\nThis is a test comment from the live-check diagnostic tool.\n\nTimestamp: ${new Date().toISOString()}`;
    
    console.log(`\nBody:\n${testBody}\n`);
    console.log('Submitting to Engain...');
    
    try {
      const result = await engain.createComment(account.userAccountId, targetUrl, testBody);
      
      if (result.ok) {
        const taskId = engain.extractCommentId(result.json);
        console.log('✅ Comment submitted successfully!');
        console.log(`   Task ID: ${taskId}`);
        console.log(`   Status: ${result.json.status}`);
        console.log('\nFull response:');
        console.log(JSON.stringify(result.json, null, 2));
        
        console.log(`\n💡 Check status with: node scripts/live-check.cjs --status ${taskId}`);
      } else {
        console.log('❌ Post failed:', result.status);
        console.log(JSON.stringify(result.json, null, 2));
      }
    } catch (error) {
      console.error('❌ Exception:', error.message);
      console.error(error.stack);
    }
  }
  
  if (!hasPost && !hasStatus) {
    console.log('\n💡 This was a read-only check.');
    console.log('   To post a real comment: node scripts/live-check.cjs --post <URL>');
    console.log('   To check task status: node scripts/live-check.cjs --status <TASK_ID>');
  }
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
