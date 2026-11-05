"""Exports EfficientAT mn05_as as ONNX for the extension's music detector.

The graph takes the power spectrogram, so the engine only does pre-emphasis and the STFT. The mel bank,
log and normalisation stay in the graph and match AugmentMelSTFT in eval mode exactly.
Input "power": [1, 513, 200], 2 s at 32 kHz with hop 320. Output "music": [1], the "Music" class probability.
"""
import contextlib
import io
import os
import sys

import numpy as np
import onnx
import torch

from detectors import WORK, EfficientAT

FRAMES = 200
OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(WORK, "models/music-detector-mn05.onnx")


class PowerToMusic(torch.nn.Module):
    def __init__(self, detector):
        super().__init__()
        self.model = detector.model
        self.music = detector.music
        mel = detector.mel
        import torchaudio
        basis, _ = torchaudio.compliance.kaldi.get_mel_banks(mel.n_mels, mel.n_fft, mel.sr, mel.fmin, mel.fmax,
                                                             vtln_low=100.0, vtln_high=-500., vtln_warp_factor=1.0)
        self.register_buffer("basis", torch.nn.functional.pad(basis, (0, 1)))

    def forward(self, power):
        mel = ((torch.matmul(self.basis, power) + 0.00001).log() + 4.5) / 5.
        logits, _ = self.model(mel.unsqueeze(1))
        return torch.sigmoid(logits[:, self.music])


def main():
    with contextlib.redirect_stdout(io.StringIO()):
        detector = EfficientAT("mn05_as", 2.0)
    wrapper = PowerToMusic(detector).eval()
    audio = torch.from_numpy(np.random.default_rng(0).standard_normal((1, 64000)).astype(np.float32) * 0.1)
    with torch.no_grad():
        x = torch.nn.functional.conv1d(audio.unsqueeze(1), detector.mel.preemphasis_coefficient).squeeze(1)
        spec = torch.stft(x, 1024, hop_length=320, win_length=800, center=True, window=detector.mel.window,
                          return_complex=False)
        power = (spec ** 2).sum(dim=-1)
        assert power.shape == (1, 513, FRAMES), power.shape
        expected = torch.sigmoid(detector.model(detector.mel(audio).unsqueeze(1))[0][:, detector.music])
        got = wrapper(power)
        assert torch.allclose(got, expected, atol=1e-5), (got, expected)
        torch.onnx.export(wrapper, (power,), OUT, input_names=["power"], output_names=["music"], opset_version=17,
                          dynamo=False)
    model = onnx.load(OUT)
    for key, value in {"sample_rate": "32000", "n_fft": "1024", "win_length": "800", "hop_length": "320",
                       "frames": str(FRAMES), "preemphasis": "0.97", "source": "fschmid56/EfficientAT mn05_as_mAP_443"}.items():
        model.metadata_props.add(key=key, value=value)
    onnx.save(model, OUT)
    import onnxruntime
    ort = onnxruntime.InferenceSession(OUT).run(None, {"power": power.numpy()})[0]
    print(OUT, os.path.getsize(OUT), "bytes, torch", float(expected[0]), "onnxruntime", float(ort[0]))


if __name__ == "__main__":
    main()
