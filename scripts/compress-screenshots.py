# Reduces the screenshots to a 64 colour palette, about a third of their
# size, since they ship in the npm package. Needs Pillow.
#
#   python3 scripts/compress-screenshots.py
import glob
import os

from PIL import Image

here = os.path.dirname(os.path.abspath(__file__))
for path in glob.glob(os.path.join(here, '..', 'docs', 'screenshots', '*.png')):
    image = Image.open(path).convert('RGB')
    image.quantize(colors=64, method=Image.Quantize.MEDIANCUT).save(path, optimize=True)
