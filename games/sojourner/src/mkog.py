"""The link-preview card. The emblem carries it; the words stay out of its way."""
from PIL import Image, ImageDraw, ImageFont
import os, sys
sys.path.insert(0, '/tmp/build')
W, H = 1200, 630
INK   = (12,11,10)
PAPER = (240,232,218)
AMBER = (224,164,74)
DIM   = (169,157,143)
VERD  = (89,185,164)
def f(path, size):
    try: return ImageFont.truetype(path, size)
    except Exception: return ImageFont.load_default()
SERIF  = '/usr/share/fonts/truetype/dejavu/DejaVuSerif-Bold.ttf'
SERIF_I= '/usr/share/fonts/truetype/dejavu/DejaVuSerif-Italic.ttf'
MONO   = '/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf'

im = Image.new('RGB', (W,H), INK)
d  = ImageDraw.Draw(im)

em = Image.open('/tmp/build/emblem.png').convert('RGBA')
ew = 780
em = em.resize((ew, round(em.height * ew / em.width)), Image.LANCZOS)
im.paste(em, ((W - ew)//2, 86), em)

d.text((W//2, 60), 'A GAME OF GEOGRAPHY', font=f(MONO,26), fill=AMBER, anchor='mm')
d.text((W//2, H-108), 'Sojourner', font=f(SERIF,80), fill=PAPER, anchor='mm')
d.text((W//2, H-46), 'playsapien.com/sojourner', font=f(MONO,25), fill=VERD, anchor='mm')
im.save('/tmp/build/og.png', optimize=True)
print('og.png', im.size, os.path.getsize('/tmp/build/og.png')//1024, 'KB')
