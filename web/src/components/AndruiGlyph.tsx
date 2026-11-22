import React from 'react';

/** Event that makes the glyph's antennae wiggle (fired by the version easter egg). */
export const ANTENNA_WIGGLE_EVENT = 'andrui:antenna-wiggle';

/** Brand glyph drawn inline so its antennae can be animated; mirrors public/logos/andrui-terminal-glyph.svg. */
export const AndruiGlyph: React.FC = () => {
  const [wiggling, setWiggling] = React.useState(false);
  // Gradient/filter ids must be unique per instance: a hidden instance (mobile header) would break references from another.
  const uid = React.useId().replace(/:/g, '');

  React.useEffect(() => {
    const start = () => setWiggling(true);
    window.addEventListener(ANTENNA_WIGGLE_EVENT, start);
    return () => window.removeEventListener(ANTENNA_WIGGLE_EVENT, start);
  }, []);

  return (
    <svg className={`andrui-glyph ${wiggling ? 'wiggling' : ''}`} viewBox="0 0 512 512" aria-hidden="true"
      onAnimationEnd={() => setWiggling(false)}>
      <defs>
        <filter id={`glyphCyanGlow-${uid}`} x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur stdDeviation="4" result="blur" />
          <feComposite in="SourceGraphic" in2="blur" operator="over" />
        </filter>
        <filter id={`glyphEmeraldGlow-${uid}`} x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur stdDeviation="6" result="blur" />
          <feComposite in="SourceGraphic" in2="blur" operator="over" />
        </filter>
        <linearGradient id={`glyphDroid-${uid}`} x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stopColor="#3ddc84" />
          <stop offset="100%" stopColor="#10b981" />
        </linearGradient>
        <linearGradient id={`glyphScreen-${uid}`} x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stopColor="#0d141f" />
          <stop offset="100%" stopColor="#070a10" />
        </linearGradient>
      </defs>

      <g className="glyph-antenna glyph-antenna-left">
        <line x1="192" y1="168" x2="152" y2="104" stroke={`url(#glyphDroid-${uid})`} strokeWidth="16" strokeLinecap="round" />
        <circle cx="152" cy="104" r="5" fill="#38bdf8" filter={`url(#glyphCyanGlow-${uid})`} />
      </g>
      <g className="glyph-antenna glyph-antenna-right">
        <line x1="320" y1="168" x2="360" y2="104" stroke={`url(#glyphDroid-${uid})`} strokeWidth="16" strokeLinecap="round" />
        <circle cx="360" cy="104" r="5" fill="#38bdf8" filter={`url(#glyphCyanGlow-${uid})`} />
      </g>

      <path d="M 124 256 A 132 132 0 0 1 388 256 Z" fill={`url(#glyphDroid-${uid})`} />
      <circle cx="196" cy="208" r="14" fill="#0f172a" />
      <circle cx="196" cy="208" r="6" fill="#38bdf8" filter={`url(#glyphCyanGlow-${uid})`} />
      <circle cx="316" cy="208" r="14" fill="#0f172a" />
      <circle cx="316" cy="208" r="6" fill="#38bdf8" filter={`url(#glyphCyanGlow-${uid})`} />

      <rect x="124" y="272" width="264" height="124" rx="20" fill={`url(#glyphScreen-${uid})`} stroke="#1e293b" strokeWidth="3" />
      <rect x="126" y="274" width="260" height="120" rx="18" fill="none" stroke="#10b981" strokeOpacity="0.25" strokeWidth="1.5" />
      <circle cx="150" cy="294" r="4" fill="#f87171" opacity="0.85" />
      <circle cx="164" cy="294" r="4" fill="#fbbf24" opacity="0.85" />
      <circle cx="178" cy="294" r="4" fill="#34d399" opacity="0.85" />
      <line x1="196" y1="294" x2="370" y2="294" stroke="#1e293b" strokeWidth="1.5" strokeLinecap="round" />

      <g filter={`url(#glyphEmeraldGlow-${uid})`}>
        <path d="M 166 332 L 194 350 L 166 368" fill="none" stroke="#3ddc84" strokeWidth="8" strokeLinecap="round" strokeLinejoin="round" />
        <rect x="214" y="358" width="28" height="9" rx="3" fill="#38bdf8" />
      </g>
      <rect x="254" y="345" width="46" height="4" rx="2" fill="#3ddc84" opacity="0.45" />
      <rect x="308" y="345" width="24" height="4" rx="2" fill="#38bdf8" opacity="0.35" />
      <rect x="254" y="357" width="78" height="4" rx="2" fill="#94a3b8" opacity="0.3" />
    </svg>
  );
};
