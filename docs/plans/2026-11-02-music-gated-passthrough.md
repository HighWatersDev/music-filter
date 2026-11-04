# Music-gated passthrough implementation plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** an opt-in popup switch, "Keep other sounds when there's no music", that plays the original audio wherever a music detector is confident there is no music, so sound effects survive.

**Architecture:** with the switch on, every browser uses read-ahead. Each window is filtered by DPDFNet together with 2.5 s of audio on each side. EfficientAT mn05 scores the residual (original minus filtered) every 0.5 s. A pure gate turns the scores into a 0..1 curve, and the worker mixes `curve × original + (1 − curve) × filtered`. The detector runs on tract inside the existing `dpdf_bg.wasm`.

**Tech stack:** Rust (tract-onnx 0.23.8, rustfft 6.2.0, wasm-bindgen 0.2.129), plain JS ES modules, `node --test`, Playwright e2e, Python 3.11 venv for the export.

**Design:** `docs/plans/2026-11-02-music-gated-passthrough-design.md`. **Evidence:** `docs/spikes/2026-11-02-music-detector-bakeoff.md`.

---

## Before you start

- Repo: `/Users/luqmaan/Projects/music-filter`. Work on a branch: `git checkout -b music-gated-passthrough`.
- Node 24 for every `node`, `npm` and `git commit`: `export PATH=/opt/homebrew/opt/node@24/bin:$PATH`.
- Rust: `export PATH=/opt/homebrew/opt/rustup/bin:$HOME/.cargo/bin:$PATH`. Toolchain 1.99.1 from `native/dpdf/rust-toolchain.toml`.
- Python: `listening/detector/.venv` (gitignored) has torch 2.5.1, onnx 1.23.2, onnxruntime 1.31.1 and the EfficientAT clone. Run the export scripts from `tools/detector-bakeoff/`.
- Disk: the Mac had under 1 GB free on 2026-11-02. Run `df -h /` before any cargo or wasm build. Stop and tell the user if under 2 GB.
- Commit after each task. Do not push. The user decides when to push.
- Writing style for comments, docs and commit messages: plain, short, no em dashes, no semicolons in prose. Code comments only for a why the code cannot show.

## Gate constants

These come from the bake-off and appear in several tasks.

| Constant | Value |
|---|---|
| Frame | 0.5 s (24000 samples at 48 kHz) |
| Threshold | 0.05 on the "Music" class |
| Reach | 3 frames (±1.5 s), every frame in reach must be below the threshold |
| Fade | 0.2 s, linear, inside the open region |
| Detector window | 2 s at 32 kHz, centred on the frame |
| Context | 2.5 s before and after each window, for the reach plus half a detector window |

---

### Task 1: Export the detector model and the parity reference

**Files:**
- Already written: `tools/detector-bakeoff/export_onnx.py` (exports `music-detector-mn05.onnx`, input `power` [1, 513, 200], output `music` [1], with metadata)
- Create: `tools/detector-bakeoff/make_detector_ref.py`
- Create: `native/dpdf/tests/music-detector-ref.txt`

**Step 1: Export the model and copy it into the extension**

```bash
cd tools/detector-bakeoff
../../listening/detector/.venv/bin/python -W ignore export_onnx.py ../../extension/assets/music-detector-mn05.onnx
shasum -a 256 ../../extension/assets/music-detector-mn05.onnx
```

Expected: a line ending `torch 0.0167… onnxruntime 0.0167…` with the two numbers equal to 5 decimals. File about 6 MB. Note the SHA-256 for Task 2.

**Step 2: Write the reference generator**

```python
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
```

**Step 3: Run it**

```bash
mkdir -p ../../native/dpdf/tests
../../listening/detector/.venv/bin/python -W ignore make_detector_ref.py 2>&1 | grep -v -E "^INFO|FMAX"
```

Expected: 4 lines, `<centre> <probability>`.

**Step 4: Commit**

```bash
git add tools/detector-bakeoff/export_onnx.py tools/detector-bakeoff/make_detector_ref.py native/dpdf/tests/music-detector-ref.txt
git commit -m "feat(detector): export EfficientAT mn05 to ONNX with a PyTorch reference"
```

---

### Task 2: Fetch the detector with the other models

**Files:**
- Modify: `scripts/fetch-models.sh`
- Modify: `native/dpdf/LICENSE-NOTES.md`, `NOTICE`

**Step 1: Ask the user to approve the release upload**

The mirror is a GitHub release on the public repo. Ask before running:

```bash
gh release create music-detector-mn05-a425fdc extension/assets/music-detector-mn05.onnx \
  --repo HighWatersDev/music-filter --title "Music detector: EfficientAT mn05_as" \
  --notes "EfficientAT mn05_as (github.com/fschmid56/EfficientAT a425fdc, MIT), exported to ONNX by tools/detector-bakeoff/export_onnx.py."
```

**Step 2: Give each model its own list of URLs**

Replace the `REPO`, `REVISION`, `MIRROR` and `MODELS` block and the loop header in `scripts/fetch-models.sh`. Keep the rest of the loop body as it is, with `$name.onnx` replaced by `$file`.

```bash
RELEASES="https://github.com/HighWatersDev/music-filter/releases/download"
DPDFNET_HF="https://huggingface.co/Ceva-IP/DPDFNet/resolve/dd6818d00f50c836fed43a6243ebe49116de5964/onnx"
DEST="$ROOT/extension/assets"
# file, sha256, then sources in order of preference
MODELS="
dpdfnet4.onnx 42a386d3601922f474c4309927e1f471cce422e9bd8e3fd3967bb943bac36c01 $RELEASES/dpdfnet-dd6818d/dpdfnet4.onnx $DPDFNET_HF/dpdfnet4.onnx
dpdfnet2.onnx 4f0ee28935b4a32abecc717d745416976565834d839601acf43031094b4dc94c $RELEASES/dpdfnet-dd6818d/dpdfnet2.onnx $DPDFNET_HF/dpdfnet2.onnx
music-detector-mn05.onnx <sha256 from Task 1> $RELEASES/music-detector-mn05-a425fdc/music-detector-mn05.onnx
"
```

```bash
echo "$MODELS" | while read -r file expected urls; do
  [ -n "$file" ] || continue
  target="$DEST/$file"
  ...
  for url in $urls; do
```

**Step 3: Run it twice**

```bash
npm run fetch:models
mv extension/assets/music-detector-mn05.onnx /tmp/mn05.bak && npm run fetch:models && cmp /tmp/mn05.bak extension/assets/music-detector-mn05.onnx
```

Expected: the first run prints `present, sha256 ok` for all three. The second downloads the detector from the release and `cmp` prints nothing.

**Step 4: Licence notes**

Add to `NOTICE` after the DPDFNet entry:

```
EfficientAT mn05_as audio tagging model (music-detector-mn05.onnx)
  Copyright 2022 Florian Schmid
  MIT License
  https://github.com/fschmid56/EfficientAT
```

Add the same model, its commit `a425fdce92572e602a1d5634799bd9f1f2efa806` and the weights file `mn05_as_mAP_443.pt` (SHA-256 `97f00bb7…69fd7f`) to `native/dpdf/LICENSE-NOTES.md` in the style of its existing entries.

**Step 5: Commit**

```bash
git add scripts/fetch-models.sh NOTICE native/dpdf/LICENSE-NOTES.md
git commit -m "feat(detector): fetch the music detector model with a pinned hash"
```

---

### Task 3: Resample 48 kHz to 32 kHz in Rust

**Files:**
- Create: `native/dpdf/src/music_detector.rs`
- Modify: `native/dpdf/src/lib.rs` (add `mod music_detector;` and `pub use music_detector::MusicDetector;` once Task 5 adds the class. For now only `mod music_detector;`)

**Step 1: Write the failing tests**

At the bottom of `music_detector.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    fn tone(hz: f64, rate: f64, len: usize) -> Vec<f32> {
        (0..len).map(|i| (0.5 * (2.0 * std::f64::consts::PI * hz * i as f64 / rate).sin()) as f32).collect()
    }

    fn rms(x: &[f32]) -> f32 {
        (x.iter().map(|v| v * v).sum::<f32>() / x.len() as f32).sqrt()
    }

    #[test]
    fn resampling_keeps_two_thirds_of_the_samples() {
        assert_eq!(resample_48k_to_32k(&vec![0.0; 4800], &resample_phases()).len(), 3200);
    }

    #[test]
    fn resampling_passes_a_1khz_tone() {
        let out = resample_48k_to_32k(&tone(1000.0, 48000.0, 48000), &resample_phases());
        let expected = tone(1000.0, 32000.0, out.len());
        let worst = out[1000..out.len() - 1000].iter().zip(&expected[1000..]).map(|(a, b)| (a - b).abs()).fold(0.0, f32::max);
        assert!(worst < 2e-3, "worst {worst}");
    }

    #[test]
    fn resampling_removes_a_20khz_tone_instead_of_aliasing_it() {
        let out = resample_48k_to_32k(&tone(20000.0, 48000.0, 48000), &resample_phases());
        assert!(rms(&out[1000..out.len() - 1000]) < 0.5e-3, "rms {}", rms(&out[1000..out.len() - 1000]));
    }
}
```

**Step 2: Run them and watch them fail**

```bash
cd native/dpdf && cargo test --lib music_detector
```

Expected: compile error, `resample_48k_to_32k` not found.

**Step 3: Implement**

```rust
pub const INPUT_RATE: usize = 48000;
pub const DETECTOR_RATE: usize = 32000;
const RESAMPLE_HALF: usize = 64;
const RESAMPLE_CUTOFF: f64 = 15000.0 / INPUT_RATE as f64;
const KAISER_BETA: f64 = 8.0;

fn bessel_i0(x: f64) -> f64 {
    let (mut sum, mut term, mut k) = (1.0, 1.0, 1.0);
    while term > 1e-12 * sum {
        term *= (x / (2.0 * k)).powi(2);
        sum += term;
        k += 1.0;
    }
    sum
}

// Output sample n sits at input position 1.5 n, so even outputs land on an input sample and odd ones
// halfway between two. Each gets its own set of taps.
fn phase_taps(frac: f64) -> Vec<f32> {
    let half = RESAMPLE_HALF as f64;
    let raw: Vec<f64> = (0..2 * RESAMPLE_HALF)
        .map(|j| {
            let d = j as f64 - (half - 1.0) - frac;
            let x = std::f64::consts::PI * 2.0 * RESAMPLE_CUTOFF * d;
            let sinc = if d == 0.0 { 1.0 } else { x.sin() / x };
            sinc * bessel_i0(KAISER_BETA * (1.0 - (d / half).powi(2)).max(0.0).sqrt())
        })
        .collect();
    let sum: f64 = raw.iter().sum();
    raw.iter().map(|t| (t / sum) as f32).collect()
}

fn resample_phases() -> [Vec<f32>; 2] {
    [phase_taps(0.0), phase_taps(0.5)]
}

fn resample_48k_to_32k(input: &[f32], phases: &[Vec<f32>; 2]) -> Vec<f32> {
    (0..input.len() * 2 / 3)
        .map(|n| {
            let first = (3 * n / 2) as isize - (RESAMPLE_HALF as isize - 1);
            phases[n % 2]
                .iter()
                .enumerate()
                .map(|(j, tap)| match usize::try_from(first + j as isize) {
                    Ok(m) if m < input.len() => tap * input[m],
                    _ => 0.0,
                })
                .sum()
        })
        .collect()
}
```

**Step 4: Run the tests**

```bash
cargo test --lib music_detector
```

Expected: 3 passed. If the 1 kHz test fails by a constant offset of one sample, the phase index is off by one. Check `first` against the formula `d = m − 1.5 n`.

**Step 5: Commit**

```bash
git add native/dpdf/src/music_detector.rs native/dpdf/src/lib.rs
git commit -m "feat(detector): resample 48 kHz to 32 kHz for the music detector"
```

---

### Task 4: Detector engine with PyTorch parity

**Files:**
- Modify: `native/dpdf/src/music_detector.rs`

**Step 1: Write the failing parity test**

Add to the tests module:

```rust
    fn model_bytes() -> Option<Vec<u8>> {
        let path = format!("{}/../../extension/assets/music-detector-mn05.onnx", env!("CARGO_MANIFEST_DIR"));
        std::fs::read(&path).map_err(|_| eprintln!("skipping: {path} missing, run npm run fetch:models")).ok()
    }

    fn reference_clip() -> Vec<f32> {
        let rate = 32000.0;
        let mut x: u32 = 7;
        (0..6 * 32000)
            .map(|i| {
                x = x.wrapping_mul(1664525).wrapping_add(1013904223);
                let noise = ((x >> 8) as f64 / 16777216.0 * 2.0 - 1.0) * 0.05;
                let t = i as f64 / rate;
                let tones: f64 = [440.0, 554.37, 659.25].iter().map(|f| 0.1 * (2.0 * std::f64::consts::PI * f * t).sin()).sum();
                (noise + tones) as f32
            })
            .collect()
    }

    #[test]
    fn matches_pytorch_on_the_reference_clip() {
        let Some(bytes) = model_bytes() else { return };
        let mut engine = DetectorEngine::new(&bytes).unwrap();
        let clip = reference_clip();
        for line in include_str!("../tests/music-detector-ref.txt").lines() {
            let (centre, expected) = line.split_once(' ').unwrap();
            let (centre, expected): (usize, f32) = (centre.parse().unwrap(), expected.parse().unwrap());
            let got = engine.window_probability(&clip[centre - DETECTOR_RATE..centre + DETECTOR_RATE]).unwrap();
            assert!((got - expected).abs() < 1e-3, "centre {centre}: got {got}, expected {expected}");
        }
    }

    #[test]
    fn frames_without_a_full_window_are_nan() {
        let Some(bytes) = model_bytes() else { return };
        let mut engine = DetectorEngine::new(&bytes).unwrap();
        let probabilities = engine.frame_probabilities(&vec![0.01; 10 * INPUT_RATE]).unwrap();
        assert_eq!(probabilities.len(), 20);
        assert!(probabilities[..2].iter().chain(&probabilities[18..]).all(|p| p.is_nan()));
        assert!(probabilities[3..17].iter().all(|p| p.is_finite()));
    }

    #[test]
    fn rejects_a_model_with_other_spectrogram_settings() {
        let Some(bytes) = model_bytes() else { return };
        let mut proto = onnx().proto_model_for_read(&mut &bytes[..]).unwrap();
        proto.metadata_props.iter_mut().find(|p| p.key == "hop_length").unwrap().value = "160".into();
        assert!(check_metadata(&proto).is_err());
    }
```

Frame k is centred at `k·16000 + 8000` samples at 32 kHz and needs 32000 plus 64 resampler taps on each side. In a 10 s clip frames 0 to 1 and 18 to 19 lack that, and frame 2 sits right at the limit, so the test leaves it out.

**Step 2: Run and watch it fail**

```bash
cargo test --lib music_detector
```

Expected: compile error, `DetectorEngine` not found.

**Step 3: Implement**

```rust
use std::collections::HashMap;
use std::sync::Arc;

use rustfft::num_complex::Complex;
use rustfft::{Fft, FftPlanner};
use tract_onnx::pb::ModelProto;
use tract_onnx::prelude::*;
use tract_onnx::tract_core::internal::{anyhow, ensure};

const FRAME_INPUT_SAMPLES: usize = INPUT_RATE / 2;
const WINDOW_SAMPLES: usize = 2 * DETECTOR_RATE;
const N_FFT: usize = 1024;
const WIN_LENGTH: usize = 800;
const HOP: usize = 320;
const BINS: usize = N_FFT / 2 + 1;
const FRAMES: usize = (WINDOW_SAMPLES - 1) / HOP + 1;
const PREEMPHASIS: f32 = 0.97;

fn check_metadata(proto: &ModelProto) -> TractResult<()> {
    let meta: HashMap<&str, &str> = proto.metadata_props.iter().map(|e| (e.key.as_str(), e.value.as_str())).collect();
    let expected = [
        ("sample_rate", DETECTOR_RATE.to_string()),
        ("n_fft", N_FFT.to_string()),
        ("win_length", WIN_LENGTH.to_string()),
        ("hop_length", HOP.to_string()),
        ("frames", FRAMES.to_string()),
        ("preemphasis", PREEMPHASIS.to_string()),
    ];
    for (key, value) in expected {
        let got = meta.get(key).copied().ok_or_else(|| anyhow!("missing metadata {key}"))?;
        ensure!(got == value, "metadata {key} is {got}, the engine computes {value}");
    }
    Ok(())
}

// Matches EfficientAT's AugmentMelSTFT in eval mode up to the power spectrogram: pre-emphasis, then
// torch.stft with center=True, reflect padding and a symmetric 800-sample Hann window centred in 1024.
struct Spectrogram {
    fft: Arc<dyn Fft<f32>>,
    window: Vec<f32>,
    padded: Vec<f32>,
    frame: Vec<Complex<f32>>,
    scratch: Vec<Complex<f32>>,
}

impl Spectrogram {
    fn new() -> Spectrogram {
        let fft = FftPlanner::<f32>::new().plan_fft_forward(N_FFT);
        let offset = (N_FFT - WIN_LENGTH) / 2;
        let mut window = vec![0.0; N_FFT];
        for i in 0..WIN_LENGTH {
            window[offset + i] = 0.5 - 0.5 * (2.0 * std::f32::consts::PI * i as f32 / (WIN_LENGTH - 1) as f32).cos();
        }
        let scratch = vec![Complex::new(0.0, 0.0); fft.get_inplace_scratch_len()];
        Spectrogram { fft, window, padded: Vec::new(), frame: vec![Complex::new(0.0, 0.0); N_FFT], scratch }
    }

    fn power(&mut self, x: &[f32], out: &mut [f32]) {
        let len = x.len() - 1;
        let pad = N_FFT / 2;
        let emphasised = |i: usize| x[i + 1] - PREEMPHASIS * x[i];
        self.padded.clear();
        self.padded.extend((1..=pad).rev().map(emphasised));
        self.padded.extend((0..len).map(emphasised));
        self.padded.extend((1..=pad).map(|j| emphasised(len - 1 - j)));
        for f in 0..FRAMES {
            for i in 0..N_FFT {
                self.frame[i] = Complex::new(self.padded[f * HOP + i] * self.window[i], 0.0);
            }
            self.fft.process_with_scratch(&mut self.frame, &mut self.scratch);
            for k in 0..BINS {
                out[k * FRAMES + f] = self.frame[k].norm_sqr();
            }
        }
    }
}

pub struct DetectorEngine {
    plan: TypedRunnableModel<TypedModel>,
    spectrogram: Spectrogram,
    phases: [Vec<f32>; 2],
    power: Vec<f32>,
}

impl DetectorEngine {
    pub fn new(model_bytes: &[u8]) -> TractResult<DetectorEngine> {
        let proto = onnx().proto_model_for_read(&mut &model_bytes[..])?;
        check_metadata(&proto)?;
        let plan = onnx()
            .model_for_proto_model(&proto)?
            .with_input_fact(0, f32::fact([1, BINS, FRAMES]).into())?
            .into_optimized()?
            .into_runnable()?;
        Ok(DetectorEngine { plan, spectrogram: Spectrogram::new(), phases: resample_phases(), power: vec![0.0; BINS * FRAMES] })
    }

    fn window_probability(&mut self, window: &[f32]) -> TractResult<f32> {
        ensure!(window.len() == WINDOW_SAMPLES, "expected {WINDOW_SAMPLES} samples");
        self.spectrogram.power(window, &mut self.power);
        let input = Tensor::from_shape(&[1, BINS, FRAMES], &self.power)?.into_tvalue();
        let outputs = self.plan.run(tvec![input])?;
        Ok(outputs[0].try_as_plain_ram()?.as_slice::<f32>()?[0])
    }

    // One probability per 0.5 s frame of 48 kHz mono input. A frame whose 2 s window does not fit
    // inside the input gets NaN, which the gate treats as music.
    pub fn frame_probabilities(&mut self, mono48: &[f32]) -> TractResult<Vec<f32>> {
        let x = resample_48k_to_32k(mono48, &self.phases);
        let frame = DETECTOR_RATE / 2;
        let reach = WINDOW_SAMPLES / 2 + RESAMPLE_HALF;
        (0..mono48.len() / FRAME_INPUT_SAMPLES)
            .map(|k| {
                let centre = k * frame + frame / 2;
                if centre < reach || centre + reach > x.len() {
                    return Ok(f32::NAN);
                }
                self.window_probability(&x[centre - WINDOW_SAMPLES / 2..centre + WINDOW_SAMPLES / 2])
            })
            .collect()
    }
}
```

A native check on 2026-11-02 ran this model through `into_runnable()` on tract 0.23.8. If the compiler names a different type than `TypedRunnableModel<TypedModel>`, use that.

**Step 4: Run the tests**

```bash
cargo test --lib music_detector
```

Expected: 6 passed. If parity fails by more than 1e-3, compare the power spectrogram first: dump `self.power` for the first centre and compare with `torch.stft` output from `export_onnx.py`. A mismatch at the edges means the reflect padding is wrong, everywhere means the window offset.

**Step 5: Commit**

```bash
git add native/dpdf/src/music_detector.rs
git commit -m "feat(detector): EfficientAT spectrogram and tract engine, matching PyTorch"
```

---

### Task 5: Export the detector to JS

**Files:**
- Modify: `native/dpdf/src/music_detector.rs`, `native/dpdf/src/lib.rs`
- Modify: `scripts/dpdf-bindings-factory.mjs`
- Test: `test/dpdf-bindings-factory.test.js`

**Step 1: Add the wasm-bindgen class**

In `music_detector.rs`:

```rust
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub struct MusicDetector {
    engine: DetectorEngine,
}

#[wasm_bindgen]
impl MusicDetector {
    #[wasm_bindgen(constructor)]
    pub fn new(model_bytes: &[u8]) -> Result<MusicDetector, JsError> {
        DetectorEngine::new(model_bytes).map(|engine| MusicDetector { engine }).map_err(crate::js_error)
    }

    pub fn frame_probabilities(&mut self, mono48: &[f32]) -> Result<Vec<f32>, JsError> {
        self.engine.frame_probabilities(mono48).map_err(crate::js_error)
    }
}
```

In `lib.rs` add `pub use music_detector::MusicDetector;` and make `js_error` `pub(crate)`.

**Step 2: Write the failing factory test**

In `test/dpdf-bindings-factory.test.js`, change the glue in `glue of an unexpected shape is refused` to include both classes:

```js
    () => toBindingsFactory("import x from 'y';\nexport class Dpdf {}\nexport class MusicDetector {}\nexport { initSync, __wbg_init as default };"),
```

and add:

```js
test('the factory refuses glue without the music detector', () => {
  assert.throws(() => toBindingsFactory('export class Dpdf {}\nexport { initSync, __wbg_init as default };'), /changed shape/);
});

test('the factory exposes a working music detector', { skip }, async () => {
  const detectorModel = new URL('../extension/assets/music-detector-mn05.onnx', import.meta.url);
  if (!existsSync(detectorModel)) return;
  const { default: createBindings } = await importSource(toBindingsFactory(readFileSync(GLUE, 'utf8')));
  const bindings = createBindings();
  bindings.initSync({ module: new WebAssembly.Module(readFileSync(WASM)) });
  const detector = new bindings.MusicDetector(new Uint8Array(readFileSync(detectorModel)));
  const probabilities = detector.frame_probabilities(new Float32Array(10 * 48000).fill(0.01));
  assert.equal(probabilities.length, 20);
  assert.ok(Number.isNaN(probabilities[0]) && Number.isFinite(probabilities[10]));
});
```

**Step 3: Run and watch it fail**

```bash
cd ../.. && node --test test/dpdf-bindings-factory.test.js
```

Expected: the new refusal test fails (the factory accepts glue without the detector).

**Step 4: Update the factory**

```js
const EXPORTED_CLASSES = ['Dpdf', 'MusicDetector'];
const EXPORT_LIST = 'export { initSync, __wbg_init as default };';

export function toBindingsFactory(source) {
  const hasClasses = EXPORTED_CLASSES.every((name) => source.includes(`export class ${name} `));
  if (!hasClasses || !source.includes(EXPORT_LIST)) {
    throw new Error('the wasm-bindgen glue changed shape, so update toBindingsFactory');
  }
  let body = source.replace(EXPORT_LIST, '');
  for (const name of EXPORTED_CLASSES) body = body.replace(`export class ${name} `, `class ${name} `);
  if (/^\s*(import|export)\b/m.test(body)) throw new Error('the wasm-bindgen glue has an import or export left');
  return `export default function createDpdfBindings() {\n${body}\nreturn { ${EXPORTED_CLASSES.join(', ')}, initSync };\n}\n`;
}
```

Keep the existing comment above the function.

**Step 5: Build the wasm and run everything**

```bash
df -h / | tail -1
npm run build:dpdf
npm test
```

Expected: `vendor/dpdf/SOURCE` shows a larger `wasm bytes` than before. All tests pass, including the two new ones (they need the model, so check they did not skip).

**Step 6: Commit**

```bash
git add native/dpdf/src scripts/dpdf-bindings-factory.mjs test/dpdf-bindings-factory.test.js vendor/dpdf/SOURCE
git commit -m "feat(detector): expose MusicDetector from the dpdf wasm"
```

---

### Task 6: Check the shipped detector against the bake-off, and its speed

This needs the bake-off scenes in `listening/detector/scenes/` with their `NN.dpdf-residual.wav`. If they are gone, rebuild them with steps 1 and 2 of the spike doc's Reproduce section first.

**Files:**
- Create: `tools/detector-bakeoff/detect.mjs`
- Modify: `tools/detector-bakeoff/score.py`

**Step 1: Write the Node runner**

```js
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { initSync, MusicDetector } from '../../vendor/dpdf/dpdf.js';

const RATE = 48000;
// The bake-off zero-padded the clip edges. 2.5 s of silence on each side gives the same first and last frames.
const PAD_FRAMES = 5;
const repoPath = (relative) => fileURLToPath(new URL(`../../${relative}`, import.meta.url));
const scenes = fileURLToPath(new URL('../../listening/detector/scenes/', import.meta.url));

initSync({ module: readFileSync(repoPath('extension/assets/dpdf_bg.wasm')) });
const detector = new MusicDetector(new Uint8Array(readFileSync(repoPath('extension/assets/music-detector-mn05.onnx'))));

function readFloatWav(file) {
  const bytes = readFileSync(file);
  for (let offset = 12; offset + 8 <= bytes.length; ) {
    const id = bytes.toString('ascii', offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    if (id === 'data') return new Float32Array(bytes.buffer.slice(bytes.byteOffset + offset + 8, bytes.byteOffset + offset + 8 + size));
    offset += 8 + size + (size % 2);
  }
  throw new Error(`${file} has no data chunk`);
}

let audioSeconds = 0;
let computeMs = 0;
for (const name of readdirSync(scenes).filter((f) => /^\d\d\.dpdf-residual\.wav$/.test(f))) {
  const residual = readFloatWav(scenes + name);
  const pad = (PAD_FRAMES * RATE) / 2;
  const padded = new Float32Array(residual.length + 2 * pad);
  padded.set(residual, pad);
  const startedAt = performance.now();
  const probabilities = detector.frame_probabilities(padded);
  computeMs += performance.now() - startedAt;
  audioSeconds += residual.length / RATE;
  const frames = Array.from(probabilities.slice(PAD_FRAMES, probabilities.length - PAD_FRAMES));
  writeFileSync(scenes + name.replace('.dpdf-residual.wav', '.shipped.json'), JSON.stringify(frames));
}
console.log(`${(computeMs / audioSeconds).toFixed(1)} ms of detector per second of audio`);
```

**Step 2: Teach score.py to read those probabilities**

Add:

```python
def shipped_probabilities():
    scenes = []
    for path in sorted(glob.glob(os.path.join(WORK, "scenes/[0-9][0-9].wav"))):
        labels = json.load(open(path.removesuffix(".wav") + ".json"))
        prob = np.array(json.load(open(path.removesuffix(".wav") + ".shipped.json")), dtype=float)
        scenes.append((prob[: len(labels["musicDb"])], labels))
    return {"Shipped detector (wasm), dpdf-residual": scenes}
```

In `main()`, build `results` from `shipped_probabilities()` when `INPUT == "shipped"` and skip loading the PyTorch detectors. Otherwise keep the current code.

**Step 3: Run both**

```bash
export PATH=/opt/homebrew/opt/node@24/bin:$PATH
node tools/detector-bakeoff/detect.mjs
cd tools/detector-bakeoff && ../../listening/detector/.venv/bin/python -W ignore score.py shipped 2>&1 | grep -v -E "^INFO|FMAX"
```

**Pass if** the 0.05 row is within these limits of the PyTorch row for EfficientAT mn05 2 s on dpdf-residual (27.5 s let through, 16 leaks, 47% effects kept):

- music let through within 22 to 33 s
- effects kept within 44% to 50%

**Speed:** natively on the M2 Pro, tract took 20 ms per 2 s window, so 41 ms per second of audio. In wasm expect about 2 to 3 times that. If Node prints more than 150 ms per second of audio, stop and tell the user. The fallback is a 1 s frame (half the cost), which needs a new score run with `FRAME_SECONDS = 1.0` and `REACH = 1` in the bake-off scripts.

If parity fails but Task 4 passed, the resampler is the difference (the bake-off used soxr). Report the numbers to the user before tuning `RESAMPLE_CUTOFF`.

**Step 4: Add the result to the spike doc and commit**

Add a "Shipped detector" row to the results table in `docs/spikes/2026-11-02-music-detector-bakeoff.md` and the measured ms per second of audio.

```bash
git add tools/detector-bakeoff docs/spikes/2026-11-02-music-detector-bakeoff.md
git commit -m "test(detector): the wasm detector reproduces the bake-off scores"
```

---

### Task 7: The gate

**Files:**
- Create: `src/pipeline/music-gate.js`
- Test: `test/music-gate.test.js`

**Step 1: Write the failing tests**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { gateCurve, isPassthrough, mixGate, openFrames, passthroughRanges } from '../src/pipeline/music-gate.js';

const near = (actual, expected) => assert.deepEqual(Array.from(actual, (v) => Math.round(v * 1000) / 1000), expected);

test('a frame opens only when every frame within reach is quiet, and the edges stay closed', () => {
  assert.deepEqual(openFrames(new Float32Array(9)), [false, false, false, true, true, true, false, false, false]);
});

test('one loud frame keeps its neighbours within reach closed', () => {
  const probabilities = new Float32Array(15);
  probabilities[7] = 0.5;
  assert.deepEqual(openFrames(probabilities).flatMap((open, k) => (open ? [k] : [])), [3, 11]);
});

test('a frame the detector could not score counts as music', () => {
  const probabilities = new Float32Array(9);
  probabilities[4] = NaN;
  assert.ok(openFrames(probabilities).every((open) => !open));
});

test('a score at the threshold counts as music', () => {
  assert.ok(openFrames(new Float32Array(9).fill(0.05)).every((open) => !open));
});

test('the curve fades in and out inside the open region', () => {
  const curve = gateCurve([false, true, true, false], { frameSamples: 10, length: 40, fadeSamples: 5 });
  near(curve.subarray(8, 16), [0, 0, 0.2, 0.4, 0.6, 0.8, 1, 1]);
  near(curve.subarray(24, 32), [1, 1, 0.8, 0.6, 0.4, 0.2, 0, 0]);
});

test('an open region shorter than two fades never reaches full original', () => {
  near(gateCurve([false, true, false], { frameSamples: 4, length: 12, fadeSamples: 5 }).subarray(4, 8), [0.2, 0.4, 0.4, 0.2]);
});

test('mixGate blends original and filtered by the curve, per channel', () => {
  const [left, right] = mixGate(
    [new Float32Array([1, 1, 1]), new Float32Array([2, 2, 2])],
    [new Float32Array(3), new Float32Array(3)],
    new Float32Array([0, 0.5, 1]),
  );
  assert.deepEqual(Array.from(left), [0, 0.5, 1]);
  assert.deepEqual(Array.from(right), [0, 1, 2]);
});

test('passthroughRanges lists where the original is mostly playing, in seconds', () => {
  const curve = new Float32Array([0, 0, 0.6, 1, 1, 0.4, 0, 0, 1, 1]);
  assert.deepEqual(passthroughRanges(curve, 10), [[0.2, 0.5], [0.8, 1]]);
});

test('isPassthrough checks a moment against those ranges', () => {
  const ranges = [[10, 12]];
  assert.equal(isPassthrough(ranges, 11), true);
  assert.equal(isPassthrough(ranges, 12), false);
  assert.equal(isPassthrough([], 11), false);
});
```

**Step 2: Run and watch them fail**

```bash
node --test test/music-gate.test.js
```

Expected: `Cannot find module`.

**Step 3: Implement**

```js
export const GATE = { frameSeconds: 0.5, threshold: 0.05, reachFrames: 3, fadeSeconds: 0.2 };

// NaN compares false, so a frame the detector could not score counts as music, and so does any frame
// past either end.
export function openFrames(probabilities, { threshold = GATE.threshold, reachFrames = GATE.reachFrames } = {}) {
  const quiet = Array.from(probabilities, (p) => p < threshold);
  return quiet.map((_, k) => {
    for (let j = k - reachFrames; j <= k + reachFrames; j++) if (!quiet[j]) return false;
    return true;
  });
}

// The fades sit inside the open region, so a closed frame always plays fully filtered.
export function gateCurve(open, { frameSamples, length, fadeSamples }) {
  const curve = new Float32Array(length);
  let sinceClosed = 0;
  for (let i = 0; i < length; i++) {
    sinceClosed = open[Math.floor(i / frameSamples)] ? sinceClosed + 1 : 0;
    curve[i] = sinceClosed;
  }
  let untilClosed = 0;
  for (let i = length - 1; i >= 0; i--) {
    untilClosed = curve[i] > 0 ? untilClosed + 1 : 0;
    curve[i] = Math.min(1, curve[i] / fadeSamples, untilClosed / fadeSamples);
  }
  return curve;
}

export function mixGate([left, right], [voiceLeft, voiceRight], curve) {
  const out = [new Float32Array(left.length), new Float32Array(left.length)];
  for (let i = 0; i < left.length; i++) {
    const g = curve[i];
    out[0][i] = g * left[i] + (1 - g) * voiceLeft[i];
    out[1][i] = g * right[i] + (1 - g) * voiceRight[i];
  }
  return out;
}

export function passthroughRanges(curve, sampleRate) {
  const ranges = [];
  let start = null;
  for (let i = 0; i <= curve.length; i++) {
    const isOpen = i < curve.length && curve[i] >= 0.5;
    if (isOpen && start === null) start = i;
    if (!isOpen && start !== null) {
      ranges.push([start / sampleRate, i / sampleRate]);
      start = null;
    }
  }
  return ranges;
}

export const isPassthrough = (ranges, seconds) => ranges.some(([from, to]) => seconds >= from && seconds < to);
```

**Step 4: Run the tests**

```bash
node --test test/music-gate.test.js
```

Expected: 9 passed.

**Step 5: Commit**

```bash
git add src/pipeline/music-gate.js test/music-gate.test.js
git commit -m "feat(gate): turn music scores into a passthrough curve"
```

---

### Task 8: Audio after the window

**Files:**
- Modify: `src/pipeline/stream-engine.js` (`DEFAULT_CONFIG`, `dispatch`, a new `readContextAfter`, the `.then` that calls `onWindow`)
- Test: `test/stream-engine.test.js`

**Step 1: Write the failing tests**

Next to the existing context tests:

```js
test('contextAfterSeconds passes the decoded audio after each window', async () => {
  const S = 48000;
  const calls = [];
  const capture = async (left, right, rate, options) => {
    calls.push({ left, options });
    return [left, right];
  };
  const { engine } = startEngine({ separate: capture, config: { windowSeconds: 4, contextAfterSeconds: 1 } });
  engine.pushChunk(bytes);
  engine.setPlayhead(0, true);
  await settle(engine);
  const [first, second] = calls;
  assert.equal(first.options.contextAfter[0].length, 1 * S);
  assertSame(first.options.contextAfter[0], second.left.subarray(1 * S, 2 * S));
});
```

The first window is `[0, 2 s)` (`firstWindowSeconds` 2). The second starts at `2 s − overlap` = 1 s, so its samples from 1 s in are the audio from 2 s to 3 s. If the first window is planned before 3 s is decoded, its context comes back shorter. Then push the fixture and let it decode before `setPlayhead`, the way the existing context tests do.

```js
test('contextAfter is empty by default and stops where decoding stops', async () => {
  const lengths = [];
  const capture = async (left, right, rate, options) => {
    lengths.push(options.contextAfter[0].length);
    return [left, right];
  };
  const { engine } = startEngine({ separate: capture, config: { windowSeconds: 4 } });
  engine.pushChunk(bytes);
  engine.setPlayhead(0, true);
  await settle(engine);
  assert.ok(lengths.length >= 3 && lengths.every((length) => length === 0));
});

test('passthrough ranges from separate come back in media seconds', async () => {
  const separate = async (left, right) => [left, right, [[0.5, 1]]];
  const { engine, windows } = startEngine({ separate, config: { windowSeconds: 4 } });
  engine.pushChunk(bytes);
  engine.setPlayhead(0, true);
  await settle(engine);
  assert.deepEqual(windows[0].passthrough, [[0.5, 1]]);
  assert.deepEqual(windows[1].passthrough, [[windows[1].startSeconds + 0.5, windows[1].startSeconds + 1]]);
});
```

**Step 2: Run and watch them fail**

```bash
node --test test/stream-engine.test.js
```

Expected: `Cannot read properties of undefined (reading '0')` on `contextAfter`, and `passthrough` undefined.

**Step 3: Implement**

In `DEFAULT_CONFIG` add `contextAfterSeconds: 0,` after `warmUpBeforeSeconds: 1,`.

Add next to `readContextBefore`:

```js
  readContextAfter({ end }) {
    const { sampleRate: rate, contextAfterSeconds, maxStartGapSeconds } = this.config;
    const latest = end + Math.round(contextAfterSeconds * rate);
    const to = Math.min(latest, bridgedEnd(this.timeline.ranges, end, maxStartGapSeconds * rate));
    if (to <= end) return [new Float32Array(0), new Float32Array(0)];
    return this.readWindow({ start: end, end: to });
  }
```

In `dispatch`, read it beside `contextBefore` and pass it on:

```js
    const contextAfter = this.readContextAfter(window);
    ...
      return this.separate(pcm[0], pcm[1], rate, { contextBefore, contextAfter, runSeconds });
```

In the `.then`:

```js
        const [left, right, passthrough = []] = separated;
        ...
        const startSeconds = window.start / rate;
        this.onWindow({
          startSeconds,
          sampleRate: rate,
          left,
          right,
          passthrough: passthrough.map(([from, to]) => [startSeconds + from, startSeconds + to]),
        });
```

**Step 4: Run all tests**

```bash
npm test
```

Expected: all pass. The playback scheduler ignores the new `passthrough` field.

**Step 5: Commit**

```bash
git add src/pipeline/stream-engine.js test/stream-engine.test.js
git commit -m "feat(read-ahead): pass audio after each window and passthrough ranges"
```

---

### Task 9: Gated filtering in the read-ahead Workers

**Files:**
- Modify: `src/separator/read-ahead-filters.js`
- Modify: `src/separator/filter-worker.js`, `src/separator/filter-pool.js`, `src/separator/worker.js`
- Test: `test/read-ahead-filters.test.js`, `test/filter-pool.test.js`

**Step 1: Write the failing tests**

In `test/read-ahead-filters.test.js`:

```js
const stereo = (seconds) => [
  Float32Array.from({ length: seconds * RATE }, (_, i) => 0.1 * Math.sin(i / 10)),
  Float32Array.from({ length: seconds * RATE }, (_, i) => 0.1 * Math.cos(i / 7)),
];

function gated({ probability = 0, detectorFails = false } = {}) {
  const runtimes = fakeRuntimes();
  const seen = [];
  const instantiate = async () => ({
    ...(await runtimes.instantiate()),
    createDetector: () => ({
      frameProbabilities(residual) {
        seen.push(residual.length);
        return new Float32Array(Math.floor(residual.length / (RATE / 2))).fill(probability);
      },
    }),
  });
  const fetchDetector = async () => {
    if (detectorFails) throw new Error('no detector');
    return new Uint8Array(1);
  };
  return { filters: createReadAheadFilters({ instantiate, fetchModel: runtimes.fetchModel, fetchDetector }), seen };
}

const runGated = (filters) =>
  filters.filter(...stereo(10), RATE, { contextBefore: stereo(2.5), contextAfter: stereo(2.5), keepOtherSounds: true });

test('with no music anywhere the window plays the original', async () => {
  const { filters, seen } = gated({ probability: 0 });
  const original = stereo(10);
  const [left, right, passthrough] = await runGated(filters);
  assert.deepEqual(seen, [15 * RATE]);
  assert.deepEqual(Array.from(left), Array.from(original[0]));
  assert.deepEqual(Array.from(right), Array.from(original[1]));
  assert.deepEqual(passthrough, [[0, 10]]);
});

test('with music everywhere the window plays the filtered voice', async () => {
  const { filters } = gated({ probability: 0.9 });
  const [left, right, passthrough] = await runGated(filters);
  assert.deepEqual(Array.from(left), Array.from(right));
  assert.deepEqual(passthrough, []);
});

test('a detector that fails to load leaves the window filtered', async () => {
  const { filters } = gated({ detectorFails: true });
  const [left, right, passthrough] = await runGated(filters);
  assert.deepEqual(Array.from(left), Array.from(right));
  assert.deepEqual(passthrough, []);
});

test('without keepOtherSounds the detector is never loaded', async () => {
  const { filters, seen } = gated();
  await filters.filter(...stereo(2), RATE, {});
  assert.deepEqual(seen, []);
});
```

Original left and right differ (sine vs cosine) and the filtered voice is mono on both channels, so `left == right` means "filtered" and `left == original` means "original".

In `test/filter-pool.test.js`, extend the test that checks what `run` posts so it also sends `contextAfter` (transferred) and `keepOtherSounds`. Follow the shape of the existing `contextBefore` assertion there.

**Step 2: Run and watch them fail**

```bash
node --test test/read-ahead-filters.test.js test/filter-pool.test.js
```

**Step 3: Implement the gate in `createReadAheadFilters`**

```js
import { GATE, gateCurve, mixGate, openFrames, passthroughRanges } from '../pipeline/music-gate.js';

const EMPTY = new Float32Array(0);

function join(parts) {
  const out = new Float32Array(parts.reduce((length, part) => length + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}
```

Change the signature to `createReadAheadFilters({ instantiate, fetchModel, fetchDetector })`, add `let detector = null;`, clear it in `discardRuntime`, and add:

```js
  // A detector that fails to load leaves the window filtered, and the next window tries again.
  function detectorFor() {
    if (!detector) {
      runtime ??= instantiate();
      const pending = Promise.all([runtime, fetchDetector()]).then(([{ createDetector }, bytes]) => createDetector(bytes));
      pending.catch(() => {
        if (detector === pending) detector = null;
      });
      detector = pending;
    }
    return detector;
  }

  // The window is filtered together with the audio around it, because the gate needs 1.5 s of scores
  // on each side and each score needs 1 s of audio on each side.
  async function gatedFilter(voiceFilter, left, right, sampleRate, { contextBefore, contextAfter }) {
    const [beforeLeft = EMPTY, beforeRight = EMPTY] = contextBefore ?? [];
    const [afterLeft = EMPTY, afterRight = EMPTY] = contextAfter ?? [];
    const spanLeft = join([beforeLeft, left, afterLeft]);
    const spanRight = join([beforeRight, right, afterRight]);
    const [voice] = voiceFilter(spanLeft, spanRight);
    const start = beforeLeft.length;
    const windowVoice = voice.subarray(start, start + left.length);
    const filtered = () => [windowVoice.slice(), windowVoice.slice(), []];

    const loaded = await detectorFor().catch(() => null);
    if (!loaded) return filtered();
    const residual = new Float32Array(voice.length);
    for (let i = 0; i < voice.length; i++) residual[i] = 0.5 * (spanLeft[i] + spanRight[i]) - voice[i];
    let probabilities;
    try {
      probabilities = loaded.frameProbabilities(residual);
    } catch {
      discardRuntime();
      return filtered();
    }
    const curve = gateCurve(openFrames(probabilities), {
      frameSamples: GATE.frameSeconds * sampleRate,
      length: voice.length,
      fadeSamples: GATE.fadeSeconds * sampleRate,
    }).subarray(start, start + left.length);
    const [outLeft, outRight] = mixGate([left, right], [windowVoice, windowVoice], curve);
    return [outLeft, outRight, passthroughRanges(curve, sampleRate)];
  }
```

And in `filter`:

```js
    async filter(left, right, sampleRate, { contextBefore, contextAfter, model = FIRST_MODEL, keepOtherSounds = false } = {}) {
      const { voiceFilter } = await filterFor(model);
      try {
        if (keepOtherSounds) return await gatedFilter(voiceFilter, left, right, sampleRate, { contextBefore, contextAfter });
        return voiceFilter(left, right, { contextBefore });
      } catch (error) {
        discardRuntime();
        throw error;
      }
    },
```

With the gate on, DPDFNet warms up on the first 0.25 s of the span (its default) instead of on `contextBefore`. The window itself is then warmed by 2.5 s of real audio.

**Step 4: Wire the Workers**

`src/separator/filter-worker.js`:

```js
const DETECTOR_MODEL_URL = new URL('../assets/music-detector-mn05.onnx', import.meta.url);

async function instantiateDpdf() {
  const module = await compileDpdf();
  const { Dpdf, MusicDetector, initSync } = createDpdfBindings();
  initSync({ module });
  return {
    createEngine: (modelBytes) => wrapDpdf(new Dpdf(modelBytes)),
    createDetector: (modelBytes) => {
      const detector = new MusicDetector(modelBytes);
      return { frameProbabilities: (samples) => detector.frame_probabilities(samples) };
    },
  };
}

const filters = createReadAheadFilters({
  instantiate: instantiateDpdf,
  fetchModel: (model) => fetchBytes(DPDF_MODEL_URLS[model]),
  fetchDetector: () => fetchBytes(DETECTOR_MODEL_URL),
});
```

`filterWindow` takes `contextAfter` and `keepOtherSounds` and passes them to `filters.filter`. In `serve`, destructure `output: [left, right, passthrough]` and add `passthrough` to the `filtered` message.

`src/separator/filter-pool.js`: `run({ model, sampleRate, left, right, contextBefore, contextAfter, keepOtherSounds })`, add `...(contextAfter ?? [])` to the transferred buffers and both fields to the message.

`src/separator/worker.js`:

```js
// The gate needs 2.5 s of audio on each side of a window. See music-gate.js.
const GATE_CONTEXT = { warmUpBeforeSeconds: 2.5, contextAfterSeconds: 2.5 };
```

- `createWindowFilter(model, streamId, { keepOtherSounds = false } = {})`. The returned function takes `{ contextBefore, contextAfter, runSeconds }`, passes `contextAfter: contextAfter?.map(copyOf)` and `keepOtherSounds` to `filterPool.run`, and returns `[result.left, result.right, result.passthrough ?? []]`.
- In `handleStream`, read `keepOtherSounds = false` from the `stream-reset` message. Pass it to `createWindowFilter`, and spread `GATE_CONTEXT` into the engine `config` when it is on.

Leave `modelPolicy.observe`'s `samples` as it is. It does not count `contextAfter`, so the measured RTF is a little high, which falls back to DPDFNet-2 sooner rather than later.

**Step 5: Run the tests and build**

```bash
npm test && npm run build
```

Expected: all pass, build clean.

**Step 6: Commit**

```bash
git add src/separator test/read-ahead-filters.test.js test/filter-pool.test.js
git commit -m "feat(gate): mix the original back in where the detector hears no music"
```

---

### Task 10: The setting and the popup switch

**Files:**
- Modify: `src/content/settings.js`, `src/popup/popup.js`, `extension/popup.html`
- Test: `test/settings.test.js`

**Step 1: Write the failing tests**

```js
test('keepOtherSounds is off until the user turns it on', async () => {
  assert.equal(await createSettings(fakeStorage()).readKeepOtherSounds(), false);
  assert.equal(await createSettings(fakeStorage({ keepOtherSounds: true })).readKeepOtherSounds(), true);
});

test('keepOtherSounds reads as off when storage fails, and stores the choice', async () => {
  const broken = fakeStorage();
  broken.local.get = async () => {
    throw new Error('storage unavailable');
  };
  assert.equal(await createSettings(broken).readKeepOtherSounds(), false);
  const settings = createSettings(fakeStorage());
  await settings.writeKeepOtherSounds(true);
  assert.equal(await settings.readKeepOtherSounds(), true);
});
```

**Step 2: Run, watch them fail, implement**

```js
const ENABLED = 'enabled';
const KEEP_OTHER_SOUNDS = 'keepOtherSounds';
const DEFAULTS = { [ENABLED]: true, [KEEP_OTHER_SOUNDS]: false };

async function read(local, key) {
  try {
    const values = await local.get(key);
    return values[key] ?? DEFAULTS[key];
  } catch {
    return DEFAULTS[key];
  }
}
```

`readEnabled` becomes `() => read(local, ENABLED)`. Add `readKeepOtherSounds: () => read(local, KEEP_OTHER_SOUNDS)` and `writeKeepOtherSounds: (on) => local.set({ [KEEP_OTHER_SOUNDS]: on })`. Keep `watchEnabled` as it is, with `DEFAULT_ENABLED` replaced by `DEFAULTS[ENABLED]`.

```bash
node --test test/settings.test.js
```

**Step 3: The popup**

In `extension/popup.html`, after `</header>` and before `#status`:

```html
<div class="option">
  <div>
    <div id="keep-title">Keep other sounds when there's no music</div>
    <div id="keep-note" class="note">Very quiet music can slip through. Reload YouTube to apply.</div>
  </div>
  <label class="switch">
    <input id="keep-other-sounds" type="checkbox" role="switch" aria-labelledby="keep-title" aria-describedby="keep-note" disabled>
    <span></span>
  </label>
</div>
```

CSS, next to the other rules:

```css
  .option { display: flex; align-items: center; gap: 10px; margin-top: 14px; }
  .option > div { flex: 1; }
  .note { margin-top: 2px; color: var(--muted); font-size: 12px; }
```

In `src/popup/popup.js`:

```js
const keepOtherSounds = document.getElementById('keep-other-sounds');
keepOtherSounds.addEventListener('change', () => settings.writeKeepOtherSounds(keepOtherSounds.checked));
```

and beside the existing startup lines:

```js
keepOtherSounds.checked = await settings.readKeepOtherSounds();
keepOtherSounds.disabled = false;
```

The setting applies on the next page load. Live mode owns the page's audio routing once it starts, so switching modes in place would need a handover that live mode only supports in one direction.

**Step 4: Check the popup renders**

```bash
npm run build
```

Open `extension/popup.html` in the built-in browser (it will show the disabled state without the extension API, which is enough to check layout in light and dark). Take a screenshot.

**Step 5: Commit**

```bash
git add src/content/settings.js src/popup/popup.js extension/popup.html test/settings.test.js
git commit -m "feat(settings): keepOtherSounds switch in the popup, off by default"
```

---

### Task 11: Read-ahead on every browser while the switch is on

**Files:**
- Modify: `src/content/live-filter.js` (`selectFilterMode`)
- Modify: `src/content/read-ahead.js`
- Test: `test/live-filter.test.js`

**Step 1: Write the failing test**

Next to the other `selectFilterMode` tests (around line 176):

```js
test('keeping other sounds uses read-ahead even on desktop Chrome', () => {
  const chrome = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
  assert.equal(mode('Google Inc.', chrome), 'live');
  assert.equal(mode('Google Inc.', chrome, { keepOtherSounds: true }), 'read-ahead');
  assert.equal(
    selectFilterMode({ vendor: 'Google Inc.', hostname: 'localhost', override: 'live', keepOtherSounds: true }),
    'live',
  );
});
```

The localhost override still wins, so a developer can test live mode with the switch on.

**Step 2: Run, watch it fail, implement**

```js
export function selectFilterMode({ vendor, userAgent = '', maxTouchPoints = 0, isMobile = false, hostname, override, keepOtherSounds = false }) {
  if (hostname === 'localhost' && MODES.has(override)) return override;
  if (keepOtherSounds) return 'read-ahead';
  ...
```

```bash
node --test test/live-filter.test.js
```

**Step 3: Read the setting before choosing the mode**

In `src/content/read-ahead.js`:

- Import `createSettings, extensionApi` from `./settings.js` and `addRange` from `../pipeline/ranges.js`.
- Add `let keepOtherSounds = false;`.
- Keep `connectTap()` running at load, before anything awaits, so no tap event is missed.
- Move the `selectFilterMode` call and the `if (filterMode === 'live') … else …` branch into:

```js
async function start() {
  keepOtherSounds = keepOtherSoundsOverride() ?? (await createSettings(extensionApi().storage).readKeepOtherSounds());
  const filterMode = selectFilterMode({
    vendor: navigator.vendor,
    userAgent: navigator.userAgent,
    maxTouchPoints: navigator.maxTouchPoints,
    isMobile: navigator.userAgentData?.mobile,
    hostname: location.hostname,
    override: readModeOverride(),
    keepOtherSounds,
  });
  if (filterMode === 'live') {
    retainedLimit = LIVE_RETAINED_BYTES;
    startLiveFilter({ onTooSlowAtStart: takeOverFromLive });
  } else {
    startReadAhead(createPanel({ onToggle: toggle }));
  }
}
```

  and call `start();` where the branch was. `readKeepOtherSounds` never throws, so `start` needs no catch of its own.

- The e2e test needs the switch without the extension's storage, like `mf_mode`:

```js
function keepOtherSoundsOverride() {
  try {
    return location.hostname === 'localhost' && localStorage.getItem('mf_keep_other_sounds') === '1' ? true : null;
  } catch {
    return null;
  }
}
```

- `sendRetained` adds `keepOtherSounds` to the `stream-reset` message.

**Step 4: Run tests and build**

```bash
npm test && npm run build
```

**Step 5: Commit**

```bash
git add src/content/live-filter.js src/content/read-ahead.js test/live-filter.test.js
git commit -m "feat(read-ahead): use read-ahead on every browser when keeping other sounds"
```

---

### Task 12: Show "Original sound" in the panel

**Files:**
- Modify: `src/content/controls-policy.js`, `src/content/panel.js`, `src/content/read-ahead.js`
- Test: `test/controls-policy.test.js`

**Step 1: Write the failing test**

```js
test('statusText says when the original sound is playing', () => {
  assert.equal(
    statusText({ isOn: true, state: 'filtered', mode: 'read-ahead', aheadSeconds: 27.6, detail: '', passthrough: true }),
    'Original sound · 28 s ready',
  );
});
```

**Step 2: Run, watch it fail, implement**

```js
  filtered: (view) => {
    const label = view.passthrough ? 'Original sound' : 'Filtered';
    return view.mode === 'live' ? label : `${label} · ${view.aheadSeconds.toFixed(0)} s ready`;
  },
```

`panel.js`: add `passthrough: false` to `view` and `passthrough: String(view.passthrough)` to the `root.dataset` assignment.

`read-ahead.js`:

- `let passthrough = [];`, and set it back to `[]` in `activate`, `deactivate` and `attach`, next to each `scheduler.reset()` or `activeStreamId = null`.
- In `handleWorkerMessage`, for `window` messages:

```js
    passthrough = message.passthrough.reduce((ranges, [from, to]) => addRange(ranges, from, to), passthrough);
```

- In `tick`, add `passthrough: isPassthrough(passthrough, video.currentTime)` to the `panel.update` call. Import `isPassthrough` from `../pipeline/music-gate.js`.

Ranges from overlapping windows are merged, so the label can lag by up to the 1 s window overlap. It is a status label, not a control.

```bash
npm test && npm run build
```

**Step 3: Commit**

```bash
git add src/content test/controls-policy.test.js
git commit -m "feat(panel): show when the original sound is playing"
```

---

### Task 13: Ship the model and test in a real browser

**Files:**
- Modify: `extension/manifest.json` (`web_accessible_resources`), `scripts/package.mjs` (`REQUIRED`), `package.json`
- Create: `test/e2e/keep-other-sounds.e2e.mjs`

**Step 1: Ship the file**

Add `"assets/music-detector-mn05.onnx"` after `"assets/dpdfnet2.onnx"` in the manifest and `'extension/assets/music-detector-mn05.onnx'` to `REQUIRED`.

```bash
npm run package && unzip -l build/store/music-filter-chrome-0.0.1.zip | grep music-detector
```

Expected: the model is listed in the Chrome and Firefox zips. Check the zip name `package.mjs` prints if it differs.

**Step 2: Write the e2e test**

```js
import assert from 'node:assert/strict';
import { snapshot, toggle, video, waitFor, withExtensionPage } from './harness.mjs';

const PORT = 8791;
const TIMEOUT_MS = 90_000;

await withExtensionPage({ port: PORT, storage: { mf_keep_other_sounds: '1', mf_fake_separator: '0' } }, async (page) => {
  await toggle(page);
  await video(page, () => document.querySelector('video').play().catch(() => {}));
  const filtered = await waitFor(page, 'filtered playback', (s) => s.panel.state === 'filtered' && !s.paused, TIMEOUT_MS);
  console.log('filtered', filtered);
  assert.ok(['true', 'false'].includes(filtered.panel.passthrough), `no passthrough state: ${JSON.stringify(filtered.panel)}`);
  await page.waitForTimeout(5000);
  const later = await snapshot(page);
  assert.equal(later.panel.state, 'filtered', `stopped filtering: ${JSON.stringify(later.panel)}`);
  assert.ok(later.currentTime > filtered.currentTime + 3, 'playback did not advance');
  assert.match(later.panel.status, /^(Filtered|Original sound) · \d+ s ready/);
});
```

No `mf_mode` is set, so desktop Chromium picks the mode itself, and it must be read-ahead (the status text with "s ready" only appears in read-ahead). It uses the real models, since the fake separator has no detector.

Add to `package.json` scripts: `"test:e2e:keep": "npm run build && node test/e2e/keep-other-sounds.e2e.mjs"`.

**Step 3: Run it**

```bash
npm run test:e2e:keep
```

Expected: passes and logs the filtered snapshot. Then run `npm run test:e2e` to check the existing suites still pass.

**Step 4: Listen to it**

Load the unpacked extension in Chrome, turn the switch on, reload a YouTube video with speech, sound effects and a music section (a game trailer or a film scene works). Check:

- the music section stays filtered
- effects play where there is no music
- the 200 ms changes are not jarring
- the panel switches between "Filtered" and "Original sound"

Write what you heard, with the video URLs and timestamps, into the spike doc under a "Listening" heading. This is the check for the LibriSpeech caveat.

**Step 5: Commit**

```bash
git add extension/manifest.json scripts/package.mjs package.json test/e2e/keep-other-sounds.e2e.mjs docs/spikes/2026-11-02-music-detector-bakeoff.md
git commit -m "feat(gate): ship the music detector, with an e2e test"
```

---

### Task 14: Docs

**Files:**
- Modify: `docs/plans/2026-11-02-music-gated-passthrough-design.md`, `docs/README.md`, `docs/store/listing.md`, `README.md`

**Step 1: Bring the design doc in line with what was built**

- Decisions: changing the switch applies on the next page load, not immediately.
- How it works: each window is filtered with 2.5 s of audio on each side (`GATE_CONTEXT` in `worker.js`). The first and last 2.5 s of a video, and the end of a window when the next audio is not decoded yet, stay filtered.
- Components: the files as built, including `music_detector.rs`, `music-gate.js` and the `passthrough` ranges.
- docs/README.md: mark the design "Built" and add this plan.

**Step 2: Listing copy**

In `docs/store/listing.md`, add one feature line for the switch, and next to the "original music never plays" line: "With Keep other sounds on, very quiet music can slip through." Update the README's feature list the same way.

**Step 3: Commit**

```bash
git add docs README.md
git commit -m "docs: music-gated passthrough as built"
```

Then tell the user the branch is ready and ask whether to push and open a PR. Store submissions need a version bump and new zips, and the user does those steps.
