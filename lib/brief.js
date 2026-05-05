const fetch = require('node-fetch');

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';

function formatAdsForPrompt(ads) {
  return ads.map(ad => {
    const parts = [`Ad: ${ad.adName}`];
    if (ad.format) parts.push(`Format: ${ad.format}`);
    if (ad.hook) parts.push(`Hook: ${ad.hook}`);
    if (ad.spend != null) parts.push(`Spend: $${ad.spend}`);
    if (ad.roas != null) parts.push(`ROAS: ${ad.roas}`);
    if (ad.ctr != null) parts.push(`CTR: ${ad.ctr}%`);
    if (ad.cpc != null) parts.push(`CPC: $${ad.cpc}`);
    if (ad.cpm != null) parts.push(`CPM: $${ad.cpm}`);
    if (ad.frequency != null) parts.push(`Frequency: ${ad.frequency}`);
    if (ad.impressions != null) parts.push(`Impressions: ${ad.impressions}`);
    return parts.join(' | ');
  }).join('\n');
}

async function generateBrief(ads, previousWeekSummary) {
  const adsText = formatAdsForPrompt(ads);

  const contextBlock = previousWeekSummary
    ? `\n\nLast week's top performers for comparison:\n${previousWeekSummary}\n`
    : '';

  const prompt = `You are a sharp creative director writing a weekly brief for your design team. Your job is to turn raw Meta Ads numbers into clear, direct instructions — what to scale, what to kill, and what to make next.

This week's ad data:
${adsText}
${contextBlock}
Write like you're talking to your team in a Monday morning debrief. Be direct and confident. Use short sentences. Say exactly what needs to happen. No jargon, no hedging, no "consider" or "may want to" — just tell them what to do and why.

Respond with ONLY a valid JSON object in this exact structure:

{
  "topPerformers": [
    {
      "adName": "name of the ad",
      "why": "1-2 punchy sentences on why it's winning — mention the specific numbers that matter",
      "action": "One clear instruction. What should the team do with this right now?"
    }
  ],
  "underperformers": [
    {
      "adName": "name of the ad",
      "why": "1-2 sentences on what's not working and why — be specific",
      "action": "One clear instruction. What needs to change?"
    }
  ],
  "fatigueAlerts": [
    {
      "adName": "name of the ad",
      "why": "1-2 sentences explaining the fatigue signal in plain terms",
      "action": "One clear instruction on what to do next"
    }
  ],
  "makeNext": [
    {
      "concept": "A specific creative concept — format, hook idea, visual direction",
      "rationale": "1-2 sentences on why this concept is the right call based on what's working"
    }
  ],
  "retireNow": [
    {
      "adName": "name of the ad",
      "reason": "One blunt sentence on why this ad needs to stop running today"
    }
  ],
  "summary": "2-3 sentences written for someone who hasn't looked at a single number. Tell them how the week went, what the headline win was, and what the team's focus should be this week."
}

Rules:
- Only include ads in each section if the data clearly supports it — empty arrays are fine
- topPerformers: ROAS > 2.0 or CTR > 2% are strong signals
- fatigueAlerts: frequency > 3.5 is a clear fatigue signal
- retireNow: spend > $50 with ROAS < 0.5 or CTR < 0.3% warrants an immediate stop
- makeNext: 2-3 concepts inspired by patterns in the top performers
- Respond with ONLY the JSON, no other text`;

  const response = await fetch(GROQ_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 2000,
      temperature: 0.4,
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Groq API error: ${err}`);
  }

  const result = await response.json();
  const raw = result.choices?.[0]?.message?.content?.trim() || '';

  try {
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON found');
    return { ok: true, brief: JSON.parse(jsonMatch[0]) };
  } catch (e) {
    return { ok: false, raw, error: e.message };
  }
}

module.exports = { generateBrief };
