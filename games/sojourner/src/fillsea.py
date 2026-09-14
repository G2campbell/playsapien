"""Give every square of open sea a name.

The picking raster only carried the 46 named water bodies as they are actually
drawn, which left 22% of the map -- almost all of it polar ocean -- with no id at
all. A press there returned nothing, and the game answered 'Open water, hold over
land' even when the thing being asked for was a sea. The Beaufort Sea was
unplayable for exactly this reason: its own pixels are there, but the Arctic
around it was blank, and pickAt only looks 14 pixels for a neighbour.

So: every unmapped pixel is assigned to the nearest named water body. Land is left
untouched, and no new ids are created -- the seas simply reach as far as the water
does. Run after fixcentroids, so that the centres and radii are measured from the
true extents rather than these grown ones.
"""
import json, numpy as np
from PIL import Image
from scipy import ndimage

SRC = '/tmp/build/idmap.png'
im = Image.open(SRC).convert('RGB')
a = np.asarray(im)
ids = a[:, :, 0].astype(np.int32) + a[:, :, 1].astype(np.int32) * 256
H, W = ids.shape

gd = json.load(open('/tmp/build/gamedata.json'))
admins, gA = gd['admins'], gd['gA']
WATER = admins.index('Water')
is_water_id = np.zeros(max(gA) if False else len(gA) + 1, dtype=bool)
for i in range(1, len(gA)):
    if gA[i] == WATER: is_water_id[i] = True

void = ids == 0
water = np.zeros_like(void)
w_ids = np.nonzero(is_water_id)[0]
for i in w_ids: water |= (ids == i)
print('before: %d unmapped (%.1f%%), %d water' % (void.sum(), 100*void.mean(), water.sum()))

# seed with the water ids only, wrapped in longitude so the fill crosses the dateline
PAD = 400
seed = np.where(water, ids, 0)
seed_p = np.concatenate([seed[:, -PAD:], seed, seed[:, :PAD]], axis=1)
_, (iy, ix) = ndimage.distance_transform_edt(seed_p == 0, return_indices=True)
near = seed_p[iy, ix][:, PAD:PAD+W]

out = ids.copy()
out[void] = near[void]
still = (out == 0).sum()
print('after:  %d unmapped (%.2f%%)' % (still, 100*still/(H*W)))

grew = {}
for i in w_ids:
    b = int((ids == i).sum()); af = int((out == i).sum())
    if af != b: grew[int(i)] = (b, af)
gL = gd['gL']
top = sorted(grew.items(), key=lambda kv: kv[1][1]-kv[1][0], reverse=True)[:8]
for i,(b,af) in top: print('   %-20s %8d -> %8d' % (gL[i], b, af))

# The blue channel of the picking map is spare, so it carries one bit the shader
# wants and cannot otherwise know: whether this pixel is sea. A blue wash on blue
# water is invisible, and the renderer uses this to hatch it instead.
kind = np.zeros(len(gA) + 2, dtype=np.uint8)
for i in range(1, len(gA)):
    if gA[i] == WATER: kind[i] = 255
o = np.zeros((H, W, 3), dtype=np.uint8)
o[:, :, 0] = (out & 255).astype(np.uint8)
o[:, :, 1] = (out >> 8).astype(np.uint8)
o[:, :, 2] = kind[np.clip(out, 0, len(gA))]
print('water flagged in the blue channel: %d px' % int((o[:,:,2] > 0).sum()))
Image.fromarray(o).save(SRC)
print('idmap.png rewritten')

# assemble.py wrote the single-file copy from the raster as it was before the
# fill, so refresh it here
import base64
open('/tmp/build/idmap.b64','w').write(base64.b64encode(open(SRC,'rb').read()).decode())
print('idmap.b64 refreshed')
