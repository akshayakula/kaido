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


def render_comet(strip, _unused, delta_c, mic_level, t):
    """Δtemp-first ring renderer with a constant-state core glow at south
    and a long, smooth comet trail orbiting the ring.

    The comet is *always* present:
      - Stable (|Δ|<0.1 °C): a soft white head sits at north and gently
        breathes, with a faint trail wrapping behind. The south anchor
        glows soft white so the ring is never blank.
      - Warming: comet head turns ember-red and orbits clockwise around
        the ring, with a 4-8 LED smooth-fading tail. The south anchor
        becomes an ember (orange-red), spread + brightness ∝ |Δ|.
      - Cooling: same but counter-clockwise, blue head + icy-cyan anchor.
      - Sign reversal triggers a 300 ms full-ring flash in the new color.

    delta_c   — temp drift from baseline (°C). Drives spin direction,
                speed, trail intensity, color, and the south anchor glow.
    mic_level — 0..1 microphone activity. Spawns brief white sparkles.
    t         — monotonic-ish seconds; must increase between calls.

    The first parameter is kept for call-site compatibility but ignored
    (absolute temp no longer affects the ring per design v3).
    """
    del _unused
    s = _comet_state
    last_t = s["last_t"]
    dt = 0.0 if last_t is None else max(0.0, min(0.2, t - last_t))
    s["last_t"] = t

    # --- Δ sign reversal flash ---
    abs_d = abs(delta_c)
    new_sign = 0 if abs_d < 0.1 else (1 if delta_c > 0 else -1)
    if new_sign != 0 and s["last_sign"] != 0 and new_sign != s["last_sign"]:
        s["flash_until"] = t + 0.30
        s["flash_color"] = _delta_to_color(delta_c)
    s["last_sign"] = new_sign

    # --- comet head moves at speed ∝ |Δ|, even at zero (slow drift) ---
    speed_turns_per_s = max(0.05, _delta_to_speed_turns_per_s(delta_c))
    # Stable: gentle ambient drift; warming: CW; cooling: CCW.
    direction = 1.0 if delta_c >= 0 else -1.0
    if abs_d < 0.1:
        # Park the head at north when stable so the operator has a fixed
        # reference, but let the trail still gently sweep around.
        speed_turns_per_s = 0.08
        direction = 1.0
    s["angle"] = (s["angle"] + direction * speed_turns_per_s * NUM_LEDS * dt) % NUM_LEDS

    buf = [(0.0, 0.0, 0.0) for _ in range(NUM_LEDS)]

    # --- constant-state south anchor glow (always lit) ---
    if abs_d < 0.1:
        breathe = 0.40 + 0.18 * math.sin(t * 1.5)
        anchor = (breathe, breathe, breathe * 0.95)
        spread = 1
    else:
        mag = min(1.0, abs_d / 2.0)
        peak = 0.55 + 0.45 * mag
        if delta_c > 0:
            anchor = (peak, peak * 0.30, peak * 0.05)        # ember
        else:
            anchor = (peak * 0.05, peak * 0.55, peak)        # icy
        spread = 1 + int(round(mag * 3))
    _add(buf, SOUTH_LED, *anchor)
    for d in range(1, spread + 1):
        falloff = (1.0 - d / (spread + 1)) ** 1.4
        for side in (-1, +1):
            led = (SOUTH_LED + side * d) % NUM_LEDS
            _add(buf, led, anchor[0] * falloff * 0.55,
                          anchor[1] * falloff * 0.55,
                          anchor[2] * falloff * 0.55)

    # --- comet head + long smooth trail ---
    # Head color: white when stable, redder/bluer with magnitude.
    if abs_d < 0.1:
        head_color = (0.85, 0.85, 0.95)
    else:
        head_color = _delta_to_color(delta_c)
    # Trail length: 3 LEDs minimum (so it always reads as a comet, not a dot),
    # ramps to nearly the full ring at big Δ. Smooth exponential falloff per
    # step so the trail looks like a fading streak rather than discrete dots.
    base_len = 3
    extra = int(round(min(NUM_LEDS - base_len, abs_d * 2.5)))
    tail_len = base_len + extra
    head_pos = s["angle"]
    head_int = int(head_pos)
    head_frac = head_pos - head_int
    for i in range(tail_len + 1):
        # i=0 is the head pixel; positive i goes opposite direction (trail behind).
        pos_a = (head_int - int(direction) * i) % NUM_LEDS
        pos_b = (head_int - int(direction) * i + int(direction)) % NUM_LEDS
        # Smooth exponential fade — each tail step is ~62% of the previous.
        # Strong head emphasis via the fractional anti-alias.
        falloff = 0.62 ** i
        # Boost the head; softer trail.
        if i == 0:
            falloff *= 1.0
        elif i == 1:
            falloff *= 0.85
        # Anti-alias the head between two pixels for sub-LED smoothness.
        a_lvl = falloff * (1.0 - head_frac if i == 0 else 1.0)
        b_lvl = falloff * (head_frac if i == 0 else 0.0)
        _add(buf, pos_a, head_color[0] * a_lvl, head_color[1] * a_lvl, head_color[2] * a_lvl)
        if b_lvl > 0:
            _add(buf, pos_b, head_color[0] * b_lvl, head_color[1] * b_lvl, head_color[2] * b_lvl)

    # --- mic sparkles ---
    _spawn_sparkles(mic_level, t, dt)
    _render_sparkles(buf, t)

    # --- Δ-sign reversal flash overlay ---
    if t < s["flash_until"]:
        remaining = (s["flash_until"] - t) / 0.30
        fr, fg, fb = s["flash_color"]
        for i in range(NUM_LEDS):
            _add(buf, i, fr * remaining, fg * remaining, fb * remaining)

    for i, (r, g, b) in enumerate(buf):
        strip.setPixelColor(i, rgb(r, g, b))
    strip.show()


# ---------------------------------------------------------------------------
# Volcano / rain — Δtemp-only renderer.
#
# Origin is the south LED (opposite north). On warming, particles erupt
# outward from south, traveling along both arcs of the ring toward north
# where they dissipate. On cooling, particles "rain" inward from north
# back toward south. Spawn rate and travel speed both scale with |Δ|.
# Stable mode shows a single soft breathing white LED at north.
# ---------------------------------------------------------------------------

SOUTH_LED = (NORTH_LED + NUM_LEDS // 2) % NUM_LEDS  # = 8 on a 16-LED ring
ARC_LEN   = NUM_LEDS // 2                            # 8 steps from origin → far side

# (distance_from_origin, age_s, side: -1 CCW / +1 CW, lane: "out" or "in")
_volcano_state = {
    "last_t": None,
    "particles": [],
    "spawn_acc": 0.0,           # fractional spawns carried across frames
    "last_sign": 0,
    "flash_until": 0.0,
    "flash_color": (0.0, 0.0, 0.0),
    "sparkles": [],
}


def _delta_to_spawn_rate(delta_c):
    """Particles per second per side. 0 below the dead zone, ramps up
       steeply with |Δ|, capped so the ring stays readable."""
    a = abs(delta_c)
    if a < 0.1:
        return 0.0
    return min(8.0, a * 2.5)


def _delta_to_speed(delta_c):
    """LED-units / second a particle travels."""
    a = abs(delta_c)
    return min(16.0, max(2.0, a * 4.0))


def _warming_color(progress):
    """Particle color while erupting outward. progress=0 at origin (white-hot
       core), 1 at the rim (deep red, fading). Gives a fire/lava vibe."""
    # white-hot → yellow → orange → red
    if progress < 0.25:
        k = progress / 0.25
        return (1.0, 1.0 - 0.1 * k, 0.85 - 0.45 * k)
    if progress < 0.6:
        k = (progress - 0.25) / 0.35
        return (1.0, 0.9 - 0.5 * k, 0.4 - 0.4 * k)
    k = (progress - 0.6) / 0.4
    return (1.0 - 0.15 * k, 0.4 - 0.35 * k, 0.0)


def _cooling_color(progress):
    """Particle color while raining inward. progress=0 at the rim (icy white),
       1 at origin (deep cobalt). Frost/water vibe."""
    if progress < 0.25:
        k = progress / 0.25
        return (1.0 - 0.4 * k, 1.0 - 0.2 * k, 1.0)
    if progress < 0.6:
        k = (progress - 0.25) / 0.35
        return (0.6 - 0.5 * k, 0.8 - 0.5 * k, 1.0)
    k = (progress - 0.6) / 0.4
    return (0.1 - 0.1 * k, 0.3 - 0.25 * k, 1.0 - 0.15 * k)


def _add(buf, led, r, g, b):
    cr, cg, cb = buf[led]
    buf[led] = (min(1.0, cr + r), min(1.0, cg + g), min(1.0, cb + b))


def render_volcano(strip, delta_c, mic_level, t):
    """Δtemp-first ring renderer. Pure delta — no absolute-temp tint.

    Warming → particles erupt south→north along both arcs (lava).
    Cooling → particles rain north→south inward (frost).
    Stable → single dim breathing white LED at north.

    delta_c   — temp drift from baseline (°C). Drives spawn rate, speed,
                travel direction, and particle color.
    mic_level — 0..1 microphone activity. Spawns brief white sparkles.
    t         — monotonic seconds; must increase between calls.
    """
    s = _volcano_state
    last_t = s["last_t"]
    dt = 0.0 if last_t is None else max(0.0, min(0.2, t - last_t))
    s["last_t"] = t

    # --- Δ sign reversal flash (blanks any in-flight particles) ---
    new_sign = 0 if abs(delta_c) < 0.1 else (1 if delta_c > 0 else -1)
    if new_sign != 0 and s["last_sign"] != 0 and new_sign != s["last_sign"]:
        s["flash_until"] = t + 0.30
        s["flash_color"] = (1.0, 0.6, 0.2) if new_sign > 0 else (0.4, 0.7, 1.0)
        s["particles"] = []  # clear stale particles from the old direction
        s["spawn_acc"] = 0.0
    s["last_sign"] = new_sign

    speed = _delta_to_speed(delta_c)            # LED-units/sec
    spawn_per_sec = _delta_to_spawn_rate(delta_c)  # per side

    # --- spawn new particles (CW + CCW symmetrically) ---
    if spawn_per_sec > 0 and dt > 0:
        s["spawn_acc"] += spawn_per_sec * dt
        while s["spawn_acc"] >= 1.0:
            s["spawn_acc"] -= 1.0
            for side in (+1, -1):
                # warming: start at distance 0; cooling: start at distance ARC_LEN
                start_dist = 0.0 if delta_c > 0 else float(ARC_LEN)
                s["particles"].append([start_dist, 0.0, side])

    # --- advance + render particles ---
    buf = [(0.0, 0.0, 0.0) for _ in range(NUM_LEDS)]
    alive = []
    for p in s["particles"]:
        dist, age, side = p
        # outward (warming) increases dist; inward (cooling) decreases
        if delta_c > 0:
            dist += speed * dt
            if dist >= ARC_LEN + 0.5:
                continue
            progress = dist / ARC_LEN
            cr, cg, cb = _warming_color(min(1.0, progress))
        else:
            dist -= speed * dt
            if dist <= -0.5:
                continue
            progress = 1.0 - (dist / ARC_LEN)
            cr, cg, cb = _cooling_color(min(1.0, max(0.0, progress)))
        age += dt

        # Brightness: bright at "fresh" end, fades along the path. Combined
        # with a head/tail soft anti-aliased deposit so the particle reads as
        # a glowing blob spanning ~2 LEDs rather than a hard pixel jump.
        body_lvl = max(0.0, 1.0 - progress * 0.85)
        head_int = math.floor(dist)
        frac = dist - head_int
        # head pixel
        led_a = (SOUTH_LED + side * head_int) % NUM_LEDS
        _add(buf, led_a, cr * body_lvl * (1.0 - frac), cg * body_lvl * (1.0 - frac), cb * body_lvl * (1.0 - frac))
        # next pixel along the path
        led_b = (SOUTH_LED + side * (head_int + 1)) % NUM_LEDS
        _add(buf, led_b, cr * body_lvl * frac, cg * body_lvl * frac, cb * body_lvl * frac)
        # short trail behind
        for back in range(1, 3):
            tail_dist = head_int - back
            if 0 <= tail_dist <= ARC_LEN:
                tail_lvl = body_lvl * (0.55 / back)
                led_t = (SOUTH_LED + side * tail_dist) % NUM_LEDS
                _add(buf, led_t, cr * tail_lvl, cg * tail_lvl, cb * tail_lvl)

        p[0], p[1] = dist, age
        alive.append(p)
    s["particles"] = alive

    # --- constant-state core glow centered on south ---
    # The south origin is *always* lit. Its color shows direction
    # (white when stable, warming-orange when Δ>0, cooling-cyan when Δ<0)
    # and its brightness + spread along ±arc grows with |Δ| so the ring
    # always reads "this device is alive AND here's the current trend"
    # even when no particles are in flight.
    abs_d = abs(delta_c)
    if abs_d < 0.1:
        # Stable: gentle white breathing core; tiny halo on adjacent LEDs.
        breathe = 0.40 + 0.18 * math.sin(t * 1.5)
        core_r, core_g, core_b = breathe, breathe, breathe * 0.95
        spread = 1
    else:
        # Mag 0 → 1 over ±2 °C, clamped — controls brightness AND halo width.
        mag = min(1.0, abs_d / 2.0)
        peak = 0.55 + 0.45 * mag                # 0.55 → 1.00
        if delta_c > 0:
            core_r, core_g, core_b = peak, peak * 0.30, peak * 0.05  # ember
        else:
            core_r, core_g, core_b = peak * 0.05, peak * 0.55, peak  # icy cyan
        spread = 1 + int(round(mag * 3))        # 1..4 LEDs each side

    _add(buf, SOUTH_LED, core_r, core_g, core_b)
    for d in range(1, spread + 1):
        falloff = (1.0 - d / (spread + 1)) ** 1.4
        for side in (-1, +1):
            led = (SOUTH_LED + side * d) % NUM_LEDS
            _add(buf, led, core_r * falloff * 0.55, core_g * falloff * 0.55, core_b * falloff * 0.55)

    # --- mic sparkles (additive white) ---
    rate = 30.0 * mic_level
    if rate > 0 and dt > 0 and random.random() < rate * dt:
        s["sparkles"].append((random.randint(0, NUM_LEDS - 1), t))
    fresh_sparkles = []
    for led, spawn_t in s["sparkles"]:
        age = t - spawn_t
        if age >= 0.25:
            continue
        fresh_sparkles.append((led, spawn_t))
        lvl = 1.0 - age / 0.25
        _add(buf, led, lvl, lvl, lvl)
    s["sparkles"] = fresh_sparkles

    # --- Δ-sign reversal flash overlay ---
    if t < s["flash_until"]:
        remaining = (s["flash_until"] - t) / 0.30
        fr, fg, fb = s["flash_color"]
        for i in range(NUM_LEDS):
            _add(buf, i, fr * remaining, fg * remaining, fb * remaining)

    for i, (r, g, b) in enumerate(buf):
        strip.setPixelColor(i, rgb(r, g, b))
    strip.show()
