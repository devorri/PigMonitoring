"""
Pig Audio Classification & Cough/Distress Monitoring Script
Using trained SwineAudioClassifier (best_pig_audio.pth / best_pig_audio.onnx)
"""

import os
import sys
import time
import math
import argparse
from pathlib import Path

# Ensure UTF-8 output on Windows terminals
if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding='utf-8', errors='replace')
        sys.stderr.reconfigure(encoding='utf-8', errors='replace')
    except Exception:
        pass

import torch
import torch.nn as nn
import torchaudio
import torchaudio.transforms as T
import numpy as np

# -------------------------------------------------------------
# 1. Swine Audio Classifier Architecture (Matches best_pig_audio.pth)
# -------------------------------------------------------------
from torchvision.models import resnet18

class SwineAudioClassifier(nn.Module):
    def __init__(self, num_classes=5):
        super().__init__()
        self.backbone = resnet18(weights=None)
        # 1-channel log Mel-Spectrogram input
        self.backbone.conv1 = nn.Conv2d(1, 64, kernel_size=7, stride=2, padding=3, bias=False)
        # 5 multi-label output classes
        self.backbone.fc = nn.Linear(self.backbone.fc.in_features, num_classes)
        
    def forward(self, x):
        return self.backbone(x)

CLASSES = [
    "Coughing / Sneezing",   # 0: TosseEspirro
    "Stress / Disputes",     # 1: EstresseDisputas
    "Normal Pig Sounds",     # 2: OutrosA (Grunts / Snorts)
    "Feeding Activity",      # 3: Alimentação de Baias
    "Cleaning / Activity",   # 4: Limpeza de Baia
]

CLASS_BADGES = [
    "[COUGH]",
    "[STRESS]",
    "[NORMAL]",
    "[FEEDING]",
    "[BARN-WORK]",
]

# -------------------------------------------------------------
# 2. Audio Processing Pipeline
# -------------------------------------------------------------
SAMPLE_RATE = 16000
CHUNK_DURATION = 1.0  # seconds
TARGET_SAMPLES = int(SAMPLE_RATE * CHUNK_DURATION)  # 16000

mel_transform = T.MelSpectrogram(
    sample_rate=SAMPLE_RATE,
    n_fft=1024,
    hop_length=512,
    n_mels=64
)
amp_to_db = T.AmplitudeToDB()

def waveform_to_spectrogram(waveform: torch.Tensor, orig_sr: int) -> torch.Tensor:
    """Converts a 1D or 2D audio waveform to a normalized Log-Mel Spectrogram."""
    # Ensure 2D [channels, samples]
    if waveform.dim() == 1:
        waveform = waveform.unsqueeze(0)
    elif waveform.dim() == 2 and waveform.shape[0] > 1:
        # Convert stereo to mono by averaging
        waveform = torch.mean(waveform, dim=0, keepdim=True)

    # Resample if needed
    if orig_sr != SAMPLE_RATE:
        waveform = T.Resample(orig_sr, SAMPLE_RATE)(waveform)

    # Pad or slice to exactly TARGET_SAMPLES
    samples = waveform.shape[1]
    if samples < TARGET_SAMPLES:
        waveform = nn.functional.pad(waveform, (0, TARGET_SAMPLES - samples))
    else:
        waveform = waveform[:, :TARGET_SAMPLES]

    # Compute Mel-Spectrogram + dB
    spec = amp_to_db(mel_transform(waveform))  # Shape: [1, 64, 32]
    # Add batch dimension: [1, 1, 64, 32]
    return spec.unsqueeze(0)

def calculate_db_level(waveform: np.ndarray) -> float:
    """Computes approximate sound pressure level (dB) from PCM float array."""
    rms = np.sqrt(np.mean(np.square(waveform)))
    if rms <= 1e-7:
        return 30.0
    db = 20 * math.log10(rms) + 94.0  # Normalized to ~30-100 dB SPL scale
    return max(35.0, min(105.0, round(db, 1)))

# -------------------------------------------------------------
# 3. Model Loading
# -------------------------------------------------------------
def load_model(model_path="best_pig_audio.pth", device=None):
    if device is None:
        device = torch.device("cuda" if torch.cuda.is_available() else "cpu")

    if not Path(model_path).exists():
        print(f"[ERROR] Model file '{model_path}' not found.")
        sys.exit(1)

    print(f"[INFO] Loading Swine Audio Classifier from: {model_path} (on {device})")
    model = SwineAudioClassifier(num_classes=len(CLASSES)).to(device)
    
    state_dict = torch.load(model_path, map_location=device)
    model.load_state_dict(state_dict)
    model.eval()
    return model, device

# -------------------------------------------------------------
# 4. Supabase Alert Logger (Optional Integration)
# -------------------------------------------------------------
def log_to_supabase(event_type: str, confidence: float, db_level: float):
    """Optionally inserts high-alert sound events into Supabase sensor_logs."""
    env_file = Path(".env")
    if not env_file.exists():
        return

    url = None
    key = None
    with open(env_file, "r") as f:
        for line in f:
            line = line.strip()
            if line.startswith("VITE_SUPABASE_URL="):
                url = line.split("=", 1)[1].strip()
            elif line.startswith("VITE_SUPABASE_ANON_KEY="):
                key = line.split("=", 1)[1].strip()

    if not url or not key:
        return

    try:
        import requests
        headers = {
            "apikey": key,
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
            "Prefer": "return=minimal"
        }
        payload = {
            "ambient_temp": 23.5,
            "floor_temp": 22.0,
            "motion_detected": True,
            "audio_level": int(db_level),
            "audio_url": "https://actions.google.com/sounds/v1/animals/pig_grunt.ogg"
        }
        endpoint = f"{url.rstrip('/')}/rest/v1/sensor_logs"
        res = requests.post(endpoint, json=payload, headers=headers, timeout=3)
        if res.status_code in (200, 201):
            print(f"   [SUPABASE SYNC] Alert logged to sensor_logs (Audio Level: {int(db_level)} dB)")
    except Exception as e:
        print(f"   [WARNING] Failed to sync to Supabase: {e}")

def load_audio_file(audio_path: str):
    """Loads audio using soundfile or scipy with fallback to torchaudio."""
    try:
        import soundfile as sf
        data, sr = sf.read(audio_path, dtype='float32')
        if data.ndim == 1:
            waveform = torch.from_numpy(data).unsqueeze(0)
        else:
            waveform = torch.from_numpy(data.T)
        return waveform, sr
    except Exception:
        pass

    try:
        import scipy.io.wavfile as wav
        sr, data = wav.read(audio_path)
        if data.dtype == np.int16:
            data = data.astype(np.float32) / 32768.0
        elif data.dtype == np.int32:
            data = data.astype(np.float32) / 2147483648.0
        elif data.dtype == np.uint8:
            data = (data.astype(np.float32) - 128.0) / 128.0

        if data.ndim == 1:
            waveform = torch.from_numpy(data).unsqueeze(0)
        else:
            waveform = torch.from_numpy(data.T)
        return waveform, sr
    except Exception:
        pass

    return torchaudio.load(audio_path)

# -------------------------------------------------------------
# 5. Audio File Classification
# -------------------------------------------------------------
def classify_audio_file(audio_path: str, model, device, threshold: float = 0.45, sync_supabase: bool = False):
    if not Path(audio_path).exists():
        print(f"[ERROR] Audio file '{audio_path}' not found.")
        return

    print(f"\n[AUDIO] Loading file: {audio_path}")
    waveform, sr = load_audio_file(audio_path)
    total_samples = waveform.shape[1]
    total_seconds = total_samples / sr
    print(f"   Duration: {total_seconds:.2f}s | Sample Rate: {sr} Hz | Channels: {waveform.shape[0]}")

    chunk_samples = int(sr * CHUNK_DURATION)
    num_chunks = max(1, math.ceil(total_samples / chunk_samples))
    print(f"   Analyzing {num_chunks} segment(s) ({CHUNK_DURATION}s each)...\n")

    print(f"{'Time':<12} | {'Top Detected Event':<26} | {'Confidence':<10} | {'Status'}")
    print("-" * 68)

    cough_count = 0
    stress_count = 0

    for i in range(num_chunks):
        start_samp = i * chunk_samples
        end_samp = min((i + 1) * chunk_samples, total_samples)
        chunk = waveform[:, start_samp:end_samp]

        # Calculate dB level
        chunk_np = chunk.cpu().numpy()
        db_level = calculate_db_level(chunk_np)

        # Preprocess to spectrogram
        spec = waveform_to_spectrogram(chunk, sr).to(device)

        with torch.no_grad():
            logits = model(spec)
            probs = torch.sigmoid(logits)[0].cpu().numpy()

        start_time = i * CHUNK_DURATION
        end_time = min((i + 1) * CHUNK_DURATION, total_seconds)
        time_str = f"{start_time:4.1f}s - {end_time:4.1f}s"

        top_idx = int(np.argmax(probs))
        top_prob = float(probs[top_idx])
        top_class = CLASSES[top_idx]
        badge = CLASS_BADGES[top_idx]

        # Check for specific cough/stress alerts
        cough_prob = float(probs[0])
        stress_prob = float(probs[1])

        status = "Normal"
        if cough_prob >= threshold:
            cough_count += 1
            status = ">>> COUGH DETECTED <<<"
            top_class = "Coughing / Sneezing"
            top_prob = cough_prob
            badge = "[COUGH]"
            if sync_supabase:
                log_to_supabase("cough", cough_prob, db_level)
        elif stress_prob >= threshold:
            stress_count += 1
            status = ">>> DISTRESS ALERT <<<"
            top_class = "Stress / Disputes"
            top_prob = stress_prob
            badge = "[STRESS]"
            if sync_supabase:
                log_to_supabase("stress", stress_prob, db_level)

        print(f"{time_str:<12} | {badge} {top_class:<20} | {top_prob*100:5.1f}%     | {status}")

    print("\n" + "=" * 68)
    print("SUMMARY REPORT:")
    print(f"   * Total Analyzed Time: {total_seconds:.1f}s")
    print(f"   * Coughing/Sneezing Events: {cough_count}")
    print(f"   * Distress/Dispute Events:  {stress_count}")
    health_status = "HEALTHY" if cough_count == 0 and stress_count == 0 else "ATTENTION NEEDED"
    print(f"   * Health Assessment: {health_status}")
    print("=" * 68 + "\n")

# -------------------------------------------------------------
# 6. Live Microphone Monitoring
# -------------------------------------------------------------
def monitor_live_microphone(model, device, threshold: float = 0.50, sync_supabase: bool = False):
    try:
        import sounddevice as sd
    except ImportError:
        print("[ERROR] sounddevice is not installed. Please install with: pip install sounddevice")
        return

    print("\n[LIVE MONITOR] Starting Swine Barn Audio Listener")
    print("   Listening on default microphone (16 kHz)...")
    print("   Press Ctrl+C to stop monitoring.\n")
    print(f"{'Time':<10} | {'Level':<8} | {'Event':<24} | {'Conf':<7} | {'Alert'}")
    print("-" * 65)

    buffer = np.zeros(TARGET_SAMPLES, dtype=np.float32)

    def audio_callback(indata, frames, time_info, status):
        nonlocal buffer
        if status:
            pass
        # Flatten and keep rolling buffer
        samples = indata[:, 0]
        buffer = np.roll(buffer, -len(samples))
        buffer[-len(samples):] = samples

    block_size = int(SAMPLE_RATE * 0.5)  # 500ms updates
    stream = sd.InputStream(
        samplerate=SAMPLE_RATE,
        channels=1,
        blocksize=block_size,
        dtype='float32',
        callback=audio_callback
    )

    with stream:
        while True:
            time.sleep(0.5)
            current_audio = buffer.copy()
            db_level = calculate_db_level(current_audio)

            # Skip dead silence
            if db_level < 40.0:
                continue

            tensor_audio = torch.from_numpy(current_audio).unsqueeze(0)
            spec = waveform_to_spectrogram(tensor_audio, SAMPLE_RATE).to(device)

            with torch.no_grad():
                logits = model(spec)
                probs = torch.sigmoid(logits)[0].cpu().numpy()

            cough_prob = float(probs[0])
            stress_prob = float(probs[1])
            top_idx = int(np.argmax(probs))
            top_prob = float(probs[top_idx])

            curr_time = time.strftime("%H:%M:%S")
            alert_str = ""

            if cough_prob >= threshold:
                alert_str = ">>> COUGH DETECTED! <<<"
                event_name = "Coughing/Sneezing"
                prob_val = cough_prob
                if sync_supabase:
                    log_to_supabase("cough", cough_prob, db_level)
            elif stress_prob >= threshold:
                alert_str = ">>> DISTRESS/FIGHT! <<<"
                event_name = "Stress/Disputes"
                prob_val = stress_prob
                if sync_supabase:
                    log_to_supabase("stress", stress_prob, db_level)
            else:
                event_name = CLASSES[top_idx]
                prob_val = top_prob

            bar_len = int(prob_val * 10)
            bar = "#" * bar_len + "-" * (10 - bar_len)
            print(f"{curr_time:<10} | {db_level:4.1f} dB | {event_name:<24} | {prob_val*100:4.0f}% [{bar}] | {alert_str}")

# -------------------------------------------------------------
# 7. Demo / Self-Test Mode
# -------------------------------------------------------------
def run_demo(model, device):
    print("\n[DEMO] Running Swine Audio Classifier Demo (Synthetic Barn Signals)...")
    t = torch.linspace(0, 1.0, SAMPLE_RATE)

    # 1. Simulate Normal Low Grunt (~200 Hz tone + harmonics + noise)
    grunt = 0.5 * torch.sin(2 * math.pi * 220 * t) + 0.2 * torch.randn(SAMPLE_RATE)
    spec_grunt = waveform_to_spectrogram(grunt, SAMPLE_RATE).to(device)

    # 2. Simulate High Cough Pulse (Broadband burst at 1.5 kHz - 3 kHz)
    cough = torch.zeros(SAMPLE_RATE)
    cough[4000:8000] = 0.8 * torch.sin(2 * math.pi * 1800 * t[:4000]) + 0.5 * torch.randn(4000)
    spec_cough = waveform_to_spectrogram(cough, SAMPLE_RATE).to(device)

    # 3. Simulate High-Pitched Distress Scream (~2500 - 4000 Hz)
    distress = 0.7 * torch.sin(2 * math.pi * 3200 * t) + 0.2 * torch.randn(SAMPLE_RATE)
    spec_distress = waveform_to_spectrogram(distress, SAMPLE_RATE).to(device)

    tests = [
        ("Simulated Normal Grunt", spec_grunt),
        ("Simulated Cough Pulse", spec_cough),
        ("Simulated Distress Scream", spec_distress),
    ]

    for name, spec in tests:
        with torch.no_grad():
            probs = torch.sigmoid(model(spec))[0].cpu().numpy()
        print(f"\n--- {name} ---")
        for cls_name, p in zip(CLASSES, probs):
            print(f"  * {cls_name:<22}: {p * 100:5.2f}%")
    print("\n[OK] Demo finished successfully!\n")

# -------------------------------------------------------------
# Main Entry Point
# -------------------------------------------------------------
def main():
    parser = argparse.ArgumentParser(description="Pig Barn Audio Detection & Cough Monitoring")
    parser.add_argument("--source", type=str, default=None, help="Path to audio file (.wav, .mp3, etc.)")
    parser.add_argument("--model", type=str, default="best_pig_audio.pth", help="Path to trained PyTorch model")
    parser.add_argument("--live", "--mic", action="store_true", help="Monitor live microphone audio in real time")
    parser.add_argument("--demo", action="store_true", help="Run self-test demo with synthetic signals")
    parser.add_argument("--threshold", type=float, default=0.45, help="Confidence threshold for alerts (default: 0.45)")
    parser.add_argument("--supabase", action="store_true", help="Sync alerts directly to Supabase sensor_logs table")

    args = parser.parse_args()

    model, device = load_model(args.model)

    if args.demo:
        run_demo(model, device)
    elif args.live:
        try:
            monitor_live_microphone(model, device, threshold=args.threshold, sync_supabase=args.supabase)
        except KeyboardInterrupt:
            print("\n[STOP] Stopped live monitoring.")
    elif args.source:
        classify_audio_file(args.source, model, device, threshold=args.threshold, sync_supabase=args.supabase)
    else:
        # If no arguments provided, run demo and show instructions
        print("\n[INFO] No input specified. Running self-test demo...")
        run_demo(model, device)
        print("Usage Instructions:")
        print("   1. Test an audio file:       python detect_audio.py --source barn_recording.wav")
        print("   2. Monitor live microphone:  python detect_audio.py --live")
        print("   3. Live with Supabase alert: python detect_audio.py --live --supabase")
        print("   4. Custom alert threshold:   python detect_audio.py --source file.wav --threshold 0.5\n")

if __name__ == "__main__":
    main()
