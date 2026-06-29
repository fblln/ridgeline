#[derive(Debug, Clone)]
pub struct Grid {
    pub width: usize,
    pub height: usize,
    pub data: Vec<f64>,
}

impl Grid {
    pub fn new(width: usize, height: usize, value: f64) -> Self {
        Self {
            width,
            height,
            data: vec![value; width * height],
        }
    }

    pub fn from_vec(width: usize, height: usize, data: Vec<f64>) -> anyhow::Result<Self> {
        if data.len() != width * height {
            anyhow::bail!(
                "grid data length {} does not match {width}x{height}",
                data.len()
            );
        }
        Ok(Self {
            width,
            height,
            data,
        })
    }

    #[inline]
    pub fn get(&self, row: usize, col: usize) -> f64 {
        self.data[row * self.width + col]
    }

    #[inline]
    pub fn set(&mut self, row: usize, col: usize, value: f64) {
        self.data[row * self.width + col] = value;
    }

    pub fn finite_min_max(&self) -> (f64, f64) {
        let mut min = f64::INFINITY;
        let mut max = f64::NEG_INFINITY;
        for &value in &self.data {
            if value.is_finite() {
                min = min.min(value);
                max = max.max(value);
            }
        }
        if min.is_finite() && max.is_finite() {
            (min, max)
        } else {
            (0.0, 0.0)
        }
    }

    pub fn get_clamped(&self, row: isize, col: isize) -> f64 {
        let row = row.clamp(0, self.height.saturating_sub(1) as isize) as usize;
        let col = col.clamp(0, self.width.saturating_sub(1) as isize) as usize;
        self.get(row, col)
    }

    pub fn bilinear(&self, row: f64, col: f64) -> f64 {
        let row = row.clamp(0.0, self.height.saturating_sub(1) as f64);
        let col = col.clamp(0.0, self.width.saturating_sub(1) as f64);
        let r0 = row.floor() as isize;
        let c0 = col.floor() as isize;
        let r1 = r0 + 1;
        let c1 = c0 + 1;
        let fr = row - r0 as f64;
        let fc = col - c0 as f64;
        let v00 = self.get_clamped(r0, c0);
        let v01 = self.get_clamped(r0, c1);
        let v10 = self.get_clamped(r1, c0);
        let v11 = self.get_clamped(r1, c1);
        let top = v00 * (1.0 - fc) + v01 * fc;
        let bottom = v10 * (1.0 - fc) + v11 * fc;
        top * (1.0 - fr) + bottom * fr
    }

    /// Drop a `pad`-cell border on all four sides. Used by the edge-apron trick:
    /// sample/process on a grid padded with real extra DEM, then crop the halo
    /// so the visible-edge cells were computed with full neighbour stencils.
    pub fn crop(&self, pad: usize) -> Self {
        if pad == 0 {
            return self.clone();
        }
        let w = self.width - 2 * pad;
        let h = self.height - 2 * pad;
        let mut data = Vec::with_capacity(w * h);
        for row in pad..pad + h {
            let start = row * self.width + pad;
            data.extend_from_slice(&self.data[start..start + w]);
        }
        Self {
            width: w,
            height: h,
            data,
        }
    }

    pub fn map(&self, mut f: impl FnMut(f64) -> f64) -> Self {
        let data = self.data.iter().map(|&value| f(value)).collect();
        Self {
            width: self.width,
            height: self.height,
            data,
        }
    }
}

pub fn linspace(start: f64, end: f64, len: usize) -> Vec<f64> {
    if len <= 1 {
        return vec![start; len];
    }
    let step = (end - start) / (len - 1) as f64;
    (0..len).map(|i| start + step * i as f64).collect()
}
