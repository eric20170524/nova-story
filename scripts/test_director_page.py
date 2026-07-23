import time
import os
from playwright.sync_api import sync_playwright

def test_director():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page()

        # Set localStorage token just in case
        page.goto("http://localhost:3000/novastory/", wait_until="domcontentloaded")
        page.evaluate("localStorage.setItem('access_token', 'dev-mock-token')")

        print("Navigating to director page...")
        page.goto("http://localhost:3000/novastory/project/1/director", wait_until="domcontentloaded")
        page.wait_for_timeout(3000)

        screenshot_dir = r"C:\Users\piaoy\.gemini\antigravity\brain\a73e22bf-1ca9-4d1b-befe-6b49754c896e\scratch"
        page.screenshot(path=os.path.join(screenshot_dir, "director_page.png"))
        print("Saved director_page.png")

        print("\n=== BUTTONS ON DIRECTOR PAGE ===")
        buttons = page.query_selector_all("button")
        for i, b in enumerate(buttons):
            if b.is_visible():
                print(f"[{i}] '{b.inner_text().strip().replace('\n', ' ')}'")

        print("\n=== CHAPTERS / TEXT SNAPSHOT ===")
        print(page.inner_text("body")[:1000])

        browser.close()

if __name__ == "__main__":
    test_director()
