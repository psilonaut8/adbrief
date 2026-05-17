const fetch = require('node-fetch');

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';

function formatAdsForPrompt(ads) {
  // Sort by spend desc, cap at 50 — keeps tokens under Groq free tier TPM limit
  const sorted = [...ads].sort((a, b) => (b.spend || 0) - (a.spend || 0)).slice(0, 50);
  return sorted.map(ad => {
    const parts = [`Ad: ${ad.adName}`];
    if (ad.adStatus) parts.push(`Status: ${ad.adStatus}`);
    if (ad.format) parts.push(`Format: ${ad.format}`);
    if (ad.spend != null) parts.push(`Spend: $${ad.spend}`);
    if (ad.results != null) {
      const label = ad.resultType ? `${ad.results} ${ad.resultType}` : String(ad.results);
      parts.push(`Results: ${label}`);
    }
    if (ad.roas != null) parts.push(`ROAS: ${ad.roas}`);
    if (ad.ctr != null) parts.push(`CTR: ${ad.ctr}%`);
    if (ad.frequency != null) parts.push(`Frequency: ${ad.frequency}`);
    return parts.join(' | ');
  }).join('\n');
}

async function generateBrief(ads, historySummary, contextText) {
  const adsText = formatAdsForPrompt(ads);

  const clientContextBlock = contextText
    ? `\n\nBusiness context — use this to make your recommendations specific to this brand, audience, and offer. Don't mention that you have this info; just let it inform your analysis:\n${contextText}\n`
    : '';

  const historyBlock = historySummary
    ? `\n\nRecent performance history — use this to spot trends, recurring winners, format patterns, and persistent underperformers:\n${historySummary}\n`
    : '';

  const prompt = `You are a sharp creative director writing a weekly brief for your design team. Your job is to turn raw Meta Ads numbers into clear, direct instructions — what to scale, what to kill, and what to make next.
${clientContextBlock}

This week's ad data:
${adsText}
${historyBlock}
Write like you're talking to your team in a Monday morning debrief. Be direct and confident. Use short sentences. Say exactly what needs to happen. No jargon, no hedging, no "consider" or "may want to" — just tell them what to do and why.

Number formatting rules — always follow these:
- Round all decimals to 1 place max (e.g. frequency 3.0, CTR 2.4%, ROAS 1.8)
- Write CTR as a percentage: "2.4%" not "0.024"
- Write frequency as a plain number: "3.0" not "3.01131645"

Respond with ONLY a valid JSON object in this exact structure:

{
  "topPerformers": [
    {
      "adName": "name of the ad",
      "metric": "The single most important number that explains why it's here — e.g. 'CTR 2.4%' or 'ROAS 3.2' or '42 Leads' or 'Spend $420'",
      "why": "1-2 punchy sentences on why it's winning. No raw decimals — round all numbers.",
      "action": "One clear instruction. What should the team do with this right now?"
    }
  ],
  "underperformers": [
    {
      "adName": "name of the ad",
      "metric": "The single number that flags the problem — e.g. 'CTR 0.3%' or 'ROAS 0.4'",
      "why": "1-2 sentences on what's not working and why — be specific. Round all numbers.",
      "action": "One clear instruction. What needs to change?"
    }
  ],
  "fatigueAlerts": [
    {
      "adName": "name of the ad",
      "metric": "The fatigue signal — e.g. 'Freq 3.5'",
      "why": "1-2 sentences explaining the fatigue signal in plain terms. Round all numbers.",
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
      "metric": "The number that kills it — e.g. 'CTR 0.1%' or 'ROAS 0.2'",
      "reason": "One blunt sentence on why this ad needs to stop running today"
    }
  ],
  "summary": [
    "One sentence on how the week went overall.",
    "One sentence on the headline win or the biggest problem.",
    "One sentence on what the team's focus should be this week."
  ]
}

Rules:
- Only include ads in each section if the data clearly supports it — empty arrays are fine
- topPerformers: ROAS > 2.0 or CTR > 2% are strong signals
- fatigueAlerts: frequency > 3.0 is a fatigue signal
- retireNow: spend > $50 with ROAS < 0.5 or CTR < 0.3% warrants an immediate stop
- makeNext: 2-3 concepts inspired by patterns in the top performers
- If history is provided, use it to flag ads that have underperformed multiple weeks in a row, or formats that are consistently winning — mention this in the why/reason fields
- summary must be an array of exactly 3 strings
- Ad status guidance — use the Status field to inform your recommendations:
  - "Active": running normally, judge on performance as usual
  - "Paused": team already stopped it — don't tell them to pause or retire it; only flag it if it's worth reactivating or if there's a useful insight
  - "Not delivered" / "Not delivering": Meta couldn't serve this ad (disapproved, budget issue, audience too narrow, outbid) — note this in the why field so the team knows it never actually ran; don't judge it on CTR/ROAS
  - "Inactive" / "Archived": ignore for recommendations
  - "In draft": ignore completely
  - "Learning" / "Learning limited": flag gently — results aren't stable yet, don't over-index on its numbers
- Respond with ONLY the JSON, no other text`;

  const response = await fetch(GROQ_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'openai/gpt-oss-120b',
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
