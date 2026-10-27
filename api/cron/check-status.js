/* api/cron/check-status.js — Status checker cron endpoint
 *
 * Runs every 10 minutes via Vercel Cron
 * Polls Engain for pending job statuses, updates database
 */

const { checkStatuses } = require('../../workers/status-checker.js');

module.exports = async (req, res) => {
  // Verify cron secret for security
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && req.headers['x-vercel-cron-secret'] !== cronSecret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  console.log('[cron/check-status] Starting status checker worker...');
  
  try {
    const result = await checkStatuses();
    
    res.status(200).json({
      ok: true,
      worker: 'status-checker',
      timestamp: new Date().toISOString(),
      ...result
    });
  } catch (error) {
    console.error('[cron/check-status] Error:', error);
    
    res.status(500).json({
      ok: false,
      error: error.message,
      stack: error.stack,
      timestamp: new Date().toISOString()
    });
  }
};
