from PIL import Image, ImageDraw, ImageFont

img = Image.open("Morning_Hike-3d-pv-blend-hs.png").convert("RGB")
w, h = img.size
d = ImageDraw.Draw(img)

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

img.save("Morning_Hike-3d-blend-compare.png")
print(f"wrote Morning_Hike-3d-blend-compare.png ({w}x{h})")
