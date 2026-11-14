// How to Play. The words come from content/howToPlay.json; this file only
// draws the pictures and handles arrows, clicks and swipes.

import { $, h, makeStand, loadContent } from './common.js';

const deck = $('#deck');
const back = new URLSearchParams(location.search).get('back');
const backUrl = back && back.startsWith('/') && !back.startsWith('//') ? back : null;
let slides = [];
let index = 0;

const fruit = (name, emoji, i) => ({ id: name.toLowerCase(), name, emoji, index: i });
const APPLE = fruit('Apple', '🍎', 0);
const GRAPE = fruit('Grape', '🍇', 2);
const MELON = fruit('Melon', '🍈', 3);
const LEMON = fruit('Lemon', '🍋', 4);

const col = (...kids) => h('div', { class: 'art-col' }, kids);
const label = (main, sub) => h('div', { class: 'art-label' }, main, sub ? h('small', null, sub) : null);
const avatar = (emoji) => h('div', { class: 'art-avatar' }, emoji);

// One picture per slide, keyed by the "art" field in the content file.
const ART = {
  welcome: () => [makeStand(APPLE), makeStand(GRAPE, { tag: '$3' }), makeStand(LEMON)],

  fruit: () => [
    col(makeStand(APPLE), label('You', '🐼')),
    col(
      h('div', { class: 'art-row art-tight' }, makeStand(APPLE), makeStand(APPLE)),
      label('Your competition', '🦊 🐯 same fruit'),
    ),
    col(makeStand(GRAPE), label('Your partner', '🐸 different fruit')),
  ],

  price: () => [
    col(
      h('div', { class: 'art-stickers' }, [1, 2, 3, 4, 5].map((n) =>
        h('div', { class: `art-sticker${n === 3 ? ' is-picked' : ''}` }, `$${n}`))),
      h('div', { class: 'btn btn--big', style: 'font-size:1.6em; padding:0.3em 1.6em; min-height:0' }, 'Submit'),
    ),
    col(h('div', { class: 'art-clock' }, '5:00'), label('No pick = $5')),
  ],

  cheapest: () => [
    h('div', { class: 'art-row art-wide' },
      h('div', { class: 'art-row' },
        col(makeStand(APPLE, { tag: '$5' }), h('div', { class: 'art-money lose' }, 'earns $0')),
        col(makeStand(APPLE, { tag: '$5' }), h('div', { class: 'art-money lose' }, 'earns $0')),
        col(makeStand(APPLE, { tag: '$4' }), h('div', { class: 'art-money win' }, '3 × $4 = $12')),
      ),
      h('div', { class: 'art-board' }, 'All three $5 → $5 each', h('small', null, 'Ties split the sales')),
    ),
  ],

  talk: () => [
    h('div', { class: 'art-row art-wide' },
      h('div', { class: 'art-row' },
        col(h('div', { class: 'art-bubble' }, '“Both $5?”'), avatar('🐼')),
        col(h('div', { class: 'art-bubble' }, '“Deal 🤝”'), avatar('🦊')),
      ),
      h('div', { class: 'art-board' }, '🍎 Apple … $3', h('br'), '🍇 Grape … $5', h('small', null, 'Lowest price only. No names.')),
    ),
  ],

  change: () => [
    col(makeStand(APPLE), label('Before')),
    h('div', { class: 'art-arrow' }, '🔄'),
    col(makeStand(MELON), label('After')),
  ],

  partners: () => [
    col(label('Rounds 1–2'), h('div', { class: 'card art-pair' }, avatar('🐼'), h('span', null, '+'), avatar('🐸'))),
    h('div', { class: 'art-arrow' }, '→'),
    col(label('Rounds 3–4'), h('div', { class: 'card art-pair' }, avatar('🐼'), h('span', null, '+'), avatar('🐧'))),
  ],

  winning: () => [
    h('div', { class: 'art-podium' },
      col(avatar('🦊'), h('div', { class: 'art-step two' }, '#2')),
      col(avatar('🐼'), h('div', { class: 'art-step one' }, '#1')),
      col(avatar('🐸'), h('div', { class: 'art-step three' }, '#3')),
    ),
  ],
};

function show(next) {
  index = Math.max(0, Math.min(slides.length - 1, next));
  const slide = slides[index];
  const art = (ART[slide.art] || ART.welcome)();
  const last = index === slides.length - 1;

  deck.replaceChildren(
    h('section', { class: 'slide anim-fade' },
      h('h1', { class: 'slide__title' }, slide.title),
      h('div', { class: `slide__art art-${slide.art}` }, art),
      h('p', { class: 'slide__text' }, slide.text),
    ),
    h('footer', { class: 'deck__foot' },
      h('div', { class: 'dots' }, slides.map((_, i) => h('span', { class: `dot${i === index ? ' is-on' : ''}` }))),
      h('div', { class: 'deck__nav' },
        h('button', { class: 'btn btn--plain btn--small', type: 'button', disabled: index === 0, 'data-nav': 'prev' }, '←'),
        last
          ? h('button', { class: 'btn btn--small', type: 'button', 'data-nav': 'done' }, 'Done')
          : h('button', { class: 'btn btn--small', type: 'button', 'data-nav': 'next' }, 'Next →'),
      ),
    ),
  );
}

function leave() {
  if (backUrl) location.href = backUrl;
  else if (history.length > 1) history.back();
  else location.href = '/';
}

// Click anywhere: right side goes on, left side goes back.
deck.addEventListener('click', (event) => {
  const nav = event.target.closest('[data-nav]');
  if (nav) {
    if (nav.dataset.nav === 'done') return leave();
    return show(index + (nav.dataset.nav === 'next' ? 1 : -1));
  }
  if (swiped) return;
  show(index + (event.clientX < window.innerWidth * 0.3 ? -1 : 1));
});

document.addEventListener('keydown', (event) => {
  if (['ArrowRight', 'PageDown', ' ', 'Enter'].includes(event.key)) {
    event.preventDefault();
    show(index + 1);
  } else if (['ArrowLeft', 'PageUp', 'Backspace'].includes(event.key)) {
    event.preventDefault();
    show(index - 1);
  } else if (event.key === 'Escape') leave();
  else if (event.key === 'Home') show(0);
  else if (event.key === 'End') show(slides.length - 1);
});

// Swipe on phones.
let startX = null;
let swiped = false;
deck.addEventListener('touchstart', (event) => {
  startX = event.touches[0].clientX;
  swiped = false;
}, { passive: true });
deck.addEventListener('touchend', (event) => {
  if (startX === null) return;
  const moved = event.changedTouches[0].clientX - startX;
  startX = null;
  if (Math.abs(moved) < 45) return;
  swiped = true;
  show(index + (moved < 0 ? 1 : -1));
  setTimeout(() => { swiped = false; }, 400);
}, { passive: true });

loadContent()
  .then((content) => {
    slides = content.slides;
    show(0);
    deck.focus();
  })
  .catch(() => {
    deck.replaceChildren(h('p', { class: 'error' }, 'The slides could not be loaded. Reload the page to try again.'));
  });
