const model = require('../assets/conversation-model.js');
const enc = encodeURIComponent;
// Small pages work with PostgREST's default server cap. A failed page aborts the snapshot.
async function all(sb, table, query) {
  const rows = [];
  for (let offset = 0; ; offset += 100) {
    const page = await sb('GET', `${table}?${query}&limit=100&offset=${offset}`);
    if (!Array.isArray(page)) throw new Error(`Invalid ${table} snapshot`);
    rows.push(...page);
    if (page.length < 100) return rows;
  }
}
async function loadConversationGraph(threadId, { sb = require('./_send.js').sb, accounts } = {}) {
  if (!/^[a-z0-9]+$/i.test(threadId || '')) throw new Error('A Reddit thread id is required');
  const [tasks, runs, known] = await Promise.all([
    all(sb, 'engain_tasks', `select=id,thread_id,user_account_id,task_type,content,status,reddit_url,published_at&or=(thread_id.eq.${enc(threadId)},reddit_url.like.*%2Fcomments%2F${enc(threadId)}%2F*)&order=id.asc`),
    all(sb, 'sequence_runs', 'select=id,state&order=id.asc'),
    accounts ? Promise.resolve(accounts) : all(sb, 'accounts', 'select=id,label,disclosed,disclosure_line&order=id.asc'),
  ]);
  return model.buildConversationGraph({ threadId, tasks, runs, accounts: known });
}
module.exports = { buildConversationGraph: model.buildConversationGraph, loadConversationGraph };
