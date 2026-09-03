/* gate.js — 4-digit passcode on entry.
 *
 * BE CLEAR ABOUT WHAT THIS IS. This is a doormat, not a lock. The page's data
 * comes from Supabase with a publishable anon key that ships in config.js, so
 * anyone who opens devtools can read the same rows without ever seeing this
 * prompt. It keeps a casual visitor or a shoulder-surfer out of the ops view.
 * It does NOT protect the data, and nothing secret may be put on these pages
 * on the strength of it. Real access control = Supabase Auth + RLS policies
 * keyed to a logged-in user, which is a different piece of work.
 *
 * Runs before render so the content never flashes on screen first.
 */
(function () {
  var CODE = "2005";
  var KEY = "geo_gate_ok";
  var TTL = 12 * 60 * 60 * 1000;          // re-ask twice a day, not every click

  try {
    var seen = JSON.parse(sessionStorage.getItem(KEY) || "null");
    if (seen && Date.now() - seen < TTL) return;
  } catch (e) { /* storage blocked — fall through and ask */ }

  var css = document.createElement("style");
  css.textContent =
    '#gate{position:fixed;inset:0;z-index:9999;background:#f5f4f0;display:flex;' +
    'align-items:center;justify-content:center;font:15px/1.5 "Inter",ui-sans-serif,system-ui,-apple-system,sans-serif;color:#2c2e33}' +
    '#gate .box{text-align:center;max-width:320px;padding:0 20px}' +
    '#gate h1{color:#17181a;font-size:16px;font-weight:600;margin:0 0 6px;letter-spacing:-.01em}' +
    '#gate p{color:#5b5f66;font-size:13.5px;margin:0 0 18px}' +
    '#gate label{display:block;color:#5b5f66;font-size:13px;margin:0 0 8px}' +
    '#gate input{width:150px;text-align:center;letter-spacing:.5em;font:22px ui-monospace,SFMono-Regular,Menlo,monospace;' +
    'padding:12px 10px 12px 18px;border-radius:8px;border:1px solid #b9b5ab;background:#fff;color:#17181a}' +
    '#gate input:focus{outline:2px solid #1a56c4;outline-offset:2px}' +
    '#gate .err{color:#b3261e;font-size:13px;height:18px;margin-top:10px}';
  document.head.appendChild(css);

  var el = document.createElement("div");
  el.id = "gate";
  el.innerHTML =
    '<div class="box">' +
      '<h1>Reddit GEO Ops</h1>' +
      '<p>Internal dashboard. Enter the four digit code.</p>' +
      '<label for="gate-pin">Passcode</label>' +
      '<input id="gate-pin" type="password" inputmode="numeric" pattern="[0-9]*" maxlength="4" autocomplete="off">' +
      '<div class="err" id="gate-err" role="status" aria-live="polite"></div>' +
    '</div>';

  function mount() {
    document.body.appendChild(el);
    document.documentElement.style.overflow = "hidden";
    var pin = document.getElementById("gate-pin");
    var err = document.getElementById("gate-err");
    pin.focus();
    pin.addEventListener("input", function () {
      err.textContent = "";
      if (pin.value.length < 4) return;
      if (pin.value === CODE) {
        try { sessionStorage.setItem(KEY, JSON.stringify(Date.now())); } catch (e) {}
        el.remove();
        document.documentElement.style.overflow = "";
      } else {
        err.textContent = "Wrong code.";
        pin.value = "";
        pin.focus();
      }
    });
  }

  if (document.body) mount();
  else document.addEventListener("DOMContentLoaded", mount);
})();
