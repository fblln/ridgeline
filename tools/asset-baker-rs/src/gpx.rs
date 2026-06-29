use std::fs;
use std::path::Path;

use regex::Regex;
use thiserror::Error;

pub const EARTH_RADIUS_M: f64 = 6_371_000.0;

#[derive(Debug, Clone, PartialEq)]
pub struct Track {
    pub lat: Vec<f64>,
    pub lon: Vec<f64>,
    pub ele: Vec<f64>,
}

#[derive(Debug, Error)]
pub enum GpxError {
    #[error("No track points found in {0}")]
    NoTrackPoints(String),
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    ParseFloat(#[from] std::num::ParseFloatError),
}

pub fn slugify(value: &str) -> String {
    let lower = value.to_lowercase();
    let mut out = String::new();
    let mut previous_dash = false;
    for ch in lower.chars() {
        if ch.is_ascii_lowercase() || ch.is_ascii_digit() {
            out.push(ch);
            previous_dash = false;
        } else if !previous_dash {
            out.push('-');
            previous_dash = true;
        }
    }
    let slug = out.trim_matches('-').to_string();
    if slug.is_empty() {
        "imported-route".to_string()
    } else {
        slug
    }
}

pub fn route_title_from_stem(stem: &str) -> String {
    let mut words = Vec::new();
    let mut current = String::new();
    for ch in stem.chars() {
        if ch == '_' || ch == '-' {
            if !current.is_empty() {
                words.push(std::mem::take(&mut current));
            }
        } else {
            current.push(ch);
        }
    }
    if !current.is_empty() {
        words.push(current);
    }
    let title = words
        .into_iter()
        .map(|word| {
            let mut chars = word.chars();
            match chars.next() {
                Some(first) => {
                    first.to_uppercase().collect::<String>() + &chars.as_str().to_lowercase()
                }
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ");
    if title.trim().is_empty() {
        "Imported route".to_string()
    } else {
        title
    }
}

pub fn parse_gpx(path: &Path) -> Result<Track, GpxError> {
    let text = fs::read_to_string(path)?;
    parse_gpx_text(&text).map_err(|error| match error {
        GpxError::NoTrackPoints(_) => GpxError::NoTrackPoints(path.display().to_string()),
        other => other,
    })
}

pub fn parse_gpx_text(text: &str) -> Result<Track, GpxError> {
    let re = Regex::new(r#"<trkpt lat="([^"]+)" lon="([^"]+)">(?s:.*?)<ele>([^<]+)</ele>"#)
        .expect("valid GPX regex");
    let mut lat = Vec::new();
    let mut lon = Vec::new();
    let mut ele = Vec::new();
    for capture in re.captures_iter(text) {
        lat.push(capture[1].parse()?);
        lon.push(capture[2].parse()?);
        ele.push(capture[3].parse()?);
    }
    if lat.len() < 2 {
        return Err(GpxError::NoTrackPoints("<text>".to_string()));
    }
    Ok(Track { lat, lon, ele })
}

pub fn haversine(a1: f64, o1: f64, a2: f64, o2: f64) -> f64 {
    let p1 = a1.to_radians();
    let p2 = a2.to_radians();
    let h = ((p2 - p1) / 2.0).sin().powi(2)
        + p1.cos() * p2.cos() * ((o2 - o1).to_radians() / 2.0).sin().powi(2);
    2.0 * EARTH_RADIUS_M * h.sqrt().asin()
}

pub fn cumulative_distance(lat: &[f64], lon: &[f64]) -> Vec<f64> {
    let mut d = vec![0.0; lat.len()];
    for i in 1..lat.len() {
        d[i] = d[i - 1] + haversine(lat[i - 1], lon[i - 1], lat[i], lon[i]);
    }
    d
}

pub fn ascent_deadband(z: &[f64], threshold: f64) -> f64 {
    let Some((&first, rest)) = z.split_first() else {
        return 0.0;
    };
    let mut total = 0.0;
    let mut low = first;
    for &v in rest {
        if v > low + threshold {
            total += v - low;
            low = v;
        } else if v < low {
            low = v;
        }
    }
    total
}

pub fn simplify_by_distance(lat: &[f64], lon: &[f64], target_step: f64) -> Vec<usize> {
    let d = cumulative_distance(lat, lon);
    if d.last().copied().unwrap_or(0.0) <= 0.0 {
        return vec![0, lat.len().saturating_sub(1)];
    }

    let total = *d.last().unwrap();
    let mut idx = Vec::new();
    let mut sample = 0.0;
    while sample < total {
        let i = d.partition_point(|&value| value < sample);
        idx.push(i.min(lat.len() - 1));
        sample += target_step;
    }
    idx.push(lat.len() - 1);
    idx.sort_unstable();
    idx.dedup();
    idx
}
