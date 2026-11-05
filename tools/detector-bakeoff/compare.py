"""Compares newer detectors with the shipped mn05 on the DPDFNet residual.

  python compare.py cache <detector>   scores every scene and saves the Music probabilities
  python compare.py report             prints the gate results for every cached detector

Each detector caches in its own process, because CED and EfficientAT clash on the `models` package.
"""
import contextlib
import glob
import io
import json
import os
import sys
import time

import numpy as np
import soundfile as sf
import torch

from score import score

WORK = os.path.join(os.path.dirname(os.path.abspath(__file__)), "../../listening/detector")
CACHE = os.path.join(WORK, "compare")
DETECTORS = ["mn05_as", "mn05_as@4", "mn10_as@4", "dymn10_as", "dymn10_as@4", "ced_tiny", "ced_mini", "ced_mini@4"]
GRID = [round(t, 3) for t in np.arange(0.01, 0.6, 0.005)]
LEAK_BUDGETS = [5, 10, 20, 30, 45]


def load(key):
    from detectors import Ced, EfficientAT
    name, _, window = key.partition("@")
    window = float(window or 2)
    with contextlib.redirect_stdout(io.StringIO()):
        return Ced(name, window) if name.startswith("ced") else EfficientAT(name, window)


def scenes():
    return sorted(glob.glob(os.path.join(WORK, "scenes/[0-9][0-9].wav")))


def cache(name):
    torch.set_num_threads(1)
    detector = load(name)
    os.makedirs(CACHE, exist_ok=True)
    audio_seconds, compute_seconds, probabilities = 0.0, 0.0, {}
    for path in scenes():
        audio, rate = sf.read(path.removesuffix(".wav") + ".dpdf-residual.wav", dtype="float32")
        started = time.perf_counter()
        scores = detector.scores(audio.astype(np.float64))
        compute_seconds += time.perf_counter() - started
        audio_seconds += len(audio) / rate
        probabilities[os.path.basename(path)] = scores[:, detector.music].tolist()
    params = sum(p.numel() for p in detector.model.parameters()) / 1e6
    json.dump({"params": params, "msPerAudioSecond": 1000 * compute_seconds / audio_seconds,
               "probabilities": probabilities}, open(os.path.join(CACHE, f"{name}.json"), "w"))
    print(f"{name}: {params:.2f} M params, {1000 * compute_seconds / audio_seconds:.0f} ms per second of audio")


def report():
    rows = {}
    for name in DETECTORS:
        path = os.path.join(CACHE, f"{name}.json")
        if not os.path.exists(path):
            continue
        cached = json.load(open(path))
        scored = []
        for scene in scenes():
            labels = json.load(open(scene.removesuffix(".wav") + ".json"))
            prob = np.array(cached["probabilities"][os.path.basename(scene)])[: len(labels["musicDb"])]
            scored.append((prob, labels))
        rows[name] = (cached, [score(scored, t) for t in GRID])
    print("Best effects kept within each music leak budget (threshold in brackets).\n")
    print("| Detector | Params | ms per s | " + " | ".join(f"≤{b} s let through" for b in LEAK_BUDGETS) + " |")
    print("|---" * (3 + len(LEAK_BUDGETS)) + "|")
    for name, (cached, results) in rows.items():
        cells = []
        for budget in LEAK_BUDGETS:
            within = [r for r in results if r["leakSeconds"] <= budget]
            best = max(within, key=lambda r: r["effectsKept"], default=None)
            cells.append(f"{best['effectsKept']:.0f}% ({best['threshold']})" if best else "n/a")
        print(f"| {name} | {cached['params']:.1f} M | {cached['msPerAudioSecond']:.0f} | " + " | ".join(cells) + " |")


if __name__ == "__main__":
    cache(sys.argv[2]) if sys.argv[1] == "cache" else report()
