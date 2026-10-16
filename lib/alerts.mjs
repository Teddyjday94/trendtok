// Niche alerts and daily collection.
//
// On a schedule (every 24 hours by default) the collector pulls every chart
// for your chosen countries, which also builds up your rank history, and
// looks up each keyword as a hashtag. It raises an alert when something
// matching one of your keywords:
//   - appears on a chart (first time, or again after dropping off), or
//   - turns Breakout.
import { randomUUID } from 'node:crypto';
import { KINDS } from './normalize.mjs';
import { cleanHashtag } from './hashtag-lookup.mjs';

export const INTERVALS = [6, 12, 24, 48];
const MAX_EVENTS = 300;

export const DEFAULT_SETTINGS = {
  keywords: [],
  countries: ['US'],
  intervalHours: 24,
  desktop: true,
  lastRun: null,
  lastResult: null,
};

const bad = (message) => Object.assign(new Error(message), { status: 400 });

export function validateSettings(input, current = DEFAULT_SETTINGS) {
  const next = { ...current };
  if (input.keywords !== undefined) {
    if (!Array.isArray(input.keywords)) throw bad('keywords must be a list');
    next.keywords = [
      ...new Set(
        input.keywords
          .map((k) => String(k).trim().toLowerCase().replace(/^#+/, '').replace(/\s+/g, ' ').slice(0, 50))
          .filter(Boolean),
      ),
    ].slice(0, 50);
  }
  if (input.countries !== undefined) {
    if (!Array.isArray(input.countries)) throw bad('countries must be a list');
    const countries = [...new Set(input.countries.filter((c) => /^[A-Z]{2}$/.test(c)))];
    if (!countries.length || countries.length > 3) throw bad('Pick between 1 and 3 countries');
    next.countries = countries;
  }
  if (input.intervalHours !== undefined) {
    if (!INTERVALS.includes(Number(input.intervalHours))) throw bad(`intervalHours must be one of ${INTERVALS}`);
    next.intervalHours = Number(input.intervalHours);
  }
  if (input.desktop !== undefined) next.desktop = Boolean(input.desktop);
  return next;
}

// Matching ignores case, spaces and the leading #, so "pressure washing"
// matches #pressurewashing and "Pressure Washing Tips".
const squash = (s) => String(s ?? '').toLowerCase().replace(/[#\s_-]+/g, '');
export function matchKeyword(item, keywords) {
  const text = squash(`${item.name} ${item.subtitle ?? ''}`);
  return keywords.find((k) => squash(k) && text.includes(squash(k))) ?? null;
}

const KIND_LABEL = { hashtags: 'hashtag', sounds: 'sound', creators: 'creator', videos: 'video' };

export function createAlerts({ store, trends, notify = () => {}, delayMs = 2000, offline = false }) {
  const getSettings = () => store.read('alerts.json', DEFAULT_SETTINGS);
  const sleep = (ms) => (ms ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());
  let running = null;

  async function runOnce() {
    const settings = await getSettings();
    const events = [];
    const errors = [];
    let charts = 0;
    const state = await store.read('alert-state.json', { onChart: {}, hashtags: {} });

    for (const country of settings.countries) {
      for (const kind of KINDS) {
        const data = await trends.getTrends({ kind, country, period: 7, refresh: true });
        await sleep(delayMs);
        if (data.source !== 'live') {
          errors.push(`${kind} ${country}: ${data.error ?? 'not live'}`);
          continue;
        }
        charts++;
        const prefix = `${kind}:${country}:`;
        const present = new Set();
        for (const item of data.items) {
          const keyword = matchKeyword(item, settings.keywords);
          if (!keyword) continue;
          const key = prefix + item.id;
          present.add(key);
          const before = state.onChart[key];
          let reason = null;
          if (!before) reason = `is on the ${country} ${KIND_LABEL[kind]} chart at #${item.rank}`;
          else if (item.status === 'breakout' && before.status !== 'breakout') reason = `turned Breakout at #${item.rank}`;
          if (reason) events.push({ keyword, kind, country, name: item.name, reason, url: item.url, momentum: item.momentum });
          state.onChart[key] = { status: item.status, at: Date.now() };
        }
        // Forget items that left the chart, so coming back raises a new alert.
        for (const key of Object.keys(state.onChart)) {
          if (key.startsWith(prefix) && !present.has(key)) delete state.onChart[key];
        }
      }

      // Look up each keyword as a hashtag, even when it isn't on any chart.
      for (const keyword of settings.keywords) {
        const name = cleanHashtag(keyword);
        if (!name) continue;
        const res = await trends.lookupHashtag({ name, country, period: 7, refresh: true });
        await sleep(delayMs);
        if (res.source !== 'live' || !res.detail) {
          if (res.source !== 'live') errors.push(`#${name} ${country}: ${res.error ?? 'not live'}`);
          continue;
        }
        const key = `${name}:${country}`;
        const before = state.hashtags[key];
        const d = res.detail;
        if (d.status === 'breakout' && before && before.status !== 'breakout') {
          events.push({
            keyword, kind: 'hashtags', country, name: d.name, url: d.url, momentum: d.momentum,
            reason: `turned Breakout in ${country} (momentum ${d.momentum})`,
          });
        }
        state.hashtags[key] = { status: d.status, at: Date.now() };
      }
    }

    await store.update('alert-state.json', {}, (s) => {
      s.onChart = state.onChart;
      s.hashtags = state.hashtags;
    });

    const at = Date.now();
    const logged = events.map((e) => ({ id: randomUUID(), at, read: false, ...e }));
    if (logged.length) {
      await store.update('alerts-log.json', [], (log) => {
        log.unshift(...logged);
        log.splice(MAX_EVENTS);
      });
    }
    const result = { at, charts, alerts: logged.length, errors: errors.slice(0, 10) };
    await store.update('alerts.json', DEFAULT_SETTINGS, (s) => {
      s.lastRun = at;
      s.lastResult = result;
    });

    if (logged.length && settings.desktop) {
      const first = logged[0];
      notify(
        logged.length === 1 ? `Trend alert: ${first.name}` : `${logged.length} new trend alerts`,
        logged.length === 1
          ? `${first.name} ${first.reason}`
          : logged.slice(0, 3).map((e) => `${e.name} ${e.reason}`).join('\n'),
      );
    }
    return result;
  }

  // Never run two checks at once; a second caller gets the running one.
  function run() {
    if (!running) running = runOnce().finally(() => (running = null));
    return running;
  }

  async function runIfDue() {
    if (offline) return null;
    const s = await getSettings();
    if (s.lastRun && Date.now() - s.lastRun < s.intervalHours * 3600_000) return null;
    return run();
  }

  // Checks once shortly after start, then hourly whether a run is due.
  function startSchedule({ firstDelayMs = 15_000, everyMs = 3600_000 } = {}) {
    const tick = () => runIfDue().catch((err) => console.error('Scheduled check failed:', err));
    const first = setTimeout(tick, firstDelayMs);
    const timer = setInterval(tick, everyMs);
    first.unref();
    timer.unref();
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }

  return {
    run,
    runIfDue,
    startSchedule,
    isRunning: () => Boolean(running),
    getSettings,
    saveSettings: async (input) => {
      const next = validateSettings(input, await getSettings());
      return store.update('alerts.json', DEFAULT_SETTINGS, (s) => {
        Object.assign(s, next);
      });
    },
    getEvents: () => store.read('alerts-log.json', []),
    markAllRead: () =>
      store.update('alerts-log.json', [], (log) => {
        for (const e of log) e.read = true;
      }),
    clearEvents: () => store.update('alerts-log.json', [], (log) => void log.splice(0)),
  };
}
