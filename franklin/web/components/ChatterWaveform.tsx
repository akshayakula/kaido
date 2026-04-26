'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

const CHATTER_SRC = '/audio/chatter.mp3';

// Real peak data extracted from /Users/akshayakula/Downloads/chatter.mp3 at
// build time. Loaded once per page and cached.
let cachedPeaks: number[] | null = null;
let cachePromise: Promise<number[]> | null = null;

async function loadPeaks(): Promise<number[]> {
  if (cachedPeaks) return cachedPeaks;
  if (!cachePromise) {
    cachePromise = fetch('/audio/chatter-waveform.json')
      .then(r => r.json() as Promise<{ peaks: number[] }>)
      .then(j => {
        cachedPeaks = j.peaks;
        return j.peaks;
      })
      .catch(() => []);
  }
  return cachePromise;
}

// Stable hash → window offset, so each device shows a different slice of the
// audio. Same id always renders the same waveform.
function hashSeed(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  }
  return h >>> 0;
}

const VIEW = 192; // number of peak bars visible in a card

export function ChatterWaveform({ seed, live }: { seed: string; live: boolean }) {
  const w = 280, h = 36, mid = h / 2;
  const [peaks, setPeaks] = useState<number[] | null>(cachedPeaks);
  const [scroll, setScroll] = useState(0);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    let alive = true;
    loadPeaks().then(p => { if (alive) setPeaks(p); });
    return () => { alive = false; };
  }, []);

  // When the card is live, slowly scroll through the waveform so it feels
  // like real-time audio scrolling past. Static otherwise.
  useEffect(() => {
    if (!live) return;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = (now - last) / 1000;
      last = now;
      // ~12 bars / second drift
      setScroll(s => s + dt * 12);
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); };
  }, [live]);

  const offset = useMemo(() => hashSeed(seed) % Math.max(1, (peaks?.length ?? 1024)), [seed, peaks]);

  const path = useMemo(() => {
    if (!peaks || peaks.length === 0) {
      return `M0,${mid} L${w},${mid}`;
    }
    const N = peaks.length;
    const start = Math.floor(offset + scroll) % N;
    // Find max peak in the visible window for normalization so quiet sections
    // still look interesting.
    let localMax = 0;
    for (let i = 0; i < VIEW; i++) {
      const v = peaks[(start + i) % N];
      if (v > localMax) localMax = v;
    }
    const norm = localMax > 0.02 ? 1 / localMax : 1;
    // Build a top-then-bottom mirrored waveform path so it looks like a
    // proper audio scope (positive + negative envelope).
    const top: string[] = [];
    const bot: string[] = [];
    for (let i = 0; i < VIEW; i++) {
      const x = (i / (VIEW - 1)) * w;
      const v = peaks[(start + i) % N] * norm;
      const amp = Math.min(1, v) * (mid - 2);
      top.push(`${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${(mid - amp).toFixed(1)}`);
      bot.unshift(`L${x.toFixed(1)},${(mid + amp).toFixed(1)}`);
    }
    return top.join(' ') + ' ' + bot.join(' ') + ' Z';
  }, [peaks, offset, scroll, w, mid]);

  // Inline play/pause for the chatter sample.
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);

  const togglePlay = useCallback(() => {
    const a = audioRef.current;
    if (!a) return;
    if (a.paused) {
      a.play().then(() => setPlaying(true)).catch(() => setPlaying(false));
    } else {
      a.pause();
      setPlaying(false);
    }
  }, []);

  return (
    <div className="sensor-audio__row">
      <button
        type="button"
        className={`sensor-audio__play${playing ? ' sensor-audio__play--on' : ''}`}
        onClick={togglePlay}
        aria-label={playing ? 'Pause sample' : 'Play sample'}
        title={playing ? 'Pause sample' : 'Play sample'}
      >
        {playing ? '❚❚' : '▶'}
      </button>
      <svg className="sensor-audio__wave" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden="true">
        <path d={path} />
      </svg>
      <audio
        ref={audioRef}
        src={CHATTER_SRC}
        preload="none"
        onEnded={() => setPlaying(false)}
        onPause={() => setPlaying(false)}
      />
    </div>
  );
}
