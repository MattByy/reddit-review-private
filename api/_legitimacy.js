/* _legitimacy.js — monitors multi-account participation patterns for organic appearance
 *
 * This system tracks how multiple accounts engage in shared threads and verifies
 * that participation patterns reflect authentic, independent behavior.
 *
 * Legitimacy dimensions:
 * - Timing variability: No synchronized posting windows
 * - Voice distinctiveness: Each account maintains unique characteristics
 * - Engagement autonomy: Independent decision-making patterns
 * - Organic discovery: Accounts join threads at different lifecycle stages
 * - Depth variation: Mix of brief and detailed contributions
 */

const fs = require("fs");
const path = require("path");

// Load account personality profile
function loadProfile(accountId) {
  const profilePath = path.join(__dirname, "../data/accounts", accountId, "profile.json");
  if (fs.existsSync(profilePath)) {
    return JSON.parse(fs.readFileSync(profilePath, "utf8"));
  }
  return null;
}

// Check timing patterns for coordination signals
function checkTimingVariability(threadParticipation) {
  const timestamps = threadParticipation
    .filter(p => p.timestamp)
    .map(p => new Date(p.timestamp).getTime());

  if (timestamps.length < 2) return { ok: true, note: "insufficient data for timing analysis" };

  // Sort and calculate intervals
  timestamps.sort((a, b) => a - b);
  const intervals = [];
  for (let i = 1; i < timestamps.length; i++) {
    intervals.push((timestamps[i] - timestamps[i - 1]) / 60000); // minutes
  }

  // Check for perfect regularity (suspicious)
  const avgInterval = intervals.reduce((a, b) => a + b, 0) / intervals.length;
  const variance = intervals.reduce((sum, iv) => sum + Math.pow(iv - avgInterval, 2), 0) / intervals.length;
  const cv = Math.sqrt(variance) / avgInterval; // coefficient of variation

  // Human behavior typically shows CV > 0.4; perfect coordination shows CV < 0.2
  const isOrganic = cv > 0.3;

  return {
    ok: isOrganic,
    coefficient_of_variation: cv,
    avg_interval_min: avgInterval,
    interval_count: intervals.length,
    note: isOrganic
      ? "timing shows human-like variability"
      : "timing intervals appear highly regular; consider adding variance",
    recommendations: isOrganic
      ? []
      : ["use probabilistic_wait with variance >= 0.5", "stagger account session start times"]
  };
}

// Verify voice distinctiveness across accounts
function checkVoiceDistinctiveness(accountIds) {
  const profiles = accountIds.map(id => loadProfile(id)).filter(p => p !== null);

  if (profiles.length < 2) return { ok: true, note: "single account or profiles unavailable" };

  const distinctiveness = {
    tones: new Set(profiles.map(p => p.writing_style?.tone || "standard")),
    vocabularies: new Set(profiles.map(p => p.writing_style?.vocabulary || "standard")),
    personas: new Set(profiles.map(p => p.persona || "standard")),
    expertise_overlap: []
  };

  // Check expertise overlap (too much overlap reduces distinctiveness)
  const expertiseDomains = profiles.map(p =>
    p.expertise?.map(e => e.domain).filter(d => d) || []
  );

  for (let i = 0; i < expertiseDomains.length; i++) {
    for (let j = i + 1; j < expertiseDomains.length; j++) {
      const overlap = expertiseDomains[i].filter(d => expertiseDomains[j].includes(d));
      if (overlap.length > 0) {
        distinctiveness.expertise_overlap.push({
          accounts: [profiles[i].account_id, profiles[j].account_id],
          shared_domains: overlap,
          overlap_ratio: overlap.length / Math.max(expertiseDomains[i].length, expertiseDomains[j].length)
        });
      }
    }
  }

  const isDistinctive = distinctiveness.tones.size >= profiles.length * 0.6 &&
                        distinctiveness.vocabularies.size >= profiles.length * 0.6;

  return {
    ok: isDistinctive,
    distinctiveness,
    account_count: profiles.length,
    note: isDistinctive
      ? "accounts show clear voice differentiation"
      : "some accounts share similar voice characteristics; consider diversifying",
    recommendations: isDistinctive
      ? []
      : ["diversify writing_style.tone across accounts", "expand expertise domain separation"]
  };
}

// Monitor engagement depth variation
function checkEngagementDepth(participationData) {
  const contributions = participationData.filter(p => p.content && p.content.length);

  if (contributions.length < 3) return { ok: true, note: "insufficient contributions for depth analysis" };

  const lengths = contributions.map(c => c.content.length);
  const avgLength = lengths.reduce((a, b) => a + b, 0) / lengths.length;
  const minLen = Math.min(...lengths);
  const maxLen = Math.max(...lengths);
  const rangeRatio = maxLen / Math.max(minLen, 1);

  // Healthy variation: range ratio between 1.5 and 4.0
  // Too uniform (< 1.5) or too extreme (> 4.0) may need adjustment
  const hasHealthyVariation = rangeRatio >= 1.5 && rangeRatio <= 4.0;

  return {
    ok: hasHealthyVariation,
    avg_content_length: avgLength,
    min_length: minLen,
    max_length: maxLen,
    range_ratio: rangeRatio,
    contribution_count: contributions.length,
    note: hasHealthyVariation
      ? "engagement shows healthy depth variation"
      : rangeRatio < 1.5
        ? "contributions are uniformly sized; encourage depth variation"
        : "large disparity in contribution depth; consider balancing",
    recommendations: hasHealthyVariation
      ? []
      : rangeRatio < 1.5
        ? ["some accounts should provide more detailed responses", "others can offer concise acknowledgments"]
        : ["balance contribution depths across accounts", "align depth with account expertise"]
  };
}

// Check organic discovery patterns
function checkOrganicDiscovery(threadParticipation) {
  // Group by thread and analyze when accounts join
  const threads = {};
  threadParticipation.forEach(p => {
    if (!threads[p.thread_id]) threads[p.thread_id] = [];
    threads[p.thread_id].push({
      account_id: p.account_id,
      joined_at: new Date(p.timestamp).getTime(),
      engagement_type: p.engagement_type
    });
  });

  const discoveryPatterns = {};
  let totalThreads = 0;
  let organicThreads = 0;

  Object.keys(threads).forEach(threadId => {
    const participants = threads[threadId];
    participants.sort((a, b) => a.joined_at - b.joined_at);

    // Calculate join intervals
    const joinIntervals = [];
    for (let i = 1; i < participants.length; i++) {
      joinIntervals.push((participants[i].joined_at - participants[i - 1].joined_at) / 60000);
    }

    // Organic: accounts join at different times (not all at once)
    const isOrganic = joinIntervals.every(iv => iv > 2); // > 2 minutes between joins

    discoveryPatterns[threadId] = {
      participant_count: participants.length,
      join_intervals_min: joinIntervals,
      is_organic: isOrganic,
      first_engagement: participants[0].engagement_type,
      engagement_sequence: participants.map(p => p.engagement_type)
    };

    totalThreads++;
    if (isOrganic) organicThreads++;
  });

  const organicRatio = organicThreads / Math.max(totalThreads, 1);

  return {
    ok: organicRatio >= 0.7,
    total_threads: totalThreads,
    organic_threads: organicThreads,
    organic_ratio: organicRatio,
    thread_patterns: discoveryPatterns,
    note: organicRatio >= 0.7
      ? "accounts show organic discovery across threads"
      : "some threads show synchronized account entry; consider staggering",
    recommendations: organicRatio >= 0.7
      ? []
      : ["stagger sequence start times across accounts", "use probabilistic delays before initial engagement"]
  };
}

// Comprehensive legitimacy assessment
function generateLegitimacyReport(threadId, accountIds, participationData) {
  const checks = {
    timing: checkTimingVariability(participationData),
    voice: checkVoiceDistinctiveness(accountIds),
    depth: checkEngagementDepth(participationData),
    discovery: checkOrganicDiscovery(participationData)
  };

  const overallScore = Object.values(checks).reduce((sum, c) => sum + (c.ok ? 1 : 0), 0) / Object.keys(checks).length;
  const isLegitimate = overallScore >= 0.75;

  return {
    thread_id: threadId,
    assessed_at: new Date().toISOString(),
    overall: {
      is_legitimate: isLegitimate,
      score: overallScore,
      account_count: accountIds.length,
      participation_count: participationData.length
    },
    checks,
    summary: isLegitimate
      ? "Multi-account participation shows organic, legitimate patterns"
      : "Participation patterns show some coordination signals; recommendations provided",
    all_recommendations: [
      ...checks.timing.recommendations || [],
      ...checks.voice.recommendations || [],
      ...checks.depth.recommendations || [],
      ...checks.discovery.recommendations || []
    ]
  };
}

module.exports = {
  loadProfile,
  checkTimingVariability,
  checkVoiceDistinctiveness,
  checkEngagementDepth,
  checkOrganicDiscovery,
  generateLegitimacyReport
};