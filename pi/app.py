#!/usr/bin/env python3
"""
========================================================
 PIG MONITORING SYSTEM - RASPBERRY PI 4 (runs EVERYTHING, no main ESP32)
========================================================
 VISION  : ESP32-CAM on USB (serial) -> YOLOv8 pig/piglet model (models/best.onnx)
           -> moving / resting tracking -> Supabase Storage "snap":
              live_0.jpg / live_1.jpg (alternating) + live.json (detections)
 AUDIO   : INMP441 mic (I2S) listened to NON-STOP -> every 1s checked by
           models/pig_audio.onnx (cough / stress / normal / feeding / cleaning)
           -> every audio_interval_seconds: 5s clip -> Storage "audio/periodic_sound.wav"
              + summary row in audio_detections
 SENSORS : MLX90614 (I2C) ambient + floor temperature
 RELAYS  : heating bulb + water solenoid, controlled from Supabase settings
 LOGS    : sensor_logs row every sync_interval_seconds (temps, noise dB, motion from camera)
 HEALTH  : system_settings -> pi_status + cam_status

 WIRING (Raspberry Pi 4, physical pin numbers):
   MLX90614   VIN->1 (3.3V)  GND->9   SDA->3 (GPIO2)   SCL->5 (GPIO3)
   INMP441    VDD->17 (3.3V) GND->14  L/R->20 (GND)
              SCK->12 (GPIO18)  WS->35 (GPIO19)  SD->38 (GPIO20)
   Relay      VCC->2 (5V)    GND->6   IN1 (bulb)->11 (GPIO17)  IN2 (solenoid)->13 (GPIO27)
              (if the relay won't switch OFF: remove the JD-VCC jumper,
               VCC->1 (3.3V) and JD-VCC->2 (5V))
   ESP32-CAM  on the ESP32-CAM-MB board -> any USB port

 /boot/firmware/config.txt (install.sh adds these, then reboot):
   dtparam=i2c_arm=on
   dtparam=i2c_arm_baudrate=50000
   dtparam=i2s=on
   dtoverlay=googlevoicehat-soundcard
   gpio=17,27=op,dh          <- relays OFF from the moment the Pi powers on

 Settings read from system_settings (change them on the website):
   bulb_mode on/off/auto   bulb_start_hour / bulb_end_hour
   solenoid_mode on/off/auto   solenoid_trigger_temp
     (heat protection: in off/auto, >= trigger -> water 10 min ON / 2 min wait, repeat until cool)
   sync_interval_seconds   audio_interval_seconds
   cam_live_enabled   cam_live_interval_seconds   cam_flash off/on/night
   audio_threshold 0.30-0.95 (default 0.60)   audio_min_db 30-90 (default 50)
   cough_alert_min 1-10 (default 2)   audio_ref_db -30..-6 (default -18)
   sms_enabled  sms_interval_minutes  sms_on_heat  sms_on_no_motion  sms_no_motion_minutes
   sms_motion_start_hour / sms_motion_end_hour  sms_on_audio  sms_send_recovery  sms_test_request

 SMS (Semaphore): put the API key ONLY on the Pi, in /home/vid/vid/.env (never in Supabase):
        SEMAPHORE_API_KEY=your_key
        SEMAPHORE_SENDER=YourSenderName      (optional, else your default Sender Name)
   Recipients = active rows in the contacts table. Every SMS is logged in sms_logs.

 Test an audio file with the exact same cough logic (no mic / Supabase needed):
        python app.py --test-audio some_clip.wav

 Run:   python app.py                (everything)
        python app.py --no-vision    (no camera)
        python app.py --no-audio     (no mic)
========================================================
"""

import argparse
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import glob
import io
import json
import logging
import math
import os
import queue
import re
import signal
import subprocess
import sys
import threading
import time
import wave
from datetime import datetime
from pathlib import Path

import numpy as np
import onnxruntime as ort
import requests
import serial
from PIL import Image

# ========================================================
# --- CONFIG ---
# ========================================================
BASE_DIR = Path(__file__).resolve().parent

DEFAULT_SUPABASE_URL = "https://rembfnigpvtuxoyjjexf.supabase.co"
DEFAULT_SUPABASE_KEY = (
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJlbWJmbmlncHZ0dXhveWpqZXhmIiwicm9sZSI6"
    "ImFub24iLCJpYXQiOjE3ODg2NDUzMTksImV4cCI6MjEwNDIyMTMxOX0.HIZvxN9LRPQl_9vh-bY1rqaMbh2mHhvGWIqZrR9ZftA"
)

# Relays (BCM GPIO numbers, active-LOW module)
RELAY_BULB_GPIO = 17       # physical pin 11
RELAY_SOLENOID_GPIO = 27   # physical pin 13
SOLENOID_HYSTERESIS = 1.0  # heat is "over" below trigger - 1.0 C
# Heat protection: works in EVERY mode (even solenoid_mode=off, even without internet)
COOL_SPRAY_S = 10 * 60     # solenoid ON for 10 min
COOL_WAIT_S = 2 * 60       # then OFF 2 min so the sensor reads dry air/floor, then check again
COOL_WARN_CYCLES = 4       # still hot after this many cycles -> warning every cycle (keeps cooling)
COOL_SENSOR_LOST_S = 30    # no temperature for 30s -> close the solenoid (fail-safe)
TEMP_VALID = (-10.0, 85.0) # readings outside this = sensor glitch, ignored
DEFAULT_TRIGGER_C = 38.0   # used when Supabase settings never loaded

# MLX90614
MLX_BUS = 1
MLX_ADDR = 0x5A

# Camera (USB serial)
CAM_PORT = os.getenv("CAM_PORT", "auto")       # e.g. /dev/ttyUSB0, or "auto"
CAM_BAUD = 921600
CAM_FAILS_BEFORE_RECONNECT = 3
MAX_JPEG = 400_000

# Live feed / vision
SNAP_BUCKET = "snap"
LIVE_JSON = "live.json"
LIVE_SLOTS = ("live_0.jpg", "live_1.jpg")
LEGACY_LIVE_JPG = "live.jpg"           # old website version reads this
DEFAULT_LIVE_INTERVAL = 3          # seconds between frames
MIN_LIVE_INTERVAL = 2              # Pi 4 needs ~1s per frame for YOLO
VISION_CONF = float(os.getenv("VISION_CONF", "0.25"))
VISION_IOU = 0.45
VISION_MAX_DET = 25
NIGHT_START, NIGHT_END = 18, 6     # cam_flash = night (Pi local time)
TRACK_RESET_GAP_S = 30             # forget old tracks after a long pause

# Audio (mic)
MIC_DEVICE = os.getenv("MIC_DEVICE", "auto")   # e.g. plughw:CARD=sndrpigooglevoi,DEV=0
MIC_RATE = 48000                   # captured at 48k (I2S overlay), down-sampled to 16k
MIC_BLOCK = 4800                   # 100ms per read (multiple of 3)
AUDIO_GAIN = float(os.getenv("AUDIO_GAIN", "4.0"))   # same 4x the ESP32 used
AUDIO_THRESHOLD = float(os.getenv("AUDIO_THRESHOLD", "0.60"))   # default, Supabase audio_threshold overrides
AUDIO_MIN_DB = float(os.getenv("AUDIO_MIN_DB", "50"))           # default, Supabase audio_min_db overrides
AUDIO_ABOVE_BG_DB = 8.0     # a sound must be this much louder than the barn's usual background
AUDIO_BG_MAX_DB = 65.0      # learned background never counts above this (so the AI always checks >73 dB)
AUDIO_CONFIRM = 2           # cough/stress must show in 2 of the last 3 checks (~1.5s)
AUDIO_COOLDOWN_S = 2.0      # one event per burst
AUDIO_CLIP_SECONDS = 5
AUDIO_BUCKET = "audio"
AUDIO_OBJECT = "periodic_sound.wav"
AUDIO_CLASSES = [
    "Coughing / Sneezing",   # 0
    "Stress / Disputes",     # 1
    "Normal Pig Sounds",     # 2
    "Feeding Activity",      # 3
    "Cleaning / Activity",   # 4
]
SAMPLE_RATE = 16000
N_FFT, HOP, N_MELS = 1024, 512, 64

# Cough refinement (the website's Audio Tester uses the SAME numbers: src/lib/coughDetector.ts)
AUDIO_REF_DBFS = float(os.getenv("AUDIO_REF_DBFS", "-18"))  # every 1s window is leveled to this before the AI
LEVEL_SET_DB = (-4.0, 0.0, 4.0)        # cough check runs at 3 loudness levels around the reference...
COUGH_SHIFTS_S = (-0.15, 0.0, 0.15)    # ...and 3 positions around the cough's peak -> 9 checks averaged
COUGH_MARGIN = 0.10                    # cough must beat every other class by this much
COUGH_DEDUP_S = 0.30                   # 2 peaks closer than this = the same cough
COUGH_ALERT_MIN = 2                    # coughs in one audio_interval before "ATTENTION NEEDED"
ENV_FRAME = 160                        # 10 ms loudness frames for the cough shape check
COUGH_PROMINENCE_DB = 9.0              # peak must stick out of its surroundings
COUGH_RISE_MAX_MS = 80                 # coughs are explosive (fast attack)
COUGH_DUR_MIN_MS, COUGH_DUR_MAX_MS = 50, 700   # short burst, not a long squeal / machine
COUGH_PAD = int(SAMPLE_RATE * (0.56 + max(COUGH_SHIFTS_S)))   # audio needed each side of a peak

# Local dashboard (open http://<pi-ip>:8080)
DASH_PORT = int(os.getenv("DASH_PORT", "8080"))

# Timing
SETTINGS_EVERY_S = 10
STATUS_EVERY_S = 60

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(threadName)s] %(message)s",
    stream=sys.stdout,
)
log = logging.getLogger("pigmonitor")

stop_event = threading.Event()


# ========================================================
# --- SUPABASE ---
# ========================================================
def read_env(name, default=""):
    """Environment variable, else KEY=value from .env next to app.py (or one folder up)."""
    v = os.getenv(name)
    if v:
        return v.strip()
    for env_file in (BASE_DIR / ".env", BASE_DIR.parent / ".env"):
        if not env_file.exists():
            continue
        for line in env_file.read_text(encoding="utf-8", errors="ignore").splitlines():
            line = line.strip()
            if "=" in line and not line.startswith("#"):
                k, val = line.split("=", 1)
                if k.strip() == name:
                    return val.strip().strip('"').strip("'")
    return default


def load_supabase_config():
    url = os.getenv("SUPABASE_URL")
    key = os.getenv("SUPABASE_KEY")
    for env_file in (BASE_DIR / ".env", BASE_DIR.parent / ".env"):
        if (url and key) or not env_file.exists():
            continue
        for line in env_file.read_text(encoding="utf-8", errors="ignore").splitlines():
            line = line.strip()
            if "=" not in line or line.startswith("#"):
                continue
            k, v = line.split("=", 1)
            k, v = k.strip(), v.strip().strip('"').strip("'")
            if k in ("SUPABASE_URL", "VITE_SUPABASE_URL") and not url:
                url = v
            elif k in ("SUPABASE_KEY", "SUPABASE_ANON_KEY", "VITE_SUPABASE_ANON_KEY") and not key:
                key = v
    return (url or DEFAULT_SUPABASE_URL).rstrip("/"), (key or DEFAULT_SUPABASE_KEY)


class Supabase:
    """One instance per thread (requests.Session is not thread-safe)."""

    def __init__(self, url, key):
        self.url = url
        self.s = requests.Session()
        self.s.headers.update({"apikey": key, "Authorization": f"Bearer {key}"})

    def select(self, table, params):
        r = self.s.get(f"{self.url}/rest/v1/{table}", params=params, timeout=10)
        r.raise_for_status()
        return r.json()

    def insert(self, table, row):
        r = self.s.post(
            f"{self.url}/rest/v1/{table}",
            json=row,
            headers={"Prefer": "return=minimal"},
            timeout=10,
        )
        if r.status_code not in (200, 201):
            raise requests.RequestException(f"insert {table}: HTTP {r.status_code} {r.text[:200]}")

    def insert_returning_id(self, table, row):
        r = self.s.post(
            f"{self.url}/rest/v1/{table}",
            params={"select": "id"},
            json=row,
            headers={"Prefer": "return=representation"},
            timeout=10,
        )
        if r.status_code not in (200, 201):
            raise requests.RequestException(f"insert {table}: HTTP {r.status_code} {r.text[:200]}")
        rows = r.json()
        return rows[0]["id"] if rows else None

    def set_setting(self, key, value):
        r = self.s.patch(
            f"{self.url}/rest/v1/system_settings",
            params={"setting_key": f"eq.{key}"},
            json={"setting_value": value},
            headers={"Prefer": "return=representation"},
            timeout=10,
        )
        if r.status_code not in (200, 204):
            raise requests.RequestException(f"setting {key}: HTTP {r.status_code} {r.text[:200]}")
        if r.status_code == 200 and r.text.strip() in ("", "[]"):
            self.insert("system_settings", {"setting_key": key, "setting_value": value})   # row was missing

    def upload(self, bucket, path, data, content_type):
        r = self.s.post(
            f"{self.url}/storage/v1/object/{bucket}/{path}",
            data=data,
            headers={
                "Content-Type": content_type,
                "x-upsert": "true",
                "cache-control": "max-age=0",
            },
            timeout=20,
        )
        if r.status_code != 200:
            raise requests.RequestException(f"upload {path}: HTTP {r.status_code} {r.text[:200]}")

    def public_url(self, bucket, path):
        return f"{self.url}/storage/v1/object/public/{bucket}/{path}?t={int(time.time())}"


# ========================================================
# --- SETTINGS (all from Supabase) ---
# ========================================================
# key -> (attribute, kind, default, min/options, max)
# SAME keys / defaults / limits as the website (src/lib/settingsSpec.ts) and supabase_pi_setup.sql.
# A missing or invalid value -> the default (exactly what the website shows).
SETTINGS_SPEC = {
    # relays
    "bulb_mode":                 ("bulb_mode", "enum", "off", ("auto", "on", "off"), None),
    "bulb_start_hour":           ("bulb_start_hour", "int", 18, 0, 23),
    "bulb_end_hour":             ("bulb_end_hour", "int", 6, 0, 23),
    "solenoid_mode":             ("solenoid_mode", "enum", "off", ("auto", "on", "off"), None),
    "solenoid_trigger_temp":     ("solenoid_trigger_temp", "float", 38.0, 25.0, 45.0),
    # camera
    "cam_live_enabled":          ("live_enabled", "bool", True, None, None),
    "cam_live_interval_seconds": ("live_interval", "int", DEFAULT_LIVE_INTERVAL, MIN_LIVE_INTERVAL, 60),
    "cam_flash":                 ("flash", "enum", "off", ("off", "on", "night"), None),
    # audio AI
    "audio_threshold":           ("audio_threshold", "float", AUDIO_THRESHOLD, 0.30, 0.95),
    "audio_min_db":              ("audio_min_db", "float", AUDIO_MIN_DB, 30.0, 90.0),
    "cough_alert_min":           ("cough_alert_min", "int", COUGH_ALERT_MIN, 1, 10),
    "audio_ref_db":              ("audio_ref_db", "float", AUDIO_REF_DBFS, -30.0, -6.0),
    # timing
    "sync_interval_seconds":     ("sync_interval", "int", 15, 5, 3600),
    "audio_interval_seconds":    ("audio_interval", "int", 60, 10, 3600),
    # SMS alerts
    "sms_enabled":               ("sms_enabled", "bool", False, None, None),
    "sms_interval_minutes":      ("sms_interval_minutes", "int", 10, 1, 1440),
    "sms_on_heat":               ("sms_on_heat", "bool", True, None, None),
    "sms_on_no_motion":          ("sms_on_no_motion", "bool", True, None, None),
    "sms_no_motion_minutes":     ("sms_no_motion_minutes", "int", 120, 10, 1440),
    "sms_motion_start_hour":     ("sms_motion_start_hour", "int", 6, 0, 23),
    "sms_motion_end_hour":       ("sms_motion_end_hour", "int", 18, 0, 23),
    "sms_on_audio":              ("sms_on_audio", "bool", True, None, None),
    "sms_send_recovery":         ("sms_send_recovery", "bool", True, None, None),
}


def parse_setting(key, raw):
    """Returns the cleaned value, or None if invalid (same rules as validateSetting() on the website)."""
    _, kind, _, lo, hi = SETTINGS_SPEC[key]
    v = str(raw if raw is not None else "").strip().lower()
    if kind == "enum":
        return v if v in lo else None
    if kind == "bool":
        if v in ("true", "1", "on", "yes"):
            return True
        if v in ("false", "0", "off", "no"):
            return False
        return None
    try:
        n = float(v)
    except ValueError:
        return None
    if key == "audio_threshold" and n > 1:      # "60" -> 0.6
        n /= 100.0
    if not lo <= n <= hi:
        return None
    if kind == "int":
        return int(n) if n == int(n) else None
    return n


class Settings:
    def __init__(self):
        self.loaded = False            # True once the first settings fetch worked
        for key, (attr, _, default, _, _) in SETTINGS_SPEC.items():
            setattr(self, attr, default)

    def apply(self, rows):
        values = {r.get("setting_key"): r.get("setting_value") for r in rows}
        bad = []
        for key, (attr, _, default, _, _) in SETTINGS_SPEC.items():
            if key not in values:
                setattr(self, attr, default)
                continue
            v = parse_setting(key, values[key])
            if v is None:
                bad.append(f"{key}={values[key]!r}")
                v = default
            setattr(self, attr, v)
        if bad and bad != getattr(self, "_last_bad", None):
            log.warning("Invalid settings -> using defaults for: %s", ", ".join(bad))
        self._last_bad = bad
        if not self.loaded:
            self.loaded = True
            log.info("Settings loaded from Supabase: bulb=%s solenoid=%s (trigger %.1fC)",
                     self.bulb_mode, self.solenoid_mode, self.solenoid_trigger_temp)

    def flash_now(self):
        if self.flash == "on":
            return True
        if self.flash == "night":
            h = datetime.now().hour
            return h >= NIGHT_START or h < NIGHT_END
        return False


settings = Settings()


def find_model(name):
    for p in (BASE_DIR / "models" / name, BASE_DIR.parent / "public" / "models" / name, BASE_DIR / name):
        if p.exists():
            return p
    sys.exit(f"[ERROR] Model '{name}' not found. Put it in {BASE_DIR / 'models'}")


def make_session(path, threads):
    so = ort.SessionOptions()
    so.intra_op_num_threads = threads
    so.inter_op_num_threads = 1
    return ort.InferenceSession(str(path), so, providers=["CPUExecutionProvider"])


# ========================================================
# --- MLX90614 TEMPERATURE SENSOR (I2C) ---
# ========================================================
class MLX90614:
    REG_AMBIENT = 0x06
    REG_OBJECT = 0x07

    def __init__(self):
        from smbus2 import SMBus
        self.bus = SMBus(MLX_BUS)

    def _read(self, reg, low, high):
        for _ in range(3):
            try:
                raw = self.bus.read_word_data(MLX_ADDR, reg)
                if raw & 0x8000:          # error flag from the sensor
                    raise OSError("MLX error flag")
                temp = raw * 0.02 - 273.15
                if low <= temp <= high:
                    return round(temp, 2)
            except OSError:
                pass
            time.sleep(0.05)
        return None

    def ambient(self):
        return self._read(self.REG_AMBIENT, -40, 125)

    def floor(self):
        return self._read(self.REG_OBJECT, -70, 380)


# ========================================================
# --- RELAYS (GPIO, active-LOW) ---
# ========================================================
class Relays:
    def __init__(self):
        self.bulb_on = False
        self.solenoid_on = False
        self.ok = False
        try:
            from gpiozero import OutputDevice
            # active_high=False -> on() drives the pin LOW (relay ON), off() drives it HIGH
            self.bulb = OutputDevice(RELAY_BULB_GPIO, active_high=False, initial_value=False)
            self.solenoid = OutputDevice(RELAY_SOLENOID_GPIO, active_high=False, initial_value=False)
            self.ok = True
        except Exception as e:
            log.error("Relays not available (%s) -> relay control disabled", e)

    def set(self, bulb_on, solenoid_on):
        if not self.ok:
            return
        if bulb_on != self.bulb_on:
            self.bulb.value = bulb_on
            self.bulb_on = bulb_on
            log.info("[RELAY] Heating bulb -> %s", "ON" if bulb_on else "OFF")
            live.event("info", f"Heating bulb {'ON' if bulb_on else 'OFF'}")
        if solenoid_on != self.solenoid_on:
            self.solenoid.value = solenoid_on
            self.solenoid_on = solenoid_on
            log.info("[RELAY] Water solenoid -> %s", "ON" if solenoid_on else "OFF")
            live.event("info", f"Water solenoid {'ON' if solenoid_on else 'OFF'}")

    def all_off(self):
        if self.ok:
            self.bulb.value = False
            self.solenoid.value = False
            self.bulb_on = self.solenoid_on = False


# ========================================================
# --- SMS ALERTS (Semaphore) ---
# ========================================================
SEMAPHORE_URL = "https://api.semaphore.co/api/v4/messages"
SMS_CAMERA_FRESH_S = 60        # camera frame older than this -> "not moving" check paused


def normalize_ph_number(raw):
    """'+63 912 345 6789' / '0912-345-6789' / '9123456789' -> '09123456789' (None if not a PH mobile)."""
    d = re.sub(r"\D", "", str(raw or ""))
    if d.startswith("63") and len(d) == 12:
        d = "0" + d[2:]
    elif d.startswith("9") and len(d) == 10:
        d = "0" + d
    return d if d.startswith("09") and len(d) == 11 else None


class SmsWorker(threading.Thread):
    """Sends queued SMS in the background (slow internet never delays the relays) + logs to sms_logs."""

    def __init__(self, sb_url, sb_key):
        super().__init__(name="sms", daemon=True)
        self.sb = Supabase(sb_url, sb_key)
        self.http = requests.Session()
        self.queue = queue.Queue(maxsize=50)
        self.api_key = read_env("SEMAPHORE_API_KEY")
        self.sender = read_env("SEMAPHORE_SENDER")
        self.sent = self.failed = 0
        self.last = "none"
        if not self.api_key:
            log.warning("[SMS] No SEMAPHORE_API_KEY in .env -> SMS alerts can't be sent")

    def send(self, kind, message):
        try:
            self.queue.put_nowait((kind, message))
        except queue.Full:
            log.warning("[SMS] queue full, dropped: %s", message)

    def status_text(self):
        return f"sms={'ready' if self.api_key else 'NO_KEY'} sent={self.sent} failed={self.failed} last={self.last}"

    def run(self):
        while not stop_event.is_set():
            try:
                kind, message = self.queue.get(timeout=1.0)
            except queue.Empty:
                continue
            self._deliver(kind, message)

    def _deliver(self, kind, message):
        numbers, status, error, response = [], "failed", None, None
        try:
            if not self.api_key:
                raise RuntimeError("no SEMAPHORE_API_KEY on the Pi")
            rows = self.sb.select("contacts", {"select": "name,phone_number", "is_active": "eq.true"})
            bad = [r.get("phone_number") for r in rows if not normalize_ph_number(r.get("phone_number"))]
            numbers = sorted({n for n in (normalize_ph_number(r.get("phone_number")) for r in rows) if n})
            if bad:
                log.warning("[SMS] skipped invalid numbers: %s", ", ".join(map(str, bad)))
            if not numbers:
                raise RuntimeError("no active contacts with a valid PH mobile number")
            data = {"apikey": self.api_key, "number": ",".join(numbers), "message": message}
            if self.sender:
                data["sendername"] = self.sender
            r = self.http.post(SEMAPHORE_URL, data=data, timeout=20)
            response = r.text[:500]
            if r.status_code != 200:
                raise RuntimeError(f"Semaphore HTTP {r.status_code}: {r.text[:200]}")
            body = r.json()
            items = body if isinstance(body, list) else [body]
            if not items or not any(isinstance(i, dict) and i.get("message_id") for i in items):
                raise RuntimeError(f"Semaphore did not accept it: {r.text[:200]}")
            status = "sent"
            self.sent += 1
            log.info("[SMS] %s -> %d contact(s): %s", kind, len(numbers), message)
        except (requests.RequestException, RuntimeError, ValueError) as e:
            error = str(e)[:300]
            self.failed += 1
            log.warning("[SMS] %s FAILED: %s", kind, error)
        self.last = f"{kind}:{status}@{datetime.now().strftime('%H:%M')}"
        live.event("alert" if status == "failed" else "info", f"SMS {kind} {status}" + (f": {error}" if error else ""))
        try:
            self.sb.insert("sms_logs", {"alert_type": kind, "message": message, "numbers": ",".join(numbers),
                                        "status": status, "error": error, "provider_response": response})
        except requests.RequestException as e:
            log.warning("[SMS] log upload failed: %s", e)


class SmsAlerts:
    """
    Decides WHEN to text (runs in the main loop every second, no network here).
      heat      : hottest of ambient/floor >= solenoid_trigger_temp
      no_motion : camera sees pigs but none moved for sms_no_motion_minutes,
                  only between sms_motion_start_hour and sms_motion_end_hour (pigs sleep at night)
      audio     : the audio AI summary says ATTENTION NEEDED (coughs / stress)
    While a problem lasts it re-sends every sms_interval_minutes (per alert type).
    sms_send_recovery -> one "back to normal" SMS when heat / no_motion clears.
    sms_test_request changed on the website -> test SMS (works even when sms_enabled is off).
    """

    def __init__(self, worker):
        self.worker = worker
        self.last_sent = {}               # kind -> time
        self.active = {}                  # kind -> True while the problem lasts (for recovery SMS)
        self.last_motion = time.time()
        self.test_seen = None

    @staticmethod
    def _stamp():
        return datetime.now().strftime("%I:%M%p").lstrip("0").lower()

    def _due(self, kind, now):
        return now - self.last_sent.get(kind, 0.0) >= settings.sms_interval_minutes * 60

    def _alert(self, kind, now, message):
        self.active[kind] = True
        if settings.sms_enabled and self._due(kind, now):
            self.last_sent[kind] = now
            self.worker.send(kind, message)

    def _clear(self, kind, message):
        if self.active.pop(kind, False):
            self.last_sent.pop(kind, None)
            if settings.sms_enabled and settings.sms_send_recovery:
                self.worker.send(kind + "_ok", message)

    def check_test(self, rows_value):
        if rows_value is None:
            return
        if self.test_seen is None:            # first read after start: don't send old requests
            self.test_seen = rows_value
            return
        if rows_value != self.test_seen:
            self.test_seen = rows_value
            self.worker.send("test", f"Pig Monitor: SMS alerts are working. You will get alerts here. {self._stamp()}")

    def tick(self, ambient, floor, logic, vision):
        now = time.time()
        temps = [t for t in (ambient, floor) if RelayLogic._valid(t)]
        peak = max(temps) if temps else None
        trig = logic.trigger()

        # --- heat ---
        if settings.sms_on_heat and peak is not None and peak >= trig:
            cooling = "water ON" if logic.phase == "spraying" else "re-checking" if logic.phase == "waiting" else "starting"
            warn = " NOT COOLING DOWN, check pigs/water!" if logic.cycles > COOL_WARN_CYCLES else ""
            self._alert("heat", now, f"PIG ALERT: HEAT {peak:.1f}C (limit {trig:.0f}C). "
                                     f"Cooling {cooling}, cycle {max(1, logic.cycles)}.{warn} {self._stamp()}")
        elif peak is not None and peak < trig - SOLENOID_HYSTERESIS:
            self._clear("heat", f"Pig Monitor OK: temperature back to {peak:.1f}C. {self._stamp()}")

        # --- pigs not moving ---
        cam_ok = bool(vision) and now - vision.last_frame_time < SMS_CAMERA_FRESH_S
        if cam_ok and vision.moving > 0:
            self.last_motion = now
        h = datetime.now().hour
        a, b = settings.sms_motion_start_hour, settings.sms_motion_end_hour
        in_window = (a <= h < b) if a < b else (h >= a or h < b)
        pigs_seen = cam_ok and (vision.pigs + vision.piglets) > 0
        if not (cam_ok and in_window):
            self.last_motion = now                 # camera down / night -> restart the count
        still_min = (now - self.last_motion) / 60
        if settings.sms_on_no_motion and pigs_seen and still_min >= settings.sms_no_motion_minutes:
            self._alert("no_motion", now, f"PIG ALERT: pigs have not moved for {still_min:.0f} min "
                                          f"({vision.pigs + vision.piglets} seen on camera). Please check. {self._stamp()}")
        elif still_min < 1:
            self._clear("no_motion", f"Pig Monitor OK: pigs are moving again. {self._stamp()}")

    def on_audio(self, result):
        if not result or result.get("status") != "ATTENTION NEEDED" or not settings.sms_on_audio:
            return
        now = time.time()
        self._alert("audio", now, f"PIG ALERT: {result.get('cough_events', 0)} cough / "
                                  f"{result.get('stress_events', 0)} stress sound(s) in the last "
                                  f"{settings.audio_interval}s ({result.get('top_class')}). {self._stamp()}")
        self.active.pop("audio", None)             # audio has no "back to normal" SMS


class RelayStatePublisher(threading.Thread):
    """
    Sends the REAL relay state to system_settings.relay_state (JSON) so the website shows
    what the relays are actually doing (incl. heat protection). Runs in its own thread:
    a slow / dead internet never delays the relays.
    """

    HEARTBEAT_S = 30

    def __init__(self, sb):
        super().__init__(name="relay-state", daemon=True)
        self.sb = sb
        self.cond = threading.Condition()
        self.latest = None
        self.key = None
        self.sent_key = None
        self.sent_at = 0.0

    def update(self, payload, key):
        with self.cond:
            self.latest, self.key = payload, key
            if key != self.sent_key:
                self.cond.notify()

    def run(self):
        while not stop_event.is_set():
            with self.cond:
                self.cond.wait(timeout=1.0)
                payload, key = self.latest, self.key
            if payload is None:
                continue
            if key == self.sent_key and time.time() - self.sent_at < self.HEARTBEAT_S:
                continue
            try:
                self.sb.set_setting("relay_state", json.dumps({**payload, "t": round(time.time(), 1)}))
                self.sent_key, self.sent_at = key, time.time()
            except requests.RequestException as e:
                log.warning("Relay state upload failed: %s", e)
                stop_event.wait(5)


class RelayLogic:
    """
    Bulb: on / off / auto (schedule) from Supabase.

    Water solenoid:
      solenoid_mode = on   -> always open
      anything else (off / auto) -> HEAT PROTECTION:
        hottest of ambient/floor >= solenoid_trigger_temp (default 38 C)
          -> open 10 min -> close, wait 2 min -> still >= trigger - 1 C? open again ...
          -> cooled down -> back to normal (closed)
        Works even when settings never loaded (no internet), using 38 C.
        While cooling, the heating bulb is forced OFF.
        No valid temperature for 30s -> solenoid closes (fail-safe).
    """

    def __init__(self):
        self.phase = "idle"          # idle | spraying | waiting
        self.phase_until = 0.0
        self.cycles = 0
        self.last_temp = None
        self.last_temp_t = 0.0

    @staticmethod
    def _valid(t):
        return t is not None and TEMP_VALID[0] <= t <= TEMP_VALID[1]

    def trigger(self):
        return settings.solenoid_trigger_temp if settings.loaded else DEFAULT_TRIGGER_C

    def state(self):
        return {
            "phase": self.phase,                           # idle | spraying | waiting
            "left": max(0, int(self.phase_until - time.time())) if self.phase != "idle" else 0,
            "cycle": self.cycles,
            "temp": None if self.last_temp is None else round(self.last_temp, 1),
            "trigger": self.trigger(),
        }

    def status(self):
        if self.phase == "idle":
            return "normal"
        left = max(0, int(self.phase_until - time.time()))
        return f"{self.phase} {left // 60}:{left % 60:02d} (cycle {self.cycles})"

    def _set_phase(self, phase, seconds, why):
        self.phase = phase
        self.phase_until = time.time() + seconds
        log.warning("[COOLING] %s", why)
        live.event("alert" if phase == "spraying" else "info", why)

    def _cooling(self, max_temp):
        """Runs the 10 min ON / 2 min wait cycle. Returns True while the solenoid must be open."""
        now = time.time()
        if self._valid(max_temp):
            self.last_temp, self.last_temp_t = max_temp, now
        sensor_lost = now - self.last_temp_t > COOL_SENSOR_LOST_S
        temp = self.last_temp
        trig = self.trigger()

        if self.phase == "idle":
            if not sensor_lost and temp is not None and temp >= trig:
                self.cycles = 1
                self._set_phase("spraying", COOL_SPRAY_S,
                                f"HEAT {temp:.1f}C >= {trig:.1f}C -> water ON for {COOL_SPRAY_S // 60} min (cycle 1)")
            return self.phase == "spraying"

        if sensor_lost:
            log.warning("[COOLING] No temperature for %ds -> water OFF (fail-safe)", COOL_SENSOR_LOST_S)
            live.event("alert", "Temp sensor lost during cooling -> water OFF")
            self.phase, self.cycles = "idle", 0
            return False

        if self.phase == "spraying":
            if now >= self.phase_until:
                self._set_phase("waiting", COOL_WAIT_S,
                                f"Cycle {self.cycles} done -> water OFF, waiting {COOL_WAIT_S // 60} min then re-check")
                return False
            return True

        # waiting
        if now < self.phase_until:
            return False
        if temp >= trig - SOLENOID_HYSTERESIS:
            self.cycles += 1
            msg = f"Still hot {temp:.1f}C -> water ON again (cycle {self.cycles})"
            if self.cycles > COOL_WARN_CYCLES:
                msg += " - NOT COOLING DOWN, check the pigs / water supply!"
            self._set_phase("spraying", COOL_SPRAY_S, msg)
            return True
        log.info("[COOLING] Cooled down to %.1fC after %d cycle(s) -> back to normal", temp, self.cycles)
        live.event("info", f"Cooled down to {temp:.1f}C after {self.cycles} cycle(s)")
        self.phase, self.cycles = "idle", 0
        return False

    def decide(self, ambient, floor, now):
        temps = [t for t in (ambient, floor) if self._valid(t)]
        max_temp = max(temps) if temps else None

        # --- Water solenoid ---
        cooling = self._cooling(max_temp)
        if settings.loaded and settings.solenoid_mode == "on":
            solenoid = True
        else:
            solenoid = cooling                         # off / auto / no settings -> heat protection only

        # --- Heating bulb ---
        if not settings.loaded:
            bulb = False
        elif settings.bulb_mode == "on":
            bulb = True
        elif settings.bulb_mode == "off":
            bulb = False
        else:   # auto / schedule
            h = now.hour
            bulb = h >= settings.bulb_start_hour or h < settings.bulb_end_hour
        if self.phase != "idle":
            bulb = False                               # never heat while cooling down a heat event
        return bulb, solenoid


# ========================================================
# --- ESP32-CAM OVER USB SERIAL ---
# ========================================================
class CamError(Exception):
    pass


class SerialCamera:
    def __init__(self):
        self.ser = None
        self.port = None
        self.info = ""

    @staticmethod
    def find_port():
        if CAM_PORT != "auto":
            return CAM_PORT
        candidates = (
            sorted(glob.glob("/dev/serial/by-id/*CH340*"))
            + sorted(glob.glob("/dev/serial/by-id/*1a86*"))
            + sorted(glob.glob("/dev/ttyUSB*"))
            + sorted(glob.glob("/dev/ttyACM*"))
        )
        if not candidates:
            raise CamError("no USB serial device found (is the ESP32-CAM-MB plugged in?)")
        return candidates[0]

    def open(self):
        self.close()
        port = self.find_port()
        ser = serial.Serial()
        ser.port = port
        ser.baudrate = CAM_BAUD
        ser.timeout = 0.5
        # Keep DTR/RTS released so the MB board doesn't hold the ESP32 in reset/boot mode
        ser.dtr = False
        ser.rts = False
        ser.open()
        time.sleep(2.5)            # opening the port may reboot the cam
        ser.reset_input_buffer()

        deadline = time.time() + 12
        while time.time() < deadline and not stop_event.is_set():
            ser.write(b"PING\n")
            end = time.time() + 1.5
            while time.time() < end:
                line = ser.readline().strip()
                if line in (b"PONG", b"READY"):
                    self.ser, self.port = ser, port
                    self.info = self._read_info()
                    log.info("ESP32-CAM connected on %s (%s)", port, self.info or "no info")
                    return
                if line.startswith(b"ERR:"):
                    log.warning("Cam says: %s", line.decode(errors="ignore"))
        ser.close()
        raise CamError(f"no answer from cam on {port}")

    def _read_info(self):
        try:
            self.ser.reset_input_buffer()
            self.ser.write(b"INFO\n")
            end = time.time() + 2
            while time.time() < end:
                line = self.ser.readline().strip()
                if line.startswith(b"INFO "):
                    return line[5:].decode(errors="ignore")
        except serial.SerialException:
            pass
        return ""

    def close(self):
        if self.ser:
            try:
                self.ser.close()
            except Exception:
                pass
        self.ser = None

    def capture(self, flash=False):
        ser = self.ser
        ser.reset_input_buffer()
        ser.write(b"SNAP1\n" if flash else b"SNAP0\n")
        deadline = time.time() + 10
        while time.time() < deadline:
            line = ser.readline().strip()
            if not line:
                continue
            if line.startswith(b"ERR:"):
                raise CamError(line.decode(errors="ignore"))
            if line.startswith(b"IMG:"):
                try:
                    size = int(line[4:])
                except ValueError:
                    raise CamError(f"bad header {line!r}")
                if not 0 < size < MAX_JPEG:
                    raise CamError(f"bad size {size}")
                old_timeout = ser.timeout
                ser.timeout = max(3.0, size / 80_000 + 3)
                data = ser.read(size)
                ser.timeout = old_timeout
                if len(data) != size:
                    raise CamError(f"short read {len(data)}/{size}")
                if data[:2] != b"\xff\xd8" or b"\xff\xd9" not in data[-64:]:
                    raise CamError("corrupt JPEG")
                ser.readline()  # blank line before END
                ser.readline()  # END
                return data
        raise CamError("timeout waiting for image")


# ========================================================
# --- VISION: YOLOv8 PIG DETECTOR (ONNX) ---
# ========================================================
def box_iou(a, b):
    """a: [4] x1y1x2y2, b: [N,4] -> [N]"""
    x1 = np.maximum(a[0], b[:, 0])
    y1 = np.maximum(a[1], b[:, 1])
    x2 = np.minimum(a[2], b[:, 2])
    y2 = np.minimum(a[3], b[:, 3])
    inter = np.clip(x2 - x1, 0, None) * np.clip(y2 - y1, 0, None)
    area_a = (a[2] - a[0]) * (a[3] - a[1])
    area_b = (b[:, 2] - b[:, 0]) * (b[:, 3] - b[:, 1])
    return inter / np.maximum(area_a + area_b - inter, 1e-9)


class PigDetector:
    LABELS = ["Pig", "Piglet"]

    def __init__(self, model_path):
        self.sess = make_session(model_path, threads=3)
        inp = self.sess.get_inputs()[0]
        self.input_name = inp.name
        self.size = inp.shape[2] if isinstance(inp.shape[2], int) else 640

    def detect(self, img):
        """img: PIL RGB image -> list of {label, score, bbox:[left, top, width, height] normalized}"""
        w, h = img.size
        s = self.size
        # Letterbox (same as YOLO training): keep aspect ratio, pad with gray
        r = min(s / w, s / h)
        nw, nh = round(w * r), round(h * r)
        px, py = (s - nw) // 2, (s - nh) // 2
        canvas = Image.new("RGB", (s, s), (114, 114, 114))
        canvas.paste(img.resize((nw, nh), Image.BILINEAR), (px, py))
        x = np.asarray(canvas, dtype=np.float32).transpose(2, 0, 1)[None] / 255.0

        out = self.sess.run(None, {self.input_name: x})[0][0]   # [6, 8400]
        if out.shape[0] > out.shape[1]:
            out = out.T
        boxes, scores = out[:4].T, out[4:].T
        cls = scores.argmax(1)
        conf = scores.max(1)
        keep = conf >= VISION_CONF
        boxes, cls, conf = boxes[keep], cls[keep], conf[keep]
        if conf.size == 0:
            return []

        # cx,cy,w,h (letterboxed pixels) -> x1,y1,x2,y2 (original pixels)
        xyxy = np.empty_like(boxes)
        xyxy[:, 0] = (boxes[:, 0] - boxes[:, 2] / 2 - px) / r
        xyxy[:, 1] = (boxes[:, 1] - boxes[:, 3] / 2 - py) / r
        xyxy[:, 2] = (boxes[:, 0] + boxes[:, 2] / 2 - px) / r
        xyxy[:, 3] = (boxes[:, 1] + boxes[:, 3] / 2 - py) / r
        xyxy[:, [0, 2]] = xyxy[:, [0, 2]].clip(0, w)
        xyxy[:, [1, 3]] = xyxy[:, [1, 3]].clip(0, h)

        # Class-agnostic NMS (same as the dashboard did)
        order = conf.argsort()[::-1]
        selected = []
        while order.size and len(selected) < VISION_MAX_DET:
            i = order[0]
            selected.append(i)
            if order.size == 1:
                break
            ious = box_iou(xyxy[i], xyxy[order[1:]])
            order = order[1:][ious < VISION_IOU]

        results = []
        for i in selected:
            x1, y1, x2, y2 = xyxy[i]
            if x2 - x1 < 1 or y2 - y1 < 1:
                continue
            label = self.LABELS[int(cls[i])] if int(cls[i]) < len(self.LABELS) else str(int(cls[i]))
            results.append({
                "label": label,
                "score": float(conf[i]),
                "bbox": [float(x1 / w), float(y1 / h), float((x2 - x1) / w), float((y2 - y1) / h)],
            })
        return results


def norm_iou(a, b):
    left, top = max(a[0], b[0]), max(a[1], b[1])
    right, bottom = min(a[0] + a[2], b[0] + b[2]), min(a[1] + a[3], b[1] + b[3])
    overlap = max(0.0, right - left) * max(0.0, bottom - top)
    union = a[2] * a[3] + b[2] * b[3] - overlap
    return overlap / union if union else 0.0


class PigTracker:
    """Same moving/resting rules the dashboard used in the browser."""

    def __init__(self):
        self.prev = []
        self.next_id = 1

    def reset(self):
        self.prev = []

    def update(self, detections):
        tracked, used = [], set()
        for d in detections:
            cx, cy = d["bbox"][0] + d["bbox"][2] / 2, d["bbox"][1] + d["bbox"][3] / 2
            best, best_dist = -1, math.inf
            for i, p in enumerate(self.prev):
                if i in used:
                    continue
                pcx, pcy = p["bbox"][0] + p["bbox"][2] / 2, p["bbox"][1] + p["bbox"][3] / 2
                dist = math.hypot(cx - pcx, cy - pcy)
                if (norm_iou(d["bbox"], p["bbox"]) > 0.2 or dist < 0.15) and dist < best_dist:
                    best, best_dist = i, dist
            if best >= 0:
                used.add(best)
                p = self.prev[best]
                moved = best_dist > 0.012
                still = 0 if moved else p["stillCount"] + 1
                tracked.append({**d, "id": p["id"], "isMoving": still < 2,
                                "displacement": best_dist, "stillCount": still})
            else:
                tracked.append({**d, "id": self.next_id, "isMoving": True,
                                "displacement": 0.0, "stillCount": 0})
                self.next_id = 1 if self.next_id >= 999 else self.next_id + 1
        self.prev = tracked
        return tracked


class VisionWorker(threading.Thread):
    def __init__(self, sb_url, sb_key):
        super().__init__(name="vision", daemon=True)
        self.sb = Supabase(sb_url, sb_key)
        self.detector = PigDetector(find_model("best.onnx"))
        self.tracker = PigTracker()
        self.cam = SerialCamera()
        self.frames = 0
        self.fails = 0
        self.slot = 0
        self.last_frame_time = 0.0
        self.last_ok = "never"
        self.infer_ms = 0
        self.pigs = self.piglets = self.moving = 0
        self.state = "starting"

    def status_text(self):
        return (f"source=pi-usb cam={self.state} frames={self.frames} fails={self.fails} "
                f"infer={self.infer_ms}ms pigs={self.pigs} piglets={self.piglets} moving={self.moving} "
                f"last={self.last_ok} interval={settings.live_interval}s flash={settings.flash} "
                f"live={'on' if settings.live_enabled else 'off'} esp=[{self.cam.info}]")

    def run(self):
        log.info("Vision model loaded (input %dx%d)", self.detector.size, self.detector.size)
        while not stop_event.is_set():
            if not settings.live_enabled:
                self.state = "paused"
                stop_event.wait(1)
                continue

            if self.cam.ser is None:
                try:
                    self.cam.open()
                    self.fails = 0
                    self.tracker.reset()
                except (CamError, serial.SerialException, OSError) as e:
                    self.state = "down"
                    log.warning("Camera not ready: %s (retry in 5s)", e)
                    stop_event.wait(5)
                    continue

            t0 = time.time()
            try:
                jpg = self.cam.capture(settings.flash_now())
            except CamError as e:
                self.fails += 1
                log.warning("Capture failed (%d/%d): %s", self.fails, CAM_FAILS_BEFORE_RECONNECT, e)
                if self.fails >= CAM_FAILS_BEFORE_RECONNECT:
                    log.warning("Reconnecting to camera")
                    self.cam.close()
                stop_event.wait(1)
                continue
            except (serial.SerialException, OSError) as e:
                log.warning("Camera unplugged? %s", e)
                self.cam.close()
                self.state = "down"
                stop_event.wait(2)
                continue

            self.fails = 0
            self.state = "ok"
            try:
                self.process_frame(jpg)
            except Exception as e:   # never let one bad frame kill the thread
                log.warning("Frame processing error: %s", e)

            # Wait for the next frame
            stop_event.wait(max(0.0, settings.live_interval - (time.time() - t0)))

        self.cam.close()

    def process_frame(self, jpg):
        img = Image.open(io.BytesIO(jpg)).convert("RGB")

        if time.time() - self.last_frame_time > TRACK_RESET_GAP_S:
            self.tracker.reset()
        self.last_frame_time = time.time()

        t_inf = time.time()
        tracked = self.tracker.update(self.detector.detect(img))
        self.infer_ms = int((time.time() - t_inf) * 1000)

        self.pigs = sum(1 for d in tracked if d["label"] == "Pig")
        self.piglets = sum(1 for d in tracked if d["label"] == "Piglet")
        self.moving = sum(1 for d in tracked if d["isMoving"])

        slot_name = LIVE_SLOTS[self.slot]
        payload = {
            "t": int(time.time() * 1000),
            "image": slot_name,
            "width": img.size[0],
            "height": img.size[1],
            "source": "pi",
            "infer_ms": self.infer_ms,
            "pigs": self.pigs,
            "piglets": self.piglets,
            "moving": self.moving,
            "detections": [{
                "id": d["id"],
                "label": d["label"],
                "score": round(d["score"], 3),
                "bbox": [round(v, 4) for v in d["bbox"]],
                "isMoving": d["isMoving"],
                "displacement": round(d["displacement"], 4),
                "stillCount": d["stillCount"],
            } for d in tracked],
        }

        live.set_frame(jpg, payload)   # local dashboard gets it even if the internet is down

        try:
            # Image first, then the JSON that points to it -> the website never sees
            # boxes for a picture that isn't uploaded yet
            self.sb.upload(SNAP_BUCKET, slot_name, jpg, "image/jpeg")
            self.sb.upload(SNAP_BUCKET, LIVE_JSON, json.dumps(payload).encode(), "application/json")
            # Also the old file name, so a website that isn't redeployed yet still shows the feed
            self.sb.upload(SNAP_BUCKET, LEGACY_LIVE_JPG, jpg, "image/jpeg")
            self.slot = 1 - self.slot
            self.frames += 1
            self.last_ok = datetime.now().strftime("%H:%M:%S")
            log.info("Frame %d: %d pigs, %d piglets, %d moving | AI %dms | %d KB",
                     self.frames, self.pigs, self.piglets, self.moving, self.infer_ms, len(jpg) // 1024)
        except requests.RequestException as e:
            log.warning("Live upload failed: %s", e)


# ========================================================
# --- AUDIO: SWINE SOUND CLASSIFIER (ONNX) ---
# ========================================================
def _hz_to_mel(f):
    return 2595.0 * np.log10(1.0 + f / 700.0)


def _mel_to_hz(m):
    return 700.0 * (10.0 ** (m / 2595.0) - 1.0)


# Same as torchaudio MelSpectrogram(16000, n_fft=1024, hop=512, n_mels=64) + AmplitudeToDB()
_all_freqs = np.linspace(0, SAMPLE_RATE // 2, N_FFT // 2 + 1)
_f_pts = _mel_to_hz(np.linspace(_hz_to_mel(0.0), _hz_to_mel(SAMPLE_RATE / 2), N_MELS + 2))
_f_diff = _f_pts[1:] - _f_pts[:-1]
_slopes = _f_pts[None, :] - _all_freqs[:, None]
MEL_FB = np.maximum(0, np.minimum(-_slopes[:, :-2] / _f_diff[:-1], _slopes[:, 2:] / _f_diff[1:]))  # [513, 64]
HANN = 0.5 - 0.5 * np.cos(2 * np.pi * np.arange(N_FFT) / N_FFT)


def waveform_to_spectrogram(chunk):
    """1s float waveform -> [1, 1, 64, 32] log-mel (matches detect_audio.py)"""
    x = np.zeros(SAMPLE_RATE, dtype=np.float64)
    x[:min(len(chunk), SAMPLE_RATE)] = chunk[:SAMPLE_RATE]
    x = np.pad(x, (N_FFT // 2, N_FFT // 2), mode="reflect")
    n_frames = 1 + (len(x) - N_FFT) // HOP
    frames = np.lib.stride_tricks.as_strided(
        x, (n_frames, N_FFT), (x.strides[0] * HOP, x.strides[0])) * HANN
    power = np.abs(np.fft.rfft(frames, axis=1)) ** 2
    mel = MEL_FB.T @ power.T
    db = 10.0 * np.log10(np.maximum(mel, 1e-10))
    return db[None, None].astype(np.float32)


def db_level(chunk):
    """Approximate sound level in dB from a float waveform (same as detect_audio.py)."""
    rms = float(np.sqrt(np.mean(np.square(chunk)))) if len(chunk) else 0.0
    if rms <= 1e-7:
        return 30.0
    return max(35.0, min(105.0, round(20 * math.log10(rms) + 94.0, 1)))


def wav_bytes(samples):
    """float32 [-1, 1] mono 16kHz -> 16-bit WAV bytes"""
    pcm = (np.clip(samples, -1.0, 1.0) * 32767).astype("<i2")
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SAMPLE_RATE)
        w.writeframes(pcm.tobytes())
    return buf.getvalue()


def lowpass_fir(taps=127, cutoff=7600.0, fs=MIC_RATE):
    n = np.arange(taps) - (taps - 1) / 2
    h = np.sinc(2 * cutoff / fs * n) * np.hamming(taps)
    return (h / h.sum()).astype(np.float64)


def level_to(chunk, offset_db=0.0, ref_db=None):
    """
    Bring a 1s window to a fixed loudness before the AI.
    The model reads absolute dB, so the same cough at 4x gain was coming out as "Cleaning".
    Peak is kept under 0 dBFS so leveling never clips.
    """
    chunk = np.asarray(chunk, dtype=np.float64)
    rms = float(np.sqrt(np.mean(np.square(chunk)))) if len(chunk) else 0.0
    if rms < 1e-6:
        return chunk.astype(np.float32)
    ref = settings.audio_ref_db if ref_db is None else ref_db
    gain = 10.0 ** ((ref + offset_db) / 20.0) / rms
    peak = float(np.max(np.abs(chunk)))
    if peak * gain > 0.99:
        gain = 0.99 / peak
    return (chunk * gain).astype(np.float32)


def envelope_db(x):
    """10 ms loudness frames in dBFS."""
    n = len(x) // ENV_FRAME
    if n == 0:
        return np.zeros(0)
    fr = np.asarray(x[:n * ENV_FRAME], dtype=np.float64).reshape(n, ENV_FRAME)
    return 20.0 * np.log10(np.sqrt(np.mean(fr * fr, axis=1)) + 1e-9)


def cough_shape(seg):
    """
    seg = 1s centered on the candidate peak. Checks the sound looks like a cough:
    sticks out of its surroundings, explosive attack, short burst.
    """
    env = envelope_db(seg)
    mid = len(env) // 2
    lo, hi = max(0, mid - 5), min(len(env), mid + 6)
    p = lo + int(np.argmax(env[lo:hi]))
    peak = float(env[p])
    floor = float(np.percentile(env, 20))
    prom = peak - floor
    on_level = peak - min(15.0, 0.8 * max(prom, 0.0))
    i = p
    while i > 0 and env[i - 1] >= on_level:
        i -= 1
    rise_ms = (p - i) * ENV_FRAME * 1000 / SAMPLE_RATE
    a = b = p
    while a > 0 and env[a - 1] >= peak - 10.0:
        a -= 1
    while b < len(env) - 1 and env[b + 1] >= peak - 10.0:
        b += 1
    dur_ms = (b - a + 1) * ENV_FRAME * 1000 / SAMPLE_RATE
    reasons = []
    if prom < COUGH_PROMINENCE_DB:
        reasons.append(f"not sharp enough ({prom:.1f} dB above surroundings, need {COUGH_PROMINENCE_DB:.0f})")
    if rise_ms > COUGH_RISE_MAX_MS:
        reasons.append(f"slow start ({rise_ms:.0f} ms, cough < {COUGH_RISE_MAX_MS} ms)")
    if dur_ms < COUGH_DUR_MIN_MS:
        reasons.append(f"too short ({dur_ms:.0f} ms)")
    if dur_ms > COUGH_DUR_MAX_MS:
        reasons.append(f"too long ({dur_ms:.0f} ms, cough < {COUGH_DUR_MAX_MS} ms)")
    return {"ok": not reasons, "prominence_db": round(prom, 1), "rise_ms": round(rise_ms),
            "duration_ms": round(dur_ms), "peak_offset": (p - mid) * ENV_FRAME, "reasons": reasons}


class AudioModel:
    def __init__(self, model_path):
        self.sess = make_session(model_path, threads=1)
        self.input_name = self.sess.get_inputs()[0].name

    def raw_probs(self, chunk):
        logits = self.sess.run(None, {self.input_name: waveform_to_spectrogram(chunk)})[0][0]
        return 1.0 / (1.0 + np.exp(-logits))

    def probs(self, chunk):
        """Normal 1s check (leveled)."""
        return self.raw_probs(level_to(chunk))

    def verify_cough(self, get, peak, threshold):
        """
        Second, careful look at a cough candidate. get(a, b) -> samples [a, b).
        9 checks (3 positions x 3 loudness levels) centered on the peak, averaged,
        plus the cough shape check.
        """
        shape = cough_shape(get(peak - SAMPLE_RATE // 2, peak + SAMPLE_RATE // 2))
        peak += shape["peak_offset"]                       # snap to the real peak
        if shape["peak_offset"]:
            shape = cough_shape(get(peak - SAMPLE_RATE // 2, peak + SAMPLE_RATE // 2))
        acc = np.zeros(len(AUDIO_CLASSES))
        n = 0
        for sh in COUGH_SHIFTS_S:
            c = peak + int(sh * SAMPLE_RATE)
            seg = get(c - SAMPLE_RATE // 2, c + SAMPLE_RATE // 2)
            for off in LEVEL_SET_DB:
                acc += self.raw_probs(level_to(seg, off))
                n += 1
        avg = acc / n
        cough = float(avg[0])
        other_i = 1 + int(np.argmax(avg[1:]))
        margin = cough - float(avg[other_i])
        reasons = []
        if cough < threshold:
            reasons.append(f"cough score {cough * 100:.0f}% < threshold {threshold * 100:.0f}%")
        if margin < COUGH_MARGIN:
            reasons.append(f"too close to {AUDIO_CLASSES[other_i]} ({avg[other_i] * 100:.0f}%)")
        reasons += shape["reasons"]
        return {"ok": not reasons, "peak": peak, "score": cough, "margin": margin,
                "probs": avg, "shape": shape, "reasons": reasons}


class CoughVerifier:
    """
    Cough candidates wait until there is 0.65s of audio after their peak,
    then get the careful 9-check look. Each real cough is counted once.
    """

    def __init__(self):
        self.pending = []
        self.done = deque(maxlen=64)

    def _near(self, peak):
        d = int(COUGH_DEDUP_S * SAMPLE_RATE)
        return any(abs(peak - p) < d for p in list(self.pending) + list(self.done))

    def add(self, peak):
        if not self._near(peak):
            self.pending.append(peak)

    def ready(self, total, get, model, threshold):
        out, keep = [], []
        for p in self.pending:
            if total >= p + COUGH_PAD:
                r = model.verify_cough(get, p, threshold)
                d = int(COUGH_DEDUP_S * SAMPLE_RATE)
                if not any(abs(r["peak"] - q) < d for q in self.done):
                    out.append(r)
                self.done.append(r["peak"])
                self.done.append(p)
            else:
                keep.append(p)
        self.pending = keep
        return out


def candidate_peaks(chunk, end_abs, max_peaks=3):
    """
    Absolute sample indexes of the loud bursts in a 1s window ending at end_abs
    (up to 3, so coughs in a quick bout are each checked, not just the loudest one).
    """
    env = envelope_db(chunk)
    if len(env) == 0:
        return []
    floor = float(np.percentile(env, 20))
    top = float(env.max())
    gap = int(COUGH_DEDUP_S * SAMPLE_RATE / ENV_FRAME)
    picked = []
    for f in np.argsort(-env, kind="stable"):
        f = int(f)
        if len(picked) >= max_peaks or env[f] < max(top - 20.0, floor + 6.0):
            break
        if f > 0 and env[f - 1] > env[f] or f < len(env) - 1 and env[f + 1] > env[f]:
            continue                                   # not a local peak
        if all(abs(f - q) >= gap for q in picked):
            picked.append(f)
    if not picked:
        picked = [int(np.argmax(env))]
    start = end_abs - len(chunk)
    return [start + f * ENV_FRAME + ENV_FRAME // 2 for f in sorted(picked)]


def analyze_samples(model, x, threshold=None, min_db=None, alert_min=None):
    """
    Same cough logic as the live mic, on a whole recording (16 kHz mono float).
    Used by --test-audio (and mirrored by the website's Audio Tester).
    """
    threshold = settings.audio_threshold if threshold is None else threshold
    min_db = settings.audio_min_db if min_db is None else min_db
    alert_min = settings.cough_alert_min if alert_min is None else alert_min
    x = np.asarray(x, dtype=np.float32)
    if len(x) < SAMPLE_RATE:
        x = np.concatenate([x, np.zeros(SAMPLE_RATE - len(x), np.float32)])
    padded = np.concatenate([np.zeros(COUGH_PAD, np.float32), x, np.zeros(COUGH_PAD, np.float32)])

    def get(a, b):
        return padded[a + COUGH_PAD: b + COUGH_PAD]

    support = max(0.30, threshold - 0.20)
    levels = deque(maxlen=240)
    verifier = CoughVerifier()
    windows, coughs, rejected = [], [], []
    hop = SAMPLE_RATE // 2
    for end in range(SAMPLE_RATE, len(x) + 1, hop):
        chunk = x[end - SAMPLE_RATE:end]
        level = db_level(chunk)
        bg = float(np.percentile(levels, 20)) if len(levels) >= 20 else None
        gate = min_db if bg is None else max(min_db, min(bg, AUDIO_BG_MAX_DB) + AUDIO_ABOVE_BG_DB)
        levels.append(level)
        if level < gate:
            windows.append({"t": (end - SAMPLE_RATE) / SAMPLE_RATE, "level": level, "quiet": True, "probs": None})
            continue
        probs = model.probs(chunk)
        windows.append({"t": (end - SAMPLE_RATE) / SAMPLE_RATE, "level": level, "quiet": False,
                        "probs": [round(float(v), 4) for v in probs]})
        if probs[0] >= support:
            for pk in candidate_peaks(chunk, end):
                verifier.add(pk)
    for r in verifier.ready(len(x) + COUGH_PAD, get, model, threshold):
        (coughs if r["ok"] else rejected).append(r)
    coughs.sort(key=lambda r: r["peak"])
    return {"windows": windows, "coughs": coughs, "rejected": rejected,
            "verdict": "COUGH" if coughs else "NO COUGH",
            "attention": len(coughs) >= alert_min}


def load_audio_file(path):
    """WAV -> 16 kHz mono float32 (other formats need ffmpeg)."""
    try:
        with wave.open(str(path), "rb") as w:
            ch, sw, sr = w.getnchannels(), w.getsampwidth(), w.getframerate()
            raw = w.readframes(w.getnframes())
        if sw == 2:
            x = np.frombuffer(raw, "<i2").astype(np.float32) / 32768.0
        elif sw == 4:
            x = np.frombuffer(raw, "<i4").astype(np.float32) / 2147483648.0
        elif sw == 1:
            x = (np.frombuffer(raw, np.uint8).astype(np.float32) - 128.0) / 128.0
        else:
            raise ValueError(f"{sw * 8}-bit WAV not supported")
        x = x.reshape(-1, ch).mean(axis=1)
    except (wave.Error, EOFError):
        out = subprocess.run(["ffmpeg", "-v", "error", "-i", str(path), "-ac", "1", "-ar", str(SAMPLE_RATE),
                              "-f", "f32le", "-"], capture_output=True, check=True).stdout
        return np.frombuffer(out, np.float32).copy()
    if sr != SAMPLE_RATE:
        t_new = np.arange(int(len(x) * SAMPLE_RATE / sr)) / SAMPLE_RATE
        x = np.interp(t_new, np.arange(len(x)) / sr, x).astype(np.float32)
    return x


def test_audio_file(path):
    model = AudioModel(find_model("pig_audio.onnx"))
    x = load_audio_file(path)
    r = analyze_samples(model, x)
    print(f"\n{path}  ({len(x) / SAMPLE_RATE:.1f}s)  threshold={settings.audio_threshold:.2f} "
          f"ref={settings.audio_ref_db:.0f} dBFS")
    for w in r["windows"]:
        if w["quiet"]:
            print(f"  {w['t']:6.1f}s  {w['level']:5.1f} dB  (quiet, skipped)")
        else:
            p = w["probs"]
            print(f"  {w['t']:6.1f}s  {w['level']:5.1f} dB  " +
                  "  ".join(f"{n.split(' ')[0][:6]}={v * 100:4.0f}%" for n, v in zip(AUDIO_CLASSES, p)))
    for c in r["coughs"]:
        print(f"  COUGH at {c['peak'] / SAMPLE_RATE:.2f}s  score={c['score'] * 100:.0f}%  "
              f"margin={c['margin'] * 100:.0f}%  rise={c['shape']['rise_ms']}ms dur={c['shape']['duration_ms']}ms")
    for c in r["rejected"]:
        print(f"  not a cough at {c['peak'] / SAMPLE_RATE:.2f}s: {'; '.join(c['reasons'])}")
    print(f"  => {r['verdict']} ({len(r['coughs'])} cough(s))"
          f"{'  ATTENTION NEEDED' if r['attention'] else ''}\n")
    return 0


class AudioWindow:
    """Summary of one audio_interval window (what goes into audio_detections)."""

    def __init__(self):
        self.start = time.time()
        self.max_cough = self.max_stress = 0.0
        self.cough_events = self.stress_events = 0
        self.class_scores = np.zeros(len(AUDIO_CLASSES))
        self.best_event_prob = 0.0
        self.event_clip = None
        self.chunks = 0          # 1s windows the AI checked
        self.quiet = 0           # 1s windows skipped (not louder than the background)

    def add_scores(self, probs):
        self.chunks += 1
        self.class_scores = np.maximum(self.class_scores, probs)
        self.max_cough = max(self.max_cough, float(probs[0]))
        self.max_stress = max(self.max_stress, float(probs[1]))

    def add_event(self, kind, prob, clip):
        if kind == "cough":
            self.cough_events += 1
        else:
            self.stress_events += 1
        # Keep the 5s around the strongest event so the uploaded clip has it
        if prob > self.best_event_prob:
            self.best_event_prob = prob
            self.event_clip = clip

    def result(self):
        if self.cough_events:
            top = AUDIO_CLASSES[0]
        elif self.stress_events:
            top = AUDIO_CLASSES[1]
        elif self.chunks == 0:
            top = "Quiet"
        else:
            top = AUDIO_CLASSES[int(np.argmax(self.class_scores))]
        return {
            "top_class": top,
            "cough_prob": round(self.max_cough, 4),
            "stress_prob": round(self.max_stress, 4),
            "cough_events": self.cough_events,
            "stress_events": self.stress_events,
            "status": ("ATTENTION NEEDED"
                       if (self.cough_events >= settings.cough_alert_min or self.stress_events) else "HEALTHY"),
        }


class EventDetector:
    """
    Turns raw AI scores into real events (fewer false alarms):
      1. Sound must be louder than the barn's usual background (learned) by AUDIO_ABOVE_BG_DB
         and at least audio_min_db, otherwise the AI doesn't even check it.
      2. Stress score must beat the "Normal Pig Sounds" score.
         (Coughs don't go through here anymore -> CoughVerifier does a 9-check look + shape check.)
      3. Must be seen in AUDIO_CONFIRM of the last 3 checks (checks run every 0.5s -> ~1.5s):
         one of them >= audio_threshold, the other >= audio_threshold - 0.20.
      4. One event per burst: the same kind can't fire again within AUDIO_COOLDOWN_S.
    """

    def __init__(self):
        self.levels = deque(maxlen=240)          # last ~2 min of levels (every 0.5s)
        self.history = deque(maxlen=3)           # last 3 candidates
        self.last_fired = {"cough": 0.0, "stress": 0.0}

    def background_db(self):
        if len(self.levels) < 20:
            return None
        return float(np.percentile(self.levels, 20))   # the "usual quiet" level

    def gate_db(self):
        bg = self.background_db()
        gate = settings.audio_min_db
        if bg is not None:
            # cap: a long loud fight must not become "normal background"
            gate = max(gate, min(bg, AUDIO_BG_MAX_DB) + AUDIO_ABOVE_BG_DB)
        return gate

    def loud_enough(self, level):
        gate = self.gate_db()                     # decide before this level shifts the background
        self.levels.append(level)
        return level >= gate

    def skip(self):
        self.history.append(None)

    def check(self, probs):
        """Returns ("stress", score) when a stress event is confirmed, else None."""
        thr = settings.audio_threshold
        support = max(0.30, thr - 0.20)          # the 2nd check only needs to be "fairly sure"
        normal = float(probs[2])
        cand = None
        if probs[1] >= support and probs[1] > normal:
            cand = ("stress", float(probs[1]))
        self.history.append(cand)
        if cand is None:
            return None
        kind = cand[0]
        same = [c[1] for c in self.history if c and c[0] == kind]
        if len(same) < AUDIO_CONFIRM or max(same) < thr:
            return None
        now = time.time()
        if now - self.last_fired[kind] < AUDIO_COOLDOWN_S:
            return None
        self.last_fired[kind] = now
        return kind, max(same)


def find_mic():
    if MIC_DEVICE != "auto":
        return MIC_DEVICE
    try:
        out = subprocess.run(["arecord", "-l"], capture_output=True, text=True, timeout=5).stdout
    except (OSError, subprocess.SubprocessError):
        return None
    cards = re.findall(r"^card \d+: (\S+) \[(.*?)\]", out, re.M)
    if not cards:
        return None
    for name, desc in cards:                       # INMP441 via the I2S overlay
        if "googlevoi" in name.lower() or "i2s" in desc.lower() or "mems" in desc.lower():
            return f"plughw:CARD={name},DEV=0"
    for name, desc in cards:                       # otherwise a USB mic
        if "usb" in desc.lower():
            return f"plughw:CARD={name},DEV=0"
    return f"plughw:CARD={cards[0][0]},DEV=0"


class MicWorker(threading.Thread):
    """Listens non-stop. Every 0.5s -> AI on the last 1s. Every audio_interval -> clip + summary."""

    def __init__(self, sb_url, sb_key):
        super().__init__(name="audio", daemon=True)
        self.sb = Supabase(sb_url, sb_key)
        self.model = AudioModel(find_model("pig_audio.onnx"))
        self.fir = lowpass_fir()
        self.results = queue.Queue()
        self.lock = threading.Lock()
        self.state = "starting"
        self.device = ""
        self.level_db = None          # last second
        self.peak_db = None           # loudest second since the last sensor log
        self.checks = 0               # 0.5s checks done
        self.windows = 0
        self.detector = EventDetector()
        self.coughs = CoughVerifier()
        self.last_result = "none"

    def take_peak_db(self):
        with self.lock:
            v, self.peak_db = self.peak_db, None
        return v

    def status_text(self):
        bg = self.detector.background_db()
        return (f"mic={self.state} level={self.level_db}dB bg={'?' if bg is None else round(bg)}dB "
                f"heard={self.checks // 2}s "
                f"windows={self.windows} last_audio={self.last_result}")

    def run(self):
        log.info("Audio model loaded")
        while not stop_event.is_set():
            dev = find_mic()
            if not dev:
                self.state = "no-mic"
                log.warning("No microphone found (check config.txt + reboot, or plug a USB mic). Retry in 15s")
                stop_event.wait(15)
                continue
            self.device = dev
            cmd = ["arecord", "-q", "-D", dev, "-c", "2", "-r", str(MIC_RATE), "-f", "S32_LE", "-t", "raw"]
            log.info("Listening on %s", dev)
            proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            try:
                self.stream(proc)
            except Exception as e:
                log.warning("Mic error: %s", e)
            finally:
                proc.kill()
                err = proc.communicate(timeout=5)[1].decode(errors="ignore").strip()
            if not stop_event.is_set():
                self.state = "down"
                log.warning("Mic stopped%s. Restarting in 5s", f": {err[-200:]}" if err else "")
                stop_event.wait(5)

    def stream(self, proc):
        block_bytes = MIC_BLOCK * 2 * 4                     # 2 channels x int32
        tail = np.zeros(len(self.fir) - 1)
        energy = np.zeros(2)
        ring = np.zeros(SAMPLE_RATE * AUDIO_CLIP_SECONDS, dtype=np.float32)
        new_samples = 0
        total = 0                                            # 16 kHz samples heard since start
        hop = SAMPLE_RATE // 2                               # check every 0.5s (1s windows overlap)
        filled = 0
        window = AudioWindow()
        detector = self.detector

        while not stop_event.is_set():
            raw = proc.stdout.read(block_bytes)
            if not raw or len(raw) < block_bytes:
                return                                       # arecord died
            self.state = "ok"

            x = np.frombuffer(raw, "<i4").reshape(-1, 2).astype(np.float64) / 2147483648.0
            energy = 0.95 * energy + np.mean(x * x, axis=0)
            mono = x[:, int(np.argmax(energy))]             # INMP441 is on one channel only
            mono = mono - mono.mean()

            # 48 kHz -> 16 kHz (low-pass + keep every 3rd sample)
            buf = np.concatenate([tail, mono])
            tail = buf[-(len(self.fir) - 1):]
            y = np.convolve(buf, self.fir, mode="valid")[::3]
            y = np.clip(y * AUDIO_GAIN, -1.0, 1.0).astype(np.float32)

            ring = np.concatenate([ring[len(y):], y])
            new_samples += len(y)
            total += len(y)
            filled = min(len(ring), filled + len(y))
            if filled < SAMPLE_RATE:
                continue                                     # first second after start

            # --- Every 0.5s: look at the last 1s ---
            while new_samples >= hop:
                new_samples -= hop
                chunk = ring[len(ring) - SAMPLE_RATE - new_samples: len(ring) - new_samples]
                level = db_level(chunk)
                with self.lock:
                    self.level_db = level
                    self.peak_db = level if self.peak_db is None else max(self.peak_db, level)
                self.checks += 1

                if not detector.loud_enough(level):
                    # Not louder than the barn's usual background -> skip the AI
                    window.quiet += 1
                    detector.skip()
                    live.update(audio_level=level, audio_probs=[0, 0, 0, 0, 0], audio_quiet=True,
                                audio_bg=detector.background_db(), audio_gate=detector.gate_db())
                    continue

                probs = self.model.probs(chunk)
                window.add_scores(probs)
                live.update(audio_level=level, audio_probs=[round(float(p), 3) for p in probs],
                            audio_quiet=False, audio_bg=detector.background_db(), audio_gate=detector.gate_db())

                hit = detector.check(probs)
                if hit:
                    kind, score = hit
                    window.add_event(kind, score, ring.copy())
                    log.info("!! STRESS/FIGHT confirmed %.0f%% (level %.0f dB, background %s dB)",
                             score * 100, level,
                             f"{detector.background_db():.0f}" if detector.background_db() else "?")
                    live.event("alert", f"STRESS/FIGHT {score * 100:.0f}% ({level:.0f} dB)")

                # Cough candidate -> careful look once the audio after its peak is in
                if probs[0] >= max(0.30, settings.audio_threshold - 0.20):
                    for pk in candidate_peaks(chunk, total - new_samples):
                        self.coughs.add(pk)

            # --- Cough candidates whose audio is complete -> verify ---
            def get(a, b, _ring=ring, _total=total):
                i = len(_ring) - (_total - a)
                return _ring[max(0, i): i + (b - a)]

            for r in self.coughs.ready(total, get, self.model, settings.audio_threshold):
                at = (total - r["peak"]) / SAMPLE_RATE
                if r["ok"]:
                    window.add_event("cough", r["score"], ring.copy())
                    log.info("!! COUGH confirmed %.0f%% (margin %.0f%%, rise %dms, %dms long, %.1fs ago)",
                             r["score"] * 100, r["margin"] * 100, r["shape"]["rise_ms"],
                             r["shape"]["duration_ms"], at)
                    live.event("alert", f"COUGH {r['score'] * 100:.0f}% "
                                        f"({window.cough_events} this window)")
                else:
                    log.info("   cough candidate rejected: %s", "; ".join(r["reasons"]))

            # --- Every audio_interval -> clip + summary ---
            if time.time() - window.start >= settings.audio_interval:
                self.finish_window(window, ring)
                window = AudioWindow()

    def finish_window(self, window, ring):
        result = window.result()
        clip = window.event_clip if window.event_clip is not None else ring.copy()
        url = None
        try:
            self.sb.upload(AUDIO_BUCKET, AUDIO_OBJECT, wav_bytes(clip), "audio/wav")
            url = self.sb.public_url(AUDIO_BUCKET, AUDIO_OBJECT)
        except requests.RequestException as e:
            log.warning("Clip upload failed: %s", e)
        self.windows += 1
        self.last_result = f"{result['status']}@{datetime.now().strftime('%H:%M')}"
        log.info("Last %ds (%d%% background, skipped): %-16s top=%-22s cough=%5.1f%% stress=%5.1f%% events=%d/%d",
                 round(time.time() - window.start),
                 round(100 * window.quiet / max(1, window.quiet + window.chunks)),
                 result["status"], result["top_class"],
                 result["cough_prob"] * 100, result["stress_prob"] * 100,
                 result["cough_events"], result["stress_events"])
        live.update(audio_window={**result, "at": datetime.now().strftime("%H:%M")})
        if result["status"] != "HEALTHY":
            live.event("alert", f"Last minute: {result['status']} ({result['top_class']}, "
                                f"{result['cough_events']} cough / {result['stress_events']} stress)")
        self.results.put((url, result))


# ========================================================
# --- LOCAL DASHBOARD (http://<pi-ip>:8080, works without internet) ---
# ========================================================
class LiveState:
    """Everything the local dashboard shows. Written by the threads, read by the web page."""

    def __init__(self):
        self.lock = threading.Lock()
        self.jpg = None
        self.frame = {}
        self.data = {"started": time.time()}
        self.events = deque(maxlen=20)

    def update(self, **kw):
        with self.lock:
            self.data.update(kw)

    def set_frame(self, jpg, frame):
        with self.lock:
            self.jpg, self.frame = jpg, frame

    def event(self, kind, text):
        with self.lock:
            self.events.appendleft({"t": datetime.now().strftime("%H:%M:%S"), "kind": kind, "text": text})

    def snapshot(self):
        with self.lock:
            return {**self.data, "now": time.time(), "frame": self.frame, "events": list(self.events)}

    def get_jpg(self):
        with self.lock:
            return self.jpg


live = LiveState()

DASHBOARD_HTML = r"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Pig Monitoring - Pi</title>
<style>
  :root { --bg:#0f1115; --card:#181b22; --line:#262a33; --text:#e7e9ee; --dim:#8b91a0;
          --green:#22c55e; --red:#ef4444; --amber:#f59e0b; --blue:#3b82f6; --pink:#ec4899; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font:14px/1.4 system-ui, sans-serif; }
  header { display:flex; align-items:center; justify-content:space-between; padding:10px 16px;
           border-bottom:1px solid var(--line); }
  header h1 { font-size:16px; margin:0; }
  .pill { display:inline-block; padding:2px 8px; border-radius:99px; font-size:12px; background:var(--line); }
  .ok { background:rgba(34,197,94,.15); color:var(--green); }
  .bad { background:rgba(239,68,68,.15); color:var(--red); }
  .warn { background:rgba(245,158,11,.15); color:var(--amber); }
  main { display:grid; grid-template-columns: minmax(0,1.6fr) minmax(0,1fr); gap:12px; padding:12px; }
  @media (max-width: 900px) { main { grid-template-columns: 1fr; } }
  .card { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:12px; }
  .card h2 { font-size:12px; text-transform:uppercase; letter-spacing:.06em; color:var(--dim); margin:0 0 8px; }
  .cam { position:relative; width:100%; aspect-ratio:4/3; background:#000; border-radius:8px; overflow:hidden; }
  .cam img, .cam canvas { position:absolute; inset:0; width:100%; height:100%; }
  .cam .msg { position:absolute; inset:0; display:flex; align-items:center; justify-content:center; color:var(--dim); }
  .stats { display:grid; grid-template-columns:repeat(4,1fr); gap:8px; margin-top:10px; }
  .stat { background:var(--bg); border-radius:8px; padding:8px; text-align:center; }
  .stat b { display:block; font-size:22px; }
  .stat span { color:var(--dim); font-size:12px; }
  .side { display:flex; flex-direction:column; gap:12px; }
  .row { display:flex; justify-content:space-between; align-items:center; padding:4px 0; }
  .big { font-size:26px; font-weight:600; }
  .grid2 { display:grid; grid-template-columns:1fr 1fr; gap:8px; }
  .bar { height:8px; background:var(--bg); border-radius:99px; overflow:hidden; flex:1; margin:0 8px; }
  .bar i { display:block; height:100%; width:0; border-radius:99px; transition:width .3s; }
  .cls { display:flex; align-items:center; font-size:12px; padding:3px 0; }
  .cls .name { width:130px; color:var(--dim); }
  .cls .val { width:40px; text-align:right; }
  .events { max-height:180px; overflow:auto; font-size:12px; }
  .events div { padding:3px 0; border-bottom:1px solid var(--line); }
  .dim { color:var(--dim); }
</style>
</head>
<body>
<header>
  <h1>🐷 Pig Monitoring - Raspberry Pi</h1>
  <div><span id="clock" class="dim"></span> &nbsp; <span id="conn" class="pill">connecting…</span></div>
</header>
<main>
  <section class="card">
    <h2>Pen camera <span id="camState" class="pill"></span> <span id="camAge" class="dim"></span></h2>
    <div class="cam">
      <img id="img" alt="">
      <canvas id="cv"></canvas>
      <div class="msg" id="camMsg">Waiting for the camera…</div>
    </div>
    <div class="stats">
      <div class="stat"><b id="sPigs">-</b><span>Pigs</span></div>
      <div class="stat"><b id="sPiglets">-</b><span>Piglets</span></div>
      <div class="stat"><b id="sMoving" style="color:var(--green)">-</b><span>Moving</span></div>
      <div class="stat"><b id="sResting" style="color:var(--blue)">-</b><span>Resting</span></div>
    </div>
    <div class="row dim" style="margin-top:6px"><span>AI time per frame</span><span id="sInfer">-</span></div>
  </section>

  <div class="side">
    <section class="card">
      <h2>Temperature</h2>
      <div class="grid2">
        <div><div class="dim">Ambient</div><div class="big" id="tAmb">--</div></div>
        <div><div class="dim">Floor</div><div class="big" id="tFloor">--</div></div>
      </div>
    </section>

    <section class="card">
      <h2>Relays</h2>
      <div class="row"><span>💡 Heating bulb <span class="dim" id="bulbMode"></span></span><span id="bulb" class="pill">-</span></div>
      <div class="row"><span>💧 Water solenoid <span class="dim" id="solMode"></span></span><span id="sol" class="pill">-</span></div>
    </section>

    <section class="card">
      <h2>Sound (live, every 1s) <span id="micState" class="pill"></span></h2>
      <div class="row"><span class="big" id="db">--</span>
        <div class="bar"><i id="dbBar" style="background:var(--pink)"></i></div></div>
      <div id="classes"></div>
      <div class="row dim" style="font-size:12px"><span>Background noise</span><span id="bg">-</span></div>
      <div class="row dim" style="font-size:12px"><span>AI listens above</span><span id="gate">-</span></div>
      <div class="row" style="margin-top:6px"><span class="dim">Last minute</span><span id="window" class="pill">-</span></div>
    </section>

    <section class="card">
      <h2>Events</h2>
      <div class="events" id="events"><div class="dim">No events yet</div></div>
    </section>

    <section class="card">
      <h2>Raspberry Pi</h2>
      <div class="row"><span class="dim">CPU temp</span><span id="cpu">-</span></div>
      <div class="row"><span class="dim">Uptime</span><span id="uptime">-</span></div>
      <div class="row"><span class="dim">Supabase settings</span><span id="settings">-</span></div>
    </section>
  </div>
</main>

<script>
const CLASSES = ["Cough / Sneeze", "Stress / Fight", "Normal sounds", "Feeding", "Cleaning / Work"];
const COLORS = ["#ef4444", "#f59e0b", "#22c55e", "#3b82f6", "#8b5cf6"];
const $ = (id) => document.getElementById(id);
let lastFrameT = 0, lastFrame = null;

$("classes").innerHTML = CLASSES.map((c, i) =>
  `<div class="cls"><span class="name">${c}</span><div class="bar"><i id="p${i}" style="background:${COLORS[i]}"></i></div><span class="val" id="v${i}">-</span></div>`
).join("");

function pill(el, text, cls) { el.textContent = text; el.className = "pill " + (cls || ""); }
function fmtT(v) { return v === null || v === undefined ? "--" : Number(v).toFixed(1) + "°C"; }
function fmtUp(s) { s = Math.floor(s); const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60); return h + "h " + m + "m"; }

function drawBoxes() {
  const img = $("img"), cv = $("cv");
  const w = cv.clientWidth, h = cv.clientHeight;
  cv.width = w; cv.height = h;
  const ctx = cv.getContext("2d");
  ctx.clearRect(0, 0, w, h);
  if (!lastFrame || !img.naturalWidth) return;
  // image is shown with object-fit: fill (stretched to the box), same as the boxes
  for (const d of lastFrame.detections || []) {
    const [l, t, bw, bh] = d.bbox;
    const color = d.isMoving ? "#22c55e" : "#3b82f6";
    ctx.strokeStyle = color; ctx.lineWidth = d.label === "Piglet" ? 2 : 3;
    ctx.strokeRect(l * w, t * h, bw * w, bh * h);
    const tag = `#${d.id} ${d.label} ${d.isMoving ? "Moving" : "Resting"} ${Math.round(d.score * 100)}%`;
    ctx.font = "12px system-ui";
    const tw = ctx.measureText(tag).width + 8;
    ctx.fillStyle = color; ctx.fillRect(l * w, Math.max(0, t * h - 18), tw, 18);
    ctx.fillStyle = "#000"; ctx.fillText(tag, l * w + 4, Math.max(13, t * h - 5));
  }
}
window.addEventListener("resize", drawBoxes);

async function tick() {
  let s;
  try {
    const r = await fetch("/state.json", { cache: "no-store" });
    s = await r.json();
    pill($("conn"), "live", "ok");
  } catch (e) {
    pill($("conn"), "Pi not responding", "bad");
    return;
  }
  $("clock").textContent = new Date().toLocaleTimeString();

  // --- camera ---
  const f = s.frame || {};
  const camOk = s.cam_state === "ok";
  pill($("camState"), s.cam_state || "off", camOk ? "ok" : (s.cam_state === "paused" ? "warn" : "bad"));
  if (f.t) {
    const age = Math.round((s.now * 1000 - f.t) / 1000);
    $("camAge").textContent = age <= 1 ? "now" : age + "s ago";
    if (f.t !== lastFrameT) {
      lastFrameT = f.t;
      const img = new Image();
      img.onload = () => { $("img").src = img.src; lastFrame = f; $("camMsg").style.display = "none"; drawBoxes(); };
      img.src = "/frame.jpg?t=" + f.t;
    }
    const moving = (f.detections || []).filter(d => d.isMoving).length;
    $("sPigs").textContent = f.pigs ?? "-";
    $("sPiglets").textContent = f.piglets ?? "-";
    $("sMoving").textContent = moving;
    $("sResting").textContent = (f.detections || []).length - moving;
    $("sInfer").textContent = (f.infer_ms ?? "-") + " ms";
  }

  // --- temps + relays ---
  $("tAmb").textContent = fmtT(s.ambient);
  $("tFloor").textContent = fmtT(s.floor);
  pill($("bulb"), s.bulb ? "ON" : "OFF", s.bulb ? "warn" : "");
  pill($("sol"), s.solenoid ? "ON" : "OFF", s.solenoid ? "ok" : "");
  $("bulbMode").textContent = s.bulb_mode ? "(" + s.bulb_mode + ")" : "";
  $("solMode").textContent = s.solenoid_mode ? "(" + s.solenoid_mode + (s.trigger ? " ≥" + s.trigger + "°C" : "") + ")" : "";
  // same wording as the website relay card
  if (s.cooling && s.cooling !== "normal") {
    pill($("sol"), (s.solenoid ? "ON" : "OFF") + " · HEAT PROTECTION " + s.cooling, s.solenoid ? "ok" : "warn");
    if (!s.bulb) pill($("bulb"), "OFF · forced by heat protection", "");
  }

  // --- sound ---
  pill($("micState"), s.mic_state === "ok" && s.audio_quiet ? "quiet - AI skipped" : (s.mic_state || "off"),
       s.mic_state === "ok" ? (s.audio_quiet ? "" : "ok") : "bad");
  if (s.audio_level !== undefined && s.audio_level !== null) {
    $("db").textContent = Math.round(s.audio_level) + " dB";
    $("dbBar").style.width = Math.max(0, Math.min(100, (s.audio_level - 30) / 75 * 100)) + "%";
  }
  $("bg").textContent = s.audio_bg ? Math.round(s.audio_bg) + " dB" : "learning…";
  $("gate").textContent = s.audio_gate ? Math.round(s.audio_gate) + " dB" : "-";
  (s.audio_probs || []).forEach((p, i) => {
    $("p" + i).style.width = Math.round(p * 100) + "%";
    $("v" + i).textContent = Math.round(p * 100) + "%";
  });
  if (s.audio_window) {
    const w = s.audio_window;
    pill($("window"), w.status + " · " + w.top_class + " @" + w.at, w.status === "HEALTHY" ? "ok" : "bad");
  }

  // --- events ---
  if (s.events && s.events.length) {
    $("events").innerHTML = s.events.map(e =>
      `<div><span class="dim">${e.t}</span> &nbsp;${e.kind === "alert" ? "⚠️" : "•"} ${e.text}</div>`).join("");
  }

  // --- pi ---
  $("cpu").textContent = s.cpu || "-";
  $("uptime").textContent = fmtUp(s.now - s.started);
  pill($("settings"), s.settings_loaded ? "loaded" : "not loaded", s.settings_loaded ? "ok" : "bad");
}

tick();
setInterval(tick, 1000);
</script>
</body>
</html>
"""


class DashboardHandler(BaseHTTPRequestHandler):
    def log_message(self, *args):     # keep the journal clean
        pass

    def _send(self, code, body, ctype):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        try:
            if path in ("/", "/index.html"):
                self._send(200, DASHBOARD_HTML.encode(), "text/html; charset=utf-8")
            elif path == "/state.json":
                self._send(200, json.dumps(live.snapshot()).encode(), "application/json")
            elif path == "/frame.jpg":
                jpg = live.get_jpg()
                if jpg:
                    self._send(200, jpg, "image/jpeg")
                else:
                    self._send(404, b"no frame yet", "text/plain")
            else:
                self._send(404, b"not found", "text/plain")
        except (BrokenPipeError, ConnectionResetError):
            pass


def start_dashboard():
    try:
        server = ThreadingHTTPServer(("0.0.0.0", DASH_PORT), DashboardHandler)
    except OSError as e:
        log.error("Local dashboard could not start on port %d: %s", DASH_PORT, e)
        return None
    server.daemon_threads = True
    threading.Thread(target=server.serve_forever, name="dashboard", daemon=True).start()
    log.info("Local dashboard: http://localhost:%d  (or http://<pi-ip>:%d from your PC)", DASH_PORT, DASH_PORT)
    return server


# ========================================================
# --- PI HEALTH ---
# ========================================================
def cpu_temp():
    try:
        with open("/sys/class/thermal/thermal_zone0/temp") as f:
            return f"{int(f.read()) / 1000:.1f}C"
    except OSError:
        return "?"


def mem_free_mb():
    try:
        with open("/proc/meminfo") as f:
            for line in f:
                if line.startswith("MemAvailable:"):
                    return int(line.split()[1]) // 1024
    except OSError:
        pass
    return -1


def throttled():
    """Pi undervoltage / throttling flags (0x0 = all good)"""
    try:
        out = subprocess.run(["vcgencmd", "get_throttled"], capture_output=True, text=True, timeout=3)
        return out.stdout.strip().split("=")[-1] or "?"
    except Exception:
        return "?"


# ========================================================
# --- MAIN LOOP: SETTINGS, SENSORS, RELAYS, SENSOR LOGS ---
# ========================================================
def main():
    parser = argparse.ArgumentParser(description="Pig Monitoring - Raspberry Pi (everything)")
    parser.add_argument("--no-vision", action="store_true", help="don't run the camera/YOLO part")
    parser.add_argument("--no-audio", action="store_true", help="don't run the microphone part")
    parser.add_argument("--no-dashboard", action="store_true", help="don't serve the local dashboard")
    parser.add_argument("--test-audio", metavar="FILE", help="run the cough check on an audio file and exit")
    args = parser.parse_args()

    if args.test_audio:
        return test_audio_file(args.test_audio)

    def stop(*_):
        stop_event.set()

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)

    # Relays first so they are OFF right away
    relays = Relays()
    relays.all_off()
    logic = RelayLogic()

    sb_url, sb_key = load_supabase_config()
    sb = Supabase(sb_url, sb_key)
    log.info("Pig Monitoring Pi starting (Supabase: %s)", sb_url)

    try:
        mlx = MLX90614()
    except Exception as e:
        mlx = None
        log.error("MLX90614 not available (%s) -> no temperatures", e)

    vision = None if args.no_vision else VisionWorker(sb_url, sb_key)
    audio = None if args.no_audio else MicWorker(sb_url, sb_key)

    try:
        settings.apply(sb.select("system_settings", {"select": "setting_key,setting_value"}))
    except requests.RequestException as e:
        log.warning("Settings fetch failed (relays stay OFF until it works): %s", e)

    dashboard = None if args.no_dashboard else start_dashboard()
    publisher = RelayStatePublisher(Supabase(sb_url, sb_key))
    publisher.start()
    sms_worker = SmsWorker(sb_url, sb_key)
    sms_worker.start()
    sms = SmsAlerts(sms_worker)

    for worker in (vision, audio):
        if worker:
            worker.start()

    boot = time.time()
    last_settings = last_sync = time.time()
    last_status = time.time() - STATUS_EVERY_S + 15     # first status ~15s after start
    ambient = floor = None
    mlx_fail_logged = False

    while not stop_event.is_set():
        now = time.time()

        # --- 1. Settings (every 10s) ---
        if now - last_settings >= SETTINGS_EVERY_S:
            last_settings = now
            try:
                rows = sb.select("system_settings", {"select": "setting_key,setting_value"})
                settings.apply(rows)
                sms.check_test(next((r.get("setting_value") for r in rows
                                     if r.get("setting_key") == "sms_test_request"), ""))
            except requests.RequestException as e:
                log.warning("Settings fetch failed: %s", e)

        # --- 2. Temperatures (every 1s) ---
        if mlx:
            ambient, floor = mlx.ambient(), mlx.floor()
            if ambient is None and floor is None and not mlx_fail_logged:
                log.warning("MLX90614 not answering (check wiring / i2cdetect -y 1)")
                mlx_fail_logged = True
            elif ambient is not None:
                mlx_fail_logged = False

        # --- 3. Relays ---
        bulb_on, solenoid_on = logic.decide(ambient, floor, datetime.now())
        relays.set(bulb_on, solenoid_on)
        st = logic.state()
        publisher.update({"bulb": relays.bulb_on, "solenoid": relays.solenoid_on,
                          "bulb_mode": settings.bulb_mode, "solenoid_mode": settings.solenoid_mode, **st},
                         (relays.bulb_on, relays.solenoid_on, st["phase"], st["cycle"]))
        sms.tick(ambient, floor, logic, vision)

        live.update(ambient=ambient, floor=floor,
                    bulb=relays.bulb_on, solenoid=relays.solenoid_on,
                    bulb_mode=settings.bulb_mode, solenoid_mode=settings.solenoid_mode,
                    trigger=logic.trigger(), cooling=logic.status(), settings_loaded=settings.loaded,
                    cam_state=vision.state if vision else "off",
                    mic_state=audio.state if audio else "off",
                    cpu=cpu_temp())

        # --- 4. Sensor log: right away when a new audio clip is ready, else every sync interval ---
        audio_item = None
        if audio:
            try:
                audio_item = audio.results.get_nowait()
            except queue.Empty:
                pass

        if audio_item or now - last_sync >= settings.sync_interval:
            last_sync = now
            audio_url, audio_result = audio_item if audio_item else (None, None)
            sms.on_audio(audio_result)
            noise = audio.take_peak_db() if audio else None
            motion = bool(vision and vision.moving > 0 and time.time() - vision.last_frame_time < 30)
            row = {
                "ambient_temp": ambient,
                "floor_temp": floor,
                "audio_level": int(round(noise)) if noise is not None else None,
                "motion_detected": motion,
                "audio_url": audio_url,
            }
            try:
                log_id = sb.insert_returning_id("sensor_logs", row)
                log.info("[SENSORS] ambient=%s C floor=%s C noise=%s dB motion=%s bulb=%s solenoid=%s cooling=%s%s",
                         ambient, floor, row["audio_level"], motion,
                         "ON" if relays.bulb_on else "OFF", "ON" if relays.solenoid_on else "OFF",
                         logic.status(),
                         " +clip" if audio_url else "")
                if audio_result:
                    sb.insert("audio_detections", {"sensor_log_id": log_id, "audio_url": audio_url, **audio_result})
            except requests.RequestException as e:
                log.warning("Sensor log upload failed: %s", e)

        # --- 5. Health (every 60s) ---
        if now - last_status >= STATUS_EVERY_S:
            last_status = now
            pi_status = (f"uptime={int((now - boot) / 60)}min cpu={cpu_temp()} "
                         f"load={os.getloadavg()[0]:.2f} memfree={mem_free_mb()}MB throttled={throttled()} "
                         f"ambient={ambient} floor={floor} "
                         f"bulb={'ON' if relays.bulb_on else 'OFF'} solenoid={'ON' if relays.solenoid_on else 'OFF'} "
                         f"settings={'ok' if settings.loaded else 'NOT_LOADED'}")
            if audio:
                pi_status += " " + audio.status_text()
            pi_status += " " + sms_worker.status_text()
            for key, value in (("pi_status", pi_status),
                               ("cam_status", vision.status_text() if vision else None)):
                if value is None:
                    continue
                try:
                    sb.set_setting(key, value)
                except requests.RequestException as e:
                    log.warning("Status report failed: %s", e)
            log.info("[STATUS] %s", pi_status)
            if vision:
                log.info("[CAM] %s", vision.status_text())

            for worker in (vision, audio):
                if worker and not worker.is_alive():
                    log.error("%s thread died -> exiting so systemd restarts us", worker.name)
                    stop_event.set()

        stop_event.wait(max(0.0, 1.0 - (time.time() - now)))

    log.info("Stopping... (relays OFF)")
    relays.all_off()
    if dashboard:
        dashboard.shutdown()
    for worker in (vision, audio):
        if worker:
            worker.join(timeout=10)
    log.info("Stopped")
    return 0


if __name__ == "__main__":
    sys.exit(main())
