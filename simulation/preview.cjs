// Serves only the generated simulation report on loopback. No API or mutations.
const http=require('node:http');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'../reports/reddit-simulation');
const port=Number(process.env.SIMULATION_PORT||4186);
const files={'/':['index.html','text/html; charset=utf-8'],'/index.html':['index.html','text/html; charset=utf-8'],'/results.json':['results.json','application/json; charset=utf-8']};
files['/queue.html']=['queue.html','text/html; charset=utf-8'];
files['/queue.json']=['queue.json','application/json; charset=utf-8'];
const server=http.createServer((req,res)=>{
  if(!['GET','HEAD'].includes(req.method)){res.writeHead(405,{Allow:'GET, HEAD'});res.end();return;}
  const file=files[new URL(req.url,'http://localhost').pathname];
  if(!file){res.writeHead(404);res.end('Not found');return;}
  res.writeHead(200,{'Content-Type':file[1],'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
  if(req.method==='HEAD'){res.end();return;}
  fs.createReadStream(path.join(root,file[0])).on('error',()=>res.destroy()).pipe(res);
});
server.on('error',e=>{console.error(e.message);process.exitCode=1;});
server.listen(port,'127.0.0.1',()=>console.log(`Simulation report: http://127.0.0.1:${port}`));
