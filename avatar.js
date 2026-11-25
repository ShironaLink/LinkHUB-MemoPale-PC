(function (root) {
  'use strict';
  const shapes = {
    circle: '<circle cx="50" cy="50" r="43"/>',
    pebble: '<path d="M48 7C71 5 91 26 93 51C95 78 73 94 47 92C23 92 7 81 7 58C7 34 24 9 48 7Z"/>',
    square: '<rect x="8" y="8" width="84" height="84" rx="24"/>',
    drop: '<path d="M47 6Q50 1 53 6C63 23 86 42 87 61C89 83 72 95 50 95C28 95 11 83 13 61C14 42 37 23 47 6Z"/>',
    triangle: '<path d="M38 13Q50-2 62 13L91 67Q102 89 79 92Q50 98 21 92Q-2 89 9 67Z"/>',
    cloud: '<path d="M39 14C41 0 62 0 66 16C81 7 98 25 87 38C104 49 94 70 79 70C88 91 65 102 54 88C44 104 22 95 25 80C8 89 0 68 13 57C-1 46 8 25 23 28C18 12 31 6 39 14Z"/>',
    pentagon: '<path d="M43 8Q50 3 57 8L88 31Q94 35 92 44L81 82Q79 91 69 91H31Q21 91 19 82L8 44Q6 35 12 31Z"/>',
    cat: '<path d="M14 39L13 13Q13 5 20 9L35 21Q50 16 65 21L80 9Q87 5 87 13L86 39C103 75 81 96 50 96C19 96-3 75 14 39Z"/>',
    rabbit: '<path d="M23 43C16 29 14 4 25 3C38 2 39 27 42 36H57C60 23 61 2 74 3C86 5 79 33 77 43C89 50 93 62 90 73C86 89 70 96 50 96C30 96 14 89 10 73C7 62 11 50 23 43Z"/>',
    bear: '<path d="M16 39C0 27 5 7 21 9C30 9 34 17 35 23Q50 18 65 23C66 17 70 9 79 9C95 7 100 27 84 39C101 70 82 95 50 95C18 95-1 70 16 39Z"/>',
    dog: '<path d="M26 24C11 18 0 37 3 54C5 67 17 58 23 48C15 79 28 94 50 94C72 94 85 79 77 48C83 58 95 67 97 54C100 37 89 18 74 24Q62 15 50 21Q38 15 26 24Z"/>',
    heart: '<path d="M50 24C36 3 9 8 5 30C-1 58 29 79 46 91Q50 94 54 91C71 79 101 58 95 30C91 8 64 3 50 24Z"/>',
    crescent: '<path d="M37 5C5 15-1 45 10 68C24 99 67 105 89 78C97 69 97 58 90 60C64 71 38 51 39 28C39 16 47 1 37 5Z"/>',
    star: '<path d="M46 7Q50 0 54 7L65 29Q67 33 72 33L92 35Q101 35 95 43L77 59Q73 62 75 67L79 89Q81 97 73 93L54 82Q50 79 46 82L27 93Q19 97 21 89L25 67Q27 62 23 59L5 43Q-1 35 8 35L28 33Q33 33 35 29Z"/>',
    cushion: '<path d="M19 9C32 16 39 19 50 19C61 19 68 16 81 9Q97 1 94 20C91 34 84 40 84 50C84 60 91 66 94 80Q97 99 81 91C68 84 61 81 50 81C39 81 32 84 19 91Q3 99 6 80C9 66 16 60 16 50C16 40 9 34 6 20Q3 1 19 9Z"/>',
    sparkle: '<path d="M45 8Q50-1 55 8L67 29Q69 33 73 35L94 46Q102 50 94 54L73 65Q69 67 67 71L55 92Q50 101 45 92L33 71Q31 67 27 65L6 54Q-2 50 6 46L27 35Q31 33 33 29Z"/>',
    horns: '<path d="M21 39C7 26 14 9 25 4Q31 0 29 8C25 19 31 27 37 30Q50 25 63 30C69 27 75 19 71 8Q69 0 75 4C86 9 93 26 79 39C97 56 94 80 76 90C63 98 37 98 24 90C6 80 3 56 21 39Z"/>',
    ghost: '<path d="M10 50C11 24 25 7 50 7C75 7 89 24 90 50L95 80C98 96 84 96 73 85C67 101 54 98 49 88C40 101 27 98 23 85C12 98 1 95 5 80Z"/>',
    mushroom: '<path d="M35 13C44 3 57 3 66 14C70 20 83 23 89 31C96 39 98 51 92 55C85 59 73 58 65 57L70 78C74 94 62 98 50 98C38 98 26 94 30 78L35 57C27 58 15 59 8 55C2 51 4 39 11 31C17 23 28 21 35 13Z"/>',
    wisp: '<path d="M31 47C31 20 45 5 62 6C86 6 95 29 92 53C89 81 72 95 45 95C25 95 8 87 4 79Q0 70 10 72C27 75 31 65 31 47Z"/>',
    amoeba: '<path d="M41 21C32 6 48-3 60 5C68 10 58 27 68 27C74 27 76 11 87 16C103 24 87 38 80 41C71 48 89 50 95 57C108 77 85 82 74 70C66 64 64 72 66 83C66 102 45 100 44 85C44 73 35 73 31 84C25 100 4 89 13 74C18 65 25 61 14 59C-4 55 3 32 16 30C28 29 29 40 37 35C45 31 44 28 41 21Z"/>',
    shield: '<path d="M17 13H83Q93 13 93 23L91 43C87 66 72 83 55 94Q50 98 45 94C28 83 13 66 9 43L7 23Q7 13 17 13Z"/>',
    slime: '<path d="M48 10Q50 4 52 10C55 29 76 32 89 47C104 64 94 84 76 88Q50 94 24 88C6 84-4 64 11 47C24 32 45 29 48 10Z"/>',
  };
  const eyes = {
    capsule: '<rect x="31" y="32" width="13" height="29" rx="6.5"/><rect x="56" y="32" width="13" height="29" rx="6.5"/>',
    dots: '<circle cx="36" cy="47" r="8"/><circle cx="63" cy="47" r="8"/>',
    oval: '<ellipse cx="36" cy="47" rx="10" ry="6.5"/><ellipse cx="64" cy="47" rx="10" ry="6.5"/>',
    sleepy: '<path d="M25 42H46V46A10.5 10.5 0 0 1 25 46Z"/><path d="M54 42H75V46A10.5 10.5 0 0 1 54 46Z"/>',
    happy: '<path d="M27 50Q36 32 45 50M55 50Q64 32 73 50" fill="none" stroke="currentColor" stroke-width="7.5" stroke-linecap="round"/>',
    squeeze: '<path d="M28 36L43 47L28 58M72 36L57 47L72 58" fill="none" stroke="currentColor" stroke-width="7.5" stroke-linecap="round" stroke-linejoin="round"/>',
    angry: '<path d="M26 37L46 51C33 59 24 52 26 37Z M74 37L54 51C67 59 76 52 74 37Z"/>',
    closed: '<path d="M27 43C28 57 43 57 45 43M55 43C56 57 71 57 73 43" fill="none" stroke="currentColor" stroke-width="7.5" stroke-linecap="round"/>',
    flat: '<path d="M27 47H44M56 47H73" fill="none" stroke="currentColor" stroke-width="7.5" stroke-linecap="round"/>',
    cross: '<path d="M29 38L43 56M43 38L29 56M57 38L71 56M71 38L57 56" fill="none" stroke="currentColor" stroke-width="7.5" stroke-linecap="round"/>',
    cry: '<path d="M27 38H45M36 38V59M55 38H73M64 38V59" fill="none" stroke="currentColor" stroke-width="8" stroke-linecap="round"/>',
    hearts: '<path d="M36 39C29 31 22 39 26 46C28 51 33 55 36 58C39 55 44 51 46 46C50 39 43 31 36 39Z M64 39C57 31 50 39 54 46C56 51 61 55 64 58C67 55 72 51 74 46C78 39 71 31 64 39Z"/>',
    sparkles: '<path d="M36 33C38 42 40 45 48 47C40 49 38 52 36 61C34 52 32 49 24 47C32 45 34 42 36 33Z M64 33C66 42 68 45 76 47C68 49 66 52 64 61C62 52 60 49 52 47C60 45 62 42 64 33Z"/>',
    wideDots: '<circle cx="36" cy="47" r="11"/><circle cx="64" cy="47" r="11"/>',
    teary: '<circle cx="36" cy="45" r="11"/><circle cx="64" cy="45" r="11"/><path d="M27 56C23.8 61 23.8 64.5 27 64.5C30.2 64.5 30.2 61 27 56ZM73 56C69.8 61 69.8 64.5 73 64.5C76.2 64.5 76.2 61 73 56Z"/>',
    wink: '<circle cx="36" cy="47" r="11"/><path d="M72 36L57 47L72 58" fill="none" stroke="currentColor" stroke-width="7.5" stroke-linecap="round" stroke-linejoin="round"/>'
  };
  // Optical fit per shape: [scale, bbox centre x, y]. Evens out the rounded areas (see artifacts/character-refine-20260925).
  const shapeFit = { circle: [0.93, 50.0, 50.0], triangle: [0.937, 50.0, 50.3], square: [0.908, 50.0, 50.0], pentagon: [0.949, 50.0, 48.2], cat: [0.91, 50.0, 51.9], rabbit: [0.904, 50.0, 49.6], bear: [0.913, 50.0, 51.9], dog: [0.914, 50.0, 56.3], heart: [0.918, 49.9, 51.6], crescent: [0.956, 49.9, 49.6], star: [0.914, 50.0, 48.9], cushion: [0.902, 50.0, 50.0], drop: [0.949, 50.0, 49.2], cloud: [0.882, 50.9, 50.1], sparkle: [0.907, 50.0, 50.0], horns: [0.902, 50.0, 49.5], ghost: [0.875, 49.8, 51.7], mushroom: [0.934, 50.0, 51.7], wisp: [0.939, 47.8, 50.5], amoeba: [0.891, 51.0, 49.5], shield: [0.945, 50.0, 54.6], slime: [0.942, 50.0, 48.9] };
  // Every tip gets the same rounding: the body is stroked in its own color with round joins.
  const roundness = 7;
  const shapeNames = { circle: 'まる', triangle: 'さんかく', square: 'しかく', pentagon: 'ごかく', cat: 'ねこ', rabbit: 'うさぎ', bear: 'くま', dog: 'たれみみ', heart: 'ハート', crescent: 'つき', star: 'ほし', cushion: 'クッション', drop: 'しずく', cloud: 'もこもこ', sparkle: 'きらり', horns: 'つの', ghost: 'おばけ', mushroom: 'きのこ', wisp: 'ひとだま', amoeba: 'アメーバ', shield: 'シールド', slime: 'スライム' };
  const shapeNumbers = { pentagon: 46, cat: 27, rabbit: 25, bear: 28, dog: 29, heart: 37, crescent: 38, star: 20, cushion: 24, drop: 7, cloud: 14, sparkle: 19, horns: 30, ghost: 31, mushroom: 33, wisp: 32, amoeba: 48, shield: 34 };
  // Place every eye style within the filled body, including ears and the moon's cutout.
  const eyeLayout = { rabbit: [50, 62, 0.85], cat: [50, 50.5, 0.9], bear: [50, 54, 0.9], dog: [50, 54.5, 0.85], horns: [50, 58.5, 0.85], crescent: [27.5, 54.5, 0.62], mushroom: [50, 39, 0.75], wisp: [62, 42.5, 0.8], heart: [50, 49, 0.85], star: [50, 50, 0.8], sparkle: [50, 50, 0.85], amoeba: [49, 51, 0.8], slime: [50, 59.5, 0.85], circle: [50, 44, 1], triangle: [50, 50, 1], square: [50, 44.5, 1], pentagon: [50, 45.5, 1], cushion: [50, 44.5, 1], drop: [50, 53.5, 1], shield: [50, 46.5, 1] };
  const eyeNames = { capsule: 'ぱっちり', dots: 'まんまる', oval: 'のんびり', sleepy: 'ねむたい', happy: 'にっこり', squeeze: 'ぎゅっ', angry: 'むっ', closed: 'とじ目', flat: 'すん', cross: 'ばつ', cry: 'なみだ', hearts: 'ハート目', sparkles: 'きらきら', wideDots: 'おおまる', teary: 'うるうる', wink: 'ウインク' };
  const eyeNumbers = { squeeze: 9, angry: 19, closed: 23, flat: 14, cross: 29, cry: 31, hearts: 37, sparkles: 39, wideDots: 25, teary: 33, wink: 24 };
  const palette = ['#E53935', '#FB8C00', '#FDD835', '#8BC34A', '#239447', '#29B6F6', '#2455C7', '#8246AF', '#F06292', '#8D5524', '#000000', '#FFFFFF'];
  const paletteNames = ['赤', '橙', '黄', '黄緑', '緑', '水色', '青', '紫', '桃', '茶', '黒', '白'];
  // A non-zero gap moves each eye outward (+) or inward (-); the halves are split at the face centre.
  function eyePair(drawing, gap) {
    if (!gap) return drawing;
    return '<clipPath id="memo-eye-l"><rect x="-100" y="-100" width="150" height="300"/></clipPath><clipPath id="memo-eye-r"><rect x="50" y="-100" width="150" height="300"/></clipPath>'
      + '<g transform="translate(' + (-gap) + ' 0)"><g clip-path="url(#memo-eye-l)">' + drawing + '</g></g><g transform="translate(' + gap + ' 0)"><g clip-path="url(#memo-eye-r)">' + drawing + '</g></g>';
  }
  // Per-eye tuning in eye space: [dy, scale around the face centre, gap]. options.eyeTune / options.eyeDrawing preview a change.
  const eyeTune = { dots: [-2.25, 1, 0], oval: [-3.25, 1, 0.75], sleepy: [-3.75, 1, 0], happy: [-0.75, 1, 1], closed: [0, 1, 0.75], flat: [-0.5, 1, 0], cross: [-1, 1, 0], cry: [2.5, 0.92, 2], wideDots: [-1.5, 1, 0], teary: [0, 1, 0], wink: [0, 0.89, 1.75] };
  function eyeDrawing(key, shapeGap, options) {
    const drawing = options.eyeDrawing || eyes[key] || eyes.capsule;
    const [dy, size, gap] = options.eyeTune || eyeTune[key] || [0, 1, 0];
    const pair = eyePair(drawing, shapeGap + gap);
    if (!dy && size === 1) return pair;
    return '<g transform="translate(50 ' + (47 + dy) + ') scale(' + size + ') translate(-50 -47)">' + pair + '</g>';
  }
  function markup(character, options = {}) {
    const color = /^#[0-9a-f]{6}$/i.test(character.color || '') ? character.color : '#464846';
    const tone = color.toUpperCase() === '#FFFFFF' ? 'white' : color.toUpperCase() === '#000000' ? 'black' : 'color';
    const eyeColor = 'var(--avatar-eye-color, ' + (tone === 'white' ? '#000000' : '#FFFFFF') + ')';
    // options.eyeLayout lets the eye tuning tool preview [x, y, scale, gap] without changing the table.
    const [eyeX, eyeY, eyeScale, eyeGap = 0] = options.eyeLayout || eyeLayout[character.shape] || [50, 47, 1];
    // Wide strokes need extra room under the triangle's sloped sides.
    const scale = character.shape === 'triangle' && ['squeeze', 'cry', 'wink'].includes(character.eyes) ? eyeScale * .88 : eyeScale;
    const [fit, fitX, fitY] = shapeFit[character.shape] || [1, 50, 50];
    const shape = shapes[character.shape] || shapes.circle, stroke = (roundness / fit).toFixed(2);
    return '<svg class="avatar" data-body-tone="' + tone + '" viewBox="0 0 100 100" aria-hidden="true" focusable="false">'
      + '<g transform="translate(50 50) scale(' + fit + ') translate(' + (-fitX) + ' ' + (-fitY) + ')">'
      + '<g class="avatar-outline" fill="none" stroke="var(--character-outline, #92968F)" stroke-width="' + ((roundness + 1.4) / fit).toFixed(2) + '" stroke-linejoin="round">' + shape + '</g>'
      + '<g class="avatar-body" fill="' + color + '" stroke="' + color + '" stroke-width="' + stroke + '" stroke-linejoin="round">' + shape + '</g>'
      + (options.bodyOnly ? '' : '<g class="avatar-eyes" transform="translate(' + eyeX + ' ' + eyeY + ') scale(' + scale + ') translate(-50 -47)" fill="' + eyeColor + '" style="color:' + eyeColor + '">' + eyeDrawing(character.eyes, eyeGap, options) + '</g>')
      + '</g></svg>';
  }
  root.MemoAvatar = { markup, eyeLayout, shapeFit, eyeTune, eyes, shapeNames, shapeNumbers, eyeNames, eyeNumbers, palette, paletteNames };
})(window);
