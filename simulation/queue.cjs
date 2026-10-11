const fs=require('node:fs'),path=require('node:path');
const {build}=require('./queue-model.cjs');
const data=build(),out=path.resolve(__dirname,'../reports/reddit-simulation');
fs.mkdirSync(out,{recursive:true});
const json=JSON.stringify(data).replaceAll('<','\\u003c');
fs.writeFileSync(path.join(out,'queue.json'),JSON.stringify(data,null,2));
fs.writeFileSync(path.join(out,'queue.html'),fs.readFileSync(path.join(__dirname,'queue.html'),'utf8').replace('__QUEUE_DATA__',()=>json));
console.log(JSON.stringify({snapshots:data.snapshots.length,initial_threads:50,returned_position:data.snapshots.find(s=>s.id==='reply-returned').focusPosition,output:path.join(out,'queue.html')}));
