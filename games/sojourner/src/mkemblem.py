"""The landing-page emblem and the link-preview card.

The composition is borrowed from W. E. B. Du Bois's hand-drawn 'Distribution of
the Negro Race', made for the American Negro Exhibit at the 1900 Paris
Exposition: two hemispheres side by side with Africa picked out. It is not a copy
-- the continents here are projected from the game's own map raster, and the
palette is the game's -- but the idea of the picture is his. His plate also ruled
lines across the gap for the crossing to the Americas; at the size this is used
they read as clutter, so the two globes carry it alone.
"""
import math, json, os
from PIL import Image, ImageDraw, ImageFilter

IDM = Image.open('/tmp/build/idmap.png').convert('RGB')
IW, IH = IDM.size
idpx = IDM.load()
gd = json.load(open('/tmp/build/gamedata.json'))
admins, gA = gd['admins'], gd['gA']

AFRICA = set(x.strip() for x in """Algeria|Angola|Benin|Botswana|Burkina Faso|Burundi|Cameroon|
Cabo Verde|Central African Republic|Chad|Comoros|Democratic Republic of the Congo|
Republic of the Congo|Djibouti|Egypt|Equatorial Guinea|Eritrea|Ethiopia|Gabon|Gambia|Ghana|
Guinea|Guinea Bissau|Ivory Coast|Kenya|Lesotho|Liberia|Libya|Madagascar|Malawi|Mali|Mauritania|
Mauritius|Morocco|Mozambique|Namibia|Niger|Nigeria|Rwanda|Sao Tome and Principe|Senegal|
Seychelles|Sierra Leone|Somalia|Somaliland|South Africa|S. Sudan|Sudan|Swaziland|
United Republic of Tanzania|Togo|Tunisia|Uganda|Western Sahara|Zambia|Zimbabwe""".replace('\n','').split('|'))

# id -> 0 sea, 1 land, 2 Africa
kind = bytearray(len(gA))
for i in range(1, len(gA)):
    a = admins[gA[i]] if gA[i] < len(admins) else ''
    if a == 'Water': kind[i] = 0
    elif a in AFRICA: kind[i] = 2
    else: kind[i] = 1

def sample(lon, lat):
    x = int((lon + 180.0) / 360.0 * IW) % IW
    y = int((90.0 - lat) / 180.0 * IH)
    y = max(0, min(IH - 1, y))
    r, g, _ = idpx[x, y]
    i = r + g * 256
    return kind[i] if i < len(kind) else 0

INK       = (12, 11, 10, 255)
DISC      = (24, 21, 18, 255)
RING      = (76, 66, 56, 255)
LAND      = (169, 157, 143, 255)
AFR       = (224, 164, 74, 255)
ARC       = (89, 185, 164, 255)

def hemisphere(size, lon0, lat0, ss=3):
    """orthographic, drawn supersampled then reduced"""
    N = size * ss
    im = Image.new('RGBA', (N, N), (0,0,0,0))
    px = im.load()
    R = N / 2.0 - ss
    cx = cy = N / 2.0
    l0, p0 = math.radians(lon0), math.radians(lat0)
    sp0, cp0 = math.sin(p0), math.cos(p0)
    for yy in range(N):
        yu = -(yy + 0.5 - cy) / R          # image y grows downward
        for xx in range(N):
            xu = (xx + 0.5 - cx) / R
            rho2 = xu*xu + yu*yu
            if rho2 > 1.0: continue
            rho = math.sqrt(rho2)
            if rho < 1e-9:
                lat, lon = p0, l0
            else:
                c = math.asin(min(1.0, rho))
                sc, cc = math.sin(c), math.cos(c)
                lat = math.asin(max(-1.0, min(1.0, cc*sp0 + yu*sc*cp0/rho)))
                lon = l0 + math.atan2(xu*sc, rho*cp0*cc - yu*sp0*sc)
            k = sample(math.degrees(lon), math.degrees(lat))
            px[xx, yy] = DISC if k == 0 else (LAND if k == 1 else AFR)
    im = im.resize((size, size), Image.LANCZOS)
    # the rim
    d = ImageDraw.Draw(im)
    d.ellipse([1, 1, size-2, size-2], outline=RING, width=max(1, size//200 + 1))
    return im

def project(size, lon0, lat0, lon, lat):
    """where a lon/lat lands inside a hemisphere of this size (or None if behind)"""
    l0, p0 = math.radians(lon0), math.radians(lat0)
    l, p = math.radians(lon), math.radians(lat)
    cosc = math.sin(p0)*math.sin(p) + math.cos(p0)*math.cos(p)*math.cos(l - l0)
    if cosc < 0.02: return None
    R = size/2.0 - 1
    x = R * math.cos(p) * math.sin(l - l0)
    y = -R * (math.cos(p0)*math.sin(p) - math.sin(p0)*math.cos(p)*math.cos(l - l0))
    return (size/2.0 + x, size/2.0 + y)

def emblem(w=900, gap_ratio=0.05, pad_ratio=0.02):
    """two hemispheres side by side, Africa picked out"""
    gap = int(w * gap_ratio); pad = int(w * pad_ratio)
    size = (w - gap - 2*pad) // 2
    h = size + 2*pad
    im = Image.new('RGBA', (w, h), (0,0,0,0))
    left  = hemisphere(size, -82, 16)     # the Americas
    right = hemisphere(size,  20,  8)     # Africa, Europe, Asia
    lx, rx, ty = pad, pad + size + gap, pad
    im.alpha_composite(left,  (lx, ty))
    im.alpha_composite(right, (rx, ty))

    return im

if __name__ == '__main__':
    em = emblem(900)
    em.save('/tmp/build/emblem.png', optimize=True)
    print('emblem', em.size, os.path.getsize('/tmp/build/emblem.png')//1024, 'KB')
