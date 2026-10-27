-- Migration 047: Transparency enforcement for GeoNode Reddit engagement
-- 
-- Adds support for:
-- 1. Subreddit filtering (allow/deny lists)
-- 2. Human review mode configuration
-- 3. Transparency audit logging
-- 4. Enhanced account disclosure requirements

-- Subreddit filters table: track which subreddits are allowed or denied
CREATE TABLE IF NOT EXISTS subreddit_filters (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subreddit text NOT NULL UNIQUE,
  status text NOT NULL CHECK (status IN ('allowed', 'denied', 'review')),
  reason text,
  added_by text,
  added_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  notes jsonb DEFAULT '{}'::jsonb
);

CREATE INDEX subreddit_filters_subreddit_idx ON subreddit_filters(subreddit);
CREATE INDEX subreddit_filters_status_idx ON subreddit_filters(status);

COMMENT ON TABLE subreddit_filters IS 'Allow/deny list for subreddits based on their self-promotion rules';
COMMENT ON COLUMN subreddit_filters.status IS 'allowed: can post, denied: blocked (e.g. bans self-promotion), review: needs manual approval';
COMMENT ON COLUMN subreddit_filters.reason IS 'Why this subreddit is allowed or denied';

-- Transparency audit log: track all transparency checks performed
CREATE TABLE IF NOT EXISTS transparency_audits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id uuid REFERENCES message_queue(id) ON DELETE CASCADE,
  draft_id uuid,
  check_type text NOT NULL,
  passed boolean NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  checked_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX transparency_audits_message_id_idx ON transparency_audits(message_id);
CREATE INDEX transparency_audits_draft_id_idx ON transparency_audits(draft_id);
CREATE INDEX transparency_audits_check_type_idx ON transparency_audits(check_type);
CREATE INDEX transparency_audits_checked_at_idx ON transparency_audits(checked_at DESC);

COMMENT ON TABLE transparency_audits IS 'Audit log of all transparency checks (disclosure, staged conversations, rate limits, etc.)';
COMMENT ON COLUMN transparency_audits.check_type IS 'Type of check: disclosure, staged_conversation, rate_limit, subreddit_filter, duplicate';

-- Add disclosure_line column to accounts if not exists (should exist, but ensure it)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='accounts' AND column_name='disclosure_line') THEN
    ALTER TABLE accounts ADD COLUMN disclosure_line text;
  END IF;
END $$;

COMMENT ON COLUMN accounts.disclosure_line IS 'Exact disclosure text that must appear in every comment (e.g., "GeoNode team member here")';

-- Add human review mode configuration
-- This is stored in workflow_state as it's a workflow configuration
INSERT INTO workflow_state (key, value, updated_at)
VALUES ('human_review_mode', '{"enabled": false, "note": "When enabled, all drafts require manual approval before posting"}'::jsonb, now())
ON CONFLICT (key) DO NOTHING;

INSERT INTO workflow_state (key, value, updated_at)
VALUES ('subreddit_policy', '{"mode": "default", "note": "default: allow new subreddits, allowlist_only: only post to explicitly allowed subreddits"}'::jsonb, now())
ON CONFLICT (key) DO NOTHING;

-- Add transparency check results to message_queue if column doesn't exist
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='message_queue' AND column_name='transparency_check') THEN
    ALTER TABLE message_queue ADD COLUMN transparency_check jsonb DEFAULT NULL;
  END IF;
END $$;

COMMENT ON COLUMN message_queue.transparency_check IS 'Results of transparency validation: disclosure, staged conversation, rate limits, etc.';

-- Function to log transparency checks
CREATE OR REPLACE FUNCTION log_transparency_check(
  p_message_id uuid,
  p_draft_id uuid,
  p_check_type text,
  p_passed boolean,
  p_details jsonb DEFAULT '{}'::jsonb
) RETURNS uuid AS $$
DECLARE
  v_audit_id uuid;
BEGIN
  INSERT INTO transparency_audits (message_id, draft_id, check_type, passed, details)
  VALUES (p_message_id, p_draft_id, p_check_type, p_passed, p_details)
  RETURNING id INTO v_audit_id;
  
  RETURN v_audit_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Function to check if human review mode is enabled
CREATE OR REPLACE FUNCTION human_review_enabled() RETURNS boolean AS $$
DECLARE
  v_config jsonb;
BEGIN
  SELECT value INTO v_config FROM workflow_state WHERE key = 'human_review_mode';
  RETURN COALESCE((v_config->>'enabled')::boolean, false);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Seed some common subreddits that typically allow/deny self-promotion
-- These are examples and should be reviewed/updated based on actual subreddit rules
INSERT INTO subreddit_filters (subreddit, status, reason, added_by, notes)
VALUES
  ('programming', 'review', 'Generally allows helpful content but scrutinizes self-promotion', 'system', '{"review_notes": "Check thread relevance carefully"}'::jsonb),
  ('webdev', 'review', 'Allows helpful content with disclosure', 'system', '{"review_notes": "Popular for web scraping discussions"}'::jsonb),
  ('webscraping', 'allowed', 'Explicitly allows tool discussions and recommendations', 'system', '{}'::jsonb),
  ('datascience', 'review', 'Case by case - helpful contributions accepted', 'system', '{}'::jsonb),
  ('entrepreneur', 'allowed', 'Business tools commonly discussed', 'system', '{}'::jsonb)
ON CONFLICT (subreddit) DO NOTHING;

-- Grant permissions
GRANT SELECT ON subreddit_filters TO anon, authenticated;
GRANT SELECT ON transparency_audits TO anon, authenticated;
GRANT EXECUTE ON FUNCTION log_transparency_check TO anon, authenticated;
GRANT EXECUTE ON FUNCTION human_review_enabled TO anon, authenticated;

-- Service role gets full access
GRANT ALL ON subreddit_filters TO service_role;
GRANT ALL ON transparency_audits TO service_role;
