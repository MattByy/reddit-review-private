const {authorized}=require('./_operator-auth.js');
const {currentSession}=require('./_session.js');
const messages=require('./_messages.js');
module.exports=async(req,res)=>{
  const out=(status,value)=>{res.statusCode=status;res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','no-store');res.end(JSON.stringify(value));};
  try{
    if(req.method==='GET'){
      if(!await currentSession(req)&&!await authorized(req))return out(401,{error:'Sign in to continue.'});
      return out(200,await messages.rows());
    }
    if(req.method!=='POST')return out(405,{error:'POST required'});
    if(!await authorized(req))return out(401,{error:'Sign in to continue.'});
    return out(200,await messages.change(typeof req.body==='string'?JSON.parse(req.body):req.body||{}));
  }catch(e){return out(e.status&&e.status<500?e.status:400,{error:e.message});}
};
