import math, numpy as np
import matplotlib; matplotlib.use("Agg")
import matplotlib.pyplot as plt
from PIL import Image
import pyvista as pv
from flex import lat, lon

mlat, mlon = 0.006, 0.008
la_lo, la_hi = min(lat)-mlat, max(lat)+mlat
lo_lo, lo_hi = min(lon)-mlon, max(lon)+mlon
CACHE = "/private/tmp/claude-501/-Users-fabio-Workspace-strava/dbc53142-5e1e-4343-8980-7dc43383ae7e/scratchpad/otm"
Z = 16
def deg2num(la, lo):
    n = 2**Z; return (lo+180)/360*n, (1-math.asinh(math.tan(math.radians(la)))/math.pi)/2*n
xfw, yfn = deg2num(la_hi, lo_lo); xfe, yfs = deg2num(la_lo, lo_hi)
tx0, tx1, ty0, ty1 = int(xfw), int(xfe), int(yfn), int(yfs)
mosaic = Image.new("RGB", ((tx1-tx0+1)*256, (ty1-ty0+1)*256))
for tx in range(tx0, tx1+1):
    for ty in range(ty0, ty1+1):
        mosaic.paste(Image.open(f"{CACHE}/{Z}_{tx}_{ty}.png").convert("RGB"),
                     ((tx-tx0)*256, (ty-ty0)*256))
crop = np.asarray(mosaic.crop((int((xfw-tx0)*256), int((yfn-ty0)*256),
                               int((xfe-tx0)*256), int((yfs-ty0)*256))))

GX, GY = np.meshgrid(np.linspace(0, 1000, 40), np.linspace(0, 1000, 40))
orients = {"raw": crop, "flipud": np.flipud(crop), "fliplr": np.fliplr(crop),
           "rot180": np.rot90(crop, 2)}
imgs = {}
for name, arr in orients.items():
    grid = pv.StructuredGrid(GX, GY, GX*0)
    grid.texture_map_to_plane(origin=(0, 0, 0), point_u=(1000, 0, 0), point_v=(0, 1000, 0), inplace=True)
    pl = pv.Plotter(off_screen=True, window_size=(400, 400))
    pl.add_mesh(grid, texture=pv.Texture(np.ascontiguousarray(arr)))
    pl.camera.focal_point = (500, 500, 0)
    pl.camera.position = (500, 500, 2000)   # straight down
    pl.camera.up = (0, 1, 0)                 # +Y (North) up, +X (East) right
    pl.camera.zoom(1.4)
    imgs[name] = pl.screenshot(return_img=True); pl.close()

def autocrop_resize(img, n=256):
    a = np.asarray(img)[..., :3]
    nonwhite = (a.sum(2) < 720)
    ys, xs = np.where(nonwhite)
    a = a[ys.min():ys.max()+1, xs.min():xs.max()+1]
    return np.asarray(Image.fromarray(a).resize((n, n))).astype(float)

gt = autocrop_resize(crop)
print("MSE vs ground truth (lower = correct orientation):")
for name in orients:
    mse = ((autocrop_resize(imgs[name]) - gt)**2).mean()
    print(f"  {name:8} {mse:9.1f}")
