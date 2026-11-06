// Declarative interaction steps for INP (Interaction to Next Paint). A scenario is a short list of steps replayed by the
// measurement job in one Lighthouse timespan after the cold navigation, identically in before and after. There is no
// arbitrary code: every step is one of a few actions on a CSS / Puppeteer selector.
//
//   { "action": "tap" | "click" | "type" | "press" | "waitFor" | "scroll" | "pause",
//     "selector"?: string, "text"?: string, "key"?: string, "ms"?: number, "label"?: string }
//
//   tap, click   selector (required); ms = settle pause after the interaction (0..10000, default 1000)
//   type         selector + text (required); focuses the element without an extra tap, then types key by key. Never into
//                a password or one-time-code field: scenarios are public run inputs, so typed text must not be a secret
//   press        key (required, e.g. "Enter"); selector (optional) is focused first; ms = settle pause
//   waitFor      selector (required): wait until visible; ms = timeout (1..60000, default 30000)
//   scroll       selector (optional): scroll it into view, or one viewport down; ms = settle pause
//   pause        ms (required, 1..10000)
//   auto         pass-partout: finds tabs, toggles, safe buttons and a modal opener by itself and taps them, so no page
//                selectors are needed (max, kinds, exclude, scope; see auto-interactions.mjs)
//
// tap, click, type, press and auto are the interactions: they are what INP measures. The other steps only prepare them.
import { createHash } from 'node:crypto';
import {
  AUTO_KINDS, AUTO_VERSION, DEFAULT_AUTO_MAX, MAX_AUTO, MAX_AUTO_EXCLUDES, discoverTargets, nextTarget,
} from './auto-interactions.mjs';

export const MAX_STEPS = 20;
export const MAX_SELECTOR_CHARS = 300;
export const MAX_TEXT_CHARS = 200;
export const MAX_LABEL_CHARS = 80;
export const MAX_PAUSE_MS = 10000;
export const MAX_WAIT_MS = 60000;
export const DEFAULT_SETTLE_MS = 1000;
export const DEFAULT_WAIT_MS = 30000;
export const TYPE_DELAY_MS = 50;

export const ACTIONS = ['tap', 'click', 'type', 'press', 'waitFor', 'scroll', 'pause', 'auto'];
export const INTERACTION_ACTIONS = ['tap', 'click', 'type', 'press', 'auto'];
// The whole scenario of `--interactions auto`: discover and exercise the page's in-page interactions.
export const AUTO_SCENARIO = [{ action: 'auto' }];
const FIELDS = ['action', 'selector', 'text', 'key', 'ms', 'label', 'max', 'kinds', 'exclude', 'scope'];
const ALLOWED = {
  tap: ['selector', 'ms', 'label'],
  click: ['selector', 'ms', 'label'],
  type: ['selector', 'text', 'ms', 'label'],
  press: ['selector', 'key', 'ms', 'label'],
  waitFor: ['selector', 'ms', 'label'],
  scroll: ['selector', 'ms', 'label'],
  pause: ['ms', 'label'],
  auto: ['max', 'kinds', 'exclude', 'scope', 'ms', 'label'],
};
const REQUIRED = { tap: ['selector'], click: ['selector'], type: ['selector', 'text'], press: ['key'], waitFor: ['selector'], scroll: [], pause: ['ms'], auto: [] };
const KEY = /^(?:[A-Za-z][A-Za-z0-9]{0,29}|[!-~])$/;
const CONTROL = /[\u0000-\u001f\u007f]/;
const SECRET_FIELD_SELECTOR = /pass(?:word|wd|code)|pwd|one-time-code|\botp\b/i;

const bad = (message) => { throw new Error(`interactions: ${message}`); };

const string = (where, field, value, max) => {
  if (typeof value !== 'string' || !value.trim()) bad(`${where} ${field} must be a non-empty string`);
  if (value.length > max) bad(`${where} ${field} is longer than ${max} characters`);
  if (CONTROL.test(value)) bad(`${where} ${field} must not contain control characters`);
};

// Throws on the first problem, with a message that names the step. Returns the steps unchanged.
export function validateInteractions(steps) {
  if (!Array.isArray(steps)) bad('must be an array of steps');
  if (!steps.length) bad('needs at least one step');
  if (steps.length > MAX_STEPS) bad(`has ${steps.length} steps; at most ${MAX_STEPS} are allowed`);
  steps.forEach((step, index) => {
    if (!step || typeof step !== 'object' || Array.isArray(step)) bad(`[${index}] must be an object`);
    if (!ACTIONS.includes(step.action)) bad(`[${index}] action must be one of ${ACTIONS.join(', ')}`);
    const where = `[${index}] (${step.action})`;
    const unknown = Object.keys(step).filter((k) => k !== 'action' && !FIELDS.includes(k));
    if (unknown.length) bad(`${where} has unknown field(s): ${unknown.join(', ')}`);
    const forbidden = Object.keys(step).filter((k) => k !== 'action' && !ALLOWED[step.action].includes(k));
    if (forbidden.length) bad(`${where} does not accept: ${forbidden.join(', ')}`);
    for (const field of REQUIRED[step.action]) if (step[field] == null) bad(`${where} needs ${field}`);
    if (step.selector != null) string(where, 'selector', step.selector, MAX_SELECTOR_CHARS);
    if (step.action === 'type' && SECRET_FIELD_SELECTOR.test(step.selector)) bad(`${where} must not type into a password or one-time-code field (perf-ab runs are public)`);
    if (step.text != null) string(where, 'text', step.text, MAX_TEXT_CHARS);
    if (step.label != null) string(where, 'label', step.label, MAX_LABEL_CHARS);
    if (step.key != null && (typeof step.key !== 'string' || !KEY.test(step.key))) bad(`${where} key must be a key name such as Enter, ArrowDown or a single character`);
    if (step.scope != null) string(where, 'scope', step.scope, MAX_SELECTOR_CHARS);
    if (step.max != null && (!Number.isInteger(step.max) || step.max < 1 || step.max > MAX_AUTO)) bad(`${where} max must be an integer between 1 and ${MAX_AUTO}`);
    if (step.kinds != null) {
      if (!Array.isArray(step.kinds) || !step.kinds.length || new Set(step.kinds).size !== step.kinds.length || step.kinds.some((k) => !AUTO_KINDS.includes(k))) {
        bad(`${where} kinds must be a non-empty list without repeats of: ${AUTO_KINDS.join(', ')}`);
      }
    }
    if (step.exclude != null) {
      if (!Array.isArray(step.exclude) || step.exclude.length > MAX_AUTO_EXCLUDES) bad(`${where} exclude must be a list of at most ${MAX_AUTO_EXCLUDES} selectors`);
      step.exclude.forEach((selector) => string(where, 'exclude selector', selector, MAX_SELECTOR_CHARS));
    }
    if (step.ms != null) {
      if (!Number.isInteger(step.ms)) bad(`${where} ms must be an integer`);
      const [min, max] = step.action === 'pause' ? [1, MAX_PAUSE_MS] : step.action === 'waitFor' ? [1, MAX_WAIT_MS] : [0, MAX_PAUSE_MS];
      if (step.ms < min || step.ms > max) bad(`${where} ms must be between ${min} and ${max}`);
    }
  });
  if (!steps.some((s) => INTERACTION_ACTIONS.includes(s.action))) bad(`needs at least one interaction step (${INTERACTION_ACTIONS.join(', ')}); INP is not measurable without one`);
  return steps;
}

// Steps in a fixed key order, without labels (a label is cosmetic and never changes what is measured). An auto step is
// written with its defaults filled in and the discovery version, so only a real change of behaviour changes the key.
export const canonicalSteps = (steps) => steps.map((s) => Object.fromEntries(FIELDS.filter((k) => k !== 'label' && s[k] != null).map((k) => [k, s[k]]))).map((s) => (
  s.action === 'auto' ? { ...s, max: s.max ?? DEFAULT_AUTO_MAX, kinds: s.kinds ?? AUTO_KINDS, exclude: s.exclude ?? [], autoVersion: AUTO_VERSION } : s));

// Identifies the scenario. Runs measured with different keys are never compared with each other.
export const interactionsKey = (steps) => createHash('sha256').update(JSON.stringify(canonicalSteps(steps))).digest('hex');

// Number of Chrome interactions (distinct interactionIds) one step produces: a tap, click or key press is one, and
// every typed character is its own keydown/keyup interaction. An auto step has no fixed count: its resolved taps (see
// runInteractions) are the steps to count.
export const interactionCount = (step) => (step.action === 'type' ? [...step.text].length : ['tap', 'click', 'press'].includes(step.action) ? 1 : 0);

export const stepLabel = (step) => step.label ?? (step.key ? `${step.action} ${step.key}` : step.selector ? `${step.action} ${step.selector}` : step.action);

// What `--interactions` / a config's "interactions" names: the word `auto`, or a scenario file read with `readFile`.
export function resolveInteractions(value, readFile, source = value) {
  return String(value).trim() === 'auto' ? structuredClone(AUTO_SCENARIO) : parseInteractions(readFile(value), source);
}

// Reads a scenario file: an array of steps, or {"interactions": [...]}. `source` only names the file in errors.
export function parseInteractions(text, source = 'interactions') {
  let parsed;
  try { parsed = JSON.parse(text); } catch (e) { throw new Error(`${source}: cannot read JSON (${e.message})`); }
  const steps = Array.isArray(parsed) ? parsed : parsed?.interactions;
  if (!Array.isArray(steps)) throw new Error(`${source}: expected an array of steps or {"interactions": [...]}`);
  try { return validateInteractions(steps); } catch (e) { throw new Error(`${source}: ${e.message}`); }
}

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
const INVALID_SELECTOR = /not a valid selector|SyntaxError|Failed to execute '(?:querySelector|evaluate)'|Unsupported pseudo|unknown pseudo/i;

// Runs the steps against a Puppeteer page. A selector that never becomes visible is a rejected (retryable) run; a
// selector that is not valid syntax can never succeed and is fatal. Returns what ran, for run.json (an error carries the
// steps that completed before it as `executed`).
export async function runInteractions(page, steps, {
  waitMs = DEFAULT_WAIT_MS, wait = sleep, now = Date.now, plans = null, discover = discoverTargets,
} = {}) {
  const executed = [];
  try {
    await replay(page, steps, executed, { waitMs, wait, now, plans, discover });
  } catch (e) {
    if (e && typeof e === 'object') e.executed = executed;
    throw e;
  }
  return executed;
}

// The targets an auto step resolved, per step index, as recorded in `executed`: handed to the "after" load of a pair so
// that it exercises exactly the elements the "before" load did.
export function plansFrom(executed) {
  const plans = new Map();
  for (const e of executed) if (e.auto) plans.set(e.index, [...(plans.get(e.index) ?? []), e.signature]);
  return plans;
}

export const targetsKey = (executed) => {
  const signatures = executed.filter((e) => e.auto).map((e) => e.signature);
  return signatures.length ? createHash('sha256').update(JSON.stringify(signatures)).digest('hex') : null;
};

// An auto step: before every tap the page is discovered again and the next target taken from it (or, in the "after" load
// of a pair, the target the before load tapped at this position, looked up by signature, waiting a few seconds for it to
// show up). Every tap is recorded in `executed` with its signature.
async function autoTaps(page, step, index, where, executed, { wait, now, plans, discover, settle }) {
  const planned = plans?.get(index) ?? null;
  const max = planned ? planned.length : step.max ?? DEFAULT_AUTO_MAX;
  const tapped = [];
  while (tapped.length < max) {
    const started = now();
    let found = [];
    let target = null;
    for (let tries = 0; ; tries += 1) {
      found = await discover(page, step);
      target = planned ? found.find((c) => c.signature === planned[tapped.length]) : nextTarget(found, { max, kinds: step.kinds ?? AUTO_KINDS, tapped });
      if (target || !planned || tries >= 10) break;
      await Promise.all(found.map((c) => c.handle?.dispose().catch(() => {})));
      await wait(500);
    }
    try {
      if (!target && planned) {
        throw Object.assign(new Error(`${where}: the target the before page tapped is missing here: ${planned[tapped.length]}`), { rejected: true });
      }
      if (!target) break;
      await target.handle.tap();
      tapped.push(target);
      executed.push({ index, action: 'tap', auto: true, label: `${target.kind}: ${target.name}`, signature: target.signature, durationMs: now() - started });
    } finally {
      await Promise.all(found.map((c) => c.handle?.dispose().catch(() => {})));
    }
    await wait(settle);
  }
  if (!tapped.length) {
    throw Object.assign(new Error(`${where}: found no safe in-page interaction targets (tabs, toggles, plain buttons and a modal opener are considered); pass explicit steps or loosen kinds/scope`), { rejected: true });
  }
}

async function replay(page, steps, executed, { waitMs, wait, now, plans, discover }) {
  for (const [index, step] of steps.entries()) {
    const started = now();
    const where = `interactions[${index}] ${stepLabel(step)}`;
    const visible = async (timeout) => {
      try {
        return await page.waitForSelector(step.selector, { visible: true, timeout });
      } catch (e) {
        if (e?.name === 'TimeoutError') throw Object.assign(new Error(`${where}: selector did not become visible within ${timeout} ms`), { rejected: true });
        if (INVALID_SELECTOR.test(e?.message ?? '')) throw Object.assign(new Error(`${where}: invalid selector (${String(e.message).split('\n')[0]})`), { fatal: true });
        throw e;
      }
    };
    const settle = step.ms ?? DEFAULT_SETTLE_MS;
    if (step.action === 'auto') {
      await autoTaps(page, step, index, where, executed, { wait, now, plans, discover, settle });
      continue;
    }
    if (step.action === 'pause') {
      await wait(step.ms);
    } else if (step.action === 'waitFor') {
      await (await visible(step.ms ?? waitMs)).dispose();
    } else if (step.action === 'scroll') {
      if (step.selector) {
        const el = await visible(waitMs);
        await el.evaluate((node) => node.scrollIntoView({ block: 'center' }));
        await el.dispose();
      } else {
        await page.evaluate(() => window.scrollBy(0, window.innerHeight));
      }
      await wait(step.ms ?? 500);
    } else if (step.action === 'press') {
      if (step.selector) {
        const el = await visible(waitMs);
        await el.focus();
        await el.dispose();
      }
      await page.keyboard.press(step.key);
      await wait(settle);
    } else {
      const el = await visible(waitMs);
      try {
        if (step.action === 'tap') await el.tap();
        else if (step.action === 'click') await el.click();
        else if (await el.evaluate((node) => node.type === 'password' || /\b(?:current-password|new-password|one-time-code)\b/.test(node.autocomplete ?? ''))) {
          throw Object.assign(new Error(`${where}: refuses to type into a password or one-time-code field (perf-ab runs are public)`), { fatal: true });
        } else await el.type(step.text, { delay: TYPE_DELAY_MS });
      } finally {
        await el.dispose().catch(() => {});
      }
      await wait(settle);
    }
    executed.push({ index, action: step.action, label: stepLabel(step), durationMs: now() - started });
  }
}
