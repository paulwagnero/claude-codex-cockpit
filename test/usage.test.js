'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { CLAUDE_WINDOWS, describeWindow, recentRate, formatDuration, formatPercent } = require('../lib/usage');

const FIVE = CLAUDE_WINDOWS.five_hour;
const WEEK = CLAUDE_WINDOWS.seven_day;
const NOW = Date.UTC(2026, 8, 28, 12, 0, 0);

// A window with `elapsedFrac` of its length gone and `used` percent consumed.
const win = (windowSeconds, elapsedFrac, used) => ({
  usedPercent: used,
  windowSeconds,
  resetsAt: NOW / 1000 + windowSeconds * (1 - elapsedFrac),
});
const level = (w) => describeWindow(w, NOW).level;

test('60% of the week used on day 6 is fine', () => {
  assert.equal(level(win(WEEK, 5.5 / 7, 60)), 'ok');
});

test('40% of the week used on day 1 is not', () => {
  assert.equal(level(win(WEEK, 1 / 7, 40)), 'hot');
});

test('on pace is ok, a little ahead warns, far ahead is hot', () => {
  assert.equal(level(win(FIVE, 0.5, 50)), 'ok');
  assert.equal(level(win(FIVE, 0.5, 60)), 'warn');
  assert.equal(level(win(FIVE, 0.5, 70)), 'hot');
});

test('the early-window floor keeps a first burst from reading as hot', () => {
  assert.equal(level(win(FIVE, 0.01, 3)), 'ok');
  assert.equal(level(win(WEEK, 0.02, 12)), 'warn');
});

test('100% is hot even at the very end of the window', () => {
  assert.equal(level(win(FIVE, 0.99, 100)), 'hot');
});

test('a window past resets_at reads as reset at 0%', () => {
  const d = describeWindow({ usedPercent: 80, windowSeconds: FIVE, resetsAt: NOW / 1000 - 60 }, NOW);
  assert.equal(d.level, 'reset');
  assert.equal(d.usedPercent, 0);
});

test('exhaustsInSec projects the burn rate so far, only when it beats the reset', () => {
  // 80% in 2.5h, so the last 20% lasts 37.5 minutes.
  assert.equal(describeWindow(win(FIVE, 0.5, 80), NOW).exhaustsInSec, 37.5 * 60);
  assert.equal(describeWindow(win(FIVE, 0.5, 40), NOW).exhaustsInSec, null);
});

const MIN = 60 * 1000;

test('recent rate: last 30 minutes, measured up to now', () => {
  // 10% -> 30% over the last 20 minutes, readings every 5 minutes.
  const points = [0, 5, 10, 15, 20].map((m) => [NOW - (20 - m) * MIN, 10 + m]);
  assert.equal(recentRate(points, NOW), 20 / (20 * 60));
  // Ten idle minutes later the same burn is spread over 30 minutes.
  assert.equal(recentRate(points, NOW + 10 * MIN), 20 / (30 * 60));
  // Usage from before the lookback only counts as the starting level.
  const long = [[NOW - 90 * MIN, 5], [NOW - 40 * MIN, 12], [NOW - 10 * MIN, 18]];
  assert.equal(recentRate(long, NOW), (18 - 12) / (30 * 60));
});

test('recent rate needs five minutes of history', () => {
  assert.equal(recentRate([[NOW - 2 * MIN, 10], [NOW - MIN, 11]], NOW), null);
  assert.equal(recentRate([[NOW, 10]], NOW), null);
  assert.equal(recentRate(undefined, NOW), null);
});

test('a burst shows up in the 5h projection before the average notices', () => {
  // 20% used after 2 of 5 hours is an easy pace (ratio 0.5), but the last 20
  // minutes went from 10% to 20%: at that rate the rest lasts 160 minutes,
  // well before the reset 3 hours out.
  const w = { ...win(FIVE, 0.4, 20), recent: [[NOW - 20 * MIN, 10], [NOW, 20]] };
  const d = describeWindow(w, NOW);
  assert.equal(d.level, 'ok');
  assert.equal(d.paceBasis, 'recent');
  assert.equal(Math.round(d.exhaustsInSec / 60), 160);
  // Without history: the average, which says it won't run out.
  const avg = describeWindow(win(FIVE, 0.4, 20), NOW);
  assert.equal(avg.paceBasis, 'average');
  assert.equal(avg.exhaustsInSec, null);
});

test('the weekly window keeps the average: nights are part of a week', () => {
  const w = { ...win(WEEK, 0.5, 30), recent: [[NOW - 20 * MIN, 20], [NOW, 30]] };
  assert.equal(describeWindow(w, NOW).paceBasis, 'average');
});

test('missing numbers describe as null', () => {
  assert.equal(describeWindow(null, NOW), null);
  assert.equal(describeWindow({ usedPercent: NaN, resetsAt: 1 }, NOW), null);
});

test('durations and percents', () => {
  assert.equal(formatDuration(30), '<1m');
  assert.equal(formatDuration(45 * 60), '45m');
  assert.equal(formatDuration(2 * 3600 + 4 * 60), '2h 04m');
  assert.equal(formatDuration(2 * 3600 + 4 * 60, true), '2h04m');
  assert.equal(formatDuration(3 * 86400 + 4 * 3600 + 59), '3d 4h');
  assert.equal(formatPercent(23.5), '23%');
  assert.equal(formatPercent(99.9), '99%');
  assert.equal(formatPercent(100), '100%');
});
