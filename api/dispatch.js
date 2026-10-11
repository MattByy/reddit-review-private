/* api/dispatch.js — approved means sent. The review page calls this right after
 * Approve, and Vercel calls it every 15 minutes (vercel.json crons) so nothing
 * depends on a laptop being awake. Calling it is NOT an authorization: it only
 * ever sends drafts a human approved, and re-checks every gate on the draft id
 * before the vendor call. The gates and the send itself live in _send.js, which
 * cron/tick.js shares.
 */
const { runQueue } = require("./_send.js");
const {authorized}=require('./_operator-auth.js');

module.exports = async function handler(req, res) {
  const out = (status, obj) => { res.setHeader("Content-Type", "application/json"); res.setHeader("Cache-Control", "no-store"); res.statusCode = status; res.end(JSON.stringify(obj, null, 2)); };
  if(req.method!=='POST')return out(405,{error:'POST required'});
  try {
    if(!await authorized(req))return out(401,{error:'Sign in to manage this dashboard.'});
    const { status, body } = await runQueue("dispatch");
    return out(status, body);
  } catch (e) {
    return out(500, { error: String(e.message).slice(0, 300) });
  }
};
