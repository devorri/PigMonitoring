"""
Run this ONCE on your PC (where PyTorch is installed), from the project root:
    python pi/verify_audio_onnx.py

Checks that the Pi version (pig_audio.onnx + numpy spectrogram, no PyTorch)
gives the same answers as the original best_pig_audio.pth + torchaudio.
"""
import sys
from pathlib import Path

import numpy as np
import torch

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "pi"))

import detect_audio as da   # original PyTorch pipeline
import app                  # Pi pipeline

wav = sys.argv[1] if len(sys.argv) > 1 else str(ROOT / "sample_barn_audio.wav")

model, device = da.load_model(str(ROOT / "best_pig_audio.pth"), device=torch.device("cpu"))
onnx_model = app.AudioClassifier(ROOT / "public" / "models" / "pig_audio.onnx")

waveform = app.load_wav_bytes(Path(wav).read_bytes())
worst_spec = worst_prob = 0.0
for i in range(max(1, int(np.ceil(len(waveform) / 16000)))):
    seg = waveform[i * 16000:(i + 1) * 16000]

    spec_torch = da.waveform_to_spectrogram(torch.from_numpy(seg.copy()), 16000)
    with torch.no_grad():
        p_torch = torch.sigmoid(model(spec_torch))[0].numpy()

    spec_np = app.waveform_to_spectrogram(seg)
    logits = onnx_model.sess.run(None, {onnx_model.input_name: spec_np})[0][0]
    p_onnx = 1 / (1 + np.exp(-logits))

    worst_spec = max(worst_spec, float(np.abs(spec_torch.numpy() - spec_np).max()))
    worst_prob = max(worst_prob, float(np.abs(p_torch - p_onnx).max()))
    print(f"chunk {i}: pth={np.round(p_torch, 3)}  pi={np.round(p_onnx, 3)}")

print(f"\nMax spectrogram difference: {worst_spec:.5f} dB")
print(f"Max probability difference: {worst_prob:.5f}")
print("OK - the Pi gives the same results" if worst_prob < 0.01 else
      "MISMATCH - pig_audio.onnx is not the same model as best_pig_audio.pth, re-export it")
