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
