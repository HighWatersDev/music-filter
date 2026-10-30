"""Export-friendly DBS-TIGER: spectrum in, three masked spectra out.

STFT and iSTFT stay outside the graph (numpy or JS). Changes from dbs.models.tiger, none changing the function:
- complex tensors -> separate real and imaginary tensors
- torch.angle(exp(1j*d)) -> atan2(sin d, cos d), and atan2 guarded for 0/0 bins
- scatter_reduce / scatter_add segment pooling -> dense one-hot [F, K] ops
- the data-dependent `if boundary_flat.any()` dropped (bin 0 is always a boundary)
- adaptive_avg_pool1d -> a fixed averaging matrix (lengths are static per export)
- Where with broadcasting and Concat of more than 7 inputs avoided (onnxruntime-web WebGPU bugs)
"""
from __future__ import annotations

import torch
import torch.nn.functional as F
from torch import Tensor, nn

from dbs.models import DBSTIGER
from dbs.models import tiger as T
from dbs.modules.dbs import topk_boundaries


def adaptive_avg_matrix(length: int, out: int, ref: Tensor) -> Tensor:
    m = torch.zeros(length, out, dtype=ref.dtype)
    for i in range(out):
        a = (i * length) // out
        b = -((-(i + 1) * length) // out)
        m[a:b, i] = 1.0 / (b - a)
    return m.to(ref.device)


def uconv_forward(self, x: Tensor) -> Tensor:
    residual = x
    out = [self.spp_dw[0](self.proj_1x1(x))]
    for k in range(1, self.depth):
        out.append(self.spp_dw[k](out[-1]))
    target = int(out[-1].shape[-1])
    global_f = None
    for feature in out:
        length = int(feature.shape[-1])
        pooled = feature if length == target else torch.matmul(feature, adaptive_avg_matrix(length, target, feature))
        global_f = pooled if global_f is None else global_f + pooled
    global_f = self.globalatt(global_f)
    fused = [self.loc_glo_fus[i](out[i], global_f) for i in range(self.depth)]
    expanded = None
    for i in range(self.depth - 2, -1, -1):
        expanded = self.last_layer[i](fused[i], fused[i - 1] if i == self.depth - 2 else expanded)
    return self.res_conv(expanded) + residual


def physics_features(spec_ri: Tensor):
    mag = torch.sqrt(spec_ri[:, 0].square() + spec_ri[:, 1].square()) + 1e-6
    re, im = spec_ri[:, 0], spec_ri[:, 1]
    # ONNX atan2 is built from atan(y / x), so 0/0 bins (digital silence) would give NaN instead of torch's 0.
    phase = torch.atan2(im, torch.where((re == 0) & (im == 0), 1.0, re))
    mag_norm = F.normalize(mag - mag.mean(dim=-1, keepdim=True), dim=-1)
    term_time = 1.0 - (mag_norm[:, :-1] * mag_norm[:, 1:]).sum(dim=-1)
    d = phase[:, 1:] - phase[:, :-1]
    phase_diff = torch.atan2(torch.sin(d), torch.cos(d))
    term_phase = phase_diff.std(dim=-1)
    mag_pad = F.pad(mag.mean(dim=-1), (1, 1), mode="replicate")
    term_peak = torch.relu(2 * mag_pad[:, 1:-1] - mag_pad[:, :-2] - mag_pad[:, 2:])
    return term_time, term_phase, term_peak


def energy_features(spec_ri: Tensor, mode: str) -> Tensor:
    magnitude = torch.sqrt(spec_ri[:, 0].square() + spec_ri[:, 1].square())
    mean = magnitude.mean(dim=-1)
    features = [torch.log1p(mean)]
    if mode == "mean_peak_std":
        features.append(torch.log1p(magnitude.amax(dim=-1) / mean.clamp(min=1e-6)))
        features.append(torch.log1p(magnitude.std(dim=-1, unbiased=False) / mean.clamp(min=1e-6)))
    return torch.stack(features, dim=-1)


def pool_dense(self, features: Tensor, probs: Tensor, hard: Tensor):
    bsz, freq, dim, time = features.shape
    k = self.max_chunks
    is_boundary = hard > 0.5
    boundary_float = is_boundary.to(features.dtype)
    seg = torch.clamp(torch.cumsum(is_boundary.to(torch.int64), dim=1) - 1, 0, k - 1)
    onehot = (seg.unsqueeze(-1) == torch.arange(k, device=seg.device).view(1, 1, k)).to(features.dtype)

    p = probs.detach()
    pool_weights = (1.0 + torch.sigmoid(self.boundary_pool_gain) * boundary_float * p
                    + torch.sigmoid(self.interior_pool_gain) * (1.0 - boundary_float) * p)
    scores = self.chunk_attn(features.mean(dim=-1)).squeeze(-1) + torch.log(pool_weights.clamp(min=1e-6))

    # Masked segment max with arithmetic instead of a broadcasting Where: onnxruntime-web 1.30 WebGPU
    # broadcast Where([1, K, F], [1, 1, F], scalar) wrongly, which overflowed exp().
    onehot_t = (torch.arange(k, device=seg.device).view(1, k, 1) == seg.unsqueeze(1)).to(features.dtype)
    seg_max = (onehot_t * scores.unsqueeze(1) + (1.0 - onehot_t) * -1e9).amax(dim=2)
    bin_max = torch.matmul(seg_max.unsqueeze(1), onehot_t).squeeze(1)
    exp_scores = torch.exp(scores - bin_max)
    denom = torch.matmul(exp_scores.unsqueeze(1), onehot).squeeze(1)
    weights = exp_scores / torch.gather(denom, 1, seg).clamp(min=1e-8)
    assign = onehot * weights.unsqueeze(-1)
    tokens = torch.matmul(assign.transpose(1, 2), features.reshape(bsz, freq, dim * time)).view(bsz, k, dim, time)

    counts = onehot.sum(dim=1)
    confidence = torch.where(is_boundary, p, 1.0 - p)
    conf_mean = torch.matmul(confidence.unsqueeze(1), onehot).squeeze(1) / counts.clamp(min=1.0)

    positions = torch.arange(freq, device=features.device).view(1, freq, 1).to(features.dtype)
    starts = onehot * boundary_float.unsqueeze(-1)
    first = (starts * positions + (1.0 - starts) * float(freq)).amin(dim=1)
    valid = first < freq
    first_idx = first.clamp(max=max(freq - 1, 0)).to(torch.int64)
    boundary_p = probs.gather(1, first_idx)
    token_probs = 0.5 * (boundary_p + conf_mean) * valid.to(boundary_p.dtype)
    return tokens, token_probs, (counts > 0) & valid


def chunker_forward(self, spec_ri, router, similarity, current_epoch: int = 0):
    term_time, term_phase, term_peak = physics_features(spec_ri)
    router_feat = router_forward(router, spec_ri, use_energy=self.use_energy)
    energy = energy_features(spec_ri, self.energy_feature_mode) if self.use_energy else None
    residual = self.residual_scale * similarity(router_feat, self.band_id, energy)
    logits = (self.alpha * F.pad(term_time, (1, 0), value=1.0)
              + self.beta * F.pad(term_phase, (1, 0), value=1.0)
              + self.gamma * term_peak + residual + self.bias)
    logits = torch.cat([torch.full_like(logits[:, :1], 10.0), logits[:, 1:]], dim=1)
    probs = torch.sigmoid(logits)
    hard = topk_boundaries(probs, self.num_tokens)
    features = self.encoder_proj(spec_ri).permute(0, 2, 1, 3)
    tokens, token_probs, token_mask = pool_dense(self, features, probs, hard)
    return tokens, token_probs, hard, probs, token_mask


def router_forward(self, spec_ri: Tensor, use_energy: bool) -> Tensor:
    batch, _, freq, _ = spec_ri.shape
    cnn = self.cnn_extractor(spec_ri)
    _, dim, _, time = cnn.shape
    x = cnn.permute(0, 2, 3, 1).reshape(batch * freq, time, dim)
    if use_energy:
        energy = energy_features(spec_ri, self.energy_feature_mode)
        energy = self.energy_proj(energy.reshape(batch * freq, 1, -1).expand(-1, time, -1))
    else:
        energy = x[..., :self.energy_dim] * 0.0
    _, (hidden, _) = self.lstm(torch.cat([x, energy], dim=-1))
    return torch.cat([hidden[-2], hidden[-1]], dim=-1).view(batch, freq, dim)


def smooth(tokens: Tensor, token_probs: Tensor, token_mask: Tensor) -> Tensor:
    bsz, count = tokens.shape[:2]
    mask = token_mask.to(tokens.dtype)
    outs = [tokens[:, 0]]
    for i in range(1, count):
        p = token_probs[:, i].view(bsz, 1, 1)
        value = p * tokens[:, i] + (1 - p) * outs[-1]
        outs.append(value * mask[:, i].view(bsz, 1, 1))
    return stack_grouped(outs, dim=1)


def stack_grouped(items, dim: int, group: int = 6) -> Tensor:
    # onnxruntime-web WebGPU builds one shader per Concat and fails above 8 storage buffers per stage.
    parts = [torch.stack(items[i:i + group], dim=dim) for i in range(0, len(items), group)]
    while len(parts) > group:
        parts = [torch.cat(parts[i:i + group], dim=dim) for i in range(0, len(parts), group)]
    return torch.cat(parts, dim=dim)


def dechunker_forward(self, tokens, hard, probs, token_probs, token_mask, spec_re, spec_im):
    bsz, count, dim, time = tokens.shape
    freq = self.band_width
    smoothed = smooth(tokens, token_probs, token_mask)
    seg = (torch.cumsum(hard, dim=1).to(torch.int64) - 1).clamp(min=0, max=count - 1)
    z = torch.gather(smoothed, 1, seg.view(bsz, freq, 1, 1).expand(bsz, freq, dim, time))
    z = z.permute(0, 2, 1, 3).contiguous()
    for block in self.freq_refine_blocks:
        z = block["norm"](z + block["pw"](block["act"](block["dw"](z))))
    z = z.permute(0, 2, 1, 3).contiguous()
    params = self.mask_net(z.view(bsz * freq, dim, time)).view(bsz, freq, self.num_sources, 2, 2, time)
    mask_real = params[..., 0, 0, :] * torch.sigmoid(params[..., 0, 1, :])
    mask_imag = params[..., 1, 0, :] * torch.sigmoid(params[..., 1, 1, :])
    mask_real = mask_real - (mask_real.sum(dim=2, keepdim=True) - 1) / self.num_sources
    mask_imag = mask_imag - mask_imag.sum(dim=2, keepdim=True) / self.num_sources
    sr, si = spec_re.unsqueeze(2), spec_im.unsqueeze(2)
    out_re = sr * mask_real - si * mask_imag
    out_im = sr * mask_imag + si * mask_real
    return out_re.permute(0, 2, 1, 3), out_im.permute(0, 2, 1, 3)


class SpecCore(nn.Module):
    """``spec [1, 2, 1025, frames]`` (re, im) -> ``out [1, 3, 2, 1025, frames]`` (music, sfx, speech)."""

    def __init__(self, model: DBSTIGER):
        super().__init__()
        self.m = model

    def forward(self, spec: Tensor) -> Tensor:
        m = self.m
        tokens, masks, states = [], [], []
        for (start, end), chunker in zip(m.band_slices, m.chunkers):
            x, token_probs, hard, probs, token_mask = chunker_forward(
                chunker, spec[:, :, start:end], m.shared_router_backbone, m.shared_similarity_projection)
            tokens.append(x)
            masks.append(token_mask)
            states.append((token_probs, hard, probs, token_mask, x.shape[1]))
        separated = m.separator(torch.cat(tokens, dim=1), chunk_mask=torch.cat(masks, dim=1))
        res_re, res_im, offset = [], [], 0
        for (start, end), dechunker, (token_probs, hard, probs, token_mask, count) in zip(
                m.band_slices, m.dechunkers, states):
            re, im = dechunker_forward(dechunker, separated[:, offset:offset + count], hard, probs, token_probs,
                                       token_mask, spec[:, 0, start:end], spec[:, 1, start:end])
            res_re.append(re)
            res_im.append(im)
            offset += count
        return torch.stack([torch.cat(res_re, dim=2), torch.cat(res_im, dim=2)], dim=2)


def install_patches():
    T.UConvBlock.forward = uconv_forward


def load_model(path: str) -> DBSTIGER:
    return DBSTIGER.from_pretrained(path).eval()


def stft(audio: Tensor, model: DBSTIGER) -> Tensor:
    win = torch.hann_window(model.win, dtype=audio.dtype)
    spec = torch.stft(audio.view(1, -1), n_fft=model.win, hop_length=model.stride, window=win, return_complex=True)
    return torch.stack([spec.real, spec.imag], 1)


def istft(out: Tensor, model: DBSTIGER, length: int) -> Tensor:
    spec = torch.complex(out[0, :, 0], out[0, :, 1])
    win = torch.hann_window(model.win, dtype=out.dtype)
    return torch.istft(spec, n_fft=model.win, hop_length=model.stride, window=win, length=length)


def frames_for(samples: int, hop: int = 512) -> int:
    return 1 + samples // hop

