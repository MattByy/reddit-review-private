const {timingSafeEqual}=require('crypto');
function authorized(req){
  const key=process.env.OPERATOR_API_KEY;
  const actual=Buffer.from(String(req.headers.authorization||''));
  const expected=Buffer.from('Bearer '+(key||''));
  return !!key&&actual.length===expected.length&&timingSafeEqual(actual,expected);
}
module.exports={authorized};
