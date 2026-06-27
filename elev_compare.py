import math, numpy as np
import matplotlib; matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.collections import LineCollection
from matplotlib.gridspec import GridSpec
from scipy.signal import savgol_filter
from scipy.ndimage import uniform_filter1d, median_filter
from PIL import Image
from flex import lat, lon, ele, ascent

TARGET = 1871.0
ele = np.asarray(ele, float)
lat = np.asarray(lat); lon = np.asarray(lon)

# cumulative distance (km) for the x-axis
def hav(la1, lo1, la2, lo2):
    R=6371000; p1,p2=math.radians(la1),math.radians(la2)
    h=math.sin((p2-p1)/2)**2+math.cos(p1)*math.cos(p2)*math.sin(math.radians(lo2-lo1)/2)**2
    return 2*R*math.asin(math.sqrt(h))
dist=np.concatenate([[0],np.cumsum([hav(lat[i],lon[i],lat[i+1],lon[i+1]) for i in range(len(lat)-1)])])/1000

# smoothers (each takes a window param)
def ma(z,w):  return uniform_filter1d(z, max(1,int(w)), mode="nearest")
def sg(z,w):  w=max(5,int(w)//2*2+1); return savgol_filter(z, w, 2)
def med(z,w): return median_filter(z, max(1,int(w)), mode="nearest")

# tune each window so total ascent == TARGET (ascent decreases as window grows)
def tune(fn, lo, hi):
    for _ in range(45):
        m=(lo+hi)/2
        if ascent(fn(ele,m))>TARGET: lo=m
        else: hi=m
    return hi, fn(ele,hi)

w_ma, z_ma = tune(ma, 1, 600)
w_sg, z_sg = tune(sg, 5, 2000)
w_med,z_med= tune(med,1, 800)
methods=[("moving avg", z_ma, "#2563eb", w_ma),
         ("Sav-Golay", z_sg, "#dc2626", w_sg),
         ("median",    z_med,"#059669", w_med)]
for n,z,_,w in methods: print(f"{n:10} window {w:6.0f}s -> ascent {ascent(z):.0f} m")

# disagreement: spread (max-min) across the three tuned series, per point
stack=np.vstack([z_ma,z_sg,z_med])
spread=stack.max(0)-stack.min(0)
hot=int(np.argmax(spread))
print(f"max disagreement {spread[hot]:.1f} m at km {dist[hot]:.2f} ({lat[hot]:.5f},{lon[hot]:.5f})")

# OTM basemap crop (cached z16) for the map panel
mlat,mlon=0.006,0.008
la_lo,la_hi=lat.min()-mlat,lat.max()+mlat; lo_lo,lo_hi=lon.min()-mlon,lon.max()+mlon
CACHE="/private/tmp/claude-501/-Users-fabio-Workspace-strava/dbc53142-5e1e-4343-8980-7dc43383ae7e/scratchpad/otm"
Z=16
def d2n(la,lo): n=2**Z; return (lo+180)/360*n,(1-math.asinh(math.tan(math.radians(la)))/math.pi)/2*n
xfw,yfn=d2n(la_hi,lo_lo); xfe,yfs=d2n(la_lo,lo_hi)
tx0,tx1,ty0,ty1=int(xfw),int(xfe),int(yfn),int(yfs)
mos=Image.new("RGB",((tx1-tx0+1)*256,(ty1-ty0+1)*256))
for tx in range(tx0,tx1+1):
    for ty in range(ty0,ty1+1):
        mos.paste(Image.open(f"{CACHE}/{Z}_{tx}_{ty}.png").convert("RGB"),((tx-tx0)*256,(ty-ty0)*256))
crop=mos.crop((int((xfw-tx0)*256),int((yfn-ty0)*256),int((xfe-tx0)*256),int((yfs-ty0)*256)))

# ---- figure ----
fig=plt.figure(figsize=(15,10))
gs=GridSpec(2,2,height_ratios=[1,1.1],width_ratios=[1.15,1],hspace=0.25,wspace=0.18)

ax1=fig.add_subplot(gs[0,:])
ax1.plot(dist, ele, color="#cbd5e1", lw=0.6, label="raw (3004 m)")
for n,z,c,w in methods:
    ax1.plot(dist, z, color=c, lw=1.2, label=f"{n} ({w:.0f}s)")
ax1.axvline(dist[hot], color="#7c3aed", ls="--", lw=1)
ax1.set_ylabel("elevation (m)"); ax1.set_xlabel("distance (km)")
ax1.set_title(f"Three smoothers all tuned to Strava's 1871 m ascent — they agree on the total, not the shape")
ax1.legend(loc="lower right", fontsize=8); ax1.margins(x=0.01)
# zoom inset on the max-divergence spot — this is where the choice actually matters
axin=ax1.inset_axes([0.07,0.45,0.30,0.5])
m=(dist>dist[hot]-0.35)&(dist<dist[hot]+0.35)
axin.plot(dist[m], ele[m], color="#94a3b8", lw=1.0, label="raw")
for n,z,c,w in methods: axin.plot(dist[m], z[m], color=c, lw=1.8)
axin.scatter(dist[hot], ele[hot], c="#94a3b8", s=12, zorder=5)
axin.set_title(f"zoom @ km {dist[hot]:.1f}: {spread[hot]:.0f} m apart", fontsize=8)
axin.tick_params(labelsize=7)
ax1.indicate_inset_zoom(axin, edgecolor="#7c3aed")

ax2=fig.add_subplot(gs[1,0])
ax2.fill_between(dist, spread, color="#7c3aed", alpha=0.35)
ax2.axvline(dist[hot], color="#7c3aed", ls="--", lw=1)
ax2.annotate(f"max {spread[hot]:.0f} m\nkm {dist[hot]:.1f}", (dist[hot],spread[hot]),
             textcoords="offset points", xytext=(8,-4), fontsize=9, color="#7c3aed")
ax2.set_ylabel("disagreement: max−min (m)"); ax2.set_xlabel("distance (km)")
ax2.set_title("Where the cleaning choice changes the elevation most"); ax2.margins(x=0.01)

ax3=fig.add_subplot(gs[1,1])
ax3.imshow(np.asarray(crop), extent=[lo_lo,lo_hi,la_lo,la_hi], origin="upper", aspect="auto")
pts=np.c_[lon,lat].reshape(-1,1,2)
seg=np.concatenate([pts[:-1],pts[1:]],axis=1)
lc=LineCollection(seg, cmap="plasma", norm=plt.Normalize(0, spread.max()), lw=2.4)
lc.set_array(spread[:-1]); ax3.add_collection(lc)
ax3.plot(lon[hot],lat[hot],"o",mfc="none",mec="#7c3aed",mew=2,ms=14)
ax3.set_title("Route colored by smoother disagreement"); ax3.set_xticks([]); ax3.set_yticks([])
fig.colorbar(lc, ax=ax3, shrink=0.7, label="disagreement (m)")

fig.savefig("elev_compare.png", dpi=140, bbox_inches="tight")
print("wrote elev_compare.png")
