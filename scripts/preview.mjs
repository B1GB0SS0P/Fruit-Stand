// Screenshots of the projector and phone screens with fake players.
//
//   npm run preview                 4 and 40 players, saved to ./preview
//   npm run preview -- 12 out-dir   another player count or folder
//   npm run preview -- predictions  the predictor screens: 40 players,
//                                   2 predictors and the host
//
// It starts the real server, plays real games with bots, and photographs
// the lobby, round 2, round 4 and the final standings in headless Chrome or
// Edge. Nothing here is used by the game itself. Needs Node 22 or later.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { io } from 'socket.io-client';
import { createApp } from '../server/app.js';
import { defaultConfig } from '../config.js';

const PASSWORD = 'preview';
const NAMES = [
  'Amelia', 'Ben', 'Chloe', 'Daniel', 'Ethan Tan', 'Faith', 'Gabriel', 'Hannah', 'Isaac', 'Joy Lim',
  'Kai', 'Lydia', 'Marcus', 'Naomi', 'Oliver', 'Priya', 'Qi Hui', 'Rachel', 'Samuel', 'Tabitha',
  'Uriah', 'Vanessa', 'Wei Jie', 'Xavier', 'Yan Ting', 'Zachary', 'Abigail', 'Boaz', 'Charis', 'Darius',
  'Esther', 'Felix', 'Grace Ong', 'Hosea', 'Ian', 'Jemimah', 'Keith', 'Leah', 'Micah', 'Nathanael',
];
// A few popular animals, so several players share one and the rings show.
const ANIMALS = ['🐼', '🦊', '🐼', '🐸', '🐧', '🐼', '🐯', '🦄', '🐶', '🦊', '🐱', '🐙'];
const PROJECTOR = { width: 1280, height: 720, mobile: false };
const PHONE = { width: 390, height: 844, mobile: true };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------- the browser ----------

const BROWSERS = [
  process.env.BROWSER_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean);
const browserPath = BROWSERS.find((file) => existsSync(file));
if (!browserPath) {
  console.error('No Chrome or Edge found. Set BROWSER_PATH to a Chromium-based browser.');
  process.exit(1);
}
if (typeof WebSocket === 'undefined') {
  console.error('The preview needs Node 22 or later.');
  process.exit(1);
}

const profile = path.join(tmpdir(), `fruit-stand-preview-${process.pid}`);
const debugPort = 9300 + (process.pid % 500);
const browser = spawn(browserPath, [
  '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--mute-audio',
  `--user-data-dir=${profile}`, `--remote-debugging-port=${debugPort}`, 'about:blank',
], { stdio: 'ignore' });

async function devtools(pathname, method = 'GET') {
  for (let attempt = 0; ; attempt++) {
    try {
      const reply = await fetch(`http://127.0.0.1:${debugPort}${pathname}`, { method });
      const text = await reply.text();
      return text.startsWith('{') ? JSON.parse(text) : text;
    } catch (err) {
      if (attempt > 60) throw err;
      await sleep(250);
    }
  }
}

// Opens a page at the given size, waits in real time for the animations to
// settle, and saves a PNG. `file` may instead be a list of [file, atMs]
// pairs, to photograph one page several times as it plays. `script` runs in
// the page once it has loaded, `settleMs` before the first photo.
async function shoot(file, url, { width, height, mobile }, waitMs, { script = null, settleMs = 1500 } = {}) {
  const tab = await devtools(`/json/new?${encodeURIComponent('about:blank')}`, 'PUT');
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', reject);
  });
  let nextId = 1;
  const pending = new Map();
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message.result);
      pending.delete(message.id);
    }
  });
  const send = (method, params = {}) => new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });

  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: mobile ? 2 : 1, mobile });
  await send('Page.navigate', { url });
  const started = Date.now();
  if (script) {
    await sleep(waitMs);
    await send('Runtime.evaluate', { expression: script, awaitPromise: true });
    await sleep(settleMs);
  }
  const shots = Array.isArray(file) ? file : [[file, script ? 0 : waitMs]];
  for (const [name, atMs] of shots) {
    await sleep(Math.max(0, atMs - (Date.now() - started)));
    const { data } = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(name, Buffer.from(data, 'base64'));
    console.log(`  ${path.relative(process.cwd(), name)}`);
  }
  ws.close();
  await devtools(`/json/close/${tab.id}`);
}

// ---------- the games ----------

const predictionsMode = process.argv[2] === 'predictions';
const counts = process.argv[2] && !predictionsMode ? [Number(process.argv[2])] : [4, 40];
const outDir = path.resolve(process.argv[3] || (predictionsMode ? 'preview/predictions' : 'preview'));
mkdirSync(outDir, { recursive: true });

const server = createApp({ hostPassword: PASSWORD });
await new Promise((resolve) => server.httpServer.listen(0, resolve));
const base = `http://localhost:${server.httpServer.address().port}`;

const sockets = [];
function connect() {
  const socket = io(base, { transports: ['websocket'], forceNew: true });
  sockets.push(socket);
  return new Promise((resolve) => socket.once('connect', () => resolve(socket)));
}
const call = (socket, event, payload = {}) => socket.emitWithAck(event, payload);

async function play(count) {
  console.log(`${count} players`);
  const host = await connect();
  await call(host, 'host:login', { password: PASSWORD });
  const { code } = await call(host, 'host:create');
  const bots = [];
  for (let i = 0; i < count; i++) {
    const socket = await connect();
    const name = NAMES[i % NAMES.length] + (i >= NAMES.length ? ` ${Math.floor(i / NAMES.length) + 1}` : '');
    const reply = await call(socket, 'player:join', { code, name, avatar: ANIMALS[i % ANIMALS.length] });
    if (!reply.ok) throw new Error(reply.message);
    bots.push({ socket, token: reply.token });
  }
  // The phone is one of the players; its seat comes from the token in the URL.
  const phone = `${base}/?room=${code}#t=${bots[Math.min(2, count - 1)].token}`;
  const screen = `${base}/screen?room=${code}`;
  const both = async (stage, waitMs = 3500) => {
    await shoot(path.join(outDir, `${count}-players-${stage}-projector.png`), screen, PROJECTOR, waitMs);
    await shoot(path.join(outDir, `${count}-players-${stage}-phone.png`), phone, PHONE, waitMs);
  };

  let seed = count;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  // The first `howMany` players lock in a random price.
  const bid = async (round, howMany = count) => {
    for (const bot of bots.slice(0, howMany)) {
      await call(bot.socket, 'player:submit', { round, price: 1 + Math.floor(random() * defaultConfig.maxPrice) });
    }
  };
  // Everyone still deciding locks in, which ends the round.
  const finish = async (round, price) => {
    for (const bot of bots) await call(bot.socket, 'player:submit', { round, price });
  };
  const half = Math.floor(count / 2);

  await both('1-lobby');
  await call(host, 'host:start');
  await bid(1);
  await call(host, 'host:next');
  await bid(2, half);
  await both('2-round2');
  await finish(2, 3);
  await call(host, 'host:next');
  await bid(3);
  await call(host, 'host:next');
  await bid(4, half);
  await both('3-round4');
  await finish(4, 4);
  await call(host, 'host:reveal');
  await call(host, 'host:standings');
  await both('4-final', 11_000); // 3rd, 2nd, 1st, then the board
}

// The predictions side game: 40 players, 2 predictors and the host. Shows
// the form, the locked screen and the "Predictors vs Host" reveal on the
// projector, a predictor's phone and the host page.
async function playPredictions() {
  const count = 40;
  console.log(`${count} players, 2 predictors and the host`);
  const host = await connect();
  await call(host, 'host:login', { password: PASSWORD });
  const { code } = await call(host, 'host:create');
  const join = async (name, avatar) => {
    const socket = await connect();
    const reply = await call(socket, 'player:join', { code, name, avatar });
    if (!reply.ok) throw new Error(reply.message);
    return { socket, token: reply.token, id: reply.playerId, name };
  };
  const bots = [];
  for (let i = 0; i < count; i++) bots.push(await join(NAMES[i], ANIMALS[i % ANIMALS.length]));
  const predictors = [await join('Ruth', '🦉'), await join('Silas', '🐢')];
  for (const p of predictors) await call(host, 'host:makePredictor', { playerId: p.id });
  await call(host, 'host:playing', { playing: true });

  const HOST_PAGE = { width: 1000, height: 1250, mobile: false };
  const TALL_PHONE = { width: 390, height: 1500, mobile: true };
  const phoneUrl = `${base}/?room=${code}#t=${predictors[0].token}`;
  const screenUrl = `${base}/screen?room=${code}`;
  const hostUrl = `${base}/host`;
  // The host page needs the password and room it would normally remember.
  const hostLogin = `(async () => {
    sessionStorage.setItem('fruitstand:host-password', ${JSON.stringify(PASSWORD)});
    localStorage.setItem('fruitstand:host-room', ${JSON.stringify(JSON.stringify(code))});
    location.reload();
  })()`;
  const out = (name) => path.join(outDir, `${name}.png`);
  const shootHost = (name) => shoot(out(name), hostUrl, HOST_PAGE, 800, { script: hostLogin, settleMs: 2500 });

  let seed = 7;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const bid = async (round, howMany = count) => {
    for (const bot of bots.slice(0, howMany)) {
      await call(bot.socket, 'player:submit', { round, price: 1 + Math.floor(random() * defaultConfig.maxPrice) });
    }
  };
  const finish = async (round) => {
    for (const bot of bots) await call(bot.socket, 'player:submit', { round, price: 1 + Math.floor(random() * defaultConfig.maxPrice) });
  };

  // The two How to Play slides that changed with the bigger markets.
  const slide = (n) => `(async () => {
    for (let i = 1; i < ${n}; i++) document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
  })()`;
  for (const n of [2, 4]) {
    await shoot(out(`howto-slide${n}-projector`), `${base}/how-to-play`, PROJECTOR, 1500, { script: slide(n), settleMs: 1200 });
    await shoot(out(`howto-slide${n}-phone`), `${base}/how-to-play`, PHONE, 1500, { script: slide(n), settleMs: 1200 });
  }

  await shoot(out('0-lobby-projector'), screenUrl, PROJECTOR, 3500);
  await shootHost('0-lobby-host');
  await call(host, 'host:start');

  // Round 1: the form. Ruth has answered everything, Silas two of three,
  // and the host has only typed a median so far.
  await call(predictors[0].socket, 'predictor:save', { median: '7.50', winner: bots[4].id, middle: bots[17].id });
  await call(predictors[1].socket, 'predictor:save', { median: '9', winner: bots[11].id, middle: null });
  await call(host, 'host:predict', { median: '6.25', winner: null, middle: null });
  await bid(1, 14);
  await shoot(out('1-form-projector'), screenUrl, PROJECTOR, 3500);
  await shoot(out('1-form-phone'), phoneUrl, TALL_PHONE, 3500);
  await shoot(out('1-form-phone-picker'), phoneUrl, PHONE, 3000, {
    script: `(async () => {
      const buttons = document.querySelectorAll('.pick__chosen');
      buttons[1].scrollIntoView({ block: 'start' });
      window.scrollBy(0, -70);
      buttons[1].click();
      const search = document.querySelectorAll('.pick__search')[1];
      search.value = 'a';
      search.dispatchEvent(new Event('input'));
    })()`,
  });
  await shootHost('1-form-host');

  // Everyone finishes answering, then round 3 starts and it all locks.
  await call(predictors[1].socket, 'predictor:save', { median: '9', winner: bots[11].id, middle: bots[30].id });
  await call(host, 'host:predict', { median: '6.25', winner: bots[22].id, middle: bots[8].id });
  await finish(1);
  await call(host, 'host:next');
  await finish(2);
  await call(host, 'host:next');
  await bid(3, 23);
  await shoot(out('2-locked-projector'), screenUrl, PROJECTOR, 3500);
  await shoot(out('2-locked-phone'), phoneUrl, TALL_PHONE, 3500);
  await shootHost('2-locked-host');

  await finish(3);
  await call(host, 'host:next');
  await finish(4);
  await call(host, 'host:reveal');
  await call(host, 'host:predictions');
  await shoot(out('3-reveal-phone-during'), phoneUrl, PHONE, 3000);
  await shoot([
    [out('3-reveal-projector-1-median'), 10_000],
    [out('3-reveal-projector-2-winner'), 20_000],
    [out('3-reveal-projector-3-middle'), 30_000],
    [out('3-reveal-projector-4-scoreboard'), 36_000],
  ], screenUrl, PROJECTOR, 0);
  await call(host, 'host:standings');
  await shoot(out('3-reveal-phone-receipt'), phoneUrl, TALL_PHONE, 3500);
  await shootHost('3-reveal-host');
}

try {
  if (predictionsMode) await playPredictions();
  else for (const count of counts) await play(count);
  console.log(`Saved to ${outDir}`);
} finally {
  for (const socket of sockets) socket.disconnect();
  await server.close();
  browser.kill();
  await sleep(500);
  rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
}
process.exit(0);
