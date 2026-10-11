// A queue turn is triggered by the latest published message. The chosen parent
// can be that message (chain) or its parent (sibling), never an unrelated root.
function options(message,history,experiment={}){
  if(message.step>(experiment.max_messages??10))return [];
  if(message.step===1)return [{reply_mode:'opening',parent_message_id:null,parent_step:null,depth:1,url:message.target_url}];
  const source=history.find(m=>m.id===message.previous_message_id);
  if(!source||source.status!=='visible'||source.contains_brand||!source.reddit_url||source.step!==message.step-1)return [];
  const option=(mode,m)=>({reply_mode:mode,parent_message_id:m.id,parent_step:m.step,depth:m.depth+1,url:m.reddit_url,body:m.body,author:m.author});
  if(message.step===2)return [option('reply',source)].filter(o=>o.depth<=(experiment.max_depth??4));
  const list=[option('chain',source)],parent=history.find(m=>m.id===source.parent_message_id);
  if(parent?.status==='visible'&&parent.reddit_url)list.push(option('sibling',parent));
  return list.filter(o=>o.depth<=(experiment.max_depth??4));
}
function mode(message,value){return value||({1:'opening',2:'reply'})[message.step]||null;}
function context(message,experiment,history,strategies,results){
  const stage=message.step===1?'opening':message.step===2?'first_reply':'later_reply';
  const choices=strategies.map(s=>({id:s.id,name:s.action_name,brief:message.step===1?s.brief:s.followup_brief,target_percent:20,
    suggested_count:results.find(r=>r.stage===stage&&r.basis==='suggested'&&r.action===s.id)?.assigned||0}));
  return {stage,limits:{max_messages:experiment.max_messages,max_depth:experiment.max_depth,messages_already_published:history.filter(m=>m.verified_at).length,
    current_message:message.step,messages_remaining_including_this:Math.max(0,experiment.max_messages-message.step+1),last_message:message.step===experiment.max_messages},
    content_actions:choices,suggested_action:message.suggested_action,allocation:{target:'20% per content action within each stage',method:'Least-assigned suggestion; random ties for replies',override:'Choose a more relevant action with action_override_reason. Opening strategy remains fixed.',scope:'Suggestions are balanced; actual choices and publication outcomes can differ.'},
    brand:{opening_required:message.step===1?strategies.find(s=>s.id===experiment.strategy_id)?.opening_mentions_brand:null,independent_of_reply_action:true,stop_on_verified_mention:true},
    considerations:['Chain when answering the latest message; sibling when contributing a distinct point to its parent. Use only returned parent options.',
      'Check the original question, current discussion, community requirements and prior messages. Add useful information without repetition.',
      'Choose brand relevance separately from placement and content action. Never force a mention on the final turn; the limit can end without one.',
      'A depth limit excludes chain. The total message limit also counts siblings. No future message is prewritten.',
      'Preserve facts and required attribution. Do not invent personal experience or independent endorsements.'],
    text_workflow:{steps:['choose parent and content action','write one draft','run the agent\'s configured humanizer','check meaning, facts, attribution and brand decision','file final body with draft_body and humanization metadata'],
      humanizer:{execution:'agent tool',server_integration:false,missing_tool:'Report the missing tool; never claim humanization ran.'}},
    automatic_tasks:['submit saved final text','poll Engain status','save task ID and comment URL','verify publication and removal','requeue an eligible unbranded publication','monitor the brand mention for seven days']};
}
module.exports={options,mode,context};
