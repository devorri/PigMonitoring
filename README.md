# 🐷 SwineBarn AI - Pig Monitoring System

An intelligent IoT and Precision Livestock Farming (PLF) monitoring system for pig barns, integrating **Real-Time Computer Vision (YOLOv8)**, **Acoustic Cough & Distress Detection (Deep Learning ResNet-18)**, **Environmental Sensing**, and a **Vite + React Dashboard with Supabase synchronization**.

---

## 🚀 Key Capabilities

### 1. 👁️ Vision: Pig & Piglet Detection (YOLOv8)
* **Model**: `best (1).pt` (PyTorch) / `public/models/best.onnx` (Web ONNX)
* **Detection Classes**:
  * `Pig` (Adult swine)
  * `Piglet`
* **Features**: Live camera feed tracking, bounding boxes, herd mobility rate calculation, moving vs. resting analysis.
* **Script**: `detect_pig.py`

### 2. 🎧 Audio: Swine Cough & Distress Classification (ResNet-18)
* **Model**: `best_pig_audio.pth` (PyTorch) / `public/models/pig_audio.onnx` (ONNX)
* **Trained on**: aSwine Audio Dataset (~15 hrs of real-world barn acoustics at 16 kHz)
* **Detection Classes**:
  1. `Coughing / Sneezing` (*Tosse/Espirro* — Early indicator of PRRS, Swine Flu, or respiratory illness)
  2. `Stress / Disputes` (*Estresse/Disputas* — Aggressive fights, screaming, crushing distress)
  3. `Normal Pig Sounds` (*OutrosA* — Baseline grunting, chewing, peaceful snorting)
  4. `Feeding Activity` (*Alimentação de Baias*)
  5. `Cleaning / Barn Work` (*Limpeza de Baia*)
* **Script**: `detect_audio.py`

### 3. 🌐 Full-Stack Web Dashboard & IoT Sync
* **Frontend**: React + TypeScript + Vite + Vanilla CSS
* **Database & Realtime**: Supabase (`sensor_logs`, `contacts`, `system_settings`)
* **Hardware Actuators**: Dual-relay control (Infrared heating lamp schedule + misting solenoid valve)

---

## 🍓 Raspberry Pi 4 AI Engine (`pi/`)

The AI now runs on a **Raspberry Pi 4** instead of the browser / PC:

```
ESP32-CAM ──USB──> Raspberry Pi 4 ──> Supabase ──> Website
MLX90614  ──I2C──>   • YOLOv8 pig/piglet detection + moving/resting tracking
INMP441   ──I2S──>   • Non-stop audio cough/stress model (every 1s)
Relays   <──GPIO──   • Temperatures, heating bulb + water solenoid, sensor_logs
(The main ESP32 is no longer used)
```

| Part | What it does |
|------|--------------|
| `firmware/pig_esp32cam` | ESP32-CAM is now a **USB camera** for the Pi (no Wi-Fi). Sits on the ESP32-CAM-MB board. |
| `firmware/pig_main_esp32` | **Not used anymore** (sensors, mic and relays are on the Pi now). Kept for reference. |
| `pi/app.py` | Camera AI (`best.onnx` -> `snap/live_*.jpg` + `snap/live.json`), non-stop mic AI (`pig_audio.onnx` -> `audio_detections` + `audio/periodic_sound.wav`), MLX90614 temps, relays from Supabase settings, `sensor_logs`, `cam_status` + `pi_status`. Wiring is in the top of the file. |
| Website "Pen" mode | Shows the Pi's image + boxes from `snap/live.json` (Webcam / Video modes still run YOLO in the browser). |

### Setup
1. Run `supabase_pi_setup.sql` in the Supabase SQL Editor.
2. Flash `firmware/pig_esp32cam` to the ESP32-CAM, put it on the ESP32-CAM-MB board, plug it into the Pi.
3. Copy this project to the Pi (Raspberry Pi OS **64-bit**), then:
   ```bash
   cd PigMonitoringSystem/pi
   bash install.sh
   journalctl -u pigmonitor -f      # live logs
   ```
4. Settings on the website: `cam_live_enabled`, `cam_live_interval_seconds` (2-60), `cam_flash` (off / on / night).

Don't run `audio_worker.py` on the PC anymore, the Pi does the audio now.

---

## 📦 File Structure

```
PigMonitoringSystem/
├── best (1).pt               # Trained YOLOv8 vision model
├── best_pig_audio.pth        # Trained ResNet-18 Swine Audio model (PyTorch)
├── best_pig_audio.onnx       # Exported self-contained ONNX audio model
├── detect_pig.py             # Vision detection script (image/webcam/video)
├── detect_audio.py           # Audio classification & live listening script
├── monitor_farm.py           # Unified runner (Vision + Audio simultaneous)
├── public/models/
│   ├── best.onnx             # Browser-based ONNX vision model
│   └── pig_audio.onnx        # Browser-based ONNX audio model
├── src/                      # React web dashboard application
└── .env                      # Supabase credentials
```

---

## 🛠️ Usage Instructions

### Audio Monitoring (`detect_audio.py`)

#### 1. Quick Self-Test Demo
Runs simulated barn signals (grunt, cough pulse, distress scream) to verify model inference:
```bash
python detect_audio.py --demo
```

#### 2. Classify an Audio File (.wav, .mp3, .ogg)
Analyzes 1-second chunks and prints a detailed health assessment:
```bash
python detect_audio.py --source recordings/barn_sample.wav
```

#### 3. Real-Time Microphone Listener
Monitors the pen microphone continuously:
```bash
python detect_audio.py --live
```

#### 4. Live Monitoring with Automatic Supabase Alerts
Automatically pushes high-alert events (`Coughing` or `Distress`) to Supabase `sensor_logs`:
```bash
python detect_audio.py --live --supabase --threshold 0.45
```

---

### Vision Detection (`detect_pig.py`)

```bash
# Run on an image
python detect_pig.py dataset-cover.png

# Run live on webcam
python detect_pig.py 0

# Run on a video file
python detect_pig.py pen_feed.mp4
```

---

### 🌟 Unified All-in-One Engine (`monitor_farm.py`)

Runs both YOLOv8 camera tracking and microphone audio monitoring concurrently:
```bash
# Run both Vision + Audio simultaneously
python monitor_farm.py --mode all

# Run demo test
python monitor_farm.py --mode demo
```

---

### 💻 Running the Web Dashboard

```bash
# Install dependencies
npm install

# Start local Vite development server
npm run dev

# Build for production
npm run build
```
