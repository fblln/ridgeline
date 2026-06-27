from PIL import Image, ImageDraw, ImageFont

left = Image.open("Morning_Hike-3d-pv-srtm-hs.png").convert("RGB")   # SRTM left
right = Image.open("Morning_Hike-3d-pv-hs.png").convert("RGB")       # LIDAR right
w, h = left.size
mid = w // 2

comp = Image.new("RGB", (w, h))
comp.paste(left.crop((0, 0, mid, h)), (0, 0))
comp.paste(right.crop((mid, 0, w, h)), (mid, 0))
d = ImageDraw.Draw(comp)
d.line((mid, 0, mid, h), fill="white", width=5)

def font(sz):
    for p in ("/System/Library/Fonts/Supplemental/Arial Bold.ttf",
              "/System/Library/Fonts/Helvetica.ttc"):
        try: return ImageFont.truetype(p, sz)
        except Exception: pass
    return ImageFont.load_default()

def label(text, anchor_x, align):
    f = font(52)
    bb = d.textbbox((0, 0), text, font=f); tw, th = bb[2]-bb[0], bb[3]-bb[1]
    x = anchor_x - tw if align == "right" else anchor_x
    y = h - th - 60
    d.rectangle((x-22, y-18, x+tw+22, y+th+22), fill=(15, 23, 42))
    d.text((x, y), text, font=f, fill="white")

label("NASA SRTM · 30 m", 60, "left")
label("ICE 2009-2011 LiDAR DTM · 5 m", w-60, "right")

comp.save("Morning_Hike-3d-compare-hs.png")
print(f"wrote Morning_Hike-3d-compare-hs.png ({w}x{h})")
