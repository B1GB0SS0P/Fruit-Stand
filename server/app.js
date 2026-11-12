import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import express from 'express';
import { Server } from 'socket.io';
import QRCode from 'qrcode';
import { resolveConfig } from '../config.js';
import { RoomStore, normalizeCode } from './rooms.js';
import { createSealer } from './seal.js';
import { createGameServer } from './sockets.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SWEEP_EVERY_MS = 5 * 60 * 1000;

export const realTimers = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle),
};

// Builds the whole service. `timers` can be swapped for a fake clock in tests.
export function createApp({ hostPassword, config = {}, timers = realTimers, publicUrl = '' } = {}) {
  if (!hostPassword) throw new Error('A host password is required.');
  resolveConfig(config); // fail at startup, not mid-game, if the config is wrong

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  const httpServer = createServer(app);
  const io = new Server(httpServer, { maxHttpBufferSize: 2_000_000 });

  const store = new RoomStore();
  const game = createGameServer({ io, store, timers, hostPassword, sealer: createSealer(hostPassword), config });

  app.get('/healthz', (req, res) => {
    res.json({ ok: true, rooms: store.rooms.size });
  });

  const joinUrl = (req, code) => {
    const base = (publicUrl || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
    return `${base}/?room=${code}`;
  };

  // QR code for the projector lobby. Made here so no outside service is used.
  app.get('/qr.svg', async (req, res) => {
    const code = normalizeCode(req.query.room);
    if (!/^[A-Z]{4}$/.test(code)) return res.status(400).send('Bad room code');
    const svg = await QRCode.toString(joinUrl(req, code), { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
    res.set('Cache-Control', 'no-store').type('image/svg+xml').send(svg);
  });

  app.get('/content/how-to-play.json', (req, res) => {
    res.sendFile(path.join(root, 'content', 'howToPlay.json'));
  });

  // /host, /screen and /how-to-play resolve to their .html files.
  app.use(express.static(path.join(root, 'public'), { extensions: ['html'] }));

  const sweeper = setInterval(() => game.sweep(), SWEEP_EVERY_MS);
  sweeper.unref();

  return {
    app,
    httpServer,
    io,
    store,
    sweep: game.sweep,
    close() {
      clearInterval(sweeper);
      game.stopTimers();
      return new Promise((resolve) => io.close(() => resolve()));
    },
  };
}
