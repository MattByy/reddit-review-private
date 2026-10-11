const {timingSafeEqual}=require('crypto');
const {sameOrigin,currentSession}=require('./_session.js');
async function authorized(req){
  const key=process.env.OPERATOR_API_KEY;
  const actual=Buffer.from(String(req.headers.authorization||''));
  const expected=Buffer.from('Bearer '+(key||''));
  if(key&&actual.length===expected.length&&timingSafeEqual(actual,expected))return true;
  return sameOrigin(req)&&!!await currentSession(req);
}
module.exports={authorized};
