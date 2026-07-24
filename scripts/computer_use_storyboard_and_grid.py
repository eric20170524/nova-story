import time
import os
import sys
import json
from playwright.sync_api import sync_playwright

SCREENSHOT_DIR = r"C:\Users\piaoy\.gemini\antigravity\brain\7825c037-5e63-4140-9166-eebd82252a95"

def run_automation():
    os.makedirs(SCREENSHOT_DIR, exist_ok=True)
    print("==================================================")
    print("Starting Playwright Computer Use Automation")
    print("==================================================")

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(viewport={'width': 1440, 'height': 900})
        
        # Inject mock access token
        context.add_init_script("localStorage.setItem('access_token', 'dev-mock-token');")
        page = context.new_page()

        # Listen to console logs & API responses
        page.on("dialog", lambda dialog: (print(f"[DIALOG ACCEPT] {dialog.message}"), dialog.accept()))
        page.on("console", lambda msg: print(f"[BROWSER LOG] {msg.type}: {msg.text}"))
        
        def handle_response(response):
            if "/api/" in response.url:
                print(f"[API Response] {response.request.method} {response.url} -> {response.status}")
                if response.status >= 400:
                    try:
                        print(f"   [API ERROR BODY] {response.text()[:500]}")
                    except Exception:
                        pass
        page.on("response", handle_response)

        # ------------------------------------------------------------------
        # 1. Access Director Mode
        # ------------------------------------------------------------------
        print("\n--- STEP 1: Navigating to Director Mode ---")
        page.goto("http://localhost:3000/novastory/project/1/director", wait_until="load")
        page.wait_for_timeout(3000)
        
        page.screenshot(path=os.path.join(SCREENSHOT_DIR, "01_director_loaded.png"))
        print("Saved 01_director_loaded.png")

        # ------------------------------------------------------------------
        # 2. Trigger Standard Auto Storyboard ("自动分镜")
        # ------------------------------------------------------------------
        print("\n--- STEP 2: Triggering Standard '自动分镜' ---")
        # Wait until button is enabled
        start_t = time.time()
        while time.time() - start_t < 10:
            is_enabled = page.evaluate("""() => {
                const btns = Array.from(document.querySelectorAll('button'));
                const btn = btns.find(b => b.textContent.includes('自动分镜') || b.textContent.includes('Auto-Storyboard'));
                return btn ? !btn.disabled : false;
            }""")
            if is_enabled:
                print(f"'自动分镜' button is ready after {time.time()-start_t:.1f}s!")
                break
            page.wait_for_timeout(1000)

        clicked = page.evaluate("""() => {
            const btns = Array.from(document.querySelectorAll('button'));
            const btn = btns.find(b => b.textContent.includes('自动分镜') || b.textContent.includes('Auto-Storyboard'));
            if (btn && !btn.disabled) {
                btn.click();
                return true;
            }
            return false;
        }""")

        if clicked:
            print("Clicked Standard '自动分镜'. Waiting for scene timeline cards...")
            start_t = time.time()
            success = False
            while time.time() - start_t < 90:
                page.wait_for_timeout(3000)
                cards_count = page.evaluate("() => document.querySelectorAll('div.bg-slate-900.border-slate-800').length")
                if cards_count > 0:
                    print(f"Standard Storyboard completed in {time.time()-start_t:.1f}s! Cards count: {cards_count}")
                    success = True
                    break
                else:
                    print(f"Waiting for storyboard generation... ({time.time()-start_t:.0f}s)")
            if not success:
                print("Standard Storyboard wait timed out.")
        else:
            print("ERROR: Could not click Standard '自动分镜' button!")

        page.screenshot(path=os.path.join(SCREENSHOT_DIR, "02_standard_storyboard_result.png"))
        print("Saved 02_standard_storyboard_result.png")

        # ------------------------------------------------------------------
        # 3. Trigger Cinematic Grid Auto Storyboard (9-Shot Grid)
        # ------------------------------------------------------------------
        print("\n--- STEP 3: Triggering Cinematic Grid (9 Shots) '自动分镜' ---")
        
        # Open dropdown menu and click Cinematic Grid option
        dropdown_opened = page.evaluate("""() => {
            const btns = Array.from(document.querySelectorAll('button'));
            // Find chevron dropdown button next to 自动分镜
            const chevronBtn = btns.find(b => b.querySelector('svg.lucide-chevron-down'));
            if (chevronBtn && !chevronBtn.disabled) {
                chevronBtn.click();
                return true;
            }
            return false;
        }""")
        page.wait_for_timeout(1000)
        
        grid_clicked = page.evaluate("""() => {
            const btns = Array.from(document.querySelectorAll('button'));
            const gridBtn = btns.find(b => b.textContent.includes('Cinematic Grid'));
            if (gridBtn) {
                gridBtn.click();
                return true;
            }
            return false;
        }""")

        if grid_clicked:
            print("Clicked Cinematic Grid (9 Shots). Waiting for 9 grid scenes...")
            start_t = time.time()
            grid_success = False
            while time.time() - start_t < 120:
                page.wait_for_timeout(3000)
                cards_count = page.evaluate("() => document.querySelectorAll('div.bg-slate-900.border-slate-800').length")
                if cards_count >= 9:
                    print(f"Cinematic Grid Storyboard completed in {time.time()-start_t:.1f}s! Cards count: {cards_count}")
                    grid_success = True
                    break
                else:
                    print(f"Waiting for Cinematic Grid generation... ({time.time()-start_t:.0f}s, current cards: {cards_count})")
            if not grid_success:
                print(f"Cinematic Grid Storyboard wait finished.")
        else:
            print("ERROR: Could not click Cinematic Grid option!")

        page.screenshot(path=os.path.join(SCREENSHOT_DIR, "03_cinematic_grid_storyboard_result.png"))
        print("Saved 03_cinematic_grid_storyboard_result.png")

        # ------------------------------------------------------------------
        # 4. Switch Asset Mode to Cinematic Grid and Batch Generate Assets
        # ------------------------------------------------------------------
        print("\n--- STEP 4: Switch Asset Mode to Cinematic Grid & Batch Generate Assets ---")
        
        # Switch mode to Cinematic Grid in Right Panel
        mode_switched = page.evaluate("""() => {
            const btns = Array.from(document.querySelectorAll('button'));
            const modeBtn = btns.find(b => b.textContent.trim() === 'Cinematic Grid');
            if (modeBtn) {
                modeBtn.click();
                return true;
            }
            return false;
        }""")
        print(f"Asset Mode switched to Cinematic Grid: {mode_switched}")

        # Trigger Generate All Assets
        asset_clicked = page.evaluate("""() => {
            const btns = Array.from(document.querySelectorAll('button'));
            const btn = btns.find(b => b.textContent.includes('Generate All Assets'));
            if (btn && !btn.disabled) {
                btn.click();
                return 'Generate All Assets';
            }
            return false;
        }""")

        if asset_clicked:
            print("Triggered 'Generate All Assets'! Waiting for asset generations...")
            start_t = time.time()
            while time.time() - start_t < 35:
                page.wait_for_timeout(3000)
                print(f"Generating assets... ({time.time()-start_t:.0f}s)")
        else:
            print("Warning: Could not find enabled 'Generate All Assets' button. Triggering first scene asset manually...")
            page.evaluate("""() => {
                const btns = Array.from(document.querySelectorAll('button'));
                const genBtn = btns.find(b => b.textContent.includes('生成资源') || b.textContent.includes('Generate'));
                if (genBtn) genBtn.click();
            }""")
            page.wait_for_timeout(5000)

        page.screenshot(path=os.path.join(SCREENSHOT_DIR, "04_cinematic_grid_assets_result.png"))
        print("Saved 04_cinematic_grid_assets_result.png")

        browser.close()
        print("\nComputer Use Automation completed successfully!")

if __name__ == "__main__":
    run_automation()
