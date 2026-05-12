/**
 * Bug Condition Exploration Tests for Outlook HTML Email CSS Compatibility
 * 
 * These tests are designed to FAIL on UNFIXED code to confirm the bug exists.
 * The bug: inlineHtmlForOutlook() preserves Outlook-unsupported CSS properties
 * (display: grid, display: flex, CSS variables, border-radius, box-shadow) in
 * the output, causing layouts to break in Outlook.
 * 
 * **Validates: Bugfix Requirements 1.1, 1.2, 1.3, 1.4, 1.5, 1.6**
 */

const fc = require('fast-check');
const { JSDOM } = require('jsdom');

// Set up JSDOM environment to simulate browser APIs
const dom = new JSDOM('<!DOCTYPE html><html><head></head><body></body></html>');
global.window = dom.window;
global.document = dom.window.document;
global.DOMParser = dom.window.DOMParser;

const { inlineHtmlForOutlook } = require('./inlineHtmlForOutlook');

/**
 * Helper to promisify the callback-based inlineHtmlForOutlook function
 */
function inlineHtmlAsync(rawHtml) {
  return new Promise((resolve) => {
    inlineHtmlForOutlook(rawHtml, resolve);
  });
}

describe('Bug Condition Exploration - Outlook Unsupported CSS Properties', () => {
  
  /**
   * Test 1: Grid Layout Bug
   * **Validates: Requirement 1.1**
   * 
   * EXPECTED: Test FAILS on unfixed code (output contains display: grid)
   * This confirms the bug exists - grid layouts are preserved and will break in Outlook
   */
  test('Grid layout test: HTML with grid CSS → output contains display: grid → will fail in Outlook', async () => {
    const htmlWithGrid = `
      <!DOCTYPE html>
      <html>
        <head>
          <style>
            .grid-2 {
              display: grid;
              grid-template-columns: 1fr 1fr;
              gap: 20px;
            }
          </style>
        </head>
        <body>
          <div class="grid-2">
            <div>Item 1</div>
            <div>Item 2</div>
          </div>
        </body>
      </html>
    `;

    const result = await inlineHtmlAsync(htmlWithGrid);
    
    // BUG CONDITION: Output should NOT contain display: grid (but it does on unfixed code)
    // This test will FAIL on unfixed code, confirming the bug exists
    expect(result).not.toMatch(/display:\s*grid/);
    
    // Additional verification: If the bug is fixed, output should contain <table> instead
    if (!result.match(/display:\s*grid/)) {
      expect(result).toMatch(/<table/);
    }
  });

  /**
   * Test 2: Flex Layout Bug
   * **Validates: Requirement 1.2**
   * 
   * EXPECTED: Test FAILS on unfixed code (output contains display: flex)
   * This confirms the bug exists - flex layouts are preserved and will break in Outlook
   */
  test('Flex layout test: HTML with flex CSS → output contains display: flex → will fail in Outlook', async () => {
    const htmlWithFlex = `
      <!DOCTYPE html>
      <html>
        <head>
          <style>
            .flex-row {
              display: flex;
              justify-content: space-between;
              align-items: center;
            }
          </style>
        </head>
        <body>
          <div class="flex-row">
            <span>Left</span>
            <span>Right</span>
          </div>
        </body>
      </html>
    `;

    const result = await inlineHtmlAsync(htmlWithFlex);
    
    // BUG CONDITION: Output should NOT contain display: flex (but it does on unfixed code)
    // This test will FAIL on unfixed code, confirming the bug exists
    expect(result).not.toMatch(/display:\s*flex/);
    
    // Additional verification: If the bug is fixed, output should contain <table> instead
    if (!result.match(/display:\s*flex/)) {
      expect(result).toMatch(/<table/);
    }
  });

  /**
   * Test 3: CSS Variables Bug
   * **Validates: Requirement 1.3**
   * 
   * EXPECTED: Test FAILS on unfixed code (output contains var(--)
   * This confirms the bug exists - CSS variables are preserved and will not render in Outlook
   */
  test('CSS variables test: HTML with CSS variables → output contains var(-- → will fail in Outlook', async () => {
    const htmlWithVars = `
      <!DOCTYPE html>
      <html>
        <head>
          <style>
            :root {
              --card: #f5f5f5;
              --primary: #0078d4;
            }
            .card {
              background-color: var(--card);
              color: var(--primary);
              padding: 20px;
            }
          </style>
        </head>
        <body>
          <div class="card">Content</div>
        </body>
      </html>
    `;

    const result = await inlineHtmlAsync(htmlWithVars);
    
    // BUG CONDITION: Output should NOT contain var(-- (but it does on unfixed code)
    // This test will FAIL on unfixed code, confirming the bug exists
    expect(result).not.toMatch(/var\(--/);
    
    // Additional verification: If the bug is fixed, output should contain resolved color values
    if (!result.match(/var\(--/)) {
      expect(result).toMatch(/#f5f5f5|#0078d4/);
    }
  });

  /**
   * Test 4: Border Radius Bug
   * **Validates: Requirement 1.4**
   * 
   * EXPECTED: Test FAILS on unfixed code (output contains border-radius)
   * This confirms the bug exists - border-radius is preserved and will not render in Outlook desktop
   */
  test('Border radius test: HTML with border-radius → output contains border-radius → will fail in Outlook desktop', async () => {
    const htmlWithBorderRadius = `
      <!DOCTYPE html>
      <html>
        <head>
          <style>
            .rounded {
              border-radius: 8px;
              border: 1px solid #ddd;
              padding: 10px;
            }
          </style>
        </head>
        <body>
          <div class="rounded">Box</div>
        </body>
      </html>
    `;

    const result = await inlineHtmlAsync(htmlWithBorderRadius);
    
    // BUG CONDITION: Output should NOT contain border-radius (but it does on unfixed code)
    // This test will FAIL on unfixed code, confirming the bug exists
    expect(result).not.toMatch(/border-radius/);
  });

  /**
   * Test 5: Box Shadow Bug
   * **Validates: Requirement 1.5**
   * 
   * EXPECTED: Test FAILS on unfixed code (output contains box-shadow)
   * This confirms the bug exists - box-shadow is preserved and will not render in Outlook
   */
  test('Box shadow test: HTML with box-shadow → output contains box-shadow → will fail in Outlook', async () => {
    const htmlWithBoxShadow = `
      <!DOCTYPE html>
      <html>
        <head>
          <style>
            .shadow {
              box-shadow: 0 2px 8px rgba(0,0,0,0.1);
              padding: 20px;
            }
          </style>
        </head>
        <body>
          <div class="shadow">Card</div>
        </body>
      </html>
    `;

    const result = await inlineHtmlAsync(htmlWithBoxShadow);
    
    // BUG CONDITION: Output should NOT contain box-shadow (but it does on unfixed code)
    // This test will FAIL on unfixed code, confirming the bug exists
    expect(result).not.toMatch(/box-shadow/);
  });

  /**
   * Property-Based Test: Mixed Unsupported CSS Properties
   * **Validates: Requirements 1.1, 1.2, 1.3, 1.4, 1.5, 1.6**
   * 
   * This test generates random combinations of unsupported CSS properties
   * and verifies that NONE of them appear in the output after processing.
   * 
   * EXPECTED: Test FAILS on unfixed code (output contains unsupported properties)
   */
  test('Property test: Any HTML with unsupported CSS → output should not contain unsupported properties', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          hasGrid: fc.boolean(),
          hasFlex: fc.boolean(),
          hasVars: fc.boolean(),
          hasBorderRadius: fc.boolean(),
          hasBoxShadow: fc.boolean(),
        }),
        async (config) => {
          // Skip if no unsupported properties are selected
          if (!config.hasGrid && !config.hasFlex && !config.hasVars && !config.hasBorderRadius && !config.hasBoxShadow) {
            return true;
          }

          let cssRules = [];
          
          if (config.hasGrid) {
            cssRules.push('.grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }');
          }
          if (config.hasFlex) {
            cssRules.push('.flex { display: flex; justify-content: space-between; }');
          }
          if (config.hasVars) {
            cssRules.push(':root { --color: #ff0000; } .vars { color: var(--color); }');
          }
          if (config.hasBorderRadius) {
            cssRules.push('.rounded { border-radius: 5px; }');
          }
          if (config.hasBoxShadow) {
            cssRules.push('.shadow { box-shadow: 0 2px 4px rgba(0,0,0,0.1); }');
          }

          const html = `
            <!DOCTYPE html>
            <html>
              <head>
                <style>${cssRules.join('\n')}</style>
              </head>
              <body>
                ${config.hasGrid ? '<div class="grid"><div>A</div><div>B</div></div>' : ''}
                ${config.hasFlex ? '<div class="flex"><span>L</span><span>R</span></div>' : ''}
                ${config.hasVars ? '<div class="vars">Text</div>' : ''}
                ${config.hasBorderRadius ? '<div class="rounded">Box</div>' : ''}
                ${config.hasBoxShadow ? '<div class="shadow">Card</div>' : ''}
              </body>
            </html>
          `;

          const result = await inlineHtmlAsync(html);

          // BUG CONDITION: None of these should appear in the output
          // This will FAIL on unfixed code for any input with unsupported CSS
          const hasUnsupportedCSS = 
            (config.hasGrid && result.match(/display:\s*grid/)) ||
            (config.hasFlex && result.match(/display:\s*flex/)) ||
            (config.hasVars && result.match(/var\(--/)) ||
            (config.hasBorderRadius && result.match(/border-radius/)) ||
            (config.hasBoxShadow && result.match(/box-shadow/));

          // Return false if unsupported CSS is found (this will fail the test on unfixed code)
          return !hasUnsupportedCSS;
        }
      ),
      { numRuns: 20 } // Run 20 random test cases
    );
  });
});
