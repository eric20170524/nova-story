import time
import os
import sys
from playwright.sync_api import sync_playwright

def inspect_projects():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page()
        page.goto("http://localhost:3000/novastory/", wait_until="domcontentloaded")
        page.wait_for_timeout(3000)

        screenshot_dir = r"C:\Users\piaoy\.gemini\antigravity\brain\a73e22bf-1ca9-4d1b-befe-6b49754c896e\scratch"
        
        print("=== CLICKABLE ELEMENTS ===")
        elements = page.query_selector_all("div, button, a")
        for i, el in enumerate(elements):
            txt = el.inner_text().strip()
            if txt and len(txt) < 50 and ("集" in txt or "剧" in txt or "项目" in txt or "万兽" in txt or "新建" in txt or "导演" in txt):
                print(f"[{i}] Tag: {el.evaluate('e => e.tagName')} | Text: '{txt}' | Class: '{el.get_attribute('class')}'")

        # Take screenshot
        page.screenshot(path=os.path.join(screenshot_dir, "projects_list.png"))
        print("Saved projects_list.png")

        # Click first project card if found
        project_cards = page.query_selector_all("div.cursor-pointer, [class*='card'], div.bg-slate-900")
        print(f"\nFound {len(project_cards)} potential project cards.")
        for idx, card in enumerate(project_cards):
            text = card.inner_text().strip().replace('\n', ' | ')
            if text:
                print(f"Card {idx}: {text[:100]}")

        browser.close()

if __name__ == "__main__":
    inspect_projects()
