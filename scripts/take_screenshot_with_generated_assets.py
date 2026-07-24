import time
import os
from playwright.sync_api import sync_playwright

SCREENSHOT_DIR = r"C:\Users\piaoy\.gemini\antigravity\brain\7825c037-5e63-4140-9166-eebd82252a95"

def capture():
    print("Capturing UI with generated scene assets...")
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(viewport={'width': 1440, 'height': 900})
        context.add_init_script("localStorage.setItem('access_token', 'dev-mock-token');")
        page = context.new_page()

        page.goto("http://localhost:3000/novastory/project/1/director", wait_until="load")
        page.wait_for_timeout(4000)

        page.screenshot(path=os.path.join(SCREENSHOT_DIR, "05_director_ui_with_generated_scenes.png"))
        print("Saved 05_director_ui_with_generated_scenes.png")
        browser.close()

if __name__ == "__main__":
    capture()
