/* Browser writes use the same remembered session as dashboard sign-in. */
try{sessionStorage.removeItem('operator-key');}catch{}
window.operatorCall=async(path,body)=>{
  if(window.adminReady&&!await window.adminReady)throw Error('Sign in to continue.');
  const response=await fetch(path,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify(body||{})});
  const result=await response.json();
  if(response.status===401){
    location.assign('/login?next='+encodeURIComponent(location.pathname+location.search+location.hash));
    throw Error('Your session expired. Sign in again.');
  }
  if(!response.ok)throw Error(result.error||result.message||response.status);
  return result;
};
