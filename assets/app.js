const NAV = [
  ["index.html","Overview"],
  ["queries.html","1 · Queries"],
  ["targets.html","2 · Targets"],
  ["dominate.html","3 · Dominate"],
  ["audit.html","4 · Audit"],
  ["experiments.html","Experiments"],
  ["log.html","Log"]
];
function nav(active){
  const here = location.pathname.split("/").pop() || "index.html";
  document.body.insertAdjacentHTML("afterbegin",
    '<nav><span class="brand">Reddit GEO Ops</span>' +
    NAV.map(([h,l])=>`<a href="${h}" class="${h===here?'on':''}">${l}</a>`).join("") + "</nav>");
}
const j = u => fetch(u).then(r => { if(!r.ok) throw new Error(u+" "+r.status); return r.json(); });
function pill(s){ return `<span class="pill ${s}">${s}</span>`; }
nav();
