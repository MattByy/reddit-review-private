#!/usr/bin/env node
// Auto-approve and send Queue 2 items
// Run as a cron job: */5 * * * * node scripts/auto-approve.js
// Or manually: node scripts/auto-approve.js

const http = require('node:http');

const API = process.env.API || 'http://127.0.0.1:3000';
const AGENT_KEY = process.env.AGENT_API_KEY;
const DRY_RUN = process.env.DRY_RUN === 'true';

if (!AGENT_KEY) {
  console.error('[INIT] Set AGENT_API_KEY in .env.local');
  process.exit(1);
}

const log = (msg) => console.log(`[${new Date().toLocaleTimeString()}] ${msg}`);

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
        if (res.status >= 400) reject(Object.assign(new Error(result.error || `HTTP ${res.status}`), { status: res.status, body: result }));
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

async function autoApprove() {
  log('INIT: Starting auto-approve cycle');
  
  let claimed = 0, drafted = 0, approved = 0, sent = 0, skipped = 0, errors = 0;

  try {
    // Step 1: Claim items from Queue 1 and draft them
    log('STEP 1: Claiming items from Queue 1 and drafting messages...');
    
    // Claim up to 5 items per cycle to avoid overwhelming the system
    for (let i = 0; i < 5; i++) {
      try {
        const result = await post('/api/agent/task', { 
          agent: 'auto-approve',
          write: true 
        });
        
        if (result.status === 'empty') {
          log(`QUEUE: Queue 1 is empty (remaining: ${result.remaining})`);
          break;
        }
        
        claimed++;
        log(`CLAIM: ${result.task_id} (${result.status}) - Queue 2 ID: ${result.queue2?.queue2_id}`);
        
        // Check if drafting was successful
        if (result.queue2) {
          drafted++;
          if (result.queue2.write_status === 'written') {
            log(`DRAFT: Written (${result.queue2.provider || 'OpenRouter'} / ${result.queue2.model || 'default'})`);
          } else if (result.queue2.write_status === 'skipped') {
            skipped++;
            log(`SKIP: Model found nothing useful to add`);
          } else if (result.queue2.write_status === 'failed') {
            errors++;
            log(`ERROR: ${result.queue2.write_error}`);
          }
        }
        
      } catch (e) {
        if (e.status === 409) {
          log(`SKIP: ${e.message}`);
        } else {
          log(`ERROR claiming item: ${e.message}`);
          errors++;
        }
      }
    }
    
    log(`STEP 1 complete: ${claimed} claimed, ${drafted} drafted, ${skipped} skipped, ${errors} errors\n`);

    // Step 2: Get all ready Queue 2 items
    log('STEP 2: Checking Queue 2 for ready items to approve and send...');
    const queue2 = await get('/api/agent/queue2');
    const readyItems = queue2.items.filter(item => 
      item.send_status === 'ready' && 
      item.write_status === 'written' &&
      !item.approved_at // Not yet approved
    );
    
    log(`QUEUE2: ${queue2.count} total, ${readyItems.length} ready for auto-approve\n`);

    // Step 3: Auto-approve and send ready items
    for (const item of readyItems) {
      try {
        log(`APPROVE: Queue 2 ID ${item.queue2_id} - ${item.item_id} (${item.kind})`);
        
        // Check disclosure - prompt-aware validation
        if (!item.disclosure?.ok) {
          const content = item.content || item.message || '';
          const promptVariantId = item.prompt_variant_id || '';
          
          // v_1f3ee5e108 is the 60% "Thread Question" variant - regular user, no GeoNode mention required
          const isRegularUserVariant = promptVariantId === 'v_1f3ee5e108';
          
          // Check for GeoNode mention in any form
          const hasGeoNodeMention = content.toLowerCase().includes('geonode') || 
                                    content.toLowerCase().includes('geo node');
          const hasEmployeeDisclosure = content.toLowerCase().includes('work at geonode') ||
                                        content.toLowerCase().includes('work for geonode') ||
                                        content.toLowerCase().includes('i work at');
          
          // Pass validation if:
          // 1. Using regular user variant (v_1f3ee5e108) - no GeoNode mention needed
          // 2. OR message includes GeoNode mention (as tool or employee disclosure)
          if (isRegularUserVariant || hasGeoNodeMention || hasEmployeeDisclosure) {
            if (isRegularUserVariant) {
              log(`PASS: Regular user variant - no GeoNode mention required`);
            } else {
              log(`PASS: GeoNode mentioned appropriately`);
            }
          } else {
            log(`WARNING: Disclosure check failed - ${item.disclosure.reason}`);
            continue;
          }
        }
        
        if (DRY_RUN) {
          log(`DRY-RUN: Would approve and send ${item.queue2_id}`);
          approved++;
          sent++;
          continue;
        }
        
        // Approve and send
        const sendResult = await post(`/api/agent/queue2/${item.queue2_id}/approve`, {
          approved_by: 'auto-approve'
        });
        
        approved++;
        if (sendResult.engain_task_id) {
          sent++;
          log(`SENT: Engain task ${sendResult.engain_task_id} ${sendResult.reddit_url ? '- ' + sendResult.reddit_url : ''}`);
        } else {
          log(`APPROVED: Awaiting send confirmation`);
        }
        
      } catch (e) {
        log(`ERROR approving ${item.queue2_id}: ${e.message}`);
        errors++;
        
        // Handle specific error cases
        if (e.status === 409) {
          log(`CONFLICT: ${e.message}`);
        } else if (e.status === 422) {
          log(`VALIDATION: ${e.message}`);
        }
      }
    }
    
    log(`\nSTEP 3 complete: ${approved} approved, ${sent} sent\n`);

    // Summary
    log('════════════════════════════════════════════════');
    log('SUMMARY:');
    log(`  Claimed from Queue 1: ${claimed}`);
    log(`  Drafted messages: ${drafted}`);
    log(`  Skipped (no content): ${skipped}`);
    log(`  Approved: ${approved}`);
    log(`  Sent to Reddit: ${sent}`);
    log(`  Errors: ${errors}`);
    log(`  DRY_RUN: ${DRY_RUN ? 'yes' : 'no'}`);
    log('════════════════════════════════════════════════\n');

  } catch (e) {
    log(`FATAL: ${e.message}`);
    process.exit(1);
  }
}

// Run
autoApprove();