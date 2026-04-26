'use client';

export type Sensitivity = {
  temp: number; // 1 = forgiving, 10 = very sensitive
  mic: number;  // 1 = ignore audio, 10 = very sensitive
};

export const DEFAULT_SENSITIVITY: Sensitivity = { temp: 5, mic: 5 };

function storageKey(device: string) {
  return `sensor:${device}:sensitivity`;
}

export function loadSensitivity(device: string): Sensitivity {
  if (typeof window === 'undefined') return DEFAULT_SENSITIVITY;
  try {
    const raw = localStorage.getItem(storageKey(device));
    if (!raw) return DEFAULT_SENSITIVITY;
    const parsed = JSON.parse(raw) as Partial<Sensitivity>;
    return {
      temp: Math.min(10, Math.max(1, Number(parsed.temp ?? DEFAULT_SENSITIVITY.temp))),
      mic:  Math.min(10, Math.max(1, Number(parsed.mic  ?? DEFAULT_SENSITIVITY.mic))),
    };
  } catch {
    return DEFAULT_SENSITIVITY;
  }
}

export function saveSensitivity(device: string, value: Sensitivity) {
  try { localStorage.setItem(storageKey(device), JSON.stringify(value)); } catch { /* ignore */ }
}

// Mapping from slider position (1-10) to firmware-side thresholds.
// A higher slider value = more sensitive = smaller threshold range.
export function micThresholds(sens: number) {
  // Pi defaults: noise_floor=0.0003 V, saturation_v=0.005 V.
  // sens=5  → defaults
  // sens=1  → very forgiving
  // sens=10 → extremely sensitive
  const k = (11 - sens) / 6; // sens=1→1.67, sens=5→1.0, sens=10→0.17
  return {
    mic_noise_floor_v: +(0.0003 * k).toFixed(6),
    mic_saturation_v:  +(0.005  * k).toFixed(6),
  };
}

export function tempThresholdC(sens: number) {
  // Pi default TEMP_THRESHOLD_C = 2.5 °C. Higher slider = smaller threshold.
  const k = (11 - sens) / 6;
  return +(2.5 * k).toFixed(2);
}

export function SensitivityControls({
  value,
  onChange,
}: {
  value: Sensitivity;
  onChange: (next: Sensitivity) => void;
}) {
  return (
    <div className="sensitivity">
      <div className="sensitivity__header">
        <span>Sensitivity for next baseline</span>
      </div>
      <label className="sensitivity__row">
        <span className="sensitivity__label">temp</span>
        <input
          type="range" min={1} max={10} step={1}
          value={value.temp}
          onChange={e => onChange({ ...value, temp: Number(e.target.value) })}
          aria-label="Temperature sensitivity"
        />
        <span className="sensitivity__val">{value.temp}</span>
      </label>
      <label className="sensitivity__row">
        <span className="sensitivity__label">mic</span>
        <input
          type="range" min={1} max={10} step={1}
          value={value.mic}
          onChange={e => onChange({ ...value, mic: Number(e.target.value) })}
          aria-label="Microphone sensitivity"
        />
        <span className="sensitivity__val">{value.mic}</span>
      </label>
    </div>
  );
}
