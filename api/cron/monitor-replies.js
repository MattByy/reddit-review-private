/* api/cron/monitor-replies.js — Reply monitor cron endpoint
 *
 * Runs every 30 minutes via Vercel Cron
 * Checks published questions for new user replies, queues follow-ups
 */

const { monitorReplies } = require('../../workers/reply-monitor.js');

module.exports = async (req, res) => {
  // Verify cron secret for security
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && req.headers['x-vercel-cron-secret'] !== cronSecret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  console.log('[cron/monitor-replies] Starting reply monitor worker...');
  
  try {
    const result = await monitorReplies();
    
    res.status(200).json({
      ok: true,
      worker: 'reply-monitor',
      timestamp: new Date().toISOString(),
      ...result
    });
  } catch (error) {
    console.error('[cron/monitor-replies] Error:', error);
    
    res.status(500).json({
      ok: false,
      error: error.message,
      stack: error.stack,
      timestamp: new Date().toISOString()
    });
  }
};
