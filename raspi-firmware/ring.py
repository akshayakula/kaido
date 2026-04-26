#!/usr/bin/env python3
# NeoPixel rendering primitives for the load-monitor firmware.
# Hardware: SK6812 RGBW 16-pixel ring on GPIO 18 (PWM0).
import math

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
