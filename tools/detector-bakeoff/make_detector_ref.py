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


# Noise for 2 s, then a plucked chord with harmonics re-struck every 0.25 s, then quiet noise with a tone.
# The windows straddle the sections so each gets a different score.
def clip():
    x = 7
    out = np.empty(RATE * SECONDS)
    for i in range(len(out)):
        x = (x * 1664525 + 1013904223) & 0xFFFFFFFF
        noise = (x >> 8) / 16777216.0 * 2 - 1
        t = i / RATE
        if t < 2:
            out[i] = 0.05 * noise
        elif t < 4:
            envelope = np.exp(-12 * ((t - 2) % 0.25))
            out[i] = envelope * sum(0.08 / h * np.sin(2 * np.pi * f * h * t) for f in TONES for h in range(1, 7))
        else:
            out[i] = 0.005 * noise + 0.1 * np.sin(2 * np.pi * 1000 * t)
    return out.astype(np.float32)


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
