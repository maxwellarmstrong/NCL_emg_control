//! Bounded diagnostic capture. One row per received packet, never per display frame.
use super::cyton::NUM_CHANNELS;
use super::pipeline::EmgPipeline;

/// Independent offline pipeline: never changes live filter or decoder state.
pub fn replay(raw: &[f32], channels: usize, car: bool, mains: u32) -> Result<Vec<f32>, &'static str> {
    if ![6, 8].contains(&channels) || ![50, 60].contains(&mains)
        || raw.is_empty() || raw.len() % NUM_CHANNELS != 0
        || raw.len() > 250 * 120 * NUM_CHANNELS || raw.iter().any(|x| !x.is_finite()) {
        return Err("Invalid replay samples or configuration");
    }
    let mut pipeline = EmgPipeline::new();
    pipeline.set_enabled(std::array::from_fn(|ch| ch < channels));
    pipeline.set_mains(mains as f32);
    pipeline.car = car;
    let mut output = Vec::with_capacity(raw.len() * 2);
    for row in raw.chunks_exact(NUM_CHANNELS) {
        let sample = std::array::from_fn(|ch| row[ch]);
        pipeline.process(&sample);
        output.extend_from_slice(&pipeline.envelopes());
        output.extend(pipeline.contact().map(|good| if good { 1.0 } else { 0.0 }));
    }
    Ok(output)
}

pub const ROW: usize = NUM_CHANNELS * 3;
const MAX_ROWS: usize = 500;

#[derive(Default)]
pub struct Capture {
    pub enabled: bool,
    rows: Vec<f32>,
    pub overflow: bool,
}

impl Capture {
    pub fn set(&mut self, enabled: bool) {
        self.enabled = enabled;
        self.rows.clear();
        self.overflow = false;
    }

    pub fn push(&mut self, raw: &[f32; NUM_CHANNELS], env: &[f32; NUM_CHANNELS], contact: &[bool; NUM_CHANNELS]) {
        if !self.enabled { return; }
        if self.rows.len() >= ROW * MAX_ROWS {
            self.overflow = true;
            return;
        }
        self.rows.extend_from_slice(raw);
        self.rows.extend_from_slice(env);
        self.rows.extend(contact.iter().map(|&v| if v { 1.0 } else { 0.0 }));
    }

    pub fn take(&mut self) -> Vec<f32> { std::mem::take(&mut self.rows) }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn replay_is_deterministic_and_reveals_mixing_without_car() {
        let raw: Vec<f32> = (0..1000).flat_map(|i| {
            let mut row = [0.0; 8];
            row[2] = 100.0 * (i as f32 * 2.0 * std::f32::consts::PI * 37.0 / 250.0).sin();
            row
        }).collect();
        let on = replay(&raw, 6, true, 60).unwrap();
        let off = replay(&raw, 6, false, 60).unwrap();
        assert_eq!(on, replay(&raw, 6, true, 60).unwrap());
        let a = &on[on.len()-16..]; let b = &off[off.len()-16..];
        assert!(a[0] > 1.0 && a[2] > a[0]);
        assert_eq!(b[0], 0.0); assert!(b[2] > a[2]);
        assert_eq!(&a[14..], &[0.0, 0.0]);
        assert!(replay(&[f32::NAN;8],6,true,60).is_err());
        assert!(replay(&[0.0;7],6,true,60).is_err());
    }
    #[test]
    fn replay_matches_production_pipeline_and_rejects_common_noise() {
        let raw: Vec<f32> = (0..1000).flat_map(|i| [30.0*(i as f32*0.93).sin();8]).collect();
        let output = replay(&raw,6,false,60).unwrap();
        let mut live = EmgPipeline::new();
        live.set_enabled(std::array::from_fn(|ch| ch<6)); live.car=false;
        for (sample, row) in raw.chunks_exact(8).zip(output.chunks_exact(16)) {
            live.process(&std::array::from_fn(|ch|sample[ch]));
            assert_eq!(live.envelopes().as_slice(), &row[..8]);
        }
        let on=replay(&raw,6,true,60).unwrap();
        assert!(on.chunks_exact(16).all(|r|r[..6].iter().all(|&v|v<0.0001)));
        assert!(output[output.len()-16]>1.0);
    }
    #[test]
    fn capture_is_opt_in_ordered_and_bounded() {
        let mut c = Capture::default();
        c.push(&[1.0; 8], &[2.0; 8], &[true; 8]);
        assert!(c.take().is_empty());
        c.set(true);
        for _ in 0..501 { c.push(&[1.0; 8], &[2.0; 8], &[true; 8]); }
        assert!(c.overflow);
        let rows = c.take();
        assert_eq!(rows.len(), ROW * 500);
        assert_eq!(&rows[..8], &[1.0; 8]);
        assert_eq!(&rows[8..16], &[2.0; 8]);
        assert_eq!(&rows[16..24], &[1.0; 8]);
        assert!(c.take().is_empty());
        c.set(false);
        assert!(!c.overflow);
    }
}
