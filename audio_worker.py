"""
ESP32 Audio -> AI Model Worker
-------------------------------
Watches Supabase `sensor_logs` for new rows that carry an `audio_url`
(the ESP32 uploads a 5s WAV to the `audio` bucket every ~60s), downloads
the clip, runs the SwineAudioClassifier (best_pig_audio.pth) on it, and
saves the result to the `audio_detections` table.

Run:   python audio_worker.py
       python audio_worker.py --threshold 0.5 --poll 5
"""

import sys
import time
import json
import argparse
import tempfile
from pathlib import Path

import requests
import numpy as np
import torch

import detect_audio as da

STATE_FILE = Path(".audio_worker_state.json")


def load_env():
    url = key = None
    for line in Path(".env").read_text().splitlines():
        line = line.strip()
        if line.startswith("VITE_SUPABASE_URL="):
            url = line.split("=", 1)[1].strip()
        elif line.startswith("VITE_SUPABASE_ANON_KEY="):
            key = line.split("=", 1)[1].strip()
    if not url or not key:
        sys.exit("[ERROR] VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY missing in .env")
    return url.rstrip("/"), key


def load_last_id():
    if STATE_FILE.exists():
        return json.loads(STATE_FILE.read_text()).get("last_id", 0)
    return None


def save_last_id(last_id):
    STATE_FILE.write_text(json.dumps({"last_id": last_id}))


def classify_clip(path, model, device, threshold):
    """Runs the model on every 1s chunk of the clip and returns a summary."""
    waveform, sr = da.load_audio_file(path)
    chunk = int(sr * da.CHUNK_DURATION)
    total = waveform.shape[1]
    n_chunks = max(1, int(np.ceil(total / chunk)))

    max_cough = max_stress = 0.0
    cough_events = stress_events = 0
    class_scores = np.zeros(len(da.CLASSES))

    for i in range(n_chunks):
        seg = waveform[:, i * chunk:min((i + 1) * chunk, total)]
        spec = da.waveform_to_spectrogram(seg, sr).to(device)
        with torch.no_grad():
            probs = torch.sigmoid(model(spec))[0].cpu().numpy()
        class_scores = np.maximum(class_scores, probs)
        max_cough = max(max_cough, float(probs[0]))
        max_stress = max(max_stress, float(probs[1]))
        if probs[0] >= threshold:
            cough_events += 1
        elif probs[1] >= threshold:
            stress_events += 1

    if cough_events:
        top = da.CLASSES[0]
    elif stress_events:
        top = da.CLASSES[1]
    else:
        top = da.CLASSES[int(np.argmax(class_scores))]

    return {
        "top_class": top,
        "cough_prob": round(max_cough, 4),
        "stress_prob": round(max_stress, 4),
        "cough_events": cough_events,
        "stress_events": stress_events,
        "status": "ATTENTION NEEDED" if (cough_events or stress_events) else "HEALTHY",
    }


def main():
    parser = argparse.ArgumentParser(description="Classify ESP32 audio clips from Supabase")
    parser.add_argument("--model", default="best_pig_audio.pth")
    parser.add_argument("--threshold", type=float, default=0.45)
    parser.add_argument("--poll", type=float, default=5.0, help="seconds between checks")
    args = parser.parse_args()

    url, key = load_env()
    headers = {"apikey": key, "Authorization": f"Bearer {key}"}
    model, device = da.load_model(args.model)

    last_id = load_last_id()
    if last_id is None:
        # First run: start from the newest row so we don't reprocess old history
        r = requests.get(f"{url}/rest/v1/sensor_logs",
                         params={"select": "id", "order": "id.desc", "limit": 1},
                         headers=headers, timeout=10)
        r.raise_for_status()
        rows = r.json()
        last_id = rows[0]["id"] if rows else 0
        save_last_id(last_id)

    print(f"[WORKER] Watching sensor_logs for new ESP32 audio (after id {last_id})... Ctrl+C to stop\n")

    while True:
        try:
            r = requests.get(f"{url}/rest/v1/sensor_logs", params={
                "select": "id,created_at,audio_url",
                "id": f"gt.{last_id}",
                "audio_url": "not.is.null",
                "order": "id.asc",
                "limit": 10,
            }, headers=headers, timeout=10)
            r.raise_for_status()

            for row in r.json():
                last_id = row["id"]
                audio_url = row["audio_url"]

                clip = requests.get(audio_url, timeout=20)
                if clip.status_code != 200 or len(clip.content) < 100:
                    print(f"[SKIP] id {row['id']}: could not download clip (HTTP {clip.status_code})")
                    save_last_id(last_id)
                    continue

                with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
                    tmp.write(clip.content)
                    tmp_path = tmp.name

                result = classify_clip(tmp_path, model, device, args.threshold)
                Path(tmp_path).unlink(missing_ok=True)

                print(f"[{time.strftime('%H:%M:%S')}] log {row['id']}: {result['status']:<16} "
                      f"top={result['top_class']:<22} cough={result['cough_prob']*100:5.1f}% "
                      f"stress={result['stress_prob']*100:5.1f}%")

                ins = requests.post(f"{url}/rest/v1/audio_detections",
                                    json={"sensor_log_id": row["id"], "audio_url": audio_url, **result},
                                    headers={**headers, "Content-Type": "application/json",
                                             "Prefer": "return=minimal"},
                                    timeout=10)
                if ins.status_code not in (200, 201):
                    print(f"   [WARN] Save failed: HTTP {ins.status_code} {ins.text}")

                save_last_id(last_id)

            time.sleep(args.poll)

        except KeyboardInterrupt:
            print("\n[STOP] Worker stopped.")
            break
        except Exception as e:
            print(f"[WARN] {e}")
            time.sleep(args.poll)


if __name__ == "__main__":
    main()
