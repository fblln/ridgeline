import math, numpy as np
import matplotlib; matplotlib.use("Agg")
import matplotlib.pyplot as plt
from PIL import Image
from flex import lat, lon, ele, smooth, simplify

ele_s = smooth(ele)
idx = simplify(1.0, ele_s, "rdp", dim=3)
rlat = [lat[i] for i in idx]; rlon = [lon[i] for i in idx]

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
crop = mosaic.crop((int((xfw-tx0)*256), int((yfn-ty0)*256),
                    int((xfe-tx0)*256), int((yfs-ty0)*256)))

# raw tile, North-up: origin='upper' places row0 (North) at top — standard map orientation
plt.figure(figsize=(9, 9))
plt.imshow(np.asarray(crop), extent=[lo_lo, lo_hi, la_lo, la_hi], origin="upper", aspect="auto")
plt.plot(rlon, rlat, "-", color="#e3000f", lw=1.8)
plt.plot(rlon[0], rlat[0], "o", color="blue", ms=8, label="start")
plt.xlabel("lon"); plt.ylabel("lat"); plt.legend()
plt.title("Ground truth: raw tile (N-up) + GPS route — does the red line follow trails?")
plt.savefig("verify_orient.png", dpi=120, bbox_inches="tight")
print("wrote verify_orient.png")
