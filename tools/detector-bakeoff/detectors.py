import os
import sys
import zipfile

import numpy as np
import soxr
import torch

WORK = os.path.join(os.path.dirname(os.path.abspath(__file__)), "../../listening/detector")
FRAME_SECONDS = 0.5
VOICE_MUSIC = {"Singing", "Choir", "Yodeling", "Chant", "Mantra", "Male singing", "Female singing",
               "Child singing", "Synthetic singing", "Rapping", "Humming"}


def music_indices(labels):
    start, end = labels.index("Music"), labels.index("Scary music")
    subtree = list(range(start, end + 1))
    voice = [i for i, name in enumerate(labels) if name in VOICE_MUSIC]
    return start, subtree + voice


def frame_windows(audio, rate, window_seconds):
    """Yields one window centred on each 0.5 s frame, zero padded at the edges."""
    hop = int(FRAME_SECONDS * rate)
    window = int(window_seconds * rate)
    frames = int(np.ceil(len(audio) / hop))
    padded = np.concatenate([np.zeros(window), audio, np.zeros(window)])
    for k in range(frames):
        centre = window + k * hop + hop // 2
        yield padded[centre - window // 2: centre - window // 2 + window]


class Yamnet:
    rate = 16000
    window_seconds = 0.975

    def __init__(self):
        from ai_edge_litert.interpreter import Interpreter
        path = os.path.join(WORK, "models/yamnet.tflite")
        self.labels = zipfile.ZipFile(path).read("yamnet_label_list.txt").decode().splitlines()
        self.music, self.music_set = music_indices(self.labels)
        self.interpreter = Interpreter(path)
        self.interpreter.allocate_tensors()
        self.input = self.interpreter.get_input_details()[0]["index"]
        self.output = self.interpreter.get_output_details()[0]["index"]

    def scores(self, audio48):
        audio = soxr.resample(audio48, 48000, self.rate).astype(np.float32)
        rows = []
        for window in frame_windows(audio, self.rate, self.window_seconds):
            self.interpreter.set_tensor(self.input, window.astype(np.float32))
            self.interpreter.invoke()
            rows.append(self.interpreter.get_tensor(self.output)[0].copy())
        return np.array(rows)


class EfficientAT:
    rate = 32000

    def __init__(self, name="mn05_as", window_seconds=2.0):
        self.window_seconds = window_seconds
        cwd = os.getcwd()
        os.chdir(os.path.join(WORK, "EfficientAT"))
        sys.path.insert(0, os.getcwd())
        try:
            from helpers.utils import NAME_TO_WIDTH, labels
            from models.preprocess import AugmentMelSTFT
            if name.startswith("dymn"):
                from models.dymn.model import get_model
            else:
                from models.mn.model import get_model
            self.model = get_model(width_mult=NAME_TO_WIDTH(name), pretrained_name=name).eval()
        finally:
            os.chdir(cwd)
        self.labels = list(labels)
        self.music, self.music_set = music_indices(self.labels)
        self.mel = AugmentMelSTFT(n_mels=128, sr=self.rate, win_length=800, hopsize=320).eval()

    def scores(self, audio48):
        audio = soxr.resample(audio48, 48000, self.rate).astype(np.float32)
        windows = np.stack(list(frame_windows(audio, self.rate, self.window_seconds))).astype(np.float32)
        rows = []
        with torch.no_grad():
            for batch in np.array_split(windows, max(1, len(windows) // 32)):
                spec = self.mel(torch.from_numpy(batch))
                logits, _ = self.model(spec.unsqueeze(1))
                rows.append(torch.sigmoid(logits).numpy())
        return np.concatenate(rows)


def audioset_labels():
    with open(os.path.join(WORK, "EfficientAT/metadata/class_labels_indices.csv")) as f:
        return [row.split(",", 2)[2].strip().strip('"') for row in f.read().splitlines()[1:]]


# CED's code and EfficientAT's both import a top-level package called `models`, so one process loads only one of them.
class Ced:
    rate = 16000

    def __init__(self, name="ced_tiny", window_seconds=2.0):
        self.window_seconds = window_seconds
        sys.path.insert(0, os.path.join(WORK, "CED"))
        import models as ced_models
        self.model = getattr(ced_models, name)(pretrained=True).eval()
        self.labels = audioset_labels()
        self.music, self.music_set = music_indices(self.labels)

    def scores(self, audio48):
        audio = soxr.resample(audio48, 48000, self.rate).astype(np.float32)
        windows = np.stack(list(frame_windows(audio, self.rate, self.window_seconds))).astype(np.float32)
        rows = []
        with torch.no_grad():
            for batch in np.array_split(windows, max(1, len(windows) // 32)):
                rows.append(self.model(torch.from_numpy(batch)).numpy())
        return np.concatenate(rows)


def music_probability(detector, scores, mode):
    if mode == "music":
        return scores[:, detector.music]
    return scores[:, detector.music_set].max(axis=1)
