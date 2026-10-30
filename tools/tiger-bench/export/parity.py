import argparse
import os
import sys
import time

import numpy as np
import onnxruntime as ort
import torch

sys.path.insert(0, __file__.rsplit("/", 1)[0])
import dbs_onnx as D  # noqa: E402

ap = argparse.ArgumentParser()
ap.add_argument("--weights", required=True)
ap.add_argument("--base", required=True, help="path prefix of .spec.npy / .ref.npy")
ap.add_argument("models", nargs="+")
args = ap.parse_args()

model = D.load_model(args.weights)
spec = np.load(args.base + ".spec.npy")
ref = np.load(args.base + ".ref.npy").astype(np.float64)
length = ref.shape[-1]


def snr(a, b):
    return 10 * np.log10(np.sum(a ** 2) / max(np.sum((a - b) ** 2), 1e-30))


for path in args.models:
    so = ort.SessionOptions()
    so.intra_op_num_threads = 1
    so.inter_op_num_threads = 1
    sess = ort.InferenceSession(path, so, providers=["CPUExecutionProvider"])
    inp = sess.get_inputs()[0]
    feed = spec.astype(np.float16) if "float16" in inp.type else spec
    sess.run(None, {inp.name: feed})
    t0 = time.time()
    out = sess.run(None, {inp.name: feed})[0].astype(np.float32)
    dt = time.time() - t0
    est = D.istft(torch.from_numpy(out), model, length).numpy().astype(np.float64)
    keep = ref[1] + ref[2]
    keep_est = est[1] + est[2]
    snrs = [snr(ref[i], est[i]) for i in range(3)]
    mb = os.path.getsize(path) / 1e6
    print(f"{os.path.basename(path)}: {mb:.2f} MB, 1-thread ORT {dt:.2f}s, SNR music {snrs[0]:.1f} "
          f"sfx {snrs[1]:.1f} speech {snrs[2]:.1f} speech+sfx {snr(keep, keep_est):.1f} dB")
