"""Writes native/dpdf/tests/music-detector-ref.txt, the PyTorch music probability for windows of a fixed clip.

The Rust test builds the same clip from the same formula, so no audio file is committed.
"""
import contextlib
import io
import os

import numpy as np
import torch

from detectors import EfficientAT

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "../../native/dpdf/tests/music-detector-ref.txt")
RATE = 32000
SECONDS = 6
CENTRES = [32000, 80000, 128000, 160000]
TONES = [440.0, 554.37, 659.25]


def clip():
    x = 7
    noise = np.empty(RATE * SECONDS)
    for i in range(len(noise)):
        x = (x * 1664525 + 1013904223) & 0xFFFFFFFF
        noise[i] = ((x >> 8) / 16777216.0 * 2 - 1) * 0.05
    t = np.arange(RATE * SECONDS) / RATE
    return (noise + sum(0.1 * np.sin(2 * np.pi * f * t) for f in TONES)).astype(np.float32)


def main():
    with contextlib.redirect_stdout(io.StringIO()):
        detector = EfficientAT("mn05_as", 2.0)
    audio = clip()
    lines = []
    with torch.no_grad():
        for centre in CENTRES:
            window = torch.from_numpy(audio[centre - RATE: centre + RATE][None])
            logits, _ = detector.model(detector.mel(window).unsqueeze(1))
            lines.append(f"{centre} {float(torch.sigmoid(logits)[0, detector.music]):.6f}")
    with open(OUT, "w") as out:
        out.write("\n".join(lines) + "\n")
    print("\n".join(lines))


if __name__ == "__main__":
    main()
