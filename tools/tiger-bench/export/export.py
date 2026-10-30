import argparse
import sys
import time

import numpy as np
import soundfile as sf
import torch

sys.path.insert(0, __file__.rsplit("/", 1)[0])
import dbs_onnx as D  # noqa: E402

ap = argparse.ArgumentParser()
ap.add_argument("--weights", required=True)
ap.add_argument("--clip", required=True)
ap.add_argument("--seconds", type=float, default=6.0)
ap.add_argument("--offset", type=float, default=20.0)
ap.add_argument("--out", required=True)
ap.add_argument("--dynamo", action="store_true")
args = ap.parse_args()

torch.set_num_threads(4)
torch.backends.nnpack.set_flags(False)
model = D.load_model(args.weights)
audio, rate = sf.read(args.clip, dtype="float32")
assert rate == 44100
n = int(round(rate * args.seconds))
start = int(args.offset * rate)
x = torch.from_numpy(audio[start:start + n].copy())

with torch.inference_mode():
    t0 = time.time()
    ref = model(x.view(1, 1, -1))[0]
    print(f"reference forward {time.time() - t0:.2f}s")

D.install_patches()
core = D.SpecCore(model).eval()
spec = D.stft(x, model)
print("spec", tuple(spec.shape))
with torch.inference_mode():
    out = core(spec)
    est = D.istft(out, model, n)


def snr(a, b):
    a, b = a.numpy().astype(np.float64), b.numpy().astype(np.float64)
    return 10 * np.log10(np.sum(a ** 2) / max(np.sum((a - b) ** 2), 1e-30))


for i, name in enumerate(["music", "sfx", "speech"]):
    print(f"patched core vs original {name}: {snr(ref[i], est[i]):.1f} dB")

np.save(args.out + ".spec.npy", spec.numpy())
np.save(args.out + ".ref.npy", ref.numpy())

t0 = time.time()
extra = {} if args.dynamo else {"do_constant_folding": False}
with torch.no_grad():
    torch.onnx.export(core, (spec,), args.out, input_names=["spec"], output_names=["out"],
                      opset_version=18, dynamo=args.dynamo, external_data=False, **extra)
print(f"export {time.time() - t0:.1f}s -> {args.out}")
