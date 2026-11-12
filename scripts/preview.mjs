// Screenshots of the projector and phone screens with fake players.
//
//   npm run preview                 4 and 40 players, saved to ./preview
//   npm run preview -- 12 out-dir   another player count or folder
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
// settle, and saves a PNG.
async function shoot(file, url, { width, height, mobile }, waitMs) {
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
  await sleep(waitMs);
  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(file, Buffer.from(data, 'base64'));
  ws.close();
  await devtools(`/json/close/${tab.id}`);
  console.log(`  ${path.relative(process.cwd(), file)}`);
}

// ---------- the games ----------

const counts = process.argv[2] ? [Number(process.argv[2])] : [4, 40];
const outDir = path.resolve(process.argv[3] || 'preview');
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

try {
  for (const count of counts) await play(count);
  console.log(`Saved to ${outDir}`);
} finally {
  for (const socket of sockets) socket.disconnect();
  await server.close();
  browser.kill();
  await sleep(500);
  rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
}
process.exit(0);
