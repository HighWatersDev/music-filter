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
}
