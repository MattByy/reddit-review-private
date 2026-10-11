const library=require('../_library.js');
module.exports=async(req,res)=>{
  res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','no-store');
  if(!process.env.CRON_SECRET||req.headers.authorization!=='Bearer '+process.env.CRON_SECRET){res.statusCode=401;return res.end(JSON.stringify({error:'Cron authentication required'}));}
  try{res.statusCode=200;res.end(JSON.stringify(await library.collect()));}catch(e){res.statusCode=502;res.end(JSON.stringify({error:e.message}));}
};
