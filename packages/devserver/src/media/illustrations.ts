// DEV ONLY: generated SVG illustrations for the demo listings (no downloads, no third-party
// images). A name `<scene>-<time>-<palette>` describes the picture completely, so the URL alone
// is enough to render it and the same URL always yields the same image.

export const SCENES = [
  'house',
  'townhouses',
  'apartment',
  'villa',
  'loft',
  'chalet',
  'tower',
  'interior',
] as const;
export type Scene = (typeof SCENES)[number];

export const TIMES = ['day', 'golden', 'dusk', 'night'] as const;
export type TimeOfDay = (typeof TIMES)[number];

/** Facade colour and its darker trim (roof, frames). */
export const PALETTES = {
  terracotta: ['#c8775a', '#7a3e2c'],
  sand: ['#e3d3b5', '#8c7656'],
  slate: ['#7d8c99', '#3c4852'],
  sage: ['#a3b79e', '#4f6650'],
  white: ['#f1ede4', '#6b6a66'],
  brick: ['#9c4f3b', '#4f2a20'],
  timber: ['#9a6a45', '#4a311f'],
  navy: ['#40566e', '#1f2d3b'],
} as const satisfies Record<string, readonly [string, string]>;
export type Palette = keyof typeof PALETTES;

export interface Illustration {
  scene: Scene;
  time: TimeOfDay;
  palette: Palette;
}

const W = 1200;
const H = 800;
const GROUND = 640;

const SKY: Record<TimeOfDay, [string, string]> = {
  day: ['#7fb9e0', '#dcf0f6'],
  golden: ['#e9a15e', '#fbe2b0'],
  dusk: ['#2c3966', '#d08a73'],
  night: ['#081625', '#1d3a4a'],
};
const LAND: Record<TimeOfDay, [string, string]> = {
  day: ['#7fae6a', '#557f45'],
  golden: ['#8f9c55', '#5d6a37'],
  dusk: ['#3f5a46', '#26392c'],
  night: ['#1d3326', '#10201a'],
};
const dark = (time: TimeOfDay) => time === 'dusk' || time === 'night';

/** Parses `house-day-terracotta`; `undefined` for anything else. */
export function parseIllustration(name: string): Illustration | undefined {
  const [scene, time, palette, ...rest] = name.split('-');
  if (rest.length > 0) return undefined;
  if (!(SCENES as readonly string[]).includes(scene ?? '')) return undefined;
  if (!(TIMES as readonly string[]).includes(time ?? '')) return undefined;
  if (palette === undefined || !Object.hasOwn(PALETTES, palette)) return undefined;
  return { scene: scene as Scene, time: time as TimeOfDay, palette: palette as Palette };
}

export const illustrationName = ({ scene, time, palette }: Illustration): string =>
  `${scene}-${time}-${palette}`;

/** Deterministic pseudo-random sequence (mulberry32), seeded by the name. */
function random(seed: string): () => number {
  let h = 2166136261;
  for (const ch of seed) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return () => {
    h = (h + 0x6d2b79f5) | 0;
    let t = Math.imul(h ^ (h >>> 15), 1 | h);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rect = (x: number, y: number, w: number, h: number, fill: string, extra = '') =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}"${extra}/>`;
const poly = (points: readonly number[], fill: string, extra = '') =>
  `<polygon points="${points.join(' ')}" fill="${fill}"${extra}/>`;

interface Ctx {
  time: TimeOfDay;
  wall: string;
  trim: string;
  /** Darkens a colour for dusk and night. */
  tone: (hex: string) => string;
  rnd: () => number;
}

/** `hex` mixed with a night blue by `amount` (0 = unchanged). */
function darken(hex: string, amount: number): string {
  if (amount === 0) return hex;
  const night = [11, 22, 34];
  const channels = [1, 3, 5].map((i, c) =>
    Math.round(parseInt(hex.slice(i, i + 2), 16) * (1 - amount) + (night[c] ?? 0) * amount),
  );
  return `#${channels.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

/** Glass: sky reflection by day, warm light (mostly) at night. */
function windowFill(ctx: Ctx): string {
  if (!dark(ctx.time)) return ctx.time === 'golden' ? 'url(#glass-gold)' : 'url(#glass)';
  return ctx.rnd() < 0.72 ? 'url(#lit)' : '#22303a';
}

function windows(
  ctx: Ctx,
  x0: number,
  y0: number,
  cols: number,
  rows: number,
  w: number,
  h: number,
  gapX: number,
  gapY: number,
): string {
  let out = '';
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      out += rect(x0 + c * (w + gapX), y0 + r * (h + gapY), w, h, windowFill(ctx), ` rx="2"`);
    }
  }
  return out;
}

function tree(x: number, size: number, time: TimeOfDay): string {
  const leaf = dark(time) ? '#1f3d2b' : time === 'golden' ? '#6f8a3e' : '#4e8a48';
  const leaf2 = dark(time) ? '#173023' : time === 'golden' ? '#5a7333' : '#3f733b';
  return (
    rect(x - size * 0.06, GROUND - size * 0.9, size * 0.12, size * 0.9, '#5b4030') +
    `<circle cx="${x}" cy="${GROUND - size}" r="${size * 0.45}" fill="${leaf}"/>` +
    `<circle cx="${x - size * 0.25}" cy="${GROUND - size * 0.8}" r="${size * 0.32}" fill="${leaf2}"/>` +
    `<circle cx="${x + size * 0.28}" cy="${GROUND - size * 0.78}" r="${size * 0.3}" fill="${leaf2}"/>`
  );
}

function pine(x: number, size: number, time: TimeOfDay, base = GROUND): string {
  const leaf = dark(time) ? '#163024' : '#2f5e3c';
  return (
    rect(x - 6, base - size * 0.25, 12, size * 0.25, '#4a3326') +
    poly(
      [x, base - size, x - size * 0.32, base - size * 0.2, x + size * 0.32, base - size * 0.2],
      leaf,
    )
  );
}

function palm(x: number, size: number, time: TimeOfDay): string {
  const leaf = dark(time) ? '#1d3b2a' : '#3f7d45';
  const top = GROUND - size;
  const fronds = [-150, -115, -70, -30, 10, 45]
    .map((deg) => {
      const rad = (deg * Math.PI) / 180;
      const ex = x + 8 + Math.cos(rad) * size * 0.42;
      const ey = top + Math.sin(rad) * size * 0.22 + size * 0.12;
      return `<path d="M${x + 8} ${top} Q${(x + 8 + ex) / 2} ${top - size * 0.12} ${ex} ${ey}" stroke="${leaf}" stroke-width="${size * 0.06}" fill="none" stroke-linecap="round"/>`;
    })
    .join('');
  return (
    `<path d="M${x} ${GROUND} Q${x - 18} ${GROUND - size * 0.5} ${x + 8} ${top}" stroke="#6b5040" stroke-width="${size * 0.05}" fill="none"/>` +
    fronds
  );
}

function sky(ctx: Ctx, horizon = GROUND): string {
  const { time, rnd } = ctx;
  let out = rect(0, 0, W, horizon + 20, 'url(#sky)');
  if (time === 'night' || time === 'dusk') {
    const count = time === 'night' ? 70 : 25;
    for (let i = 0; i < count; i++) {
      const x = Math.round(rnd() * W);
      const y = Math.round(rnd() * horizon * 0.6);
      out += `<circle cx="${x}" cy="${y}" r="${(rnd() * 1.6 + 0.6).toFixed(1)}" fill="#fff" opacity="${(rnd() * 0.6 + 0.3).toFixed(2)}"/>`;
    }
  }
  if (time === 'night') {
    out +=
      `<circle cx="960" cy="130" r="46" fill="#f4ecd0"/>` +
      `<circle cx="982" cy="116" r="40" fill="#0d1d2c"/>`;
  } else if (time === 'day') {
    out += `<circle cx="980" cy="140" r="58" fill="#fff6cf" opacity="0.95"/>`;
    out += cloud(220, 150, 1, '#ffffff') + cloud(690, 110, 0.7, '#ffffff');
  } else if (time === 'golden') {
    out += `<circle cx="900" cy="${horizon - 120}" r="80" fill="#ffd38a" opacity="0.9"/>`;
    out += cloud(300, 170, 0.9, '#fbd7a6');
  } else {
    out += cloud(260, 200, 0.8, '#9b6f7a');
  }
  return out;
}

function cloud(x: number, y: number, s: number, fill: string): string {
  return `<g fill="${fill}" opacity="0.8"><ellipse cx="${x}" cy="${y}" rx="${90 * s}" ry="${26 * s}"/><ellipse cx="${x + 40 * s}" cy="${y - 18 * s}" rx="${50 * s}" ry="${28 * s}"/><ellipse cx="${x - 36 * s}" cy="${y - 10 * s}" rx="${40 * s}" ry="${22 * s}"/></g>`;
}

function ground(ctx: Ctx): string {
  return (
    `<path d="M0 ${GROUND - 40} Q300 ${GROUND - 90} 600 ${GROUND - 50} T1200 ${GROUND - 60} V${H} H0Z" fill="${LAND[ctx.time][0]}" opacity="0.65"/>` +
    rect(0, GROUND, W, H - GROUND, 'url(#land)')
  );
}

function house(ctx: Ctx): string {
  const { wall, trim, time } = ctx;
  return (
    sky(ctx) +
    ground(ctx) +
    tree(230, 230, time) +
    tree(1010, 190, time) +
    rect(690, 270, 46, 90, trim) +
    rect(420, 390, 400, 250, wall) +
    poly([395, 400, 620, 250, 845, 400], trim) +
    poly([420, 395, 620, 262, 820, 395], wall, ' opacity="0.35"') +
    windows(ctx, 455, 425, 2, 1, 90, 80, 30, 0) +
    windows(ctx, 665, 425, 1, 1, 120, 80, 0, 0) +
    windows(ctx, 455, 530, 1, 1, 90, 80, 0, 0) +
    rect(600, 520, 64, 120, trim, ' rx="4"') +
    windows(ctx, 700, 530, 1, 1, 90, 80, 0, 0) +
    `<circle cx="620" cy="330" r="22" fill="${windowFill(ctx)}"/>` +
    poly([600, 640, 664, 640, 720, 800, 560, 800], '#cbbfa8', ' opacity="0.7"') +
    `<g stroke="#f3eee4" stroke-width="6" opacity="${dark(time) ? 0.4 : 0.85}">${Array.from(
      { length: 12 },
      (_, i) =>
        `<line x1="${60 + i * 40}" y1="${GROUND + 10}" x2="${60 + i * 40}" y2="${GROUND + 60}"/>`,
    ).join('')}<line x1="50" y1="${GROUND + 25}" x2="520" y2="${GROUND + 25}"/></g>`
  );
}

function townhouses(ctx: Ctx): string {
  const colours = [ctx.wall, '#d9b98f', '#a9433a', '#e8e1d2', '#6f8f8a'].map((c, i) =>
    i === 0 ? c : ctx.tone(c),
  );
  let out = sky(ctx) + ground(ctx);
  for (let i = 0; i < 5; i++) {
    const x = 120 + i * 196;
    const top = 300 + (i % 2) * 40;
    const wall = colours[i % colours.length] ?? ctx.wall;
    out +=
      rect(x, top, 190, GROUND - top, wall) +
      poly([x - 6, top + 4, x + 95, top - 90, x + 196, top + 4], ctx.trim) +
      windows(ctx, x + 25, top + 40, 2, 3, 55, 60, 30, 34) +
      rect(x + 70, GROUND - 90, 50, 90, ctx.trim, ' rx="3"');
  }
  return out + tree(80, 160, ctx.time) + tree(1140, 170, ctx.time);
}

function apartment(ctx: Ctx): string {
  let out = sky(ctx) + ground(ctx) + rect(310, 180, 580, GROUND - 180, ctx.wall);
  out += rect(296, 168, 608, 18, ctx.trim);
  for (let floor = 0; floor < 5; floor++) {
    const y = 210 + floor * 86;
    out += windows(ctx, 340, y, 6, 1, 64, 58, 26, 0);
    if (floor > 0) {
      for (const bx of [330, 600]) {
        out += rect(bx, y + 52, 250, 8, ctx.trim);
        out += `<g stroke="${ctx.trim}" stroke-width="3" opacity="0.8">${Array.from(
          { length: 11 },
          (_, i) =>
            `<line x1="${bx + 5 + i * 24}" y1="${y + 30}" x2="${bx + 5 + i * 24}" y2="${y + 52}"/>`,
        ).join('')}<line x1="${bx}" y1="${y + 30}" x2="${bx + 250}" y2="${y + 30}"/></g>`;
      }
    }
  }
  out += rect(560, GROUND - 70, 80, 70, ctx.trim);
  return out + tree(200, 220, ctx.time) + tree(1000, 240, ctx.time) + tree(1110, 170, ctx.time);
}

function villa(ctx: Ctx): string {
  const water = dark(ctx.time) ? ['#1f7a86', '#0e4250'] : ['#5fd0dc', '#2a95b0'];
  return (
    sky(ctx) +
    ground(ctx) +
    palm(150, 330, ctx.time) +
    palm(1080, 300, ctx.time) +
    rect(250, 430, 520, 200, ctx.wall) +
    rect(230, 418, 560, 16, ctx.trim) +
    windows(ctx, 280, 455, 4, 1, 105, 160, 14, 0) +
    rect(600, 330, 380, 140, ctx.wall) +
    rect(585, 318, 410, 16, ctx.trim) +
    windows(ctx, 625, 350, 3, 1, 105, 100, 14, 0) +
    rect(790, 470, 18, 160, ctx.trim) +
    `<linearGradient id="water" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${water[0]}"/><stop offset="1" stop-color="${water[1]}"/></linearGradient>` +
    rect(0, GROUND, W, H - GROUND, '#d8cdb8', dark(ctx.time) ? ' opacity="0.45"' : '') +
    poly([140, GROUND + 30, 1060, GROUND + 30, 1180, 790, 20, 790], 'url(#water)') +
    `<g stroke="#ffffff" stroke-width="3" opacity="0.35">${[690, 715, 745]
      .map((y, i) => `<line x1="${260 + i * 90}" y1="${y}" x2="${520 + i * 140}" y2="${y}"/>`)
      .join('')}</g>`
  );
}

function loft(ctx: Ctx): string {
  const harbour = dark(ctx.time) ? '#14303b' : '#4f86a0';
  let out = sky(ctx, 560) + rect(0, 560, W, 240, harbour);
  out += rect(240, 250, 720, 310, ctx.wall);
  for (let i = 0; i < 6; i++) {
    const x = 240 + i * 120;
    out += poly([x, 250, x + 120, 250, x + 120, 180], ctx.trim);
  }
  out += rect(880, 100, 46, 150, ctx.trim);
  for (let i = 0; i < 5; i++) {
    const x = 285 + i * 135;
    out += rect(x, 300, 100, 210, windowFill(ctx), ' rx="50"');
    out += `<g stroke="${ctx.trim}" stroke-width="5"><line x1="${x + 50}" y1="300" x2="${x + 50}" y2="510"/><line x1="${x}" y1="400" x2="${x + 100}" y2="400"/></g>`;
  }
  out += rect(200, 556, 800, 14, '#3a3a3a');
  out += `<g opacity="0.35" transform="translate(0 1130) scale(1 -1)">${rect(240, 570, 720, 120, ctx.wall)}</g>`;
  out += `<g stroke="#ffffff" stroke-width="3" opacity="0.25">${[620, 660, 700, 740]
    .map((y, i) => `<line x1="${120 + i * 50}" y1="${y}" x2="${1000 - i * 40}" y2="${y}"/>`)
    .join('')}</g>`;
  return out;
}

function chalet(ctx: Ctx): string {
  const rock = dark(ctx.time) ? '#2f3d4f' : '#7b8aa0';
  const snow = dark(ctx.time) ? '#c9d3dd' : '#ffffff';
  let out = sky(ctx);
  out +=
    poly([0, 520, 260, 210, 520, 520], rock) +
    poly([200, 280, 260, 210, 320, 280, 290, 300, 260, 270, 230, 300], snow);
  out +=
    poly([360, 540, 720, 150, 1080, 540], rock) +
    poly([640, 240, 720, 150, 800, 240, 760, 262, 720, 230, 680, 262], snow);
  out += poly([860, 540, 1100, 260, 1300, 540], rock, ' opacity="0.85"');
  out += ground(ctx);
  out += rect(430, 420, 380, 220, ctx.wall);
  out += poly([380, 430, 620, 290, 860, 430], ctx.trim);
  out += windows(ctx, 470, 455, 3, 1, 80, 70, 40, 0);
  out += rect(410, 540, 420, 12, ctx.trim);
  out += `<g stroke="${ctx.trim}" stroke-width="5">${Array.from(
    { length: 15 },
    (_, i) => `<line x1="${420 + i * 28}" y1="512" x2="${420 + i * 28}" y2="540"/>`,
  ).join('')}<line x1="410" y1="512" x2="830" y2="512"/></g>`;
  out += windows(ctx, 470, 565, 3, 1, 80, 60, 40, 0);
  return (
    out +
    pine(220, 260, ctx.time) +
    pine(300, 200, ctx.time) +
    pine(980, 280, ctx.time) +
    pine(1080, 210, ctx.time)
  );
}

function tower(ctx: Ctx): string {
  let out = sky(ctx);
  const skyline = dark(ctx.time) ? '#1b2a3a' : '#9fb2c4';
  for (const [x, w, h] of [
    [40, 140, 300],
    [190, 110, 380],
    [820, 130, 340],
    [960, 180, 260],
    [1100, 120, 420],
  ] as const) {
    out += rect(x, GROUND - h, w, h, skyline);
    if (dark(ctx.time))
      out += windows(ctx, x + 14, GROUND - h + 20, 3, Math.floor(h / 60), 20, 18, 22, 40);
  }
  out += rect(450, 110, 300, GROUND - 110, ctx.wall);
  out += rect(440, 96, 320, 20, ctx.trim);
  out += windows(ctx, 472, 140, 4, 12, 52, 26, 18, 13);
  out += rect(0, GROUND, W, H - GROUND, 'url(#land)');
  return out + palm(380, 260, ctx.time) + palm(820, 230, ctx.time);
}

function interior(ctx: Ctx): string {
  const night = dark(ctx.time);
  const wallColour = night ? '#3b3a35' : '#ece5d8';
  let out = rect(0, 0, W, H, wallColour);
  // Window with the sky of the chosen time.
  out += `<svg x="140" y="110" width="520" height="380" viewBox="0 0 ${W} ${GROUND + 20}" preserveAspectRatio="xMidYMax slice">${sky(ctx)}${rect(0, GROUND - 60, W, 80, LAND[ctx.time][1])}</svg>`;
  out += `<g stroke="${ctx.trim}" stroke-width="12" fill="none"><rect x="140" y="110" width="520" height="380"/><line x1="400" y1="110" x2="400" y2="490"/></g>`;
  // Floor, rug, sofa, lamp, plant, picture.
  out += rect(0, 600, W, 200, night ? '#4a3527' : '#b48a62');
  out += `<g stroke="${night ? '#3c2b20' : '#a07a55'}" stroke-width="3">${Array.from(
    { length: 9 },
    (_, i) => `<line x1="${i * 150}" y1="600" x2="${i * 150 - 80}" y2="800"/>`,
  ).join('')}</g>`;
  out += `<ellipse cx="640" cy="720" rx="360" ry="50" fill="${ctx.wall}" opacity="0.55"/>`;
  out +=
    rect(420, 520, 520, 120, ctx.wall, ' rx="26"') + rect(400, 480, 560, 70, ctx.trim, ' rx="30"');
  out +=
    rect(450, 560, 140, 50, ctx.wall, ' rx="14" opacity="0.8"') +
    rect(770, 560, 140, 50, ctx.wall, ' rx="14" opacity="0.8"');
  out +=
    rect(1030, 330, 8, 300, '#2d2d2d') +
    poly([980, 330, 1088, 330, 1060, 260, 1008, 260], night ? '#ffd27a' : '#f0e3c4');
  if (night) out += `<circle cx="1034" cy="330" r="160" fill="url(#glow)"/>`;
  out += rect(1080, 560, 70, 80, '#7a5236', ' rx="8"');
  out += `<g fill="${night ? '#2a4a35' : '#4f8a52'}"><ellipse cx="1115" cy="520" rx="22" ry="60" transform="rotate(-25 1115 520)"/><ellipse cx="1115" cy="510" rx="20" ry="66"/><ellipse cx="1118" cy="520" rx="22" ry="60" transform="rotate(25 1118 520)"/></g>`;
  out += rect(760, 170, 200, 140, '#f7f3ea', ' rx="4"') + rect(775, 185, 170, 110, ctx.wall);
  return out;
}

const DRAW: Record<Scene, (ctx: Ctx) => string> = {
  house,
  townhouses,
  apartment,
  villa,
  loft,
  chalet,
  tower,
  interior,
};

/** The illustration as a standalone SVG document (1200×800, 3:2). */
export function renderIllustration(illustration: Illustration): string {
  const { scene, time, palette } = illustration;
  const [baseWall, baseTrim] = PALETTES[palette];
  const tone = (hex: string) => darken(hex, time === 'night' ? 0.5 : time === 'dusk' ? 0.32 : 0);
  const [wall, trim] = [tone(baseWall), tone(baseTrim)];
  const ctx: Ctx = { time, wall, trim, tone, rnd: random(illustrationName(illustration)) };
  const [skyTop, skyBottom] = SKY[time];
  const [land, landDark] = LAND[time];
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">`,
    '<defs>',
    `<linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${skyTop}"/><stop offset="1" stop-color="${skyBottom}"/></linearGradient>`,
    `<linearGradient id="land" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${land}"/><stop offset="1" stop-color="${landDark}"/></linearGradient>`,
    '<linearGradient id="glass" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#d9eef7"/><stop offset="0.55" stop-color="#8fb8cc"/><stop offset="1" stop-color="#5d8aa3"/></linearGradient>',
    '<linearGradient id="glass-gold" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fde3b0"/><stop offset="1" stop-color="#c98a55"/></linearGradient>',
    '<linearGradient id="lit" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffe2a0"/><stop offset="1" stop-color="#f0a94e"/></linearGradient>',
    '<radialGradient id="glow"><stop offset="0" stop-color="#ffd27a" stop-opacity="0.45"/><stop offset="1" stop-color="#ffd27a" stop-opacity="0"/></radialGradient>',
    '</defs>',
    DRAW[scene](ctx),
    // Warm wash for the golden hour (dusk and night get their mood from sky, land and windows).
    time === 'golden' && scene !== 'interior' ? rect(0, 0, W, H, '#f2a65a', ' opacity="0.12"') : '',
    '</svg>',
  ].join('');
}
