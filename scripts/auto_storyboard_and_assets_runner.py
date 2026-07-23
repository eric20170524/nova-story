import time
import os
import sys
import json
from playwright.sync_api import sync_playwright

SCREENSHOT_DIR = r"C:\Users\piaoy\.gemini\antigravity\brain\a73e22bf-1ca9-4d1b-befe-6b49754c896e"

def run_automation():
    os.makedirs(SCREENSHOT_DIR, exist_ok=True)
    print("Starting Playwright Computer Use Automation...")

    with sync_playwright() as p:
        browser = p.chromium.launch(channel="msedge", headless=True)
        context = browser.new_context(viewport={'width': 1440, 'height': 900})
        
        # Inject token before page load
        context.add_init_script("localStorage.setItem('access_token', 'dev-mock-token');")
        page = context.new_page()

        # Intercept console logs & network calls
        page.on("dialog", lambda dialog: (print(f"[DIALOG ACCEPT] {dialog.message}"), dialog.accept()))
        page.on("console", lambda msg: print(f"[BROWSER LOG] {msg.type}: {msg.text}"))
        
        def handle_response(response):
            if "/api/" in response.url:
                print(f"[API {response.request.method}] {response.url} -> {response.status}")
                try:
                    if response.status >= 400:
                        print(f"   [API ERROR BODY] {response.text()[:500]}")
                except Exception:
                    pass
        page.on("response", handle_response)

        # 1. Access page directly
        print("\n--- STEP 1: Navigating to Director Mode ---")
        page.goto("http://localhost:3000/novastory/project/1/director", wait_until="load")
        page.wait_for_timeout(4000)
        
        page.screenshot(path=os.path.join(SCREENSHOT_DIR, "01_director_loaded.png"))
        print("Saved 01_director_loaded.png")

        # 2. Wait for initial getTimeline call to finish
        print("\n--- STEP 2: Waiting for initial timeline load ---")
        start_t = time.time()
        while time.time() - start_t < 10:
            is_enabled = page.evaluate("""() => {
                const btns = Array.from(document.querySelectorAll('button'));
                const btn = btns.find(b => b.querySelector('svg.lucide-film') && !b.className.includes('w-10 h-10'));
                return btn ? !btn.disabled : false;
            }""")
            if is_enabled:
                print(f"'自动分镜' button is ENABLED after {time.time()-start_t:.1f}s!")
                break
            page.wait_for_timeout(1000)

        page.screenshot(path=os.path.join(SCREENSHOT_DIR, "02_chapter_selected.png"))

        # 3. Click Auto Storyboard ("自动分镜")
        print("\n--- STEP 3: Triggering '自动分镜' ---")
        clicked = page.evaluate("""() => {
            const btns = Array.from(document.querySelectorAll('button'));
            const btn = btns.find(b => b.querySelector('svg.lucide-film') && !b.className.includes('w-10 h-10'));
            if (btn && !btn.disabled) {
                btn.click();
                return true;
            }
            return false;
        }""")

        if clicked:
            print("Successfully clicked '自动分镜'! Waiting for timeline generation...")
            start_t = time.time()
            success = False
            while time.time() - start_t < 60:
                page.wait_for_timeout(3000)
                cards_count = page.evaluate("""() => {
                    return document.querySelectorAll('div.bg-slate-900.border-slate-800').length;
                }""")
                if cards_count > 0:
                    print(f"Storyboard generation completed in {time.time()-start_t:.1f}s! Scene cards count: {cards_count}")
                    success = True
                    break
                else:
                    print(f"Waiting for storyboard generation... ({time.time()-start_t:.0f}s)")
            
            if not success:
                print("Storyboard generation wait timed out.")
        else:
            print("ERROR: Could not click '自动分镜' button via JS evaluate!")

        page.screenshot(path=os.path.join(SCREENSHOT_DIR, "03_storyboard_result.png"))
        print("Saved 03_storyboard_result.png")

        # 4. Click "Generate All Assets"
        print("\n--- STEP 4: Triggering 'Generate All Assets' ---")
        asset_clicked = page.evaluate("""() => {
            const btns = Array.from(document.querySelectorAll('button'));
            const btn = btns.find(b => b.innerText.includes('Generate All Assets'));
            if (btn && !btn.disabled) {
                btn.click();
                return 'Generate All Assets';
            }
            return false;
        }""")

        if asset_clicked:
            print(f"Successfully triggered asset generation via button: {asset_clicked}!")
            start_t = time.time()
            while time.time() - start_t < 15:
                page.wait_for_timeout(3000)
                print(f"Waiting for asset generation... ({time.time()-start_t:.0f}s)")
        else:
            print("Warning: Could not find enabled 'Generate All Assets' button.")

        page.screenshot(path=os.path.join(SCREENSHOT_DIR, "04_assets_generation_result.png"))
        print("Saved 04_assets_generation_result.png")

        browser.close()
        print("Automation finished successfully.")

if __name__ == "__main__":
    run_automation()
