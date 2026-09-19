#!/usr/bin/env node
/**
 * Emits every media file the fixtures reference into `public/media/<slug>/`.
 *
 * The fixtures name local paths (`/media/skinare/cover.svg`) that no build step
 * would otherwise create, so without this the profile pages ship broken images.
 * The file list is READ OUT of lib/mock-businesses.ts rather than hard-coded
 * here: a fixture gaining a gallery image must not be able to silently outrun
 * its art.
 *
 * Output is a pure function of (slug, filename, themeColor), so re-running is a
 * no-op in the diff.
 *
 * The art is kashi-kari — the blue-and-white Multani tilework the whole site
 * borrows its identity from. Flat tones, no gradients, no photography pastiche.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const KASHI = '#1C4E8A';
const KASHI_DEEP = '#123765';
const PAPER = '#F6F3EC';
const PAPER_WARM = '#EFE7D7';
const INK = '#16211C';

/* -------------------------------------------------------------------------- */
/*  Colour                                                                     */
/* -------------------------------------------------------------------------- */

const hexToRgb = (hex) => {
  const value = parseInt(hex.replace('#', ''), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
};

const rgbToHex = (r, g, b) =>
  '#' + [r, g, b].map((channel) => Math.round(Math.min(255, Math.max(0, channel))).toString(16).padStart(2, '0')).join('');

function rgbToHsl(r, g, b) {
  const [rf, gf, bf] = [r / 255, g / 255, b / 255];
  const max = Math.max(rf, gf, bf);
  const min = Math.min(rf, gf, bf);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];

  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h =
    max === rf ? ((gf - bf) / d + (gf < bf ? 6 : 0)) : max === gf ? (bf - rf) / d + 2 : (rf - gf) / d + 4;
  return [h * 60, s, l];
}

function hslToHex(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = ((h % 360) + 360) % 360 / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const [r, g, b] = hp < 1 ? [c, x, 0] : hp < 2 ? [x, c, 0] : hp < 3 ? [0, c, x] : hp < 4 ? [0, x, c] : hp < 5 ? [x, 0, c] : [c, 0, x];
  const m = l - c / 2;
  return rgbToHex((r + m) * 255, (g + m) * 255, (b + m) * 255);
}

/**
 * An owner's theme colour is bounded customisation, not a free hand. It gets
 * pulled into the site's ceramic range — saturation and lightness clamped, and
 * violet hues (which would read as the generic SaaS gradient this design is
 * defined against) snapped back to kashi blue.
 */
function ceramic(hex) {
  if (!hex) return KASHI;
  const [h, s, l] = rgbToHsl(...hexToRgb(hex));
  const hue = h >= 238 && h <= 320 ? 212 : h;
  return hslToHex(hue, Math.min(s, 0.52), Math.min(Math.max(l, 0.3), 0.44));
}

const mix = (a, b, amount) => {
  const [ar, ag, ab] = hexToRgb(a);
  const [br, bg, bb] = hexToRgb(b);
  return rgbToHex(ar + (br - ar) * amount, ag + (bg - ag) * amount, ab + (bb - ab) * amount);
};

/* -------------------------------------------------------------------------- */
/*  Geometry                                                                   */
/* -------------------------------------------------------------------------- */

function hash(value) {
  let h = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

const round = (n) => Math.round(n * 100) / 100;

/** The khatam — an eight-point star, the anchor motif of kashi kari. */
function star(cx, cy, outer, inner, rotation = 22.5) {
  const points = [];
  for (let i = 0; i < 16; i += 1) {
    const radius = i % 2 === 0 ? outer : inner;
    const angle = ((rotation + i * 22.5) * Math.PI) / 180;
    points.push(`${round(cx + radius * Math.cos(angle))},${round(cy + radius * Math.sin(angle))}`);
  }
  return `M${points.join('L')}Z`;
}

const lozenge = (cx, cy, r) =>
  `M${round(cx)},${round(cy - r)}L${round(cx + r)},${round(cy)}L${round(cx)},${round(cy + r)}L${round(cx - r)},${round(cy)}Z`;

function hexagon(cx, cy, r) {
  const points = [];
  for (let i = 0; i < 6; i += 1) {
    const angle = ((30 + i * 60) * Math.PI) / 180;
    points.push(`${round(cx + r * Math.cos(angle))},${round(cy + r * Math.sin(angle))}`);
  }
  return `M${points.join('L')}Z`;
}

/* -------------------------------------------------------------------------- */
/*  Tile patterns — three motifs, chosen deterministically                     */
/* -------------------------------------------------------------------------- */

function starTile(id, s, line, accent, w) {
  const corners = [[0, 0], [s, 0], [0, s], [s, s]]
    .map(([x, y]) => `<path d="${star(x, y, s * 0.3, s * 0.13)}" fill="${line}" fill-opacity="0.55"/>`)
    .join('');

  return `<pattern id="${id}" width="${s}" height="${s}" patternUnits="userSpaceOnUse">
      ${corners}
      <path d="${star(s / 2, s / 2, s * 0.36, s * 0.16)}" fill="none" stroke="${line}" stroke-width="${w}"/>
      <path d="${star(s / 2, s / 2, s * 0.18, s * 0.08)}" fill="${accent}"/>
      <path d="${lozenge(s / 2, 0, s * 0.09)}" fill="${accent}"/>
      <path d="${lozenge(0, s / 2, s * 0.09)}" fill="${accent}"/>
    </pattern>`;
}

function fretTile(id, s, line, accent, w) {
  const r = s * 0.29;
  return `<pattern id="${id}" width="${s}" height="${round(s * 0.866)}" patternUnits="userSpaceOnUse">
      <path d="${hexagon(0, 0, r)}${hexagon(s, 0, r)}${hexagon(0, s * 0.866, r)}${hexagon(s, s * 0.866, r)}${hexagon(s / 2, s * 0.433, r)}"
            fill="none" stroke="${line}" stroke-width="${w}"/>
      <path d="${hexagon(s / 2, s * 0.433, r * 0.45)}" fill="${accent}"/>
      <path d="${lozenge(0, 0, s * 0.08)}${lozenge(s, 0, s * 0.08)}${lozenge(0, s * 0.866, s * 0.08)}${lozenge(s, s * 0.866, s * 0.08)}" fill="${line}" fill-opacity="0.7"/>
    </pattern>`;
}

/**
 * Interlacing circles — the girih lattice a khatam is constructed from. Circles
 * sit on the cell corners and centre so the motif is continuous across seams
 * rather than a repeated stamp with visible edges.
 */
function arcTile(id, s, line, accent, w) {
  const circles = [[0, 0], [s, 0], [0, s], [s, s], [s / 2, s / 2]]
    .map(([x, y]) => `<circle cx="${x}" cy="${y}" r="${round(s / 2)}" fill="none" stroke="${line}" stroke-width="${w}"/>`)
    .join('');

  return `<pattern id="${id}" width="${s}" height="${s}" patternUnits="userSpaceOnUse">
      ${circles}
      <circle cx="${s / 2}" cy="${s / 2}" r="${round(s * 0.22)}" fill="none" stroke="${accent}" stroke-width="${round(w * 1.6)}"/>
      <path d="${star(s / 2, s / 2, s * 0.1, s * 0.045)}${star(0, 0, s * 0.1, s * 0.045)}${star(s, 0, s * 0.1, s * 0.045)}${star(0, s, s * 0.1, s * 0.045)}${star(s, s, s * 0.1, s * 0.045)}" fill="${accent}"/>
    </pattern>`;
}

const TILES = [starTile, fretTile, arcTile];

/* -------------------------------------------------------------------------- */
/*  Plates                                                                     */
/* -------------------------------------------------------------------------- */

const svg = (w, h, body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-hidden="true">${body}</svg>\n`;

/**
 * @param inverted paper ground with blue drawing, rather than blue ground with
 * paper drawing. Galleries alternate so a profile is not three dark blocks.
 */
function plate({ width, height, seed, accent, inverted }) {
  const motif = TILES[seed % TILES.length];
  // Cells are sized as a fraction of the plate, not in absolute pixels: a cover
  // is shown at 96px in a mobile row and at ~700px in the desktop feature, and a
  // fixed cell size turns into invisible fuzz at the small end.
  const size = round(width / (4 + (seed % 3)));
  const ground = inverted ? PAPER_WARM : seed % 2 === 0 ? KASHI : KASHI_DEEP;
  const line = inverted ? mix(KASHI, PAPER, 0.12) : PAPER;
  const detail = inverted ? accent : mix(accent, PAPER, 0.42);
  const inset = Math.round(Math.min(width, height) * 0.05);
  const frame = round(width * 0.004);

  return svg(
    width,
    height,
    `<defs>${motif(`t${seed}`, size, line, detail, round(size * 0.03))}</defs>` +
      `<rect width="${width}" height="${height}" fill="${ground}"/>` +
      `<rect width="${width}" height="${height}" fill="url(#t${seed})" opacity="${inverted ? 0.7 : 0.55}"/>` +
      `<rect x="${inset}" y="${inset}" width="${width - inset * 2}" height="${height - inset * 2}" fill="none" stroke="${line}" stroke-opacity="0.65" stroke-width="${frame}"/>` +
      `<rect x="${inset + frame * 3}" y="${inset + frame * 3}" width="${width - inset * 2 - frame * 6}" height="${height - inset * 2 - frame * 6}" fill="none" stroke="${line}" stroke-opacity="0.3" stroke-width="${round(frame / 2)}"/>` +
      `<rect width="${width}" height="${Math.round(height * 0.012)}" fill="${accent}"/>`,
  );
}

/** A monogram tile: initials over a kashi corner, the way a shopfront plate sits. */
function logoTile({ initials, seed, accent }) {
  const size = 256;
  const motif = TILES[seed % TILES.length];

  return svg(
    size,
    size,
    `<defs>${motif(`l${seed}`, 88, mix(KASHI, PAPER, 0.25), accent, 3)}` +
      `<clipPath id="lc${seed}"><path d="M0,0H${size}V96Q96,96 96,${size}H0Z"/></clipPath></defs>` +
      `<rect width="${size}" height="${size}" fill="${PAPER}"/>` +
      `<g clip-path="url(#lc${seed})"><rect width="${size}" height="${size}" fill="url(#l${seed})" opacity="0.5"/></g>` +
      `<rect x="8" y="8" width="${size - 16}" height="${size - 16}" fill="none" stroke="${accent}" stroke-width="2"/>` +
      `<text x="${size / 2}" y="${size / 2}" text-anchor="middle" dominant-baseline="central" ` +
      `font-family="Fraunces, Georgia, 'Times New Roman', serif" font-size="104" font-weight="600" fill="${KASHI_DEEP}">${initials}</text>`,
  );
}

function avatarDisc({ initial, _seed, accent }) {
  const size = 240;
  const r = size / 2 - 10;
  return svg(
    size,
    size,
    `<rect width="${size}" height="${size}" fill="${PAPER}"/>` +
      `<circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="${mix(accent, PAPER, 0.84)}" stroke="${accent}" stroke-width="2"/>` +
      `<path d="${star(size / 2, size / 2, r * 0.94, r * 0.62)}" fill="none" stroke="${accent}" stroke-opacity="0.35" stroke-width="1.5"/>` +
      `<text x="${size / 2}" y="${size / 2}" text-anchor="middle" dominant-baseline="central" ` +
      `font-family="Fraunces, Georgia, 'Times New Roman', serif" font-size="96" font-weight="600" fill="${INK}">${initial}</text>`,
  );
}

/* -------------------------------------------------------------------------- */
/*  Drive it from the fixtures                                                 */
/* -------------------------------------------------------------------------- */

const fixtures = readFileSync(join(root, 'lib/mock-businesses.ts'), 'utf8');

const businesses = fixtures
  .split(/\n\s*\.\.\.base,/)
  .slice(1)
  .map((block) => ({
    slug: block.match(/slug: '([^']+)'/)?.[1],
    name: block.match(/name: '([^']+)'/)?.[1] ?? '',
    themeColor: block.match(/themeColor: '([^']+)'/)?.[1] ?? null,
    media: [...block.matchAll(/'(\/media\/[^']+)'/g)].map((match) => match[1]),
  }))
  .filter((business) => business.slug);

const initialsOf = (name) =>
  name
    .replace(/[^A-Za-z ]/g, '')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0].toUpperCase())
    .join('');

let written = 0;

for (const business of businesses) {
  const accent = ceramic(business.themeColor);

  for (const url of business.media) {
    const file = join(root, 'public', url);
    const name = url.split('/').pop().replace('.svg', '');
    const seed = hash(`${business.slug}/${name}`);
    let contents;

    if (name === 'logo') {
      contents = logoTile({ initials: initialsOf(business.name), seed, accent });
    } else if (name.startsWith('staff-')) {
      contents = avatarDisc({ initial: name.slice(6).charAt(0).toUpperCase(), seed, accent });
    } else if (name === 'cover') {
      contents = plate({ width: 1200, height: 720, seed, accent, inverted: false });
    } else {
      // Galleries alternate ground so a profile reads as a set of tiles rather
      // than a wall of one colour.
      const index = Number(name.split('-')[1] ?? 1);
      contents = plate({
        width: index % 2 === 0 ? 900 : 1000,
        height: index % 2 === 0 ? 900 : 750,
        seed,
        accent,
        inverted: index % 2 === 1,
      });
    }

    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, contents, 'utf8');
    written += 1;
  }
}

console.log(`generate-media: wrote ${written} files for ${businesses.length} businesses`);
