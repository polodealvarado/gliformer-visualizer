"""Turn one document page into an image, text and aligned word boxes."""

import base64
import csv
import io
import shutil
import subprocess

import pymupdf
from PIL import Image

MAX_FILE = 10 * 1024 * 1024
MAX_PIXELS = 16_000_000


def image_url(data):
    return "data:image/png;base64," + base64.b64encode(data).decode()


def assemble(items, width, height, image, source, name, page=0, pages=1):
    words, parts, offset = [], [], 0
    for word, box in items:
        word = word.strip()
        if not word:
            continue
        if parts:
            offset += 1
        box = [round(1000 * v / (width if i % 2 == 0 else height)) for i, v in enumerate(box)]
        box = [max(0, min(1000, v)) for v in box]
        words.append({"text": word, "start": offset, "end": offset + len(word), "bbox": box})
        parts.append(word)
        offset += len(word)
    if not words:
        raise ValueError("No words were found on this page. Try a clearer image or another page.")
    return {"name": name, "text": " ".join(parts), "words": words, "image": image_url(image),
            "width": width, "height": height, "source": source, "page": page, "pages": pages}


def ocr(data, name):
    if not shutil.which("tesseract"):
        raise ValueError("Image and scanned-PDF input needs Tesseract. Install it, or use a PDF with embedded text.")
    with Image.open(io.BytesIO(data)) as im:
        if im.width * im.height > MAX_PIXELS:
            raise ValueError("Use an image with at most 16 million pixels.")
        im = im.convert("RGB")
        width, height = im.size
        png = io.BytesIO()
        im.save(png, format="PNG")
    run = subprocess.run(["tesseract", "stdin", "stdout", "--psm", "3", "tsv"], input=png.getvalue(),
                         capture_output=True, timeout=45, check=True)
    items = []
    for row in csv.DictReader(io.StringIO(run.stdout.decode()), delimiter="\t"):
        if row["level"] == "5" and row.get("text", "").strip():
            x, y, w, h = (int(row[k]) for k in ("left", "top", "width", "height"))
            items.append((row["text"], [x, y, x + w, y + h]))
    return assemble(items, width, height, png.getvalue(), "Tesseract OCR", name)


def read_document(body):
    try:
        data = base64.b64decode(body["data"], validate=True)
    except (ValueError, KeyError) as exc:
        raise ValueError("Send a document encoded as base64.") from exc
    if not 0 < len(data) <= MAX_FILE:
        raise ValueError("Use a document of at most 10 MB.")
    name = str(body.get("name", "document"))[:120]
    if data.startswith(b"%PDF"):
        with pymupdf.open(stream=data, filetype="pdf") as pdf:
            if pdf.needs_pass:
                raise ValueError("Use a PDF without a password.")
            number = int(body.get("page", 0))
            if not 0 <= number < len(pdf):
                raise ValueError(f"Choose a page from 1 to {len(pdf)}.")
            page = pdf[number]
            scale = min(1.5, (MAX_PIXELS / max(page.rect.width * page.rect.height, 1)) ** 0.5)
            png = page.get_pixmap(matrix=pymupdf.Matrix(scale, scale), alpha=False).tobytes("png")
            items = [(w[4], list(w[:4])) for w in page.get_text("words", sort=True)]
            if items:
                return assemble(items, page.rect.width, page.rect.height, png,
                                "Embedded PDF text", name, number, len(pdf))
            result = ocr(png, name)
            result.update(page=number, pages=len(pdf))
            return result
    try:
        return ocr(data, name)
    except (OSError, Image.DecompressionBombError) as exc:
        raise ValueError("Choose a PNG, JPEG, WebP or PDF document.") from exc


def example_document():
    """A generated invoice with exact PDF text geometry; no OCR approximations."""
    with pymupdf.open() as pdf:
        page = pdf.new_page(width=640, height=760)
        ink, muted, teal = (0.12, 0.19, 0.23), (0.4, 0.47, 0.51), (0.08, 0.45, 0.47)

        def write(x, y, text, size=13, color=ink, bold=False):
            page.insert_text((x, y), text, fontsize=size, fontname="hebo" if bold else "helv", color=color)

        page.draw_rect(pymupdf.Rect(0, 0, 640, 12), fill=teal, color=teal)
        write(50, 75, "NORTHSTAR STUDIO", 17, bold=True)
        write(50, 98, "Design & engineering", 11, muted)
        write(444, 75, "INVOICE", 24, teal, True)
        write(50, 160, "Invoice number", 10, muted)
        write(50, 183, "INV-2026-042", 15, bold=True)
        write(340, 160, "Issue date", 10, muted)
        write(340, 183, "2 November 2026", 15)
        page.draw_line((50, 210), (590, 210), color=(0.83, 0.87, 0.87))
        write(50, 252, "BILL TO", 10, muted, True)
        write(50, 280, "Alice Morgan", 17, bold=True)
        write(50, 304, "Acme Research Ltd.", 14)
        write(50, 327, "24 Baker Street, London", 13, muted)
        page.draw_rect(pymupdf.Rect(50, 380, 590, 418), fill=(0.93, 0.96, 0.95), color=None)
        write(65, 404, "Description", 12, bold=True)
        write(465, 404, "Amount", 12, bold=True)
        write(65, 454, "Website design", 14)
        write(465, 454, "$2,400.00", 14)
        write(65, 495, "Accessibility review", 14)
        write(465, 495, "$600.00", 14)
        page.draw_line((50, 525), (590, 525), color=(0.83, 0.87, 0.87))
        write(340, 568, "Total due", 17, bold=True)
        write(465, 568, "$3,000.00", 17, teal, True)
        write(50, 665, "Payment due: 2 December 2026", 12)
        write(50, 696, "Thank you for your business.", 11, muted)
        png = page.get_pixmap(alpha=False).tobytes("png")
        items = [(w[4], list(w[:4])) for w in page.get_text("words", sort=True)]
        return assemble(items, 640, 760, png, "Generated PDF with exact word boxes", "Northstar invoice")
