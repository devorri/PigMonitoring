"""
Pig and Piglet Detection Script using best (1).pt
"""
import sys
from pathlib import Path
from ultralytics import YOLO

def run_detection(source="dataset-cover.png", model_path: str = "best (1).pt", conf: float = 0.25):
    if not Path(model_path).exists():
        print(f"Error: Model file '{model_path}' not found.")
        return

    print(f"Loading custom YOLOv8 model: {model_path}")
    model = YOLO(model_path)
    print(f"Model classes: {model.names}")

    is_live = False
    if str(source).lower() in ("webcam", "live", "0"):
        source = 0
        is_live = True
    elif any(str(source).lower().endswith(ext) for ext in (".mp4", ".avi", ".mov", ".mkv")):
        is_live = True

    print(f"Running inference on: {source} (confidence >= {conf})")
    
    if is_live:
        print("Opening live detection window (Press 'q' in the window to exit)...")
        for r in model.predict(source=source, conf=conf, show=True, stream=True):
            pigs = sum(1 for b in r.boxes if int(b.cls[0].item()) == 0)
            piglets = sum(1 for b in r.boxes if int(b.cls[0].item()) == 1)
            print(f"\rTracking: {pigs} pigs, {piglets} piglets detected | Press 'q' to stop", end="")
        print("\nLive detection closed.")
        return

    results = model.predict(source=source, conf=conf, save=True)

    for i, r in enumerate(results):
        print(f"\n--- Result for Image #{i + 1} ---")
        boxes = r.boxes
        if len(boxes) == 0:
            print("No pigs or piglets detected.")
        else:
            print(f"Total detected: {len(boxes)}")
            for box in boxes:
                cls_id = int(box.cls[0].item())
                label = model.names.get(cls_id, str(cls_id))
                confidence = float(box.conf[0].item())
                xyxy = [round(x, 1) for x in box.xyxy[0].tolist()]
                print(f"  • {label.upper()}: {confidence * 100:.1f}% confidence, box: {xyxy}")

    print(f"\nSaved annotated output to: runs/detect/predict/")

if __name__ == "__main__":
    src = sys.argv[1] if len(sys.argv) > 1 else "dataset-cover.png"
    run_detection(source=src)
