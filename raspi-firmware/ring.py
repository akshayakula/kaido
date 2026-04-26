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
