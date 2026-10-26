use std::collections::HashMap;

use rustfft::num_complex::Complex;
use rustfft::{Fft, FftPlanner};
use tract_onnx::pb::ModelProto;
use tract_onnx::prelude::*;
use tract_onnx::tract_core::internal::{anyhow, ensure};
use tract_onnx::tract_core::ops::gru_seq::GruSeq;
use tract_onnx::tract_core::ops::scan::OptScan;
use tract_onnx::tract_core::plan::SimplePlan;
use wasm_bindgen::prelude::*;

struct ModelInfo {
    n: usize,
    hop: usize,
    bins: usize,
    initial_state: Vec<f32>,
}

fn read_model(model_bytes: &[u8]) -> TractResult<(ModelProto, ModelInfo)> {
    let proto = onnx().proto_model_for_read(&mut &model_bytes[..])?;
    let meta: HashMap<&str, &str> =
        proto.metadata_props.iter().map(|e| (e.key.as_str(), e.value.as_str())).collect();
    let get = |k: &str| meta.get(k).copied().ok_or_else(|| anyhow!("missing metadata {k}"));
    let n: usize = get("n_fft")?.parse()?;
    let hop: usize = get("hop_length")?.parse()?;
    let state_size: usize = get("state_size")?.parse()?;
    let erb_size: usize = get("erb_norm_state_size")?.parse()?;
    ensure!(get("window_type")? == "vorbis", "unexpected window {}", get("window_type")?);

    let erb = parse_list(get("erb_norm_init")?)?;
    let spec = parse_list(get("spec_norm_init")?)?;
    ensure!(erb.len() <= erb_size && erb_size + spec.len() <= state_size, "norm init does not fit the state");
    let mut initial_state = vec![0f32; state_size];
    initial_state[..erb.len()].copy_from_slice(&erb);
    initial_state[erb_size..erb_size + spec.len()].copy_from_slice(&spec);

    ensure!(n == 2 * hop, "expected n_fft to be twice the hop, got n_fft {n} and hop {hop}");

    let info = ModelInfo { n, hop, bins: n / 2 + 1, initial_state };
    Ok((proto, info))
}

fn parse_list(s: &str) -> TractResult<Vec<f32>> {
    s.split(',').map(|v| v.trim().parse::<f32>().map_err(|e| anyhow!("bad float {v}: {e}"))).collect()
}

fn optimized_model(proto: &ModelProto, info: &ModelInfo) -> TractResult<TypedModel> {
    onnx()
        .model_for_proto_model(proto)?
        .with_input_fact(0, f32::fact([1, 1, info.bins, 2]).into())?
        .with_input_fact(1, f32::fact([info.initial_state.len()]).into())?
        .into_optimized()
}

// tract keeps GRU hidden state inside the session and reads initial_h on the first call only.
// DPDFNet carries its hidden state through state_in and state_out, so every call must reseed
// from initial_h. Without this, the second hop onward runs on a stale hidden state.
fn reseed_recurrences_every_call(mut model: TypedModel) -> TractResult<TypedModel> {
    let mut reseeded = 0;
    for node in model.nodes_mut() {
        if let Some(gru) = node.op_as_mut::<GruSeq>() {
            gru.reset_every_turn = true;
            reseeded += 1;
        } else if let Some(scan) = node.op_as::<OptScan>() {
            let mut params = (**scan).clone();
            params.reset_every_turn = true;
            node.op = Box::new(OptScan::new(Arc::new(params)));
            reseeded += 1;
        }
    }
    ensure!(reseeded > 0, "found no GRU or Scan node to reseed, so tract has renamed or changed its recurrent ops");
    Ok(model)
}

fn vorbis(n: usize) -> Vec<f32> {
    (0..n)
        .map(|i| {
            let s = (0.5 * std::f64::consts::PI * (i as f64 + 0.5) / (n as f64 / 2.0)).sin();
            (0.5 * std::f64::consts::PI * s * s).sin() as f32
        })
        .collect()
}

fn overlap_add_norm(window: &[f32], hop: usize) -> Vec<f32> {
    let n = window.len();
    let reach = n.div_ceil(hop) as isize;
    (0..n)
        .map(|i| {
            (-reach..=reach)
                .map(|k| i as isize + k * hop as isize)
                .filter(|&j| j >= 0 && (j as usize) < n)
                .map(|j| window[j as usize] * window[j as usize])
                .sum()
        })
        .collect()
}

pub struct Engine {
    state: TypedSimpleState,
    model_state: Option<TValue>,
    initial_state: Vec<f32>,
    n: usize,
    hop: usize,
    bins: usize,
    window: Vec<f32>,
    norm: Vec<f32>,
    analysis: Vec<f32>,
    synthesis: Vec<f32>,
    fft: Arc<dyn Fft<f64>>,
    ifft: Arc<dyn Fft<f64>>,
    cbuf: Vec<Complex<f64>>,
    scratch: Vec<Complex<f64>>,
    spec: Vec<f32>,
}

impl Engine {
    pub fn new(model_bytes: &[u8]) -> TractResult<Engine> {
        let (proto, info) = read_model(model_bytes)?;
        let plan = SimplePlan::new(reseed_recurrences_every_call(optimized_model(&proto, &info)?)?)?;
        let state = TypedSimpleState::new(&plan)?;
        let ModelInfo { n, hop, bins, initial_state } = info;
        let window = vorbis(n);
        let norm = overlap_add_norm(&window, hop);

        let mut planner = FftPlanner::<f64>::new();
        let fft = planner.plan_fft_forward(n);
        let ifft = planner.plan_fft_inverse(n);
        let scratch_len = fft.get_inplace_scratch_len().max(ifft.get_inplace_scratch_len());

        Ok(Engine {
            state,
            model_state: Some(tensor1(&initial_state).into_tvalue()),
            initial_state,
            n,
            hop,
            bins,
            window,
            norm,
            analysis: vec![0.0; n],
            synthesis: vec![0.0; n],
            fft,
            ifft,
            cbuf: vec![Complex::new(0.0, 0.0); n],
            scratch: vec![Complex::new(0.0, 0.0); scratch_len],
            spec: vec![0.0; bins * 2],
        })
    }

    pub fn hop(&self) -> usize {
        self.hop
    }

    pub fn reset(&mut self) -> TractResult<()> {
        self.state = TypedSimpleState::new(self.state.plan())?;
        self.model_state = Some(tensor1(&self.initial_state).into_tvalue());
        self.analysis.fill(0.0);
        self.synthesis.fill(0.0);
        Ok(())
    }

    pub fn process(&mut self, input: &[f32], output: &mut [f32]) -> TractResult<()> {
        let (n, hop, bins) = (self.n, self.hop, self.bins);
        ensure!(input.len() == hop && output.len() == hop, "expected {hop} samples");
        self.analysis.copy_within(hop.., 0);
        self.analysis[n - hop..].copy_from_slice(input);
        for i in 0..n {
            self.cbuf[i] = Complex::new((self.analysis[i] * self.window[i]) as f64, 0.0);
        }
        self.fft.process_with_scratch(&mut self.cbuf, &mut self.scratch);
        for k in 0..bins {
            self.spec[2 * k] = self.cbuf[k].re as f32;
            self.spec[2 * k + 1] = self.cbuf[k].im as f32;
        }

        let spec_in = Tensor::from_shape(&[1, 1, bins, 2], &self.spec)?.into_tvalue();
        let model_state = self.model_state.take().ok_or_else(|| anyhow!("engine poisoned by an earlier error"))?;
        let mut outputs = self.state.run(tvec![spec_in, model_state])?;
        self.model_state = Some(outputs.pop().ok_or_else(|| anyhow!("no state output"))?);
        let spec_out = outputs.pop().ok_or_else(|| anyhow!("no spec output"))?;
        let spec_view = spec_out.try_as_plain_ram()?;
        let spec_out = spec_view.as_slice::<f32>()?;

        // Only the real part of the inverse is kept, so the imaginary parts of DC and Nyquist
        // are dropped. This matches the onnxruntime reference runner.
        for k in 0..bins {
            self.cbuf[k] = Complex::new(spec_out[2 * k] as f64, spec_out[2 * k + 1] as f64);
        }
        for k in bins..n {
            self.cbuf[k] = self.cbuf[n - k].conj();
        }
        self.ifft.process_with_scratch(&mut self.cbuf, &mut self.scratch);

        self.synthesis.copy_within(hop.., 0);
        self.synthesis[n - hop..].fill(0.0);
        for i in 0..n {
            let t = (self.cbuf[i].re / n as f64) as f32;
            self.synthesis[i] += t * self.window[i] / self.norm[i];
        }
        output.copy_from_slice(&self.synthesis[..hop]);
        Ok(())
    }
}

fn js_error(e: TractError) -> JsError {
    JsError::new(&format!("{e:?}"))
}

#[wasm_bindgen]
pub struct Dpdf {
    engine: Engine,
}

#[wasm_bindgen]
impl Dpdf {
    #[wasm_bindgen(constructor)]
    pub fn new(model_bytes: &[u8]) -> Result<Dpdf, JsError> {
        Engine::new(model_bytes).map(|engine| Dpdf { engine }).map_err(js_error)
    }

    #[wasm_bindgen(getter)]
    pub fn hop(&self) -> usize {
        self.engine.hop()
    }

    pub fn process_hop(&mut self, input: &[f32], output: &mut [f32]) -> Result<(), JsError> {
        self.engine.process(input, output).map_err(js_error)
    }

    pub fn reset(&mut self) -> Result<(), JsError> {
        self.engine.reset().map_err(js_error)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn model_bytes_named(name: &str) -> Option<Vec<u8>> {
        let path = format!("{}/../../extension/assets/{name}.onnx", env!("CARGO_MANIFEST_DIR"));
        match std::fs::read(&path) {
            Ok(bytes) => Some(bytes),
            Err(_) => {
                eprintln!("skipping: {path} missing, run npm run fetch:models");
                None
            }
        }
    }

    fn model_bytes() -> Option<Vec<u8>> {
        model_bytes_named("dpdfnet2")
    }

    fn noise(len: usize, seed: u32, scale: f32) -> Vec<f32> {
        let mut x = seed;
        (0..len)
            .map(|_| {
                x = x.wrapping_mul(1664525).wrapping_add(1013904223);
                ((x >> 8) as f32 / 16777216.0 * 2.0 - 1.0) * scale
            })
            .collect()
    }

    fn run(state: &mut TypedSimpleState, info: &ModelInfo, spec: &[f32], model_state: &[f32]) -> (Vec<f32>, Vec<f32>) {
        let spec_in = Tensor::from_shape(&[1, 1, info.bins, 2], spec).unwrap().into_tvalue();
        let outputs = state.run(tvec![spec_in, tensor1(model_state).into_tvalue()]).unwrap();
        let flat = |v: &TValue| v.try_as_plain_ram().unwrap().as_slice::<f32>().unwrap().to_vec();
        (flat(&outputs[0]), flat(&outputs[1]))
    }

    fn max_abs_diff(a: &[f32], b: &[f32]) -> f32 {
        assert_eq!(a.len(), b.len());
        a.iter().zip(b).map(|(x, y)| (x - y).abs()).fold(0.0, f32::max)
    }

    #[test]
    fn consecutive_calls_match_a_fresh_session_per_call() {
        let Some(bytes) = model_bytes() else { return };
        let (proto, info) = read_model(&bytes).unwrap();
        let reseeded = SimplePlan::new(reseed_recurrences_every_call(optimized_model(&proto, &info).unwrap()).unwrap()).unwrap();
        let plain = SimplePlan::new(optimized_model(&proto, &info).unwrap()).unwrap();
        let mut reseeded_session = TypedSimpleState::new(&reseeded).unwrap();
        let mut plain_session = TypedSimpleState::new(&plain).unwrap();

        let mut model_state = info.initial_state.clone();
        let mut plain_worst = 0f32;
        for call in 0..6 {
            let spec = noise(info.bins * 2, 7 + call, 2.0);
            let (reference_spec, reference_state) = run(&mut TypedSimpleState::new(&plain).unwrap(), &info, &spec, &model_state);
            let (spec_out, state_out) = run(&mut reseeded_session, &info, &spec, &model_state);
            let (plain_spec, plain_state) = run(&mut plain_session, &info, &spec, &model_state);

            assert!(max_abs_diff(&spec_out, &reference_spec) < 1e-5, "call {call}: spec_e diverged");
            assert!(max_abs_diff(&state_out, &reference_state) < 1e-5, "call {call}: state_out diverged");
            plain_worst = plain_worst.max(max_abs_diff(&plain_state, &reference_state)).max(max_abs_diff(&plain_spec, &reference_spec));
            model_state = reference_state;
        }
        assert!(plain_worst > 1e-3, "without the reseed the session should drift, worst diff {plain_worst}");
    }

    #[test]
    fn reset_restores_the_initial_state() {
        let Some(bytes) = model_bytes() else { return };
        let mut engine = Engine::new(&bytes).unwrap();
        let hop = engine.hop();
        let input = noise(hop * 30, 3, 0.2);
        let render = |engine: &mut Engine| {
            let mut out = vec![0f32; input.len()];
            for (x, y) in input.chunks(hop).zip(out.chunks_mut(hop)) {
                engine.process(x, y).unwrap();
            }
            out
        };

        let first = render(&mut engine);
        let carried_on = render(&mut engine);
        engine.reset().unwrap();
        let after_reset = render(&mut engine);

        assert_eq!(after_reset, first);
        assert_ne!(carried_on, first);
        assert_eq!(render(&mut Engine::new(&bytes).unwrap()), first);
    }

    #[test]
    fn both_models_are_the_16khz_variants() {
        for name in ["dpdfnet2", "dpdfnet4"] {
            let Some(bytes) = model_bytes_named(name) else { continue };
            let (_, info) = read_model(&bytes).unwrap();
            assert_eq!((info.n, info.hop, info.bins), (320, 160, 161), "{name}");
        }
    }

    #[test]
    fn reseeding_a_model_without_recurrences_fails() {
        assert!(reseed_recurrences_every_call(TypedModel::default()).is_err());
    }

    #[test]
    fn rejects_a_wrong_hop_length() {
        let Some(bytes) = model_bytes() else { return };
        let mut engine = Engine::new(&bytes).unwrap();
        let mut out = vec![0f32; engine.hop()];
        assert!(engine.process(&[0.0; 10], &mut out).is_err());
    }
}
