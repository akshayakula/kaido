#!/usr/bin/env python3
# NeoPixel rendering primitives for the load-monitor firmware.
# Hardware: SK6812 RGBW 16-pixel ring on GPIO 18 (PWM0).
import math
import random

from rpi_ws281x import PixelStrip, Color, ws

NUM_LEDS    = 16
GPIO_PIN    = 18
LED_FREQ_HZ = 800000
LED_DMA     = 10
LED_INVERT  = False
LED_CHANNEL = 0
LED_STRIP   = ws.SK6812_STRIP_GRBW
MAX_BRIGHT  = 32
GAMMA       = 2.2
NORTH_LED   = 0


def gamma_byte(v):
    v = max(0.0, min(1.0, v))
    return int(round((v ** GAMMA) * 255))


def rgb(r, g, b, scale=1.0):
    return Color(gamma_byte(r * scale), gamma_byte(g * scale), gamma_byte(b * scale))


def make_strip():
    strip = PixelStrip(NUM_LEDS, GPIO_PIN, LED_FREQ_HZ, LED_DMA,
                       LED_INVERT, MAX_BRIGHT, LED_CHANNEL, LED_STRIP)
    strip.begin()
    return strip


def clear(strip):
    for i in range(NUM_LEDS):
        strip.setPixelColor(i, 0)
    strip.show()


def boot_wipe(strip, duration=1.0):
    import time
    step_time = duration * 0.6 / NUM_LEDS
    for i in range(NUM_LEDS):
        strip.setPixelColor(i, rgb(1, 1, 1, 0.5))
        strip.show()
        time.sleep(step_time)
    fade_steps = 20
    for s in range(fade_steps, 0, -1):
        lvl = (s / fade_steps) * 0.5
        for i in range(NUM_LEDS):
            strip.setPixelColor(i, rgb(1, 1, 1, lvl))
        strip.show()
        time.sleep(duration * 0.4 / fade_steps)
    clear(strip)


def render_load(strip, delta_c, threshold_c, stable, t):
    """Load visualization.

    delta_c     — current temperature minus baseline (°C)
    threshold_c — |delta| at which the ring is fully on (or fully off)
    stable      — True when temperature is constant; overrides color to green
    t           — monotonic seconds, used for a slow breathing pulse
    """
    norm = max(-1.0, min(1.0, delta_c / threshold_c)) if threshold_c > 0 else 0.0
    count = int(round(8 + norm * 8))
    count = max(0, min(NUM_LEDS, count))

    pulse = 0.7 + 0.3 * (0.5 + 0.5 * math.sin(t * 1.5))

    if stable:
        r, g, b = 0.0, 1.0, 0.2
    elif norm >= 0:
        # baseline → red as we heat up
        r = norm
        g = 1.0 - norm
        b = 0.0
    else:
        # baseline → blue as we cool down
        m = -norm
        r = 0.0
        g = 1.0 - m
        b = m

    for i in range(NUM_LEDS):
        if i < count:
            strip.setPixelColor(i, rgb(r, g, b, pulse))
        else:
            strip.setPixelColor(i, 0)
    strip.show()


def render_load_audio(strip, delta_c, threshold_c, stable, mic_level, t):
    """Load viz with per-LED color flicker driven by mic_level (0..1).

    Same LED count as render_load; instead of a single color per state, each
    lit LED blends between three palette colors using a phase-offset sine
    triple. mic_level speeds up the cycling — louder = more frantic.

    Palettes:
      stable  → green / blue / yellow
      heating → red   / blue / purple
      cooling → blue  / cyan / purple
    """
    norm = max(-1.0, min(1.0, delta_c / threshold_c)) if threshold_c > 0 else 0.0
    count = int(round(8 + norm * 8))
    count = max(0, min(NUM_LEDS, count))

    if stable:
        palette = [(0.0, 1.0, 0.2), (0.0, 0.4, 1.0), (0.6, 0.1, 1.0)]
    elif norm >= 0:
        palette = [(1.0, 0.0, 0.0), (0.0, 0.3, 1.0), (0.6, 0.1, 1.0)]
    else:
        palette = [(0.0, 0.3, 1.0), (0.0, 1.0, 1.0), (0.6, 0.1, 1.0)]

    m = max(0.0, min(1.0, mic_level))
    speed = 0.6 + 6.0 * m
    pulse = 0.7 + 0.3 * (0.5 + 0.5 * math.sin(t * 1.5))

    TWO_PI_3 = 2.0944  # 120° in radians

    for i in range(NUM_LEDS):
        if i < count:
            phase = (i * 0.55) + t * speed
            w0 = (1.0 + math.sin(phase)) * 0.5
            w1 = (1.0 + math.sin(phase + TWO_PI_3)) * 0.5
            w2 = (1.0 + math.sin(phase + 2 * TWO_PI_3)) * 0.5
            wsum = w0 + w1 + w2 or 1.0
            r = (palette[0][0] * w0 + palette[1][0] * w1 + palette[2][0] * w2) / wsum
            g = (palette[0][1] * w0 + palette[1][1] * w1 + palette[2][1] * w2) / wsum
            b = (palette[0][2] * w0 + palette[1][2] * w1 + palette[2][2] * w2) / wsum
            strip.setPixelColor(i, rgb(r, g, b, pulse))
        else:
            strip.setPixelColor(i, 0)
    strip.show()


def render_warn(strip, t):
    b = 0.15 + 0.45 * (0.5 + 0.5 * math.sin(t * 3.5))
    for i in range(NUM_LEDS):
        strip.setPixelColor(i, rgb(1.0, 0.0, 0.0, b))
    strip.show()


def render_wifi_pulse(strip, t):
    """Blue breathing pulse — shown while waiting for WiFi to come up."""
    lvl = 0.15 + 0.55 * (0.5 + 0.5 * math.sin(t * 2.5))
    for i in range(NUM_LEDS):
        strip.setPixelColor(i, rgb(0.0, 0.4, 1.0, lvl))
    strip.show()


def render_wifi_connected(strip, t, duration=1.5):
    """Brief celebratory blue spin once WiFi is up. Returns when t >= duration."""
    head = int((t / duration) * NUM_LEDS)
    head = min(head, NUM_LEDS - 1)
    for i in range(NUM_LEDS):
        if i <= head:
            strip.setPixelColor(i, rgb(0.0, 0.6, 1.0, 0.7))
        else:
            strip.setPixelColor(i, 0)
    strip.show()


def _hsv(h, s=1.0, v=1.0):
    """HSV → RGB tuple in [0,1]. h in turns (0..1)."""
    h = (h % 1.0) * 6.0
    i = int(h)
    f = h - i
    p = v * (1.0 - s)
    q = v * (1.0 - s * f)
    t = v * (1.0 - s * (1.0 - f))
    return [(v, t, p), (q, v, p), (p, v, t),
            (p, q, v), (t, p, v), (v, p, q)][i % 6]


def render_recalibrate(strip, t, duration=6.0):
    """Recalibration pattern. Three movements:

      0.0 - 0.4 s  : white burst from north LED outward (commit signal)
      0.4 - 4.5 s  : counter-rotating rainbow chase + breathing white core
      4.5 - duration: gentle white settle

    Designed to be visually distinct from every other ring state in the
    firmware, so an operator standing in front of the rack knows the
    recalibration command was actually received.
    """
    n = NUM_LEDS

    # Phase 1: white burst expanding from the north LED.
    if t < 0.4:
        prog = t / 0.4
        radius = prog * (n / 2)
        for i in range(n):
            offset = (i - NORTH_LED) % n
            offset = min(offset, n - offset)  # shortest arc
            d = abs(offset - radius)
            lvl = max(0.0, 1.0 - d * 0.9)
            strip.setPixelColor(i, rgb(1.0, 1.0, 1.0, lvl))
        strip.show()
        return

    # Phase 3: settle.
    if t > duration - 1.0:
        fade = max(0.0, (duration - t) / 1.0)
        for i in range(n):
            strip.setPixelColor(i, rgb(0.7, 0.95, 1.0, 0.45 * fade))
        strip.show()
        return

    # Phase 2: rainbow chase + breathing core.
    cw  = (t * 1.4)         # clockwise spin (turns/sec)
    ccw = -(t * 0.9)        # counter-clockwise spin
    breathe = 0.35 + 0.65 * (0.5 + 0.5 * math.sin(t * 5.0))

    for i in range(n):
        # Two rainbow heads, one in each direction.
        hue1 = (i / n + cw)  % 1.0
        hue2 = (i / n + ccw) % 1.0
        head1 = ((i / n - (cw  % 1.0)) % 1.0)
        head2 = ((i / n - (ccw % 1.0)) % 1.0)
        # Bright near the head, dim away — sharper falloff makes the chase visible.
        env1 = max(0.0, 1.0 - head1 * 4.0)
        env2 = max(0.0, 1.0 - (1.0 - head2) * 4.0)
        r1, g1, b1 = _hsv(hue1)
        r2, g2, b2 = _hsv(hue2)
        r = r1 * env1 + r2 * env2
        g = g1 * env1 + g2 * env2
        b = b1 * env1 + b2 * env2
        # Breathing white core blended in for depth.
        r = min(1.0, r * 0.85 + 0.25 * breathe)
        g = min(1.0, g * 0.85 + 0.25 * breathe)
        b = min(1.0, b * 0.85 + 0.30 * breathe)
        strip.setPixelColor(i, rgb(r, g, b, 1.0))
    strip.show()


# ---------------------------------------------------------------------------
# Comet tachometer — Δtemp-first visualization. Δ owns motion, color, length.
# Absolute temp lives as a dim background tint. Mic activity decays as
# short white sparkles. Sign reversal of Δ triggers a brief full-ring flash.
# ---------------------------------------------------------------------------

# Module-level state for the comet renderer (single ring per process).
_comet_state = {
    "last_t": None,         # last frame timestamp (s, monotonic-ish)
    "angle": 0.0,           # accumulated comet head position in LED-units
    "last_sign": 0,         # -1 cooling, 0 stable, +1 warming
    "flash_until": 0.0,     # absolute t when reversal flash ends
    "flash_color": (0.0, 0.0, 0.0),  # color of the reversal flash
    "sparkles": [],         # [(led_index, spawn_t)] active sparkles
}


def _temp_band_color(temp_c):
    """Map absolute temperature (°C) to the dim background hue.
    cool blue at ~16 °C → muted amber/red at ~38 °C."""
    if temp_c is None:
        return (0.5, 0.5, 0.5)
    # Map 16-38 C → 0..1 hue ramp blue→cyan→green→amber→red.
    f = max(0.0, min(1.0, (temp_c - 16.0) / 22.0))
    if f < 0.25:    # blue → cyan
        k = f / 0.25; return (0.0, 0.3 * k, 1.0)
    if f < 0.5:     # cyan → green
        k = (f - 0.25) / 0.25; return (0.0, 0.3 + 0.5 * k, 1.0 - k)
    if f < 0.75:    # green → amber
        k = (f - 0.5) / 0.25; return (k, 0.8, 0.0)
    # amber → red
    k = (f - 0.75) / 0.25
    return (1.0, 0.8 * (1.0 - k), 0.0)


def _delta_to_speed_turns_per_s(delta_c):
    """Map |Δ°C| → turns per second. Mirror of the table in the design notes:
       0.1 → 0,  0.5 → 0.5,  1.5 → 1.5,  3.0 → 3.0,  >=5 → 4.0 (clamp)."""
    a = abs(delta_c)
    if a < 0.1:
        return 0.0
    return min(4.0, a)  # roughly 1 turn/s per °C, clamped at 4


def _delta_to_tail_length(delta_c):
    """Map |Δ°C| → number of LEDs in the comet tail (head + trail)."""
    a = abs(delta_c)
    if a >= 5.0:
        return NUM_LEDS              # screaming comet — fill the ring
    return int(min(7, max(1, 1 + a * 1.5)))


def _delta_to_color(delta_c):
    """Warming = red, cooling = blue, near-stable = white. Saturation grows
    with magnitude so small drifts read as washed-out, big drifts pop."""
    a = abs(delta_c)
    sat = max(0.0, min(1.0, a / 2.0))   # 0 at 0, 1 at ±2 °C and beyond
    if delta_c >= 0:
        # red, with white mixed in at low magnitudes
        return (1.0, 0.18 * (1.0 - sat), 0.10 * (1.0 - sat))
    return (0.10 * (1.0 - sat), 0.30 * (1.0 - sat), 1.0)


def _spawn_sparkles(mic_level, t, dt):
    """Maybe add new sparkles based on mic_level. Each frame, with probability
    proportional to mic_level * dt * spawn_rate, spawn at most one."""
    spawn_rate = 30.0 * mic_level         # ~30 sparkles/s when mic saturated
    if spawn_rate <= 0:
        return
    # Probability of at least one in this dt ≈ 1 - exp(-rate*dt); for small
    # dt just use rate*dt linearly.
    if random.random() < spawn_rate * dt:
        led = random.randint(0, NUM_LEDS - 1)
        _comet_state["sparkles"].append((led, t))


def _render_sparkles(buf, t, decay=0.25):
    """Apply active sparkles into the buffer (additive white). Drops expired."""
    alive = []
    for led, spawn_t in _comet_state["sparkles"]:
        age = t - spawn_t
        if age > decay:
            continue
        alive.append((led, spawn_t))
        lvl = (1.0 - age / decay)        # linear fade
        r, g, b = buf[led]
        buf[led] = (min(1.0, r + lvl), min(1.0, g + lvl), min(1.0, b + lvl))
    _comet_state["sparkles"] = alive


def render_comet(strip, temp_c, delta_c, mic_level, t):
    """Δtemp-first ring renderer. See design notes at top of this section.

    delta_c   — temp drift from baseline (°C). Drives spin direction, speed,
                tail length, and color saturation.
    temp_c    — absolute temp (°C). Picks the dim background tint.
    mic_level — 0..1 microphone activity. Spawns brief white sparkles.
    t         — monotonic-ish seconds; must increase between calls.
    """
    s = _comet_state
    last_t = s["last_t"]
    dt = 0.0 if last_t is None else max(0.0, min(0.2, t - last_t))
    s["last_t"] = t

    # --- Δ sign reversal flash ---
    new_sign = 0 if abs(delta_c) < 0.1 else (1 if delta_c > 0 else -1)
    if new_sign != 0 and s["last_sign"] != 0 and new_sign != s["last_sign"]:
        s["flash_until"] = t + 0.30
        s["flash_color"] = _delta_to_color(delta_c)
    s["last_sign"] = new_sign

    # --- accumulate comet position ---
    speed = _delta_to_speed_turns_per_s(delta_c)             # turns/s
    direction = 1.0 if delta_c >= 0 else -1.0                # CW vs CCW
    s["angle"] = (s["angle"] + direction * speed * NUM_LEDS * dt) % NUM_LEDS

    # --- background ring (dim, absolute-temp colored) ---
    bg = _temp_band_color(temp_c)
    bg_lvl = 0.12
    buf = [(bg[0] * bg_lvl, bg[1] * bg_lvl, bg[2] * bg_lvl) for _ in range(NUM_LEDS)]

    # --- comet head + trail ---
    if speed <= 0:
        # Stable: pulse a soft white "alive" indicator on the north LED.
        breathe = 0.35 + 0.25 * math.sin(t * 1.5)
        buf[NORTH_LED] = (breathe, breathe, breathe * 0.95)
    else:
        head_color = _delta_to_color(delta_c)
        tail_len = _delta_to_tail_length(delta_c)
        head_pos = s["angle"]
        for i in range(tail_len):
            # Position along the comet, head at i=0
            pos = (head_pos - direction * i) % NUM_LEDS
            led = int(pos) % NUM_LEDS
            falloff = 1.0 - (i / max(1, tail_len))            # 1.0 head → ~0 tail
            level = falloff ** 1.4                            # nonlinear punch on head
            r, g, b = head_color
            cr, cg, cb = buf[led]
            buf[led] = (min(1.0, cr + r * level),
                        min(1.0, cg + g * level),
                        min(1.0, cb + b * level))

    # --- mic sparkles ---
    _spawn_sparkles(mic_level, t, dt)
    _render_sparkles(buf, t)

    # --- Δ-sign reversal flash overlay ---
    if t < s["flash_until"]:
        remaining = (s["flash_until"] - t) / 0.30           # 1 → 0
        fr, fg, fb = s["flash_color"]
        for i in range(NUM_LEDS):
            cr, cg, cb = buf[i]
            buf[i] = (min(1.0, cr + fr * remaining),
                      min(1.0, cg + fg * remaining),
                      min(1.0, cb + fb * remaining))

    for i, (r, g, b) in enumerate(buf):
        strip.setPixelColor(i, rgb(r, g, b))
    strip.show()
