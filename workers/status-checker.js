/* workers/status-checker.js — Status checker worker
 *
 * Runs every 10 minutes (Vercel cron)
 *
 * Lifecycle:
 * 1. Claim pending jobs (row locking)
 * 2. Call real Engain GET for each task
 * 3. Update based on actual status:
 *    - Still pending: nothing changes
 *    - Published: update status, store Reddit URL
 *    - Failed/removed: mark as failed with reason
 * 4. For published questions: re-enter as 'watching' for reply detection
 */

const { sb } = require('../api/_db.js');
const engain = require('../api/_engain-real.js');

const WORKER_ID = `status-checker-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const MAX_JOBS_PER_RUN = 10;
const enc = encodeURIComponent;
const now = () => new Date().toISOString();

/**
 * Check status of a job with Engain
 */
async function checkJobStatus(job) {
  console.log(`[${WORKER_ID}] Checking status for job ${job.id}, Engain task: ${job.engain_task_id}`);
  
  try {
    // Get comment status from Engain
    const result = await engain.withRetry(async () => {
      return await engain.getCommentById(job.engain_task_id);
    });
    
    if (!result.ok) {
      return {
        success: false,
        error: `Engain returned ${result.status}`,
        status: result.status
      };
    }
    
    const comment = result.json;
    const engainStatus = comment.status;
    const redditUrl = engain.extractRedditUrl(comment);
    
    console.log(`[${WORKER_ID}] Job ${job.id} Engain status: ${engainStatus}, URL: ${redditUrl || 'none'}`);
    
    // Parse status
    const parsed = engain.parseEngainStatus(engainStatus);
    
    return {
      success: true,
      engainStatus,
      jobStatus: parsed.jobStatus,
      isFinal: parsed.isFinal,
      reason: parsed.reason,
      redditUrl,
      comment
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
 * Process status update for a single job
 */
async function processStatusUpdate(job) {
  console.log(`[${WORKER_ID}] Processing status update for job ${job.id}`);
  
  try {
    const status = await checkJobStatus(job);
    
    if (!status.success) {
      console.error(`[${WORKER_ID}] Job ${job.id} status check failed:`, status.error);
      
      // Update last error but keep pending
      await sb('PATCH', `engain_job_queue?id=eq.${enc(job.id)}`, {
        last_error: status.error,
        retry_count: job.retry_count + 1,
        next_check_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(), // Check again in 10 min
        claimed_by: null,
        claimed_at: null,
        updated_at: now()
      }, 'return=minimal');
      
      return {
        job_id: job.id,
        outcome: 'check_failed',
        error: status.error
      };
    }
    
    // Update engain_response with latest data
    await sb('PATCH', `engain_job_queue?id=eq.${enc(job.id)}`, {
      engain_status: status.engainStatus,
      engain_response: status.comment,
      updated_at: now()
    }, 'return=minimal');
    
    // Handle based on status
    if (status.jobStatus === 'published') {
      console.log(`[${WORKER_ID}] Job ${job.id} is PUBLISHED!`);
      
      // Update with Reddit URL and mark as published
      await sb('PATCH', `engain_job_queue?id=eq.${enc(job.id)}`, {
        reddit_permalink: status.redditUrl,
        updated_at: now()
      }, 'return=minimal');
      
      await sb('POST', 'rpc/update_job_status', {
        p_job_id: job.id,
        p_new_status: 'published',
        p_details: {
          reddit_url: status.redditUrl,
          engain_status: status.engainStatus
        },
        p_worker: WORKER_ID
      });
      
      // If this is a question, re-enter as watching for replies
      if (job.job_type === 'question') {
        console.log(`[${WORKER_ID}] Job ${job.id} is a question - entering watch mode`);
        
        await sb('PATCH', `engain_job_queue?id=eq.${enc(job.id)}`, {
          watching_for_replies: true,
          last_reply_check_at: null,
          next_check_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(), // Check for replies in 30 min
          updated_at: now()
        }, 'return=minimal');
        
        await sb('POST', 'rpc/update_job_status', {
          p_job_id: job.id,
          p_new_status: 'watching',
          p_details: {
            reddit_url: status.redditUrl,
            watch_started: now()
          },
          p_worker: WORKER_ID
        });
        
        return {
          job_id: job.id,
          outcome: 'published_watching',
          reddit_url: status.redditUrl
        };
      } else {
        // Not a question - mark as done
        await sb('POST', 'rpc/update_job_status', {
          p_job_id: job.id,
          p_new_status: 'done',
          p_details: {
            reddit_url: status.redditUrl,
            completed: now()
          },
          p_worker: WORKER_ID
        });
        
        return {
          job_id: job.id,
          outcome: 'published_done',
          reddit_url: status.redditUrl
        };
      }
      
    } else if (status.jobStatus === 'failed') {
      console.log(`[${WORKER_ID}] Job ${job.id} FAILED:`, status.reason);
      
      await sb('POST', 'rpc/update_job_status', {
        p_job_id: job.id,
        p_new_status: 'failed',
        p_details: {
          reason: status.reason || 'Engain reported failure',
          engain_status: status.engainStatus
        },
        p_worker: WORKER_ID
      });
      
      await sb('PATCH', `engain_job_queue?id=eq.${enc(job.id)}`, {
        failure_reason: status.reason || status.engainStatus,
        updated_at: now()
      }, 'return=minimal');
      
      return {
        job_id: job.id,
        outcome: 'failed',
        reason: status.reason
      };
      
    } else {
      // Still pending - update next check time
      console.log(`[${WORKER_ID}] Job ${job.id} still pending (${status.engainStatus})`);
      
      await sb('PATCH', `engain_job_queue?id=eq.${enc(job.id)}`, {
        next_check_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
        claimed_by: null,
        claimed_at: null,
        updated_at: now()
      }, 'return=minimal');
      
      return {
        job_id: job.id,
        outcome: 'still_pending',
        engain_status: status.engainStatus
      };
    }
    
  } catch (error) {
    console.error(`[${WORKER_ID}] Job ${job.id} status processing error:`, error);
    
    await sb('PATCH', `engain_job_queue?id=eq.${enc(job.id)}`, {
      last_error: error.message,
      retry_count: job.retry_count + 1,
      next_check_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
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
 * Main status checker run
 */
async function checkStatuses() {
  console.log(`[${WORKER_ID}] Starting status check run...`);
  
  try {
    // Claim jobs for status checking
    const jobs = await sb('POST', 'rpc/claim_jobs_for_status_check', {
      p_worker: WORKER_ID,
      p_limit: MAX_JOBS_PER_RUN
    });
    
    if (!jobs || jobs.length === 0) {
      console.log(`[${WORKER_ID}] No jobs to check`);
      return {
        ok: true,
        checked: 0,
        results: []
      };
    }
    
    console.log(`[${WORKER_ID}] Claimed ${jobs.length} jobs for status checking`);
    
    // Process each job
    const results = [];
    for (const job of jobs) {
      const result = await processStatusUpdate(job);
      results.push(result);
    }
    
    const summary = {
      ok: true,
      checked: jobs.length,
      results,
      outcomes: {
        published_done: results.filter(r => r.outcome === 'published_done').length,
        published_watching: results.filter(r => r.outcome === 'published_watching').length,
        failed: results.filter(r => r.outcome === 'failed').length,
        still_pending: results.filter(r => r.outcome === 'still_pending').length,
        check_failed: results.filter(r => r.outcome === 'check_failed').length,
        error: results.filter(r => r.outcome === 'error').length
      }
    };
    
    console.log(`[${WORKER_ID}] Status check complete:`, summary);
    return summary;
    
  } catch (error) {
    console.error(`[${WORKER_ID}] Status check run error:`, error);
    return {
      ok: false,
      error: error.message,
      stack: error.stack
    };
  }
}

module.exports = { checkStatuses, WORKER_ID };

// Allow running directly
if (require.main === module) {
  checkStatuses()
    .then(result => {
      console.log('Status check result:', JSON.stringify(result, null, 2));
      process.exit(result.ok ? 0 : 1);
    })
    .catch(error => {
      console.error('Status check failed:', error);
      process.exit(1);
    });
}
