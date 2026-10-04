const model = require('../assets/conversation-model.js');
const { loadConversationGraph } = require('./_conversation_graph.js');
module.exports = {
  checkCoordinationWindows: model.checkCoordinationWindows,
  checkVoiceDistinctiveness: model.checkVoiceDistinctiveness,
  checkEngagementAutonomy: model.checkEngagementAutonomy,
  checkOrganicDiscovery: model.checkOrganicDiscovery,
  async generateLegitimacyReport(threadId, options = {}) {
    const graph = options.graph || await loadConversationGraph(threadId, options);
    return model.generateLegitimacyReport(threadId, graph);
  },
};
