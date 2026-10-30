import sys
import numpy as np
import soundfile as sf
import torch

sys.path.insert(0, __file__.rsplit("/", 1)[0])
import dbs_onnx as D  # noqa: E402

weights, clip, seconds, offset, out = sys.argv[1], sys.argv[2], float(sys.argv[3]), float(sys.argv[4]), sys.argv[5]
torch.backends.nnpack.set_flags(False)
model = D.load_model(weights)
audio, rate = sf.read(clip, dtype="float32")
n = int(round(rate * seconds))
x = torch.from_numpy(audio[int(offset * rate):int(offset * rate) + n].copy())
with torch.inference_mode():
    ref = model(x.view(1, 1, -1))[0]
np.save(out + ".spec.npy", D.stft(x, model).numpy())
np.save(out + ".ref.npy", ref.numpy())
