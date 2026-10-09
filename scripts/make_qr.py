"""
Turns any web address into a printable QR code (PNG).

Typical use: print a QR for the Google Form made by cloud_sync/CreateGoogleForm.gs
(see FORMULARIO_GOOGLE.md):

    python scripts/make_qr.py "https://docs.google.com/forms/d/e/XXXX/viewform" formulario.png

The app's own QR (Settings -> QR in the program) is separate and points at the
local registration page; this script is for everything else.
"""
import sys
from pathlib import Path

import qrcode
import qrcode.constants


def main(argv: list[str]) -> int:
    if len(argv) < 2 or argv[1] in ("-h", "--help"):
        print(__doc__)
        return 1
    url = argv[1]
    if not url.startswith(("http://", "https://")):
        print("The address must start with http:// or https://", file=sys.stderr)
        return 2
    out = Path(argv[2] if len(argv) > 2 else "qr.png")
    qr = qrcode.QRCode(version=None, error_correction=qrcode.constants.ERROR_CORRECT_M, box_size=10, border=3)
    qr.add_data(url)
    qr.make(fit=True)
    qr.make_image(fill_color="#0f172a", back_color="#ffffff").save(out)
    print(f"Saved {out.resolve()}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
