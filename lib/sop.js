const DEFAULT_SOP_SETTINGS = {
  spendTier: 'lite',
  brandRegister: 'mainstream',
  targetCpa: null,
  baselineCtr: null,
  activeStages: ['TOF'],
};

const SPEND_TIERS = {
  lite: {
    label: 'Lite / Starter',
    adsPerWeek: 5,
    liveAdsTarget: '8-10',
    fresh: 2,
    iterations: 3,
    stages: ['TOF'],
  },
  growth: {
    label: 'Growth / Standard',
    adsPerWeek: 10,
    liveAdsTarget: '15-20',
    fresh: 4,
    iterations: 6,
    stages: ['TOF', 'MOF'],
  },
  scale: {
    label: 'Scale / Flagship',
    adsPerWeek: 15,
    liveAdsTarget: '24-30',
    fresh: 6,
    iterations: 9,
    stages: ['TOF', 'MOF', 'BOF'],
  },
};

const PREMIUM_BLOCKED_FORMATS = [
  ['faketweet', 'Fake Tweet / X Post'],
  ['xpost', 'Fake Tweet / X Post'],
  ['textmessage', 'Text Message Thread'],
  ['textthread', 'Text Message Thread'],
  ['meme', 'Meme Format'],
  ['reddit', 'Reddit / Forum Post Style'],
  ['forum', 'Reddit / Forum Post Style'],
];

const PREMIUM_CAUTION_FORMATS = [
  ['stickynote', 'Sticky Note Photo'],
  ['iphonenotes', 'iPhone Notes App'],
  ['notesapp', 'iPhone Notes App'],
  ['googlesearch', 'Fake Google Search'],
  ['crumpled', 'Crumpled / Torn Document'],
  ['torn', 'Crumpled / Torn Document'],
  ['journal', 'Journal Entry'],
  ['googledoc', 'Google Doc Screenshot'],
];

const KNOWN_ANGLES = [
  'ProblemFirst',
  'OutcomeFirst',
  'Objection',
  'SocialProof',
  'HowItWorks',
  'Comparison',
  'OfferHook',
  'PainAware',
  'Proof',
  'Demo',
];

function normalizeSettings(settings = {}) {
  const spendTier = SPEND_TIERS[settings.spendTier] ? settings.spendTier : DEFAULT_SOP_SETTINGS.spendTier;
  const brandRegister = ['premium', 'mainstream', 'casual'].includes(settings.brandRegister)
    ? settings.brandRegister
    : DEFAULT_SOP_SETTINGS.brandRegister;
  const tier = SPEND_TIERS[spendTier];
  const activeStages = Array.isArray(settings.activeStages) && settings.activeStages.length
    ? settings.activeStages.filter(s => ['TOF', 'MOF', 'BOF'].includes(s))
    : tier.stages;

  return {
    ...DEFAULT_SOP_SETTINGS,
    ...settings,
    spendTier,
    brandRegister,
    activeStages: activeStages.length ? activeStages : tier.stages,
    targetCpa: numberOrNull(settings.targetCpa),
    baselineCtr: numberOrNull(settings.baselineCtr),
  };
}

function numberOrNull(value) {
  if (value === '' || value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function norm(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function parseAdName(ad) {
  const name = String(ad.adName || '');
  const tokens = name.split(/[_|\-\s]+/).map(t => t.trim()).filter(Boolean);
  const upperTokens = tokens.map(t => t.toUpperCase());
  const status = upperTokens.includes('EVG') ? 'EVG' : (upperTokens.includes('TEST') ? 'TEST' : null);
  const stage = ['TOF', 'MOF', 'BOF'].find(s => upperTokens.includes(s)) || null;
  const ratio = tokens.find(t => /^(4x5|9x16|1x1)$/i.test(t)) || null;
  const angle = KNOWN_ANGLES.find(a => norm(name).includes(norm(a))) || null;
  const format = ad.format || inferFormat(name);
  return { status, stage, ratio, angle, format };
}

function inferFormat(name) {
  const n = norm(name);
  const formats = [
    ['carousel', 'Carousel'],
    ['video', 'Video'],
    ['reel', 'Video'],
    ['reviewcard', 'Review Card'],
    ['quotecard', 'Quote Card'],
    ['stickynote', 'Sticky Note'],
    ['napkinmath', 'Napkin Math'],
    ['checklist', 'Checklist'],
    ['whiteboard', 'Whiteboard'],
    ['invoice', 'Invoice'],
    ['receipt', 'Receipt'],
    ['newspaper', 'Newspaper'],
  ];
  const found = formats.find(([key]) => n.includes(key));
  return found ? found[1] : null;
}

function brandFormatIssue(ad, settings) {
  if (settings.brandRegister !== 'premium') return null;
  const haystack = norm(`${ad.adName || ''} ${ad.format || ''}`);
  const blocked = PREMIUM_BLOCKED_FORMATS.find(([key]) => haystack.includes(key));
  if (blocked) return { level: 'Block', format: blocked[1], adName: ad.adName };
  const caution = PREMIUM_CAUTION_FORMATS.find(([key]) => haystack.includes(key));
  if (caution) return { level: 'Caution', format: caution[1], adName: ad.adName };
  return null;
}

function cpa(ad) {
  const results = Number(ad.results);
  const spend = Number(ad.spend);
  if (!Number.isFinite(results) || results <= 0 || !Number.isFinite(spend)) return null;
  return spend / results;
}

function enoughDelivery(ad, settings) {
  const impressions = Number(ad.impressions) || 0;
  const spend = Number(ad.spend) || 0;
  return impressions >= 1000 || (settings.targetCpa != null && spend >= settings.targetCpa);
}

function decisionFor(ad, settings) {
  if (!hasMetrics(ad)) return { decision: 'No metrics', reason: 'Meta did not return performance stats for this ad.' };

  const ctr = numberOrNull(ad.ctr);
  const spend = Number(ad.spend) || 0;
  const results = Number(ad.results) || 0;
  const actualCpa = cpa(ad);
  const baselineCtr = settings.baselineCtr;
  const targetCpa = settings.targetCpa;
  const delivered = enoughDelivery(ad, settings);

  if (!delivered) return { decision: 'Needs more delivery', reason: 'Not enough impressions or spend to judge yet.' };

  const ctrStrong = baselineCtr == null || (ctr != null && ctr >= baselineCtr);
  const ctrWeak = baselineCtr != null && ctr != null && ctr < baselineCtr * 0.7;
  const cpaWinner = targetCpa != null && actualCpa != null && actualCpa <= targetCpa && results >= 2;
  const roasWinner = numberOrNull(ad.roas) != null && Number(ad.roas) >= 3;

  if ((cpaWinner || roasWinner) && ctrStrong) {
    return { decision: 'Winner', reason: 'Meets the win rule against CPA/ROAS and CTR.' };
  }
  if (ctrWeak) return { decision: 'Pause candidate', reason: 'CTR is clearly below the account baseline.' };
  if (targetCpa != null && spend >= targetCpa * 2 && results < 1) {
    return { decision: 'Pause candidate', reason: 'Spend is near 2x target CPA with poor or no conversions.' };
  }
  return { decision: 'Keep testing', reason: 'Has delivery, but does not clearly win or fail yet.' };
}

function hasMetrics(ad) {
  return ['spend', 'impressions', 'clicks', 'ctr', 'cpc', 'cpm', 'reach', 'frequency', 'results', 'roas']
    .some(key => ad[key] != null && Number.isFinite(Number(ad[key])));
}

function buildSopReadout(ads = [], rawSettings = {}) {
  const settings = normalizeSettings(rawSettings);
  const tier = SPEND_TIERS[settings.spendTier];
  const enriched = ads.map(ad => {
    const parsed = parseAdName(ad);
    return { ...ad, sop: { ...parsed, ...decisionFor(ad, settings), cpa: cpa(ad) } };
  });

  const liveAds = enriched.filter(ad => !/paused|inactive|deleted|archived/i.test(String(ad.adStatus || '')));
  const withMetrics = enriched.filter(hasMetrics);
  const decisions = {
    winners: enriched.filter(ad => ad.sop.decision === 'Winner'),
    pause: enriched.filter(ad => ad.sop.decision === 'Pause candidate'),
    needsMoreDelivery: enriched.filter(ad => ad.sop.decision === 'Needs more delivery'),
    keepTesting: enriched.filter(ad => ad.sop.decision === 'Keep testing'),
  };

  const missingFields = enriched.filter(ad => !ad.sop.stage || !ad.sop.angle || !ad.sop.format || !ad.sop.ratio);
  const formatIssues = enriched.map(ad => brandFormatIssue(ad, settings)).filter(Boolean);
  const stagesPresent = new Set(enriched.map(ad => ad.sop.stage).filter(Boolean));
  const missingStages = settings.activeStages.filter(stage => !stagesPresent.has(stage));

  const checks = [
    {
      label: 'Weekly launch target',
      ok: enriched.length >= tier.adsPerWeek,
      detail: `${enriched.length}/${tier.adsPerWeek} ads present for ${tier.label}.`,
    },
    {
      label: 'Live ad target',
      ok: liveAds.length >= Number(tier.liveAdsTarget.split('-')[0]),
      detail: `${liveAds.length} live ads; target is ${tier.liveAdsTarget}.`,
    },
    {
      label: 'SOP naming fields',
      ok: missingFields.length === 0,
      detail: missingFields.length ? `${missingFields.length} ads missing stage, angle, format, or ratio.` : 'Every ad has stage, angle, format, and ratio signals.',
    },
    {
      label: 'Brand format gate',
      ok: !formatIssues.some(i => i.level === 'Block'),
      detail: formatIssues.length ? `${formatIssues.length} premium format issue(s) found.` : 'No brand-register format issues detected.',
    },
    {
      label: 'Funnel coverage',
      ok: missingStages.length === 0,
      detail: missingStages.length ? `Missing ${missingStages.join(', ')} ads.` : `Active stages covered: ${settings.activeStages.join(', ')}.`,
    },
  ];

  const nextCreative = buildNextCreative(decisions.winners, settings, tier);

  return {
    settings,
    tier,
    summary: {
      adCount: enriched.length,
      liveAds: liveAds.length,
      metricsCount: withMetrics.length,
      winners: decisions.winners.length,
      pause: decisions.pause.length,
      needsMoreDelivery: decisions.needsMoreDelivery.length,
      keepTesting: decisions.keepTesting.length,
    },
    checks,
    decisions: {
      winners: compactAds(decisions.winners, 6),
      pause: compactAds(decisions.pause, 6),
      needsMoreDelivery: compactAds(decisions.needsMoreDelivery, 6),
      keepTesting: compactAds(decisions.keepTesting, 6),
    },
    gaps: {
      missingFields: missingFields.slice(0, 8).map(ad => ({ adName: ad.adName, missing: missingFor(ad.sop) })),
      formatIssues: formatIssues.slice(0, 8),
      missingStages,
    },
    nextCreative,
  };
}

function missingFor(sop) {
  return ['stage', 'angle', 'format', 'ratio'].filter(key => !sop[key]);
}

function compactAds(ads, limit) {
  return ads.slice(0, limit).map(ad => ({
    adName: ad.adName,
    spend: ad.spend ?? null,
    impressions: ad.impressions ?? null,
    ctr: ad.ctr ?? null,
    results: ad.results ?? null,
    cpa: ad.sop.cpa,
    stage: ad.sop.stage,
    angle: ad.sop.angle,
    format: ad.sop.format,
    decision: ad.sop.decision,
    reason: ad.sop.reason,
  }));
}

function buildNextCreative(winners, settings, tier) {
  const winnerAngles = [...new Set(winners.map(ad => ad.sop.angle).filter(Boolean))];
  const winnerFormats = [...new Set(winners.map(ad => ad.sop.format).filter(Boolean))];
  const stages = settings.activeStages.length ? settings.activeStages : tier.stages;
  const concepts = [];

  for (const stage of stages) {
    const angle = winnerAngles.shift() || defaultAngle(stage);
    const format = winnerFormats.shift() || defaultFormat(stage, settings.brandRegister);
    concepts.push({
      stage,
      angle,
      format,
      count: Math.max(1, Math.round(tier.adsPerWeek / stages.length)),
      note: winners.length
        ? 'Iterate from the strongest winning message and vary the proof, hook, or visual treatment.'
        : 'No clear winner yet. Use a clean fresh angle plus variants so next week has enough signal.',
    });
  }

  return {
    target: tier.adsPerWeek,
    fresh: tier.fresh,
    iterations: tier.iterations,
    concepts,
  };
}

function defaultAngle(stage) {
  if (stage === 'MOF') return 'SocialProof';
  if (stage === 'BOF') return 'OfferHook';
  return 'ProblemFirst';
}

function defaultFormat(stage, register) {
  if (stage === 'MOF') return 'Review Card';
  if (stage === 'BOF') return 'Quote Card';
  return register === 'premium' ? 'Bold Typographic Quote Card' : 'Static / Graphic';
}

module.exports = { DEFAULT_SOP_SETTINGS, SPEND_TIERS, normalizeSettings, buildSopReadout };
