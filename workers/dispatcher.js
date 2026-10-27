/* workers/dispatcher.js — Job dispatcher worker
 *
 * Runs every 10 minutes (Vercel cron)
 * 
 * Lifecycle:
 * 1. Claim queued jobs (row locking)
 * 2. Run transparency checks
 * 3. Make REAL POST to Engain accounts-beta
 * 4. Store Engain task ID
 * 5. Update status to 'pending'
 * 6. Log all transitions
 */

const { sb } = require('../api/_db.js');
const engain = require('../api/_engain-real.js');
const transparency = require('../api/_transparency.js');

const WORKER_ID = `dispatcher-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const MAX_JOBS_PER_RUN = 5;
const enc = encodeURIComponent;
const now = () => new Date().toISOString();

/**
 * Run transparency validation on a job
 */
async function validateJob(job) {
  console.log(`[${WORKER_ID}] Validating job ${job.id}...`);
  
  // Get account details
  const accounts = await sb('GET', `accounts?select=*&id=eq.${enc(job.account_id)}&limit=1`);
  if (!accounts || accounts.length === 0) {
    return {
      ok: false,
      failures: [`Account ${job.account_id} not found`]
    };
  }
  
  const account = accounts[0];
  
  // Run comprehensive transparency validation
  const validation = await transparency.validateTransparency({
    body: job.drafted_body,
    accountId: job.account_id,
    accountDisclosureLine: account.disclosure_line,
    subreddit: job.subreddit,
    threadId: job.thread_id,
    parentUrl: job.parent_url,
    kind: job.parent_url ? 'reply' : 'comment'
  });
  
  return validation;
}

/**
 * Submit job to Engain
 */
async function submitToEngain(job) {
  console.log(`[${WORKER_ID}] Submitting job ${job.id} to Engain...`);
  
  try {
    // Use withRetry for resilience
    const result = await engain.withRetry(async () => {
      return await engain.createComment(
        job.account_id,
        job.parent_url || job.thread_url,
        job.drafted_body
      );
    });
    
    if (!engain.isEngainSuccess(result)) {
      return {
        success: false,
        error: `Engain returned ${result.status}: ${JSON.stringify(result.json).slice(0, 500)}`,
        status: result.status,
        response: result.json
      };
    }
    
    const commentId = engain.extractCommentId(result.json);
    if (!commentId) {
      return {
        success: false,
        error: 'Engain response missing comment ID',
        response: result.json
      };
    }
    
    return {
      success: true,
      commentId,
      response: result.json,
      status: result.json.status || 'in_queue'
    };
    
  } catch (error) {
    return {
      success: false,
      error: error.message,
      stack: error.stack
    };
  }
}

/**
 * Process a single queued job
 */
async function processJob(job) {
  console.log(`[${WORKER_ID}] Processing job ${job.id} (${job.job_type})`);
  
  try {
    // 1. Run transparency validation
    const validation = await validateJob(job);
    
    // Update job with validation results
    await sb('PATCH', `engain_job_queue?id=eq.${enc(job.id)}`, {
      transparency_check_passed: validation.ok,
      transparency_check_details: validation,
      updated_at: now()
    }, 'return=minimal');
    
    if (!validation.ok) {
      console.log(`[${WORKER_ID}] Job ${job.id} failed transparency checks:`, validation.failures);
      
      // Mark as failed
      await sb('POST', 'rpc/update_job_status', {
        p_job_id: job.id,
        p_new_status: 'failed',
        p_details: {
          reason: 'transparency_violation',
          failures: validation.failures,
          checks: validation.checks_performed
        },
        p_worker: WORKER_ID
      });
      
      return {
        job_id: job.id,
        outcome: 'transparency_failed',
        failures: validation.failures
      };
    }
    
    console.log(`[${WORKER_ID}] Job ${job.id} passed transparency checks`);
    
    // 2. Submit to Engain
    const submission = await submitToEngain(job);
    
    if (!submission.success) {
      console.error(`[${WORKER_ID}] Job ${job.id} Engain submission failed:`, submission.error);
      
      // Check if this is a rate limit - if so, don't fail, just retry later
      if (submission.status === 429) {
        await sb('PATCH', `engain_job_queue?id=eq.${enc(job.id)}`, {
          last_error: submission.error,
          retry_count: job.retry_count + 1,
          next_check_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
          claimed_by: null,
          claimed_at: null,
          updated_at: now()
        }, 'return=minimal');
        
        return {
          job_id: job.id,
          outcome: 'rate_limited',
          retry_at: new Date(Date.now() + 15 * 60 * 1000).toISOString()
        };
      }
      
      // Other errors - mark as failed
      await sb('POST', 'rpc/update_job_status', {
        p_job_id: job.id,
        p_new_status: 'failed',
        p_details: {
          reason: 'engain_error',
          error: submission.error,
          status: submission.status,
          response: submission.response
        },
        p_worker: WORKER_ID
      });
      
      await sb('PATCH', `engain_job_queue?id=eq.${enc(job.id)}`, {
        failure_reason: submission.error,
        last_error: submission.error,
        retry_count: job.retry_count + 1,
        updated_at: now()
      }, 'return=minimal');
      
      return {
        job_id: job.id,
        outcome: 'engain_failed',
        error: submission.error
      };
    }
    
    console.log(`[${WORKER_ID}] Job ${job.id} submitted successfully. Engain task: ${submission.commentId}`);
    
    // 3. Update job with Engain task ID and set to pending
    await sb('PATCH', `engain_job_queue?id=eq.${enc(job.id)}`, {
      engain_task_id: submission.commentId,
      engain_response: submission.response,
      engain_status: submission.status,
      next_check_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(), // Check in 5 minutes
      updated_at: now()
    }, 'return=minimal');
    
    await sb('POST', 'rpc/update_job_status', {
      p_job_id: job.id,
      p_new_status: 'pending',
      p_details: {
        engain_task_id: submission.commentId,
        engain_status: submission.status,
        response: submission.response
      },
      p_worker: WORKER_ID
    });
    
    return {
      job_id: job.id,
      outcome: 'submitted',
      engain_task_id: submission.commentId,
      engain_status: submission.status
    };
    
  } catch (error) {
    console.error(`[${WORKER_ID}] Job ${job.id} processing error:`, error);
    
    // Mark as failed with error
    await sb('PATCH', `engain_job_queue?id=eq.${enc(job.id)}`, {
      failure_reason: error.message,
      last_error: error.message,
      retry_count: job.retry_count + 1,
      claimed_by: null,
      claimed_at: null,
      updated_at: now()
    }, 'return=minimal');
    
    return {
      job_id: job.id,
      outcome: 'error',
      error: error.message
    };
  }
}

/**
 * Main dispatcher run
 */
async function dispatch() {
  console.log(`[${WORKER_ID}] Starting dispatch run...`);
  
  try {
    // Claim jobs for processing
    const jobs = await sb('POST', 'rpc/claim_job_for_dispatch', {
      p_worker: WORKER_ID,
      p_limit: MAX_JOBS_PER_RUN
    });
    
    if (!jobs || jobs.length === 0) {
      console.log(`[${WORKER_ID}] No jobs to process`);
      return {
        ok: true,
        processed: 0,
        results: []
      };
    }
    
    console.log(`[${WORKER_ID}] Claimed ${jobs.length} jobs for processing`);
    
    // Process each job
    const results = [];
    for (const job of jobs) {
      const result = await processJob(job);
      results.push(result);
    }
    
    const summary = {
      ok: true,
      processed: jobs.length,
      results,
      outcomes: {
        submitted: results.filter(r => r.outcome === 'submitted').length,
        transparency_failed: results.filter(r => r.outcome === 'transparency_failed').length,
        engain_failed: results.filter(r => r.outcome === 'engain_failed').length,
        rate_limited: results.filter(r => r.outcome === 'rate_limited').length,
        error: results.filter(r => r.outcome === 'error').length
      }
    };
    
    console.log(`[${WORKER_ID}] Dispatch complete:`, summary);
    return summary;
    
  } catch (error) {
    console.error(`[${WORKER_ID}] Dispatch run error:`, error);
    return {
      ok: false,
      error: error.message,
      stack: error.stack
    };
  }
}

module.exports = { dispatch, WORKER_ID };

// Allow running directly
if (require.main === module) {
  dispatch()
    .then(result => {
      console.log('Dispatch result:', JSON.stringify(result, null, 2));
      process.exit(result.ok ? 0 : 1);
    })
    .catch(error => {
      console.error('Dispatch failed:', error);
      process.exit(1);
    });
}
