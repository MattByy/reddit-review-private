(async()=>{
  const $=id=>document.getElementById(id),params=new URLSearchParams(location.search);
  let token=new URLSearchParams(location.hash.slice(1)).get('setup');
  if(token)history.replaceState(null,'',location.pathname+location.search);
  const requested=params.get('next')||'/plan';
  let next='/plan';
  try{const url=new URL(requested,location.origin);if(url.origin===location.origin&&!/^\/login(?:\.html)?\/?$/.test(url.pathname))next=url.pathname+url.search+url.hash;}catch{}
  if(token){
    $('heading').textContent='Choose your password';$('description').textContent='Set your dashboard password once. You’ll stay signed in on this browser for 30 days.';
    $('password').autocomplete='new-password';$('password').minLength=12;$('confirm-field').hidden=false;$('confirm').required=true;$('submit').textContent='Save password and continue';
  }
  $('login-form').addEventListener('submit',async e=>{
    e.preventDefault();$('error').textContent='';
    if(token&&$('password').value!==$('confirm').value){$('error').textContent='The passwords don’t match.';return;}
    const button=$('submit');button.disabled=true;
    try{
      const response=await fetch('/api/session',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:token?'setup':'login',password:$('password').value,...(token?{setup_token:token}:{})})});
      const result=await response.json();
      if(!response.ok)throw Error(result.error||'Could not sign in. Try again.');
      token=null;$('login-form').reset();location.replace(next);
    }catch(err){$('error').textContent=err.message;button.disabled=false;}
  });
  try{
    const response=await fetch('/api/session',{credentials:'same-origin',cache:'no-store'}),session=await response.json();
    if(session.authenticated)location.replace(next);
    else if(session.setup_required&&!token){$('description').textContent='Open your private setup link to choose your dashboard password.';$('submit').disabled=true;}
  }catch{}
})();
