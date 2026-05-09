/**
 * Documentation Generation Script (Template)
 * 
 * This script is intended to be run during build time to capture screenshots 
 * of the application and update the bundled documentation.
 * 
 * Requirements: Playwright
 * Run: node scripts/doc-gen.js
 */

import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';

const SCREENSHOT_DIR = path.resolve('public/assets/docs/screenshots');

async function captureScreenshots() {
  if (!fs.existsSync(SCREENSHOT_DIR)) {
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  }

  const browser = await chromium.launch();
  const page = await browser.newPage();
  
  // Set viewport to a premium resolution
  await page.setViewportSize({ width: 1440, height: 900 });

  console.log('🚀 Starting Documentation Screenshot Capture...');

  try {
    // 1. Visit the app
    await page.goto('http://localhost:5173'); // Assuming dev server is running
    await page.waitForTimeout(2000);

    // 2. Capture Sidebar/Explorer
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'explorer.png') });
    console.log('✅ Captured Explorer');

    // 3. Open Settings
    await page.keyboard.press('Control+Alt+S');
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'settings.png') });
    console.log('✅ Captured Settings');

    // 4. Open Help (The new feature!)
    await page.keyboard.press('Control+H');
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'help-dialog.png') });
    console.log('✅ Captured Help Dialog');

    console.log('\n✨ Documentation screenshots generated successfully!');
    console.log(`📂 Location: ${SCREENSHOT_DIR}`);
    
  } catch (err) {
    console.error('❌ Error capturing screenshots:', err.message);
    console.log('Wait: Ensure your dev server is running at http://localhost:5173');
  } finally {
    await browser.close();
  }
}

captureScreenshots();
