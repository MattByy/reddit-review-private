/* The server verifies the session again for every operator action. */
document.documentElement.style.visibility='hidden';
try{sessionStorage.removeItem('geo_gate_ok');sessionStorage.removeItem('operator-key');}catch{}
window.adminReady=(async()=>{
  try{
    const response=await fetch('/api/session',{credentials:'same-origin',cache:'no-store'});
    if(!response.ok)throw Error('Sign-in is temporarily unavailable. Reload to try again.');
    const session=await response.json();
    if(!session.authenticated){
      location.replace('/login?next='+encodeURIComponent(location.pathname+location.search+location.hash));
      return false;
    }
    document.documentElement.style.visibility='';return true;
  }catch(e){
    const show=()=>{
      document.body.replaceChildren();
      const message=document.createElement('p');message.textContent=e.message;message.style.padding='32px';
      document.body.appendChild(message);document.documentElement.style.visibility='';
    };
    if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',show,{once:true});else show();
    return false;
  }
})();
