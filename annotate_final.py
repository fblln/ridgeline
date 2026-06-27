from PIL import Image, ImageDraw, ImageFont

SRC = "/private/tmp/claude-501/-Users-fabio-Workspace-strava/dbc53142-5e1e-4343-8980-7dc43383ae7e/scratchpad/wide_test.png"
img = Image.open(SRC).convert("RGB")
w, h = img.size
d = ImageDraw.Draw(img)

def font(sz):
    for p in ("/System/Library/Fonts/Supplemental/Arial Bold.ttf", "/System/Library/Fonts/Helvetica.ttc"):
        try: return ImageFont.truetype(p, sz)
        except Exception: pass
    return ImageFont.load_default()

def label(text, x, y, align):
    f = font(52)
    bb = d.textbbox((0, 0), text, font=f); tw, th = bb[2]-bb[0], bb[3]-bb[1]
    if align == "right": x -= tw
    d.rectangle((x-22, y-18, x+tw+22, y+th+22), fill=(15, 23, 42))
    d.text((x, y), text, font=f, fill="white")

label("ICE 2009-2011 LiDAR DTM · 5 m", 60, h-110, "left")   # detailed side (lower-left)
label("NASA SRTM · 30 m", w-60, 50, "right")                # smooth side (upper-right)

img.save("Morning_Hike-3d-compare-final.png")
print(f"wrote Morning_Hike-3d-compare-final.png ({w}x{h})")
