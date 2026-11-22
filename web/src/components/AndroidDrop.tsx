import React from 'react';

/** Event that makes the Android drop onto the page (fired by the header's Android button). */
export const ANDROID_DROP_EVENT = 'andrui:android-drop';

const WIDTH = 136;
/** The Android is drawn taller than the logo: the viewBox is 512 wide and VIEW_H tall, with the feet at FEET_Y. */
const VIEW_H = 524;
const FEET_Y = 514;
const HEIGHT = (WIDTH * VIEW_H) / 512;
const FEET = FEET_Y / VIEW_H;
const TOTAL_MS = 4800;
const SELECTOR = '#main-content .workspace-panel, #main-content [class*="card"], #main-content [data-testid^="chart-"]';

/** Random spot on the top edge of a visible container, where the Android can stand fully in view. */
const pickLanding = (): { x: number; y: number } => {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const spots = Array.from(document.querySelectorAll<HTMLElement>(SELECTOR))
    .map(el => el.getBoundingClientRect())
    .filter(r => r.width >= WIDTH + 24 && r.height >= 48 && r.top - HEIGHT * FEET >= 56 && r.top <= vh - 40 && r.right > 0 && r.left < vw);
  if (!spots.length) return { x: vw / 2, y: vh * 0.55 };
  const r = spots[Math.floor(Math.random() * spots.length)];
  const lo = Math.max(r.left, 0) + WIDTH / 2 + 8;
  const hi = Math.min(r.right, vw) - WIDTH / 2 - 8;
  return { x: hi > lo ? lo + Math.random() * (hi - lo) : (lo + hi) / 2, y: r.top };
};

const reducedMotion = () => typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** The brand Android drops onto a random container, waves, then flies out of the window while the page dims. */
export const AndroidDrop: React.FC = () => {
  const [spot, setSpot] = React.useState<{ x: number; y: number } | null>(null);
  const [wiggling, setWiggling] = React.useState(false);
  const busy = React.useRef(false);
  const dimRef = React.useRef<HTMLDivElement>(null);
  const droidRef = React.useRef<HTMLDivElement>(null);
  const armRef = React.useRef<SVGGElement>(null);
  const uid = React.useId().replace(/:/g, '');

  React.useEffect(() => {
    const start = () => {
      if (busy.current || reducedMotion()) return;
      busy.current = true;
      setSpot(pickLanding());
    };
    window.addEventListener(ANDROID_DROP_EVENT, start);
    return () => window.removeEventListener(ANDROID_DROP_EVENT, start);
  }, []);

  React.useLayoutEffect(() => {
    if (!spot || !dimRef.current || !droidRef.current) return;
    const away = spot.y - HEIGHT * FEET + HEIGHT + 40;
    const timing = { duration: TOTAL_MS, fill: 'both' as const };
    const dim = dimRef.current.animate(
      [{ opacity: 0, offset: 0 }, { opacity: 0.45, offset: 0.12 }, { opacity: 0.45, offset: 0.7 }, { opacity: 0, offset: 1 }],
      timing,
    );
    const droid = droidRef.current.animate([
      { transform: `translateY(${-away}px)`, easing: 'cubic-bezier(.55,0,.9,.6)', offset: 0 },
      { transform: 'translateY(0) scale(1.1,.88)', easing: 'ease-out', offset: 0.17 },
      { transform: 'translateY(-16px) scale(.97,1.04)', easing: 'ease-in', offset: 0.2 },
      { transform: 'translateY(0) scale(1,1)', offset: 0.23 },
      { transform: 'translateY(0) scale(1,1)', offset: 0.67 },
      { transform: 'translateY(0) scale(1.08,.9)', easing: 'cubic-bezier(.5,0,.9,.4)', offset: 0.71 },
      { transform: `translateY(${-away}px) scale(.92,1.12) rotate(-4deg)`, offset: 1 },
    ], timing);
    const wave = (deg: number) => ({ transform: `rotate(${deg}deg)` });
    const arm = armRef.current?.animate([
      { ...wave(0), offset: 0 }, { ...wave(0), offset: 0.22 }, { ...wave(-125), offset: 0.28 }, { ...wave(-160), offset: 0.34 },
      { ...wave(-120), offset: 0.4 }, { ...wave(-160), offset: 0.46 }, { ...wave(-120), offset: 0.52 }, { ...wave(-160), offset: 0.58 },
      { ...wave(-125), offset: 0.64 }, { ...wave(0), offset: 0.69 }, { ...wave(0), offset: 1 },
    ], timing);
    const wiggleOn = window.setTimeout(() => setWiggling(true), 0.2 * TOTAL_MS);
    let cancelled = false;
    void droid.finished.then(() => {
      if (cancelled) return;
      busy.current = false;
      setWiggling(false);
      setSpot(null);
    }, () => {});
    return () => {
      cancelled = true;
      window.clearTimeout(wiggleOn);
      busy.current = false;
      dim.cancel(); droid.cancel(); arm?.cancel();
    };
  }, [spot]);

  if (!spot) return null;

  return (
    <div className="android-drop-layer" aria-hidden="true" data-testid="android-drop">
      <div className="android-drop-dim" ref={dimRef} />
      <div className="android-drop-droid" ref={droidRef}
        style={{ left: spot.x - WIDTH / 2, top: spot.y - HEIGHT * FEET, width: WIDTH, height: HEIGHT, transformOrigin: `50% ${FEET * 100}%` }}>
        <svg className={`andrui-glyph ${wiggling ? 'wiggling' : ''}`} viewBox={`0 0 512 ${VIEW_H}`} onAnimationEnd={() => setWiggling(false)}>
          <defs>
            <linearGradient id={`dropDroid-${uid}`} x1="0%" y1="0%" x2="0%" y2="100%">
              <stop offset="0%" stopColor="#3ddc84" />
              <stop offset="100%" stopColor="#10b981" />
            </linearGradient>
            <linearGradient id={`dropScreen-${uid}`} x1="0%" y1="0%" x2="0%" y2="100%">
              <stop offset="0%" stopColor="#0d141f" />
              <stop offset="100%" stopColor="#070a10" />
            </linearGradient>
          </defs>
          <g className="glyph-antenna glyph-antenna-left">
            <line x1="192" y1="168" x2="152" y2="104" stroke={`url(#dropDroid-${uid})`} strokeWidth="16" strokeLinecap="round" />
            <circle cx="152" cy="104" r="5" fill="#38bdf8" />
          </g>
          <g className="glyph-antenna glyph-antenna-right">
            <line x1="320" y1="168" x2="360" y2="104" stroke={`url(#dropDroid-${uid})`} strokeWidth="16" strokeLinecap="round" />
            <circle cx="360" cy="104" r="5" fill="#38bdf8" />
          </g>
          <line x1="120" y1="290" x2="90" y2="372" stroke="#3ddc84" strokeWidth="22" strokeLinecap="round" />
          <rect x="168" y="448" width="36" height="66" rx="14" fill="#10b981" />
          <rect x="308" y="448" width="36" height="66" rx="14" fill="#10b981" />
          <path d="M 124 256 A 132 132 0 0 1 388 256 Z" fill={`url(#dropDroid-${uid})`} />
          <circle cx="196" cy="208" r="14" fill="#0f172a" />
          <circle cx="196" cy="208" r="6" fill="#38bdf8" />
          <circle cx="316" cy="208" r="14" fill="#0f172a" />
          <circle cx="316" cy="208" r="6" fill="#38bdf8" />
          <rect x="124" y="272" width="264" height="200" rx="20" fill={`url(#dropScreen-${uid})`} stroke="#1e293b" strokeWidth="3" />
          <rect x="126" y="274" width="260" height="196" rx="18" fill="none" stroke="#10b981" strokeOpacity="0.25" strokeWidth="1.5" />
          <circle cx="150" cy="294" r="4" fill="#f87171" opacity="0.85" />
          <circle cx="164" cy="294" r="4" fill="#fbbf24" opacity="0.85" />
          <circle cx="178" cy="294" r="4" fill="#34d399" opacity="0.85" />
          <line x1="196" y1="294" x2="370" y2="294" stroke="#1e293b" strokeWidth="1.5" strokeLinecap="round" />
          <path d="M 166 332 L 194 350 L 166 368" fill="none" stroke="#3ddc84" strokeWidth="8" strokeLinecap="round" strokeLinejoin="round" />
          <rect x="214" y="358" width="28" height="9" rx="3" fill="#38bdf8" />
          <rect x="254" y="345" width="46" height="4" rx="2" fill="#3ddc84" opacity="0.45" />
          <rect x="308" y="345" width="24" height="4" rx="2" fill="#38bdf8" opacity="0.35" />
          <rect x="254" y="357" width="78" height="4" rx="2" fill="#94a3b8" opacity="0.3" />
          <path d="M 166 400 L 194 418 L 166 436" fill="none" stroke="#3ddc84" strokeWidth="8" strokeLinecap="round" strokeLinejoin="round" opacity="0.55" />
          <rect x="214" y="426" width="46" height="9" rx="3" fill="#38bdf8" opacity="0.55" />
          <rect x="274" y="413" width="58" height="4" rx="2" fill="#3ddc84" opacity="0.3" />
          <rect x="274" y="425" width="40" height="4" rx="2" fill="#94a3b8" opacity="0.25" />
          <g ref={armRef} style={{ transformOrigin: '392px 290px' }}>
            <line x1="392" y1="290" x2="424" y2="372" stroke="#3ddc84" strokeWidth="22" strokeLinecap="round" />
          </g>
        </svg>
      </div>
    </div>
  );
};
