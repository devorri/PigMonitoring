"""
Unified Pig Farm AI Monitor:
Simultaneously runs Computer Vision (YOLOv8) and Audio Bioacoustic Monitoring (SwineAudioClassifier)
"""

import sys
import time
import argparse
import subprocess
from pathlib import Path

# Ensure UTF-8 output on Windows terminals
if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding='utf-8', errors='replace')
        sys.stderr.reconfigure(encoding='utf-8', errors='replace')
    except Exception:
        pass

def run_audio(source=None, live=False, supabase=False, threshold=0.45):
    import detect_audio
    model, device = detect_audio.load_model("best_pig_audio.pth")
    if live:
        detect_audio.monitor_live_microphone(model, device, threshold=threshold, sync_supabase=supabase)
    elif source:
        detect_audio.classify_audio_file(source, model, device, threshold=threshold, sync_supabase=supabase)
    else:
        detect_audio.run_demo(model, device)

def run_vision(source="0", model_path="best (1).pt", conf=0.25):
    import detect_pig
    detect_pig.run_detection(source=source, model_path=model_path, conf=conf)

def run_unified(video_source=0, audio_live=True, supabase=True, conf=0.25, audio_thresh=0.45):
    """Launches both Vision and Audio monitors concurrently in separate processes."""
    print("=" * 70)
    print("🐷 PIG MONITORING SYSTEM - UNIFIED AI ENGINE (VISION + AUDIO)")
    print("=" * 70)
    print(f" • Vision Model:  best (1).pt (YOLOv8 Pig & Piglet Detection)")
    print(f" • Audio Model:   best_pig_audio.pth (ResNet-18 Swine Audio Classifier)")
    print(f" • Video Source:  {video_source}")
    print(f" • Audio Source:  {'Live Microphone' if audio_live else 'Demo/File'}")
    print(f" • Supabase Sync: {'ENABLED' if supabase else 'DISABLED'}")
    print("=" * 70)
    print("\nStarting AI engines... (Press Ctrl+C to stop all)\n")

    py_exe = sys.executable

    # Command for Audio
    audio_cmd = [py_exe, "detect_audio.py"]
    if audio_live:
        audio_cmd.append("--live")
    if supabase:
        audio_cmd.append("--supabase")
    audio_cmd.extend(["--threshold", str(audio_thresh)])

    # Command for Vision
    vision_cmd = [py_exe, "detect_pig.py", str(video_source)]

    audio_proc = subprocess.Popen(audio_cmd)
    vision_proc = subprocess.Popen(vision_cmd)

    try:
        while True:
            time.sleep(1)
            # Check if any process terminated
            if audio_proc.poll() is not None:
                print("[INFO] Audio monitor stopped.")
                break
            if vision_proc.poll() is not None:
                print("[INFO] Vision monitor stopped.")
                break
    except KeyboardInterrupt:
        print("\n[STOP] Shutting down AI monitoring engines...")
    finally:
        audio_proc.terminate()
        vision_proc.terminate()
        audio_proc.wait()
        vision_proc.wait()
        print("[OK] All processes stopped cleanly.")

def main():
    parser = argparse.ArgumentParser(description="Unified Pig Farm AI Monitoring (Vision + Audio)")
    parser.add_argument("--mode", choices=["all", "vision", "audio", "demo"], default="all",
                        help="Monitoring mode: 'all' (both), 'vision' (YOLO only), 'audio' (audio only), 'demo'")
    parser.add_argument("--video-source", type=str, default="0", help="Camera source for vision (0 for webcam, or video.mp4)")
    parser.add_argument("--audio-source", type=str, default=None, help="Audio file path (or leave empty for live mic)")
    parser.add_argument("--supabase", action="store_true", default=True, help="Sync alerts to Supabase")
    parser.add_argument("--no-supabase", action="store_false", dest="supabase", help="Disable Supabase sync")
    parser.add_argument("--conf", type=float, default=0.25, help="Vision confidence threshold")
    parser.add_argument("--audio-threshold", type=float, default=0.45, help="Audio alert threshold")

    args = parser.parse_args()

    if args.mode == "demo":
        run_audio(None, live=False, supabase=False)
    elif args.mode == "audio":
        run_audio(args.audio_source, live=(args.audio_source is None), supabase=args.supabase, threshold=args.audio_threshold)
    elif args.mode == "vision":
        run_vision(source=args.video_source, conf=args.conf)
    else:
        run_unified(
            video_source=args.video_source,
            audio_live=(args.audio_source is None),
            supabase=args.supabase,
            conf=args.conf,
            audio_thresh=args.audio_threshold
        )

if __name__ == "__main__":
    main()
