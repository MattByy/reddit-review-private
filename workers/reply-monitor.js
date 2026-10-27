/* workers/reply-monitor.js — Reply monitoring worker
 *
 * Runs every 30 minutes
 *
 * For jobs in 'watching' status (published questions):
 * 1. Fetch the Reddit thread
 * 2. Check for new replies from non-GeoNode users
 * 3. Draft disclosed responses
 * 4. Queue them as follow_up jobs
 * 5. Never have GeoNode answer its own question
 */

const { sb } = require('../api/_db.js');
const { repliesTo } = require('../api/_reddit.js');

const WORKER_ID = `reply-monitor-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const MAX_JOBS_PER_RUN = 5;
const enc = encodeURIComponent;
const now = () => new Date().toISOString();

/**
 * Check for new replies to a published question
 */
async function checkForReplies(job) {
  console.log(`[${WORKER_ID}] Checking for replies on job ${job.id}, URL: ${job.reddit_permalink}`);
  
  if (!job.reddit_permalink) {
    return {
      success: false,
      error: 'No Reddit permalink available'
    };
  }
  
  try {
    // Get our own Reddit usernames to filter out
    const accounts = await sb('GET', 'accounts?select=reddit_username&reddit_username=not.is.null');
    const ourUsernames = new Set(
      accounts.map(a => a.reddit_username.toLowerCase().replace(/^u\//i, ''))
    );
    
    // Fetch replies from Reddit
    const result = await repliesTo(job.reddit_permalink, ourUsernames);
    
    if (!result.ok) {
      return {
        success: false,
        error: result.reason,
        gone: result.gone
      };
    }
    
    // Filter to only replies from non-GeoNode users
    const userReplies = result.replies.filter(reply => {
      const author = reply.author.toLowerCase().replace(/^u\//i, '');
      return !ourUsernames.has(author);
    });
    
    console.log(`[${WORKER_ID}] Found ${userReplies.length} user replies (${result.replies.length} total)`);
    
    return {
      success: true,
      replies: userReplies,
      url: result.url
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
 * Check if we've already responded to a specific reply
 */
async function hasRespondedToReply(replyId) {
  const existing = await sb('GET', 
    `engain_job_queue?select=id&metadata->>reply_to_id=eq.${enc(replyId)}&limit=1`
  );
  return existing && existing.length > 0;
}

/**
 * Queue follow-up jobs for new user replies
 */
async function queueFollowUps(job, replies) {
  console.log(`[${WORKER_ID}] Queueing follow-ups for ${replies.length} replies`);
  
  const queued = [];
  
  for (const reply of replies) {
    // Check if already responded
    if (await hasRespondedToReply(reply.id)) {
      console.log(`[${WORKER_ID}] Already responded to reply ${reply.id}`);
      continue;
    }
    
    // Draft a disclosed response
    // In a real system, this would call an LLM to generate the response
    // For now, queue with a placeholder that requires LLM processing
    const draftBody = `[NEEDS_LLM_DRAFT] Reply to: ${reply.body.slice(0, 100)}...`;
    
    // Queue follow-up job
    const followUp = await sb('POST', 'engain_job_queue', [{
      job_type: 'answer',
      status: 'queued',
      thread_url: job.thread_url,
      thread_id: job.thread_id,
      subreddit: job.subreddit,
      parent_url: reply.url,  // Reply to this specific comment
      account_id: job.account_id,  // Use same account
      drafted_body: draftBody,
      parent_job_id: job.id,
      metadata: {
        reply_to_id: reply.id,
        reply_author: reply.author,
        reply_body: reply.body,
        needs_llm_draft: true,
        original_question_job: job.id
      },
      next_check_at: now()
    }], 'return=representation');
    
    if (followUp && followUp.length > 0) {
      queued.push(followUp[0]);
      console.log(`[${WORKER_ID}] Queued follow-up job ${followUp[0].id} for reply ${reply.id}`);
    }
  }
  
  return queued;
}

/**
 * Process a watching job
 */
async function processWatchJob(job) {
  console.log(`[${WORKER_ID}] Processing watch job ${job.id}`);
  
  try {
    // Check for replies
    const replyCheck = await checkForReplies(job);
    
    if (!replyCheck.success) {
      console.error(`[${WORKER_ID}] Reply check failed for job ${job.id}:`, replyCheck.error);
      
      // If the comment is gone, mark watch as done
      if (replyCheck.gone) {
        await sb('POST', 'rpc/update_job_status', {
          p_job_id: job.id,
          p_new_status: 'done',
          p_details: {
            reason: 'comment_removed_or_deleted',
            completed: now()
          },
          p_worker: WORKER_ID
        });
        
        return {
          job_id: job.id,
          outcome: 'comment_gone'
        };
      }
      
      // Temporary error - retry later
      await sb('PATCH', `engain_job_queue?id=eq.${enc(job.id)}`, {
        last_error: replyCheck.error,
        last_reply_check_at: now(),
        next_check_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
        claimed_by: null,
        claimed_at: null,
        updated_at: now()
      }, 'return=minimal');
      
      return {
        job_id: job.id,
        outcome: 'check_failed',
        error: replyCheck.error
      };
    }
    
    // Update last check time
    await sb('PATCH', `engain_job_queue?id=eq.${enc(job.id)}`, {
      last_reply_check_at: now(),
      next_check_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      claimed_by: null,
      claimed_at: null,
      updated_at: now()
    }, 'return=minimal');
    
    // If no new replies, just update and continue
    if (!replyCheck.replies || replyCheck.replies.length === 0) {
      console.log(`[${WORKER_ID}] No new replies for job ${job.id}`);
      return {
        job_id: job.id,
        outcome: 'no_new_replies'
      };
    }
    
    // Queue follow-up jobs
    const queued = await queueFollowUps(job, replyCheck.replies);
    
    return {
      job_id: job.id,
      outcome: 'follow_ups_queued',
      count: queued.length,
      queued_ids: queued.map(j => j.id)
    };
    
  } catch (error) {
    console.error(`[${WORKER_ID}] Watch job ${job.id} processing error:`, error);
    
    await sb('PATCH', `engain_job_queue?id=eq.${enc(job.id)}`, {
      last_error: error.message,
      last_reply_check_at: now(),
      next_check_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
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
 * Main reply monitor run
 */
async function monitorReplies() {
  console.log(`[${WORKER_ID}] Starting reply monitor run...`);
  
  try {
    // Claim watching jobs
    const jobs = await sb('POST', 'rpc/claim_jobs_for_reply_check', {
      p_worker: WORKER_ID,
      p_limit: MAX_JOBS_PER_RUN
    });
    
    if (!jobs || jobs.length === 0) {
      console.log(`[${WORKER_ID}] No watch jobs to process`);
      return {
        ok: true,
        monitored: 0,
        results: []
      };
    }
    
    console.log(`[${WORKER_ID}] Claimed ${jobs.length} watch jobs`);
    
    // Process each job
    const results = [];
    for (const job of jobs) {
      const result = await processWatchJob(job);
      results.push(result);
    }
    
    const summary = {
      ok: true,
      monitored: jobs.length,
      results,
      outcomes: {
        follow_ups_queued: results.filter(r => r.outcome === 'follow_ups_queued').length,
        no_new_replies: results.filter(r => r.outcome === 'no_new_replies').length,
        comment_gone: results.filter(r => r.outcome === 'comment_gone').length,
        check_failed: results.filter(r => r.outcome === 'check_failed').length,
        error: results.filter(r => r.outcome === 'error').length
      },
      total_follow_ups: results.filter(r => r.outcome === 'follow_ups_queued')
        .reduce((sum, r) => sum + (r.count || 0), 0)
    };
    
    console.log(`[${WORKER_ID}] Reply monitor complete:`, summary);
    return summary;
    
  } catch (error) {
    console.error(`[${WORKER_ID}] Reply monitor run error:`, error);
    return {
      ok: false,
      error: error.message,
      stack: error.stack
    };
  }
}

module.exports = { monitorReplies, WORKER_ID };

// Allow running directly
if (require.main === module) {
  monitorReplies()
    .then(result => {
      console.log('Reply monitor result:', JSON.stringify(result, null, 2));
      process.exit(result.ok ? 0 : 1);
    })
    .catch(error => {
      console.error('Reply monitor failed:', error);
      process.exit(1);
    });
}
