function svgResponse(svg: string): Response {
  return new Response(svg, {
    headers: {
      'Content-Type': 'image/svg+xml; charset=utf-8',
      'Cache-Control': 'public, max-age=86400',
    },
  });
}

export function serveGameSprite(pathname: string): Response | null {
  if (pathname === '/raid/arena.webp') {
    return svgResponse(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 680">
      <defs>
        <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#1A2C26"/>
          <stop offset="55%" stop-color="#284239"/>
          <stop offset="100%" stop-color="#1E312A"/>
        </linearGradient>
        <radialGradient id="moon" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stop-color="#FAF3DE" stop-opacity="0.95"/>
          <stop offset="70%" stop-color="#E5B454" stop-opacity="0.25"/>
          <stop offset="100%" stop-color="#E5B454" stop-opacity="0"/>
        </radialGradient>
      </defs>
      <rect width="1200" height="680" fill="url(#sky)"/>
      <circle cx="880" cy="170" r="140" fill="url(#moon)"/>
      <circle cx="880" cy="170" r="46" fill="#FAF5E6" opacity="0.9"/>
      <path d="M0 500 Q260 400 560 465 T1200 430 L1200 680 L0 680 Z" fill="#15241E" opacity="0.85"/>
      <path d="M0 555 Q340 490 720 545 T1200 520 L1200 680 L0 680 Z" fill="#101B16"/>
      <g stroke="#3F7A68" stroke-opacity="0.16" stroke-width="1">
        <path d="M0 580 H1200 M0 620 H1200"/>
      </g>
    </svg>`);
  }

  if (pathname.startsWith('/raid/hero-')) {
    const role = pathname.replace('/raid/hero-', '').replace('.webp', '');
    const palette: Record<string, { bg: string; accent: string; emblem: string }> = {
      knight: { bg: '#2B5B70', accent: '#A8D0E6', emblem: 'M60 28 L88 40 V66 C88 86 60 98 60 98 C60 98 32 86 32 66 V40 Z' },
      mage: { bg: '#3F7A68', accent: '#E5B454', emblem: 'M60 22 L69 48 L95 57 L69 66 L60 92 L51 66 L25 57 L51 48 Z' },
      archer: { bg: '#B5502B', accent: '#FAF0CA', emblem: 'M36 84 L84 36 M62 34 H86 V58 M42 68 C42 46 58 34 78 34' },
    };
    const p = palette[role] ?? palette.knight;
    return svgResponse(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120">
      <circle cx="60" cy="60" r="52" fill="${p.bg}" stroke="#FAF8F4" stroke-width="4"/>
      <circle cx="60" cy="60" r="44" fill="none" stroke="${p.accent}" stroke-opacity="0.45" stroke-width="2" stroke-dasharray="6 4"/>
      <path d="${p.emblem}" fill="${role === 'archer' ? 'none' : p.accent}" stroke="${p.accent}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>`);
  }

  if (/^\/raid(?:\/g9)?\/boss-(easy|normal|hard)\.webp$/.test(pathname)) {
    const diff = pathname.includes('hard') ? 'hard' : pathname.includes('normal') ? 'normal' : 'easy';
    const colors =
      diff === 'hard'
        ? { body: '#A14320', glow: '#D96B43', eye: '#FFE066' }
        : diff === 'normal'
        ? { body: '#4A3F78', glow: '#9F8FEF', eye: '#FFD166' }
        : { body: '#2F8F83', glow: '#8BD3C7', eye: '#FAF8F4' };

    return svgResponse(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 240">
      <circle cx="120" cy="126" r="88" fill="${colors.glow}" fill-opacity="0.18"/>
      <path d="M54 148 C50 86 84 48 120 48 C156 48 190 86 186 148 C184 182 162 198 120 198 C78 198 56 182 54 148 Z" fill="${colors.body}" stroke="#FAF8F4" stroke-width="5"/>
      <path d="M74 62 L56 26 L94 46 M166 62 L184 26 L146 46" fill="${colors.body}" stroke="#FAF8F4" stroke-width="4" stroke-linejoin="round"/>
      <circle cx="94" cy="118" r="12" fill="#1B2823"/>
      <circle cx="146" cy="118" r="12" fill="#1B2823"/>
      <circle cx="96" cy="115" r="5" fill="${colors.eye}"/>
      <circle cx="148" cy="115" r="5" fill="${colors.eye}"/>
      <path d="M92 156 Q120 170 148 156" fill="none" stroke="#FAF8F4" stroke-width="5" stroke-linecap="round"/>
    </svg>`);
  }

  if (pathname === '/duel/red-fighter.png' || pathname === '/duel/blue-fighter.png') {
    const isRed = pathname.includes('red');
    const fill = isRed ? '#D96B43' : '#4B7E96';
    const sub = isRed ? '#FAD4C0' : '#CBE2EE';
    return svgResponse(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 180 180">
      <circle cx="90" cy="90" r="76" fill="${fill}" fill-opacity="0.22" stroke="${sub}" stroke-width="3"/>
      <circle cx="90" cy="66" r="28" fill="${fill}" stroke="#FAF8F4" stroke-width="4"/>
      <path d="M46 152 C48 112 66 98 90 98 C114 98 132 112 134 152 Z" fill="${fill}" stroke="#FAF8F4" stroke-width="4"/>
      <path d="M126 114 L160 64" stroke="${sub}" stroke-width="7" stroke-linecap="round"/>
    </svg>`);
  }

  return null;
}
