use std::path::Path;
use std::ptr::{null, null_mut};

use anyhow::Context;
use gdal::raster::Buffer;
use gdal::spatial_ref::{AxisMappingStrategy, SpatialRef};
use gdal::{Dataset, DriverManager};
use gdal_sys::{CPLErr, GDALReprojectImage, GDALResampleAlg};

/// One raster band read through GDAL: row-major f64 samples.
///
/// GDAL is the same engine rasterio uses on the Python side, so this handles
/// every GeoTIFF variant (tiling, compression, predictors, *sparse tiles*)
/// identically — no hand-rolled tile/affine/nodata logic.
pub struct GdalBand {
    pub width: usize,
    pub height: usize,
    pub data: Vec<f64>,
}

fn wgs84() -> anyhow::Result<SpatialRef> {
    let mut srs = SpatialRef::from_epsg(4326)?;
    srs.set_axis_mapping_strategy(AxisMappingStrategy::TraditionalGisOrder);
    Ok(srs)
}

/// In-memory single-band f64 dataset (MEM driver) with the given geo-transform,
/// EPSG:4326. Used to wrap the WMS-fetched IGN grid as a GDAL source for warping.
pub fn mem_dataset_4326(
    data: &[f64],
    width: usize,
    height: usize,
    geo_transform: [f64; 6],
) -> anyhow::Result<Dataset> {
    let drv = DriverManager::get_driver_by_name("MEM")?;
    let mut ds = drv.create_with_band_type::<f64, _>("", width, height, 1)?;
    ds.set_geo_transform(&geo_transform)?;
    ds.set_spatial_ref(&wgs84()?)?;
    let mut band = ds.rasterband(1)?;
    let mut buffer = Buffer::new((width, height), data.to_vec());
    band.write((0, 0), (width, height), &mut buffer)?;
    Ok(ds)
}

/// GDAL cubic reproject of `src` onto a target grid (EPSG:4326) defined by
/// `dst_geo_transform` + size. Returns row-major f64 (north-up), NaN where the
/// warp had no data. `dfMaxError = 0` forces the exact transformer so this is
/// bit-identical to rasterio.reproject(..., resampling=cubic, tolerance=0).
pub fn warp_cubic_4326(
    src: &Dataset,
    dst_geo_transform: [f64; 6],
    width: usize,
    height: usize,
) -> anyhow::Result<Vec<f64>> {
    let drv = DriverManager::get_driver_by_name("MEM")?;
    let mut dst = drv.create_with_band_type::<f64, _>("", width, height, 1)?;
    dst.set_geo_transform(&dst_geo_transform)?;
    dst.set_spatial_ref(&wgs84()?)?;
    {
        // MEM bands initialize to 0; GDALReprojectImage only writes covered pixels
        // and won't reset the rest. Pre-fill NaN so uncovered/nodata cells read as
        // NaN (matching rasterio's init_dest_nodata=True) — the blend & min-fill
        // downstream depend on it.
        let mut band = dst.rasterband(1)?;
        band.set_no_data_value(Some(f64::NAN))?;
        let mut nan = Buffer::new((width, height), vec![f64::NAN; width * height]);
        band.write((0, 0), (width, height), &mut nan)?;
    }
    let rv = unsafe {
        GDALReprojectImage(
            src.c_dataset(),
            null(),
            dst.c_dataset(),
            null(),
            GDALResampleAlg::GRA_Cubic,
            0.0,
            0.0,
            None,
            null_mut(),
            null_mut(),
        )
    };
    if rv != CPLErr::CE_None {
        anyhow::bail!("GDALReprojectImage failed: {rv:?}");
    }
    let band = dst.rasterband(1)?;
    let buffer = band.read_as::<f64>((0, 0), (width, height), (width, height), None)?;
    let (_, data) = buffer.into_shape_and_vec();
    Ok(data)
}

pub fn read_band_f64(path: &Path) -> anyhow::Result<GdalBand> {
    let ds = Dataset::open(path).with_context(|| format!("opening {}", path.display()))?;
    let (width, height) = ds.raster_size();
    let band = ds.rasterband(1)?;
    let buffer = band.read_as::<f64>((0, 0), (width, height), (width, height), None)?;
    let (_, data) = buffer.into_shape_and_vec();
    Ok(GdalBand {
        width,
        height,
        data,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mem_dataset_round_trips_pixels_and_projection() {
        let data = vec![1.0, 2.0, 3.0, 4.0];
        let ds = mem_dataset_4326(&data, 2, 2, [7.0, 0.1, 0.0, 45.2, 0.0, -0.1]).unwrap();
        let band = ds.rasterband(1).unwrap();
        let buffer = band.read_as::<f64>((0, 0), (2, 2), (2, 2), None).unwrap();
        let (_, values) = buffer.into_shape_and_vec();
        assert_eq!(values, data);
        assert_eq!(
            ds.geo_transform().unwrap(),
            [7.0, 0.1, 0.0, 45.2, 0.0, -0.1]
        );
        assert!(ds.spatial_ref().unwrap().auth_code().unwrap() == 4326);
    }

    #[test]
    fn read_band_f64_reads_geotiff_data() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("band.tif");

        {
            let driver = DriverManager::get_driver_by_name("GTiff").unwrap();
            let mut ds = driver
                .create_with_band_type::<f64, _>(&path, 2, 2, 1)
                .unwrap();

            ds.set_geo_transform(&[7.0, 0.1, 0.0, 45.2, 0.0, -0.1])
                .unwrap();
            ds.set_spatial_ref(&wgs84().unwrap()).unwrap();

            {
                let mut band = ds.rasterband(1).unwrap();
                let mut buffer = Buffer::new((2, 2), vec![10.0, 20.0, 30.0, 40.0]);

                band.write((0, 0), (2, 2), &mut buffer).unwrap();
            }
        }

        let band = read_band_f64(&path).unwrap();
        assert_eq!((band.width, band.height), (2, 2));
        assert_eq!(band.data, vec![10.0, 20.0, 30.0, 40.0]);
    }
}
