import time
import os
import sys
from playwright.sync_api import sync_playwright

def run_computer_use():
    with sync_playwright() as p:
        print("Launching browser...")
        browser = p.chromium.launch(headless=True)
        page = browser.new_page()
        
        # Listen for console logs and network errors
        page.on("console", lambda msg: print(f"[BROWSER CONSOLE] {msg.type}: {msg.text}"))
        page.on("pageerror", lambda err: print(f"[BROWSER ERROR] {err}"))
        
        print("Navigating to http://localhost:3000...")
        page.goto("http://localhost:3000", wait_until="domcontentloaded")
        page.wait_for_timeout(3000)

        print("\n=== CURRENT PAGE INFO ===")
        print("URL:", page.url)
        print("Title:", page.title())

        screenshot_dir = r"C:\Users\piaoy\.gemini\antigravity\brain\a73e22bf-1ca9-4d1b-befe-6b49754c896e\scratch"
        os.makedirs(screenshot_dir, exist_ok=True)
        page.screenshot(path=os.path.join(screenshot_dir, "step1_initial.png"))
        print("Saved step1_initial.png")

        # Get all text
        body_text = page.inner_text("body")
        print("\n=== PAGE BODY TEXT SNAPSHOT ===")
        print(body_text[:1500])

        # Get buttons
        buttons = page.query_selector_all("button")
        print("\n=== BUTTONS FOUND ===")
        for i, b in enumerate(buttons):
            text = b.inner_text().strip().replace("\n", " ")
            if b.is_visible():
                print(f"[{i}] Text: '{text}'")

        browser.close()

if __name__ == "__main__":
    run_computer_use()
