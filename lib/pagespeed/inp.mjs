// Diagnostics for the slowest interaction of a Lighthouse timespan trace. Never used for medians or acceptance: INP
// itself is Lighthouse's own interaction-to-next-paint audit. This only explains it (input delay / processing /
// presentation delay, as in the web-vitals attribution) and ties it back to the scenario step when that is unambiguous.
import { Responsiveness } from 'lighthouse/core/computed/metrics/responsiveness.js';
import { interactionCount, stepLabel } from './interactions.mjs';

export const INP_AUDIT = 'interaction-to-next-paint';

const round = (n) => Math.round(n * 10) / 10;

// EventTiming events that belong to an interaction, grouped by interactionId in the order the interactions started.
export function interactionGroups(trace) {
  const groups = new Map();
  for (const event of trace?.traceEvents ?? []) {
    const d = event?.name === 'EventTiming' && event.ph !== 'e' ? event.args?.data : null;
    if (!d || !(d.interactionId > 0)) continue;
    const group = groups.get(d.interactionId) ?? { interactionId: d.interactionId, ts: event.ts, events: [] };
    group.ts = Math.min(group.ts, event.ts);
    group.events.push(d);
    groups.set(d.interactionId, group);
  }
  return [...groups.values()].sort((a, b) => a.ts - b.ts);
}

// Breaks one interaction group down. The longest event decides the start; processing spans every handler of the group.
export function breakdown(group) {
  const longest = group.events.reduce((a, b) => (b.duration > a.duration ? b : a));
  const processingStart = Math.min(...group.events.map((e) => e.processingStart));
  const processingEnd = Math.max(...group.events.map((e) => e.processingEnd));
  return {
    interactionId: group.interactionId,
    eventType: longest.type,
    duration: round(longest.duration),
    inputDelay: round(Math.max(0, processingStart - longest.timeStamp)),
    processingTime: round(Math.max(0, processingEnd - processingStart)),
    presentationDelay: round(Math.max(0, longest.timeStamp + longest.duration - processingEnd)),
  };
}

// { interactions, slowest } for a timespan trace. `steps` (the scenario) is only used to name the step of the slowest
// interaction, and only when the number of interactions Chrome saw equals the number the steps should have produced.
export async function analyzeInteractions(trace, steps = null, settings = { throttlingMethod: 'devtools' }) {
  const groups = interactionGroups(trace);
  const event = await Responsiveness.request({ trace, settings }, { computedCache: new Map() });
  if (!event) return { interactions: groups.length, slowest: null };
  const target = event.args.data.duration;
  const match = groups.map((group) => ({ group, gap: Math.min(...group.events.map((e) => Math.abs(e.duration - target))) }))
    .sort((a, b) => a.gap - b.gap)[0];
  if (!match || match.gap > 5) return { interactions: groups.length, slowest: null };
  const slowest = breakdown(match.group);
  const ordinals = steps?.flatMap((step, index) => Array.from({ length: interactionCount(step) }, () => index)) ?? [];
  if (ordinals.length === groups.length) {
    const index = ordinals[groups.indexOf(match.group)];
    slowest.step = { index, label: stepLabel(steps[index]) };
  }
  return { interactions: groups.length, slowest };
}
