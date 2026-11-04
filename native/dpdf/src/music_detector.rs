use std::collections::HashMap;
use std::sync::Arc;

use rustfft::num_complex::Complex;
use rustfft::{Fft, FftPlanner};
use tract_onnx::pb::ModelProto;
use tract_onnx::prelude::*;
use tract_onnx::tract_core::internal::{anyhow, ensure};
use tract_onnx::tract_core::plan::SimplePlan;

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
    state: TypedSimpleState,
    spectrogram: Spectrogram,
    phases: [Vec<f32>; 2],
    power: Vec<f32>,
}

impl DetectorEngine {
    pub fn new(model_bytes: &[u8]) -> TractResult<DetectorEngine> {
        let proto = onnx().proto_model_for_read(&mut &model_bytes[..])?;
        check_metadata(&proto)?;
        let model = onnx()
            .model_for_proto_model(&proto)?
            .with_input_fact(0, f32::fact([1, BINS, FRAMES]).into())?
            .into_optimized()?;
        let state = TypedSimpleState::new(&SimplePlan::new(model)?)?;
        Ok(DetectorEngine { state, spectrogram: Spectrogram::new(), phases: resample_phases(), power: vec![0.0; BINS * FRAMES] })
    }

    fn window_probability(&mut self, window: &[f32]) -> TractResult<f32> {
        ensure!(window.len() == WINDOW_SAMPLES, "expected {WINDOW_SAMPLES} samples");
        self.spectrogram.power(window, &mut self.power);
        let input = Tensor::from_shape(&[1, BINS, FRAMES], &self.power)?.into_tvalue();
        let outputs = self.state.run(tvec![input])?;
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
        let level = rms(&out[1000..out.len() - 1000]);
        assert!(level < 0.5e-3, "rms {level}");
    }
    fn model_bytes() -> Option<Vec<u8>> {
        let path = format!("{}/../../extension/assets/music-detector-mn05.onnx", env!("CARGO_MANIFEST_DIR"));
        std::fs::read(&path).map_err(|_| eprintln!("skipping: {path} missing, run npm run fetch:models")).ok()
    }

    fn reference_clip() -> Vec<f32> {
        let tones = [440.0, 554.37, 659.25];
        let mut x: u32 = 7;
        (0..6 * 32000)
            .map(|i| {
                x = x.wrapping_mul(1664525).wrapping_add(1013904223);
                let noise = (x >> 8) as f64 / 16777216.0 * 2.0 - 1.0;
                let t = i as f64 / 32000.0;
                let sample = if t < 2.0 {
                    0.05 * noise
                } else if t < 4.0 {
                    let envelope = (-12.0 * ((t - 2.0) % 0.25)).exp();
                    let chord: f64 = tones
                        .iter()
                        .flat_map(|f| (1..7).map(move |h| 0.08 / h as f64 * (2.0 * std::f64::consts::PI * f * h as f64 * t).sin()))
                        .sum();
                    envelope * chord
                } else {
                    0.005 * noise + 0.1 * (2.0 * std::f64::consts::PI * 1000.0 * t).sin()
                };
                sample as f32
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
}
