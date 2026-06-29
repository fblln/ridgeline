use crate::grid::Grid;

pub fn savgol_smooth(values: &[f64], window: usize) -> Vec<f64> {
    if values.len() < window || window < 3 || window.is_multiple_of(2) {
        return values.to_vec();
    }
    let half = window as isize / 2;
    let x = (-half..=half).map(|v| v as f64).collect::<Vec<_>>();
    let sum_x2 = x.iter().map(|v| v * v).sum::<f64>();
    let sum_x4 = x.iter().map(|v| v * v * v * v).sum::<f64>();
    let n = window as f64;
    let det = n * sum_x4 - sum_x2 * sum_x2;
    let a = sum_x4 / det;
    let c = -sum_x2 / det;
    let coeff = x.iter().map(|v| a + c * v * v).collect::<Vec<_>>();
    let mut out = (0..values.len())
        .map(|i| {
            coeff
                .iter()
                .enumerate()
                .map(|(j, &weight)| {
                    let offset = j as isize - half;
                    let idx = (i as isize + offset).clamp(0, values.len() as isize - 1) as usize;
                    values[idx] * weight
                })
                .sum()
        })
        .collect::<Vec<_>>();

    // scipy.signal.savgol_filter defaults to mode="interp": edge samples are
    // evaluated from a polynomial fit to the first/last full window.
    let left = fit_quadratic(&values[..window]);
    let right = fit_quadratic(&values[values.len() - window..]);
    for i in 0..half as usize {
        out[i] = eval_quadratic(left, i as f64);
        out[values.len() - half as usize + i] =
            eval_quadratic(right, (window - half as usize + i) as f64);
    }
    out
}

pub fn gaussian_filter(input: &Grid, sigma: f64) -> Grid {
    if sigma <= 0.0 {
        return input.clone();
    }
    let radius = (sigma * 4.0 + 0.5).floor() as isize;
    if radius <= 0 {
        return input.clone();
    }
    let mut kernel = (-radius..=radius)
        .map(|i| (-0.5 * (i as f64 / sigma).powi(2)).exp())
        .collect::<Vec<_>>();
    let sum = kernel.iter().sum::<f64>();
    for value in &mut kernel {
        *value /= sum;
    }

    let mut tmp = Grid::new(input.width, input.height, 0.0);
    for row in 0..input.height {
        for col in 0..input.width {
            let mut value = 0.0;
            for (ki, &weight) in kernel.iter().enumerate() {
                let offset = ki as isize - radius;
                value +=
                    input.get(row, reflect(col as isize + offset, input.width) as usize) * weight;
            }
            tmp.set(row, col, value);
        }
    }

    let mut out = Grid::new(input.width, input.height, 0.0);
    for row in 0..input.height {
        for col in 0..input.width {
            let mut value = 0.0;
            for (ki, &weight) in kernel.iter().enumerate() {
                let offset = ki as isize - radius;
                value +=
                    tmp.get(reflect(row as isize + offset, input.height) as usize, col) * weight;
            }
            out.set(row, col, value);
        }
    }
    out
}

pub fn gradient(input: &Grid, dy: f64, dx: f64) -> (Grid, Grid) {
    let mut gy = Grid::new(input.width, input.height, 0.0);
    let mut gx = Grid::new(input.width, input.height, 0.0);
    for row in 0..input.height {
        for col in 0..input.width {
            let ddy = if input.height <= 1 {
                0.0
            } else if row == 0 {
                (input.get(row + 1, col) - input.get(row, col)) / dy
            } else if row == input.height - 1 {
                (input.get(row, col) - input.get(row - 1, col)) / dy
            } else {
                (input.get(row + 1, col) - input.get(row - 1, col)) / (2.0 * dy)
            };
            let ddx = if input.width <= 1 {
                0.0
            } else if col == 0 {
                (input.get(row, col + 1) - input.get(row, col)) / dx
            } else if col == input.width - 1 {
                (input.get(row, col) - input.get(row, col - 1)) / dx
            } else {
                (input.get(row, col + 1) - input.get(row, col - 1)) / (2.0 * dx)
            };
            gy.set(row, col, ddy);
            gx.set(row, col, ddx);
        }
    }
    (gy, gx)
}

pub fn percentile(values: &[f64], pct: f64) -> f64 {
    let mut finite = values
        .iter()
        .copied()
        .filter(|v| v.is_finite())
        .collect::<Vec<_>>();
    if finite.is_empty() {
        return 0.0;
    }
    finite.sort_by(f64::total_cmp);
    let rank = (pct / 100.0) * (finite.len() - 1) as f64;
    let lo = rank.floor() as usize;
    let hi = rank.ceil() as usize;
    if lo == hi {
        finite[lo]
    } else {
        finite[lo] * (hi as f64 - rank) + finite[hi] * (rank - lo as f64)
    }
}

pub fn normalize_to_u8(values: &[f64], lo: Option<f64>, hi: Option<f64>) -> Vec<u8> {
    let lo = lo.unwrap_or_else(|| percentile(values, 2.0));
    let hi = hi.unwrap_or_else(|| percentile(values, 98.0));
    values
        .iter()
        .map(|&value| {
            let scaled = ((value.clamp(lo, hi) - lo) / (hi - lo).max(1e-9) * 255.0).round();
            scaled.clamp(0.0, 255.0) as u8
        })
        .collect()
}

fn reflect(mut idx: isize, len: usize) -> isize {
    if len <= 1 {
        return 0;
    }
    let len = len as isize;
    while idx < 0 || idx >= len {
        if idx < 0 {
            idx = -idx - 1;
        } else {
            idx = 2 * len - idx - 1;
        }
    }
    idx
}

fn fit_quadratic(values: &[f64]) -> [f64; 3] {
    let n = values.len() as f64;
    let mut sx = 0.0;
    let mut sx2 = 0.0;
    let mut sx3 = 0.0;
    let mut sx4 = 0.0;
    let mut sy = 0.0;
    let mut sxy = 0.0;
    let mut sx2y = 0.0;
    for (i, &y) in values.iter().enumerate() {
        let x = i as f64;
        let x2 = x * x;
        sx += x;
        sx2 += x2;
        sx3 += x2 * x;
        sx4 += x2 * x2;
        sy += y;
        sxy += x * y;
        sx2y += x2 * y;
    }
    solve_3x3(
        [[n, sx, sx2], [sx, sx2, sx3], [sx2, sx3, sx4]],
        [sy, sxy, sx2y],
    )
}

fn eval_quadratic(coeff: [f64; 3], x: f64) -> f64 {
    coeff[0] + coeff[1] * x + coeff[2] * x * x
}

fn solve_3x3(mut a: [[f64; 3]; 3], mut b: [f64; 3]) -> [f64; 3] {
    for pivot in 0..3 {
        let mut max_row = pivot;
        for row in pivot + 1..3 {
            if a[row][pivot].abs() > a[max_row][pivot].abs() {
                max_row = row;
            }
        }
        if max_row != pivot {
            a.swap(pivot, max_row);
            b.swap(pivot, max_row);
        }
        let scale = a[pivot][pivot];
        let mut col = pivot;
        while col < 3 {
            a[pivot][col] /= scale;
            col += 1;
        }
        b[pivot] /= scale;
        for row in 0..3 {
            if row == pivot {
                continue;
            }
            let factor = a[row][pivot];
            let mut col = pivot;
            while col < 3 {
                a[row][col] -= factor * a[pivot][col];
                col += 1;
            }
            b[row] -= factor * b[pivot];
        }
    }
    b
}

#[cfg(test)]
mod tests {
    use super::*;

    fn approx(a: f64, b: f64) {
        assert!((a - b).abs() < 1e-9, "{a} != {b}");
    }

    #[test]
    fn savgol_preserves_constant_and_passes_through_invalid_windows() {
        assert_eq!(savgol_smooth(&[5.0; 10], 5), vec![5.0; 10]);
        // window must be odd, >= 3, and <= len; otherwise input is returned as-is.
        assert_eq!(
            savgol_smooth(&[1.0, 2.0, 3.0, 4.0], 4),
            vec![1.0, 2.0, 3.0, 4.0]
        );
        assert_eq!(savgol_smooth(&[1.0, 2.0], 5), vec![1.0, 2.0]);
        assert_eq!(savgol_smooth(&[1.0, 2.0, 3.0], 1), vec![1.0, 2.0, 3.0]);
    }

    #[test]
    fn savgol_fits_a_line_exactly() {
        // A quadratic-fit smoother reproduces a straight line within fp error.
        let line: Vec<f64> = (0..11).map(|i| 2.0 * i as f64 + 1.0).collect();
        for (got, want) in savgol_smooth(&line, 5).iter().zip(&line) {
            approx(*got, *want);
        }
    }

    #[test]
    fn gaussian_identity_paths() {
        let g = Grid::from_vec(2, 2, vec![1.0, 2.0, 3.0, 4.0]).unwrap();
        assert_eq!(gaussian_filter(&g, 0.0).data, g.data); // sigma <= 0
        assert_eq!(gaussian_filter(&g, 0.05).data, g.data); // radius rounds to 0
    }

    #[test]
    fn gaussian_keeps_constant_and_shrinks_a_spike() {
        let flat = Grid::new(9, 9, 7.0);
        for v in gaussian_filter(&flat, 1.5).data {
            approx(v, 7.0);
        }
        let mut spike = Grid::new(9, 9, 0.0);
        spike.set(4, 4, 100.0);
        let out = gaussian_filter(&spike, 1.0);
        assert!(out.get(4, 4) < 100.0 && out.get(4, 4) > 0.0); // peak spread
        assert!(out.get(3, 4) > 0.0 && out.get(4, 3) > 0.0); // energy leaked to neighbours
    }

    #[test]
    fn gradient_of_a_ramp_is_constant_slope() {
        // value = col -> d/dx = 1/dx everywhere, d/dy = 0.
        let data: Vec<f64> = (0..4).flat_map(|_r| (0..4).map(|c| c as f64)).collect();
        let g = Grid::from_vec(4, 4, data).unwrap();
        let (gy, gx) = gradient(&g, 1.0, 1.0);
        for v in gx.data {
            approx(v, 1.0);
        }
        for v in gy.data {
            approx(v, 0.0);
        }
    }

    #[test]
    fn gradient_degenerate_dimensions_are_zero() {
        let row = Grid::from_vec(3, 1, vec![1.0, 5.0, 9.0]).unwrap();
        let (gy, _gx) = gradient(&row, 1.0, 1.0);
        for v in gy.data {
            approx(v, 0.0); // height == 1 -> no y gradient
        }
    }

    #[test]
    fn percentile_interpolates_and_handles_edges() {
        let v = [1.0, 2.0, 3.0, 4.0, 5.0];
        approx(percentile(&v, 50.0), 3.0);
        approx(percentile(&v, 0.0), 1.0);
        approx(percentile(&v, 100.0), 5.0);
        approx(percentile(&v, 25.0), 2.0);
        approx(percentile(&[], 50.0), 0.0); // empty -> 0
        approx(percentile(&[f64::NAN, 4.0, f64::NAN], 50.0), 4.0); // NaN filtered
    }

    #[test]
    fn normalize_default_bounds_use_percentiles() {
        // With None bounds it stretches the 2nd..98th percentile across 0..=255.
        let out = normalize_to_u8(&[0.0, 1.0, 2.0, 3.0, 100.0], None, None);
        assert_eq!(out.len(), 5);
        assert_eq!(*out.iter().min().unwrap(), 0);
        assert_eq!(*out.iter().max().unwrap(), 255);
    }
}
