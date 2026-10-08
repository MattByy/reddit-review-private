/* The public read key cannot approve work. Keep the operator key in this tab only. */
window.operatorCall=async(path,body)=>{
  let key=sessionStorage.getItem('operator-key');
  if(!key){key=prompt('Operator API key (saved for this tab only):');if(!key)throw Error('Operator key required');sessionStorage.setItem('operator-key',key);}
  const response=await fetch(path,{method:'POST',headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},body:JSON.stringify(body||{})});
  const result=await response.json();
  if(response.status===401)sessionStorage.removeItem('operator-key');
  if(!response.ok)throw Error(result.error||result.message||response.status);
  return result;
};
