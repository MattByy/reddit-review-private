-- Migration 048: Real job queue for persistent Engain integration
-- 
-- Creates a durable job queue with lifecycle:
-- queued -> pending -> published -> done (or failed at any stage)
-- Questions re-enter as follow-up watch jobs after publication

BEGIN;

-- Job queue table for persistent Engain workflow
CREATE TABLE IF NOT EXISTS engain_job_queue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  
  -- Job identification
  job_type text NOT NULL CHECK (job_type IN ('question', 'answer', 'comment', 'follow_up_watch')),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'pending', 'published', 'failed', 'done', 'watching')),
  
  -- Content
  thread_url text NOT NULL,
  thread_id text,
  subreddit text NOT NULL,
  parent_url text,  -- For replies
  account_id text NOT NULL,
  drafted_body text NOT NULL,
  
  -- Engain integration
  engain_task_id text UNIQUE,
  engain_response jsonb,
  engain_status text,  -- Engain's reported status
  reddit_permalink text,
  
  -- Timestamps
  created_at timestamptz NOT NULL DEFAULT now(),
  queued_at timestamptz NOT NULL DEFAULT now(),
  submitted_at timestamptz,  -- When sent to Engain
  published_at timestamptz,  -- When Engain reports published
  completed_at timestamptz,
  failed_at timestamptz,
  next_check_at timestamptz,  -- For status polling
  
  -- Error handling
  failure_reason text,
  retry_count integer DEFAULT 0,
  last_error text,
  
  -- Locking for workers
  claimed_by text,
  claimed_at timestamptz,
  
  -- Transparency validation
  transparency_check_passed boolean,
  transparency_check_details jsonb,
  
  -- Follow-up tracking
  parent_job_id uuid REFERENCES engain_job_queue(id),
  watching_for_replies boolean DEFAULT false,
  last_reply_check_at timestamptz,
  
  -- Metadata
  metadata jsonb DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Indexes for efficient queries
CREATE INDEX engain_job_queue_status_idx ON engain_job_queue(status);
CREATE INDEX engain_job_queue_next_check_idx ON engain_job_queue(next_check_at) WHERE status IN ('pending', 'watching');
CREATE INDEX engain_job_queue_job_type_idx ON engain_job_queue(job_type);
CREATE INDEX engain_job_queue_thread_id_idx ON engain_job_queue(thread_id);
CREATE INDEX engain_job_queue_engain_task_id_idx ON engain_job_queue(engain_task_id);
CREATE INDEX engain_job_queue_claimed_idx ON engain_job_queue(claimed_by, claimed_at) WHERE status IN ('queued', 'pending');
CREATE INDEX engain_job_queue_watching_idx ON engain_job_queue(status) WHERE status = 'watching';

COMMENT ON TABLE engain_job_queue IS 'Persistent job queue for real Engain API integration';
COMMENT ON COLUMN engain_job_queue.job_type IS 'question: will re-enter as follow_up_watch; answer/comment: one-time post';
COMMENT ON COLUMN engain_job_queue.status IS 'queued->pending->published->done; failed at any stage';
COMMENT ON COLUMN engain_job_queue.watching_for_replies IS 'True for question jobs after publication to monitor for user replies';

-- Job state transitions audit log
CREATE TABLE IF NOT EXISTS engain_job_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES engain_job_queue(id) ON DELETE CASCADE,
  from_status text,
  to_status text NOT NULL,
  transition text NOT NULL,
  details jsonb DEFAULT '{}'::jsonb,
  worker text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX engain_job_audit_job_id_idx ON engain_job_audit(job_id);
CREATE INDEX engain_job_audit_created_at_idx ON engain_job_audit(created_at DESC);

COMMENT ON TABLE engain_job_audit IS 'Audit log of all job state transitions';

-- Function to claim jobs for workers (idempotent with row locking)
CREATE OR REPLACE FUNCTION claim_job_for_dispatch(
  p_worker text,
  p_limit int DEFAULT 5
) RETURNS SETOF engain_job_queue AS $$
BEGIN
  RETURN QUERY
  UPDATE engain_job_queue
  SET 
    claimed_by = p_worker,
    claimed_at = now(),
    updated_at = now()
  WHERE id IN (
    SELECT id
    FROM engain_job_queue
    WHERE status = 'queued'
      AND (claimed_at IS NULL OR claimed_at < now() - INTERVAL '10 minutes')
      AND (next_check_at IS NULL OR next_check_at <= now())
    ORDER BY created_at
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  )
  RETURNING *;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Function to claim jobs for status checking
CREATE OR REPLACE FUNCTION claim_jobs_for_status_check(
  p_worker text,
  p_limit int DEFAULT 10
) RETURNS SETOF engain_job_queue AS $$
BEGIN
  RETURN QUERY
  UPDATE engain_job_queue
  SET 
    claimed_by = p_worker,
    claimed_at = now(),
    updated_at = now()
  WHERE id IN (
    SELECT id
    FROM engain_job_queue
    WHERE status = 'pending'
      AND (claimed_at IS NULL OR claimed_at < now() - INTERVAL '5 minutes')
      AND (next_check_at IS NULL OR next_check_at <= now())
    ORDER BY submitted_at
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  )
  RETURNING *;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Function to claim watch jobs for reply monitoring
CREATE OR REPLACE FUNCTION claim_jobs_for_reply_check(
  p_worker text,
  p_limit int DEFAULT 5
) RETURNS SETOF engain_job_queue AS $$
BEGIN
  RETURN QUERY
  UPDATE engain_job_queue
  SET 
    claimed_by = p_worker,
    claimed_at = now(),
    updated_at = now()
  WHERE id IN (
    SELECT id
    FROM engain_job_queue
    WHERE status = 'watching'
      AND watching_for_replies = true
      AND (claimed_at IS NULL OR claimed_at < now() - INTERVAL '10 minutes')
      AND (last_reply_check_at IS NULL OR last_reply_check_at < now() - INTERVAL '30 minutes')
    ORDER BY published_at
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  )
  RETURNING *;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Function to log job transitions (idempotent)
CREATE OR REPLACE FUNCTION log_job_transition(
  p_job_id uuid,
  p_from_status text,
  p_to_status text,
  p_transition text,
  p_details jsonb DEFAULT '{}'::jsonb,
  p_worker text DEFAULT NULL
) RETURNS uuid AS $$
DECLARE
  v_audit_id uuid;
BEGIN
  INSERT INTO engain_job_audit (job_id, from_status, to_status, transition, details, worker)
  VALUES (p_job_id, p_from_status, p_to_status, p_transition, p_details, p_worker)
  RETURNING id INTO v_audit_id;
  
  RETURN v_audit_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Function to update job status (with transition logging)
CREATE OR REPLACE FUNCTION update_job_status(
  p_job_id uuid,
  p_new_status text,
  p_details jsonb DEFAULT '{}'::jsonb,
  p_worker text DEFAULT NULL
) RETURNS engain_job_queue AS $$
DECLARE
  v_job engain_job_queue;
  v_old_status text;
BEGIN
  -- Get current status
  SELECT status INTO v_old_status FROM engain_job_queue WHERE id = p_job_id;
  
  -- Update job
  UPDATE engain_job_queue
  SET 
    status = p_new_status,
    updated_at = now(),
    claimed_by = NULL,  -- Release claim
    claimed_at = NULL,
    submitted_at = CASE WHEN p_new_status = 'pending' AND submitted_at IS NULL THEN now() ELSE submitted_at END,
    published_at = CASE WHEN p_new_status = 'published' AND published_at IS NULL THEN now() ELSE published_at END,
    completed_at = CASE WHEN p_new_status IN ('done', 'failed') AND completed_at IS NULL THEN now() ELSE completed_at END,
    failed_at = CASE WHEN p_new_status = 'failed' AND failed_at IS NULL THEN now() ELSE failed_at END
  WHERE id = p_job_id
  RETURNING * INTO v_job;
  
  -- Log transition
  PERFORM log_job_transition(p_job_id, v_old_status, p_new_status, 
    CASE 
      WHEN v_old_status = 'queued' AND p_new_status = 'pending' THEN 'submitted_to_engain'
      WHEN v_old_status = 'pending' AND p_new_status = 'published' THEN 'engain_published'
      WHEN v_old_status = 'published' AND p_new_status = 'done' THEN 'completed'
      WHEN v_old_status = 'published' AND p_new_status = 'watching' THEN 'entered_watch_mode'
      WHEN p_new_status = 'failed' THEN 'failed'
      ELSE 'status_change'
    END,
    p_details, p_worker);
  
  RETURN v_job;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Grant permissions
GRANT SELECT, INSERT, UPDATE ON engain_job_queue TO service_role;
GRANT SELECT, INSERT ON engain_job_audit TO service_role;
GRANT EXECUTE ON FUNCTION claim_job_for_dispatch TO service_role;
GRANT EXECUTE ON FUNCTION claim_jobs_for_status_check TO service_role;
GRANT EXECUTE ON FUNCTION claim_jobs_for_reply_check TO service_role;
GRANT EXECUTE ON FUNCTION log_job_transition TO service_role;
GRANT EXECUTE ON FUNCTION update_job_status TO service_role;

COMMIT;
