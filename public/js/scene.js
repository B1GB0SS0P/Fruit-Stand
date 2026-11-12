// The market backdrop behind every screen: sky, sun, skyline, bunting,
// string lights and the plank ground, plus the round 2 drifting fruit.
//
// All of it is CSS, inline SVG and emoji. Movement is CSS transforms and
// opacity only; the only timers here add and remove elements.

import { h, prefersReducedMotion } from './common.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const FLAG_COLORS = ['var(--awning-1)', 'var(--awning-5)', 'var(--awning-3)', 'var(--awning-4)', 'var(--awning-2)'];
const SKY_FADE_MS = 3000;
const MORNING = ['#bfe3f5', '#fde6d2', '#ffd9b8']; // shown until the room's own colours arrive

function svg(tag, attrs = {}, ...kids) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
  el.append(...kids);
  return el;
}

// ---------- colour helpers ----------

const parse = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const toHex = (rgb) => `#${rgb.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('')}`;
const darken = (hex, amount) => toHex(parse(hex).map((v) => v * (1 - amount)));
const brightness = (hex) => {
  const [r, g, b] = parse(hex);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
};

// Which backdrop a game state uses. The reveal shares the dusk scene.
export function sceneFor(state) {
  if (!state || state.status === 'lobby') return 'lobby';
  if (state.status === 'reveal' || state.status === 'final') return 'final';
  const step = Math.ceil((state.round / Math.max(1, state.totalRounds)) * 4);
  return `round${Math.max(1, Math.min(4, step))}`;
}

// ---------- pieces ----------

// One swag of bunting: a sagging string with triangle flags hanging off it.
function swag(flags, offset) {
  const width = 400;
  const sag = 26;
  const box = svg('svg', { viewBox: `0 0 ${width} 70`, preserveAspectRatio: 'none', class: 'bunting__swag' });
  const y = (x) => 4 + sag * 4 * (x / width) * (1 - x / width);
  box.append(svg('path', {
    d: `M0 4 Q ${width / 2} ${4 + sag * 2} ${width} 4`, fill: 'none', stroke: 'rgba(58,40,26,0.55)', 'stroke-width': '2',
    'vector-effect': 'non-scaling-stroke',
  }));
  const step = width / flags;
  for (let i = 0; i < flags; i++) {
    const left = i * step + step * 0.14;
    const right = (i + 1) * step - step * 0.14;
    const mid = (left + right) / 2;
    box.append(svg('polygon', {
      points: `${left},${y(left)} ${right},${y(right)} ${mid},${y(mid) + 34}`,
      fill: FLAG_COLORS[(i + offset) % FLAG_COLORS.length],
    }));
  }
  return box;
}

// A strand of bulbs under the bunting. Dark until the evening rounds.
function lightStrand(bulbs) {
  const width = 400;
  const box = svg('svg', { viewBox: `0 0 ${width} 60`, preserveAspectRatio: 'none', class: 'lights__strand' });
  const y = (x) => 6 + 18 * 4 * (x / width) * (1 - x / width);
  box.append(svg('path', {
    d: `M0 6 Q ${width / 2} 42 ${width} 6`, fill: 'none', stroke: 'rgba(40,30,30,0.6)', 'stroke-width': '1.5',
    'vector-effect': 'non-scaling-stroke',
  }));
  for (let i = 0; i < bulbs; i++) {
    const x = (i + 0.5) * (width / bulbs);
    box.append(
      svg('ellipse', { cx: x, cy: y(x) + 5, rx: 9, ry: 13, class: `lights__glow${i % 2 ? ' is-odd' : ''}` }),
      svg('ellipse', { cx: x, cy: y(x) + 5, rx: 3.2, ry: 4.6, class: 'lights__bulb' }),
    );
  }
  return box;
}

// Shophouse rooftops with a few rain trees and palms: one flat silhouette.
function skyline() {
  const parts = [];
  const house = (x, w, body, roof, kind) => {
    const top = 200 - body;
    let d = `M${x} 200 V${top} `;
    if (kind === 0) d += `L${x + w / 2} ${top - roof} L${x + w} ${top} `; // pitched roof
    else if (kind === 1) d += `h${w * 0.12} v${-roof} h${w * 0.76} v${roof} h${w * 0.12} `; // parapet
    else d += `Q${x + w / 2} ${top - roof * 1.5} ${x + w} ${top} `; // curved gable
    return `${d}V200 Z`;
  };
  const rainTree = (x, s) => [
    svg('rect', { x: x - 3 * s, y: 200 - 70 * s, width: 6 * s, height: 70 * s }),
    svg('ellipse', { cx: x, cy: 200 - 78 * s, rx: 58 * s, ry: 24 * s }),
    svg('ellipse', { cx: x - 30 * s, cy: 200 - 66 * s, rx: 30 * s, ry: 14 * s }),
    svg('ellipse', { cx: x + 32 * s, cy: 200 - 68 * s, rx: 30 * s, ry: 13 * s }),
  ];
  const palm = (x, s) => {
    const top = 200 - 110 * s;
    const frond = (dx, dy) => svg('path', {
      d: `M${x} ${top} Q${x + dx * 0.5 * s} ${top - 26 * s + dy * 0.2 * s} ${x + dx * s} ${top + dy * s} Q${x + dx * 0.45 * s} ${top - 8 * s} ${x} ${top}Z`,
    });
    return [
      svg('path', { d: `M${x - 3 * s} 200 Q${x + 5 * s} ${200 - 60 * s} ${x - 1 * s} ${top} h${4 * s} Q${x + 9 * s} ${200 - 60 * s} ${x + 4 * s} 200Z` }),
      frond(-46, 10), frond(46, 10), frond(-34, -16), frond(34, -16), frond(-20, 24), frond(22, 24),
    ];
  };

  // x, width, body height, roof height, roof kind
  const row = [
    [0, 92, 58, 22, 0], [92, 70, 74, 12, 1], [162, 96, 62, 20, 2], [330, 80, 80, 12, 1], [410, 104, 60, 26, 0],
    [514, 76, 70, 18, 2], [690, 92, 66, 12, 1], [782, 86, 82, 24, 0], [868, 100, 58, 18, 2], [1060, 84, 76, 12, 1],
    [1144, 96, 62, 24, 0], [1240, 72, 84, 14, 1], [1400, 100, 64, 20, 2], [1500, 100, 72, 22, 0],
  ];
  for (const [x, w, body, roof, kind] of row) parts.push(svg('path', { d: house(x, w, body, roof, kind) }));
  parts.push(...rainTree(290, 1), ...rainTree(1000, 1.15), ...palm(640, 1), ...palm(672, 0.8), ...palm(1360, 1.05));
  parts.push(svg('rect', { x: 0, y: 196, width: 1600, height: 6 }));
  return svg('svg', { viewBox: '0 0 1600 200', preserveAspectRatio: 'xMidYMax slice', class: 'scene__skyline' }, ...parts);
}

// ---------- the scene ----------

// kind: 'projector' (everything) or 'phone' (no skyline, thinner strips).
export function mountScene(kind) {
  const projector = kind === 'projector';
  const skyA = h('div', { class: 'scene__sky is-on' });
  const skyB = h('div', { class: 'scene__sky' });
  const ambientLayer = h('div', { class: 'scene__ambient' });
  const swags = projector ? 4 : 2;
  const root = h('div', { class: `scene scene--${kind}`, 'aria-hidden': 'true', 'data-scene': 'lobby' },
    skyA,
    skyB,
    h('div', { class: 'scene__sun' }),
    projector ? skyline() : null,
    h('div', { class: 'scene__ground' }),
    ambientLayer,
    h('div', { class: 'scene__lights' }, Array.from({ length: swags }, () => lightStrand(projector ? 7 : 6))),
    h('div', { class: 'scene__bunting' }, Array.from({ length: swags }, (_, i) => swag(projector ? 9 : 7, i * 2))),
  );
  document.body.prepend(root, h('div', { class: 'grain', 'aria-hidden': 'true' }));

  // Everything stops moving while the tab is in the background.
  const onVisibility = () => document.documentElement.classList.toggle('is-hidden', document.hidden);
  document.addEventListener('visibilitychange', onVisibility);
  onVisibility();

  let current = null;
  let front = skyA;
  let back = skyB;
  const gradient = (stops) => `linear-gradient(180deg, ${stops.join(', ')})`;
  skyA.style.backgroundImage = gradient(MORNING);

  function set(key, theme) {
    const stops = theme && theme[key];
    if (!stops || key === current) return;
    const first = current === null;
    current = key;
    root.dataset.scene = key;

    // Cross-fade: paint the hidden layer, then swap which one shows.
    if (first || prefersReducedMotion()) {
      front.style.backgroundImage = gradient(stops);
    } else {
      back.style.backgroundImage = gradient(stops);
      back.classList.add('is-on');
      front.classList.remove('is-on');
      [front, back] = [back, front];
    }

    // Text that sits straight on the sky follows it: dark ink by day, pale by night.
    const average = stops.reduce((sum, stop) => sum + brightness(stop), 0) / stops.length;
    const dark = average < 0.45;
    const page = document.documentElement;
    page.dataset.sky = dark ? 'dark' : 'light';
    page.style.setProperty('--skyline', darken(stops[stops.length - 1], 0.15));
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', stops[0]);
  }

  return { set, ambient: createAmbient(ambientLayer, projector), fadeMs: SKY_FADE_MS };
}

// ---------- round 2: drifting fruit ----------

const rand = (min, max) => min + Math.random() * (max - min);

function createAmbient(layer, projector) {
  const size = projector ? [24, 64] : [18, 36];
  let sequence = null;
  let index = 0;
  let interval = 3000;
  let count = 0;
  let timer = null;
  let clearTimer = null;

  // One fruit. `progress` (0-1) starts it part-way across, so a screen that
  // opens mid-round is not empty.
  function spawn(item, progress = 0) {
    const still = prefersReducedMotion();
    const el = h('div', { class: `drift${still ? ' drift--still' : ''}` },
      h('span', { class: 'drift__sway' }, item.emoji));
    el.style.fontSize = `${Math.round(rand(size[0], size[1]))}px`;
    el.style.opacity = rand(0.12, 0.2).toFixed(3);

    if (still) {
      // No drift: the fruit simply sits somewhere for a while.
      el.style.left = `${rand(4, 90)}vw`;
      el.style.top = `${rand(10, 80)}vh`;
    } else {
      // Enters off one edge and leaves off the opposite one.
      const across = Math.random() < 0.6;
      const flip = Math.random() < 0.5;
      const from = flip ? 108 : -12;
      const to = flip ? -12 : 108;
      const a = rand(4, 92);
      const b = Math.max(0, Math.min(96, a + rand(-22, 22)));
      el.style.setProperty('--x0', across ? `${from}vw` : `${a}vw`);
      el.style.setProperty('--x1', across ? `${to}vw` : `${b}vw`);
      el.style.setProperty('--y0', across ? `${a}vh` : `${from}vh`);
      el.style.setProperty('--y1', across ? `${b}vh` : `${to}vh`);
      el.style.animationDuration = `${item.duration}ms`;
      el.style.animationDelay = `${-Math.round(progress * item.duration)}ms`;
      const sway = el.firstChild;
      sway.style.setProperty('--sway', `${rand(8, 26).toFixed(0)}px`);
      sway.style.setProperty('--turn', `${rand(-16, 16).toFixed(0)}deg`);
      sway.style.animationDuration = `${rand(5, 9).toFixed(1)}s`;
      sway.style.animationDelay = `${-rand(0, 9).toFixed(1)}s`;
      el.addEventListener('animationend', (event) => {
        if (event.target === el) el.remove();
      });
    }
    layer.append(el);
    if (still) while (layer.children.length > count) layer.firstChild.remove();
  }

  const next = () => sequence[index++ % sequence.length];

  function schedule() {
    const item = next();
    // The item's delay nudges the gap either side of this screen's pace.
    const wait = interval * (0.5 + item.delay / 2000);
    timer = setTimeout(() => {
      if (!sequence) return;
      if (!document.hidden && layer.children.length < count + 3) spawn(item);
      schedule();
    }, wait);
  }

  return {
    // `elapsedMs` into the round keeps every screen at roughly the same
    // place in the sequence, including one that reconnects.
    start(items, wanted, elapsedMs = 0) {
      if (!items || !items.length || wanted < 1) return this.stop();
      if (sequence) return undefined; // already running
      clearTimeout(clearTimer);
      layer.replaceChildren();
      sequence = items;
      count = wanted;
      interval = 30_000 / count; // a pass takes 30 s on average
      index = Math.floor(Math.max(0, elapsedMs) / interval);
      for (let i = 0; i < count; i++) spawn(next(), Math.random() * 0.85);
      layer.classList.add('is-on');
      schedule();
      return undefined;
    },
    stop() {
      if (!sequence && !layer.children.length) return;
      sequence = null;
      clearTimeout(timer);
      layer.classList.remove('is-on');
      clearTimeout(clearTimer);
      clearTimer = setTimeout(() => layer.replaceChildren(), 2600);
    },
  };
}
