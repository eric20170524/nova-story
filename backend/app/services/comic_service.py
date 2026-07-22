import os
import io
import textwrap
import logging
from PIL import Image, ImageDraw, ImageFont
from reportlab.pdfgen import canvas
from reportlab.lib.pagesizes import A4, landscape
import requests
from ..core.config import settings

logger = logging.getLogger(__name__)

class ComicService:
    def __init__(self):
        self.static_dir = os.path.join(os.path.dirname(os.path.dirname(__file__)), "static")
        self.comic_dir = os.path.join(self.static_dir, "comics")
        os.makedirs(self.comic_dir, exist_ok=True)
        
        # Font settings
        self.font_path = self._find_font()
        self.font_size = 24
        
    def _find_font(self):
        """Find a suitable font for Chinese/English text."""
        # 1. Check local static/fonts folder
        font_dir = os.path.join(self.static_dir, "fonts")
        if os.path.exists(font_dir):
            for file in os.listdir(font_dir):
                if file.lower().endswith((".ttf", ".otf", ".ttc")):
                    return os.path.join(font_dir, file)

        # 2. Common Windows paths for Chinese fonts
        candidates = [
            "C:\\Windows\\Fonts\\msyh.ttc",  # Microsoft YaHei
            "C:\\Windows\\Fonts\\simhei.ttf", # SimHei
            "C:\\Windows\\Fonts\\arial.ttf",  # Fallback (no Chinese)
        ]
        for path in candidates:
            if os.path.exists(path):
                return path
        return None

    def _get_image(self, asset_url):
        """Load image from local path or URL."""
        try:
            if asset_url.startswith("/static/generated/"):
                # Local file
                filename = asset_url.split("/")[-1]
                path = os.path.join(self.static_dir, "generated", filename)
                return Image.open(path).convert("RGB")
            elif asset_url.startswith("http"):
                # Remote URL
                resp = requests.get(asset_url, stream=True)
                resp.raise_for_status()
                return Image.open(resp.raw).convert("RGB")
            else:
                # Assume absolute path or relative to static
                if os.path.exists(asset_url):
                    return Image.open(asset_url).convert("RGB")
        except Exception as e:
            logger.error(f"Failed to load image {asset_url}: {e}")
            return None
        return None

    def _draw_subtitle(self, img, text):
        """Draw subtitle at the bottom of the image."""
        if not text:
            return img
            
        draw = ImageDraw.Draw(img)
        width, height = img.size
        
        try:
            font = ImageFont.truetype(self.font_path, self.font_size) if self.font_path else ImageFont.load_default()
        except:
            font = ImageFont.load_default()

        # Text wrapping
        # Approximate chars per line based on width (very rough)
        # Assuming avg char width is font_size/2 for English, font_size for Chinese. 
        # We'll be conservative.
        avg_char_width = self.font_size * 0.8
        chars_per_line = int((width - 40) / avg_char_width)
        
        lines = textwrap.wrap(text, width=chars_per_line)
        
        # Calculate text block height
        line_height = self.font_size + 10
        text_block_height = len(lines) * line_height + 20 # padding
        
        # Draw background rectangle
        # Create a transparent overlay
        overlay = Image.new("RGBA", img.size, (0, 0, 0, 0))
        overlay_draw = ImageDraw.Draw(overlay)
        
        rect_y1 = height - text_block_height
        rect_y2 = height
        overlay_draw.rectangle([(0, rect_y1), (width, rect_y2)], fill=(0, 0, 0, 150))
        
        img = img.convert("RGBA")
        img = Image.alpha_composite(img, overlay)
        img = img.convert("RGB")
        
        # Draw Text
        draw = ImageDraw.Draw(img)
        current_y = rect_y1 + 10
        
        for line in lines:
            # Center text
            # bbox = draw.textbbox((0, 0), line, font=font)
            # text_w = bbox[2] - bbox[0]
            # Since older Pillow versions might be used, we can use textlength or estimate
            text_w = draw.textlength(line, font=font)
            text_x = (width - text_w) / 2
            
            draw.text((text_x, current_y), line, font=font, fill=(255, 255, 255))
            current_y += line_height
            
        return img

    def generate_page(self, scene_id, asset_url, dialogue):
        """Generate a single comic page."""
        img = self._get_image(asset_url)
        if not img:
            return None
            
        img_with_text = self._draw_subtitle(img, dialogue)
        
        filename = f"comic_scene_{scene_id}.jpg"
        filepath = os.path.join(self.comic_dir, filename)
        img_with_text.save(filepath, quality=90)
        
        return f"/static/comics/{filename}", filepath

    def generate_pdf(self, chapter_id, pages):
        """Generate PDF from list of page image paths."""
        pdf_filename = f"chapter_{chapter_id}_comic.pdf"
        pdf_path = os.path.join(self.comic_dir, pdf_filename)
        
        if not pages:
            return None
            
        # Get size of first image to set page size
        first_img = Image.open(pages[0])
        page_width, page_height = first_img.size
        
        c = canvas.Canvas(pdf_path, pagesize=(page_width, page_height))
        
        for page_img_path in pages:
            c.drawImage(page_img_path, 0, 0, width=page_width, height=page_height)
            c.showPage()
            
        c.save()
        return f"/static/comics/{pdf_filename}"
