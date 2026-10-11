const {authorized}=require('./_operator-auth.js'),{currentSession}=require('./_session.js'),library=require('./_library.js');
module.exports=async(req,res)=>{
  const out=(status,value)=>{res.statusCode=status;res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','no-store');res.end(JSON.stringify(value));};
  try{
    if(req.method==='GET'){
      if(!await currentSession(req)&&!await authorized(req))return out(401,{error:'Sign in to continue.'});
      return out(200,await library.list(Object.fromEntries(new URL(req.url,'https://local').searchParams)));
    }
    if(req.method!=='POST')return out(405,{error:'POST required'});
    if(!await authorized(req))return out(401,{error:'Sign in to continue.'});
    const b=typeof req.body==='string'?JSON.parse(req.body):req.body||{};
    if(b.action==='collect')return out(200,await library.collect());
    if(b.action==='settings')return out(200,await library.saveSettings(b.settings||{}));
    if(b.action==='refresh')return out(200,await library.refresh(b.thread_id));
    if(b.action==='queue')return out(200,await library.queue(b.thread_id,b));
    return out(422,{error:'Unknown library action'});
  }catch(e){return out(e.status&&e.status<500?e.status:400,{error:e.message});}
};
