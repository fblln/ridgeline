//! Disk cache for serialized elevation grids.
//!
//! The format is a small, versioned, self-describing binary — no external
//! dependency and trivial to inspect with `xxd`:
//!
//! ```text
//!   offset  bytes  field
//!   0       8      magic   "RDGEGRD\0"
//!   8       4      version u32 LE   (bump to invalidate older caches)
//!   12      4      width   u32 LE
//!   16      4      height  u32 LE
//!   20      ...    data    width*height f32 LE, row-major
//! ```
//!
//! `f32` matches the WMS source precision and halves the file vs `f64`. Anything
//! that isn't an exact match — missing file, wrong magic, older version, or a
//! body length that disagrees with the header — is reported as a cache miss
//! (`Ok(None)`) so the caller simply re-fetches. A stale or foreign file is
//! never misread.

use std::fs;
use std::io;
use std::path::Path;

use crate::grid::Grid;

const MAGIC: &[u8; 8] = b"RDGEGRD\0";
const VERSION: u32 = 1;
const HEADER_LEN: usize = 20;

/// File extension for cached grids (no leading dot).
pub const EXT: &str = "rgrid";

/// Serialize a grid to `path` (creating parent dirs), atomically via a temp file.
pub fn write_grid(path: &Path, grid: &Grid) -> anyhow::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let mut out = Vec::with_capacity(HEADER_LEN + grid.data.len() * 4);
    out.extend_from_slice(MAGIC);
    out.extend_from_slice(&VERSION.to_le_bytes());
    out.extend_from_slice(&(grid.width as u32).to_le_bytes());
    out.extend_from_slice(&(grid.height as u32).to_le_bytes());
    for &value in &grid.data {
        out.extend_from_slice(&(value as f32).to_le_bytes());
    }
    let tmp = path.with_extension(format!("{EXT}.tmp"));
    fs::write(&tmp, &out)?;
    fs::rename(&tmp, path)?;
    Ok(())
}

/// Read a cached grid. `Ok(None)` is a cache miss (absent / wrong magic /
/// version mismatch / size mismatch); the caller re-fetches.
pub fn read_grid(path: &Path) -> anyhow::Result<Option<Grid>> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    if bytes.len() < HEADER_LEN || &bytes[0..8] != MAGIC {
        return Ok(None);
    }
    let version = u32::from_le_bytes(bytes[8..12].try_into().expect("4 bytes"));
    if version != VERSION {
        return Ok(None);
    }
    let width = u32::from_le_bytes(bytes[12..16].try_into().expect("4 bytes")) as usize;
    let height = u32::from_le_bytes(bytes[16..20].try_into().expect("4 bytes")) as usize;
    let body = &bytes[HEADER_LEN..];
    if body.len() != width * height * 4 {
        return Ok(None);
    }
    let data = body
        .chunks_exact(4)
        .map(|chunk| f32::from_le_bytes(chunk.try_into().expect("4 bytes")) as f64)
        .collect::<Vec<_>>();
    Ok(Some(Grid::from_vec(width, height, data)?))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_path(name: &str) -> std::path::PathBuf {
        let mut p = std::env::temp_dir();
        p.push(format!(
            "ridgeline-cache-test-{}-{name}.{EXT}",
            std::process::id()
        ));
        p
    }

    #[test]
    fn round_trip_preserves_shape_and_values() {
        let grid = Grid::from_vec(3, 2, vec![1.0, 2.0, 3.0, 4.0, 5.0, 6.0]).unwrap();
        let path = temp_path("roundtrip");
        write_grid(&path, &grid).unwrap();
        let back = read_grid(&path).unwrap().expect("cache hit");
        assert_eq!((back.width, back.height), (3, 2));
        assert_eq!(back.data, grid.data);
        fs::remove_file(&path).ok();
    }

    #[test]
    fn round_trip_keeps_nan() {
        let grid = Grid::new(2, 2, f64::NAN);
        let path = temp_path("nan");
        write_grid(&path, &grid).unwrap();
        let back = read_grid(&path).unwrap().expect("cache hit");
        assert!(back.data.iter().all(|v| v.is_nan()));
        fs::remove_file(&path).ok();
    }

    #[test]
    fn missing_file_is_a_miss() {
        let path = temp_path("does-not-exist");
        assert!(read_grid(&path).unwrap().is_none());
    }

    #[test]
    fn corrupt_or_foreign_file_is_a_miss_not_an_error() {
        let path = temp_path("corrupt");
        // Old npy magic / arbitrary bytes -> treated as a miss, never misread.
        fs::write(&path, b"\x93NUMPY\x01\x00....garbage....").unwrap();
        assert!(read_grid(&path).unwrap().is_none());
        // Right magic, wrong version -> miss.
        let mut wrong_version = MAGIC.to_vec();
        wrong_version.extend_from_slice(&999u32.to_le_bytes());
        wrong_version.extend_from_slice(&[0u8; 8]);
        fs::write(&path, &wrong_version).unwrap();
        assert!(read_grid(&path).unwrap().is_none());
        // Right header, truncated body -> miss.
        let mut short_body = MAGIC.to_vec();
        short_body.extend_from_slice(&VERSION.to_le_bytes());
        short_body.extend_from_slice(&2u32.to_le_bytes());
        short_body.extend_from_slice(&2u32.to_le_bytes());
        short_body.extend_from_slice(&[0u8; 4]); // claims 16 bytes, has 4
        fs::write(&path, &short_body).unwrap();
        assert!(read_grid(&path).unwrap().is_none());
        fs::remove_file(&path).ok();
    }
}
