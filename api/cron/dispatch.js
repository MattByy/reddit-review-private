/* api/cron/dispatch.js — Dispatcher cron endpoint
 *
 * Runs every 10 minutes via Vercel Cron
 * Claims queued jobs, validates transparency, submits to Engain
 */

const { dispatch } = require('../../workers/dispatcher.js');

module.exports = async (req, res) => {
  // Verify cron secret for security
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && req.headers['x-vercel-cron-secret'] !== cronSecret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  console.log('[cron/dispatch] Starting dispatch worker...');
  
  try {
    const result = await dispatch();
    
    res.status(200).json({
      ok: true,
      worker: 'dispatcher',
      timestamp: new Date().toISOString(),
      ...result
    });
  } catch (error) {
    console.error('[cron/dispatch] Error:', error);
    
    res.status(500).json({
      ok: false,
      error: error.message,
      stack: error.stack,
      timestamp: new Date().toISOString()
    });
  }
};
