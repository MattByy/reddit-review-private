const fs=require('node:fs'),path=require('node:path');
function render(report){
  const data=JSON.stringify(report).replaceAll('<','\\u003c').replaceAll('\u2028','\\u2028').replaceAll('\u2029','\\u2029');
  return fs.readFileSync(path.join(__dirname,'template.html'),'utf8').replace('__REPORT_DATA__',()=>data);
}
module.exports={render};
