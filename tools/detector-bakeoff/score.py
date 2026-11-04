"""Runs each detector over the scenes and scores the gate rule from the design doc.

A frame plays the original only if every frame within ±1.5 s has a music probability below the threshold.
"""
import contextlib
import glob
import io
import json
import os
import sys

import numpy as np
import soundfile as sf

from detectors import EfficientAT, Yamnet, music_probability

WORK = os.path.join(os.path.dirname(os.path.abspath(__file__)), "../../listening/detector")
REACH = 3
INPUT = sys.argv[1] if len(sys.argv) > 1 else "mix"
THRESHOLDS = [0.02, 0.05, 0.1, 0.2, 0.3, 0.5]
BUCKETS = [(-15, 99, "≥-15 dB"), (-25, -15, "-15 to -25"), (-35, -25, "-25 to -35"), (-45, -35, "-35 to -45")]
NO_MUSIC_DB = -60
EFFECT_DB = -20


def gate_open(prob, threshold):
    below = prob < threshold
    return np.array([below[max(0, k - REACH): k + REACH + 1].all() for k in range(len(prob))])


def runs(mask):
    return int(np.sum(mask[1:] & ~mask[:-1]) + mask[0]) if len(mask) else 0


def detector_probabilities(detectors):
    results = {}
    for path in sorted(glob.glob(os.path.join(WORK, "scenes/[0-9][0-9].wav"))):
        source = path.removesuffix(".wav") + (f".{INPUT}.wav" if INPUT != "mix" else ".wav")
        audio, _ = sf.read(source, dtype="float32")
        labels = json.load(open(path.removesuffix(".wav") + ".json"))
        for name, (detector, mode) in detectors.items():
            key = (name, id(detector))
            scores = results.setdefault("_scores", {})
            if (key, path) not in scores:
                scores[(key, path)] = detector.scores(audio.astype(np.float64))
            prob = music_probability(detector, scores[(key, path)], mode)[: len(labels["musicDb"])]
            results.setdefault(name, []).append((prob, labels))
    results.pop("_scores")
    return results


def shipped_probabilities():
    scenes = []
    for path in sorted(glob.glob(os.path.join(WORK, "scenes/[0-9][0-9].wav"))):
        labels = json.load(open(path.removesuffix(".wav") + ".json"))
        prob = np.array(json.load(open(path.removesuffix(".wav") + ".shipped.json")), dtype=float)
        scenes.append((prob[: len(labels["musicDb"])], labels))
    return {"Shipped detector (wasm), dpdf-residual": scenes}


def pytorch_probabilities():
    with contextlib.redirect_stdout(io.StringIO()):
        yamnet = Yamnet()
        mn05_2s = EfficientAT("mn05_as", 2.0)
        mn05_4s = EfficientAT("mn05_as", 4.0)
    return detector_probabilities({
        f"YAMNet, Music class, {INPUT}": (yamnet, "music"),
        f"EfficientAT mn05 2 s, Music class, {INPUT}": (mn05_2s, "music"),
        f"EfficientAT mn05 4 s, Music class, {INPUT}": (mn05_4s, "music"),
    })


def score(scenes, threshold):
    music_db, effects_db, musiclike, opened, leak_runs = [], [], [], [], 0
    for prob, labels in scenes:
        is_open = gate_open(prob, threshold)
        m = np.array(labels["musicDb"])
        opened.append(is_open)
        music_db.append(m)
        effects_db.append(np.array(labels["effectsDb"]))
        musiclike.append(np.array(labels["musicLikeEffect"]))
        leak_runs += runs(is_open & (m > -35))
    opened, music_db, effects_db, musiclike = map(np.concatenate, (opened, music_db, effects_db, musiclike))
    row = {"threshold": threshold}
    for low, high, label in BUCKETS:
        frames = (music_db > low) & (music_db <= high)
        row[label] = (opened[frames].mean() * 100 if frames.any() else float("nan"), frames.sum() / 2)
    row["leakSeconds"] = (opened & (music_db > -35)).sum() / 2
    row["leakRuns"] = leak_runs
    no_music = music_db < NO_MUSIC_DB
    effect = no_music & (effects_db > EFFECT_DB)
    row["effectsKept"] = opened[effect & ~musiclike].mean() * 100
    row["musicLikeKept"] = opened[effect & musiclike].mean() * 100
    row["noMusicOpen"] = opened[no_music].mean() * 100
    return row


def main():
    results = shipped_probabilities() if INPUT == "shipped" else pytorch_probabilities()
    report = {}
    for name, scenes in results.items():
        report[name] = [score(scenes, t) for t in THRESHOLDS]
        print(f"\n## {name}\n")
        print("| threshold | " + " | ".join(label for *_, label in BUCKETS)
              + " | leak s | leak runs | effects kept | music-like kept | no-music open |")
        print("|---" * (len(BUCKETS) + 6) + "|")
        for row in report[name]:
            buckets = " | ".join(f"{row[label][0]:.1f}%" for *_, label in BUCKETS)
            print(f"| {row['threshold']} | {buckets} | {row['leakSeconds']:.1f} | {row['leakRuns']} | "
                  f"{row['effectsKept']:.0f}% | {row['musicLikeKept']:.0f}% | {row['noMusicOpen']:.0f}% |")
    first = next(iter(results.values()))
    totals = {label: score(first, 0.5)[label][1] for *_, label in BUCKETS}
    print("\nMusic seconds per level bucket:", totals)
    json.dump({k: v for k, v in report.items()}, open(os.path.join(WORK, f"report-{INPUT}.json"), "w"), indent=1)


if __name__ == "__main__":
    sys.exit(main())
