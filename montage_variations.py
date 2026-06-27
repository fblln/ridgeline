from PIL import Image, ImageDraw, ImageFont
import os

VARS = "/private/tmp/claude-501/-Users-fabio-Workspace-strava/dbc53142-5e1e-4343-8980-7dc43383ae7e/scratchpad/variations"
AZS = [230, 270, 310]      # rows: camera azimuth
SAS = [45, 90, 135]        # cols: seam angle (45/135 diagonal, 90 vertical)
TW, TH = 600, 450          # thumb size
pad, lab = 12, 34

def font(sz):
    for p in ("/System/Library/Fonts/Supplemental/Arial Bold.ttf", "/System/Library/Fonts/Helvetica.ttc"):
        try: return ImageFont.truetype(p, sz)
        except Exception: pass
    return ImageFont.load_default()
f = font(26)

W = len(SAS)*(TW+pad)+pad
H = len(AZS)*(TH+lab+pad)+pad
sheet = Image.new("RGB", (W, H), (24, 28, 34))
d = ImageDraw.Draw(sheet)
for r, az in enumerate(AZS):
    for c, sa in enumerate(SAS):
        p = f"{VARS}/var_az{az}_sa{sa}.png"
        x = pad + c*(TW+pad); y = pad + r*(TH+lab+pad)
        if os.path.exists(p):
            im = Image.open(p).convert("RGB").resize((TW, TH))
            sheet.paste(im, (x, y+lab))
        d.text((x+6, y+4), f"AZ {az}  ·  seam {sa}deg{'  (vertical)' if sa==90 else '  (diagonal)'}",
               font=f, fill="white")
sheet.save("variations_contact.png")
print(f"wrote variations_contact.png ({W}x{H})")
