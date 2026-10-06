/* _reddit.js — read-only Reddit helpers shared by the tick and the sequence
 * engine. Nothing here writes to Reddit. */
const UA = "geonode-reddit-agent/1.0 (+https://geonode.com; disclosed brand account tooling)";

// Share links (/r/x/s/ID) redirect to the real permalink.
async function permalink(url) {
  if (!url || !/\/s\//.test(url)) return url;
  try {
    const r = await fetch(url, { redirect: "manual", headers: { "User-Agent": UA } });
    const loc = r.headers.get("location");
    return loc ? loc.split("?")[0] : url;
  } catch { return url; }
}

/* Replies under one comment, minus ours, AutoModerator and deleted authors.
 * -> { ok, url, comment, replies:[{id, author, body, score, permalink}] } or { ok:false, reason } */
async function repliesTo(url, ourUsernames) {
  const link = await permalink(url);
  const r = await fetch(link.replace(/\/?$/, "/") + ".json?limit=100&depth=2", { headers: { "User-Agent": UA } });
  if (!r.ok) return { ok: false, reason: `reddit ${r.status} reading ${link}` };
  const data = await r.json();
  const c = data[1] && data[1].data.children[0] && data[1].data.children[0].data;
  if (!c || ["[deleted]", "[removed]"].includes(c.body)) return { ok: false, gone: true, reason: "our comment is gone" };
  const replies = ((c.replies && c.replies.data && c.replies.data.children) || [])
    .filter(x => x.kind === "t1").map(x => x.data)
    .filter(x => x.author && !["[deleted]", "AutoModerator"].includes(x.author) && !ourUsernames.has(x.author.toLowerCase()))
    .map(x => ({ id: x.id, author: x.author, body: x.body, score: x.score, permalink: `https://www.reddit.com${x.permalink}` }));
  return { ok: true, url: link, comment: { body: c.body, score: c.score }, replies };
}

module.exports = { permalink, repliesTo, UA };
