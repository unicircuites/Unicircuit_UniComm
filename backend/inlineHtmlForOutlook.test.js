/**
 * Property-Based Tests for Outlook HTML Email CSS Compatibility Fix
 * 
 * Tests verify that the inlineHtmlForOutlook() function correctly transforms
 * Outlook-unsupported CSS properties into compatible alternatives.
 * 
 * **Validates: Requirements 2.1, 2.2, 2.3, 2.4, 2.5, 2.6**
 */

const fc = require('fast-check');
const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');

// Load the dashboard.html file and extract the inlineHtmlForOutlook function
const dashboardHtmlPath = path.join(__dirname, '..', 'dashboard.html');
const dashboardHtml = fs.readFileSync(dashboardHtmlPath, 'utf-8');

// Extract the inlineHtmlForOutlook function from dashboard.html
// We need to create a DOM environment and execute the function definition
let inlineHtmlForOutlook;

beforeAll(() => {
  // Create a JSDOM instance with the dashboard.html content
  const dom = new JSDOM(dashboardHtml, {
    runScripts: 'dangerously',
    resources: 'usable',
    url: 'http://localhost'
  });
  
  // Wait for scripts to load
  return new Promise((resolve) => {
    dom.window.addEventListener('load', () => {
      // Extract the function from the window object
      inlineHtmlForOutlook = dom.window.inlineHtmlForOutlook;
      resolve();
    });
    
    // Fallback: if load event doesn't fire, resolve after a short delay
    setTimeout(() => {
      inlineHtmlForOutlook = dom.window.inlineHtmlForOutlook;
      resolve();
    }, 1000);
  });
});

/**
 * Helper function to wrap inlineHtmlForOutlook in a Promise
 */
function inlineHtmlAsync(html) {
  return new Promise((resolve) => {
    inlineHtmlForOutlook(html, (result) => {
      resolve(result);
    });
  });
}

/**
 * Bug Condition Checker
 * Returns true if HTML contains Outlook-unsupported CSS properties
 */
function isBugCondition(html) {
  return /display:\s*grid/i.test(html) ||
         /display:\s*flex/i.test(html) ||
         /var\(--/.test(html) ||
         /border-radius/.test(html) ||
         /box-shadow/.test(html);
}

describe('Outlook HTML Email CSS Compatibility - Property-Based Tests', () => {
  
  describe('Property 1: Bug Condition - Outlook-Unsupported CSS Transformation', () => {
    
    test('Grid layouts are converted to tables', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 1, max: 4 }), // number of columns
          fc.integer({ min: 1, max: 6 }), // number of items
          fc.integer({ min: 0, max: 40 }), // gap in pixels
          async (cols, items, gap) => {
            // Generate HTML with display: grid
            const gridItems = Array.from({ length: items }, (_, i) => 
              `<div>Item ${i + 1}</div>`
            ).join('');
            
            const html = `
              <html>
                <head>
                  <style>
                    .grid-container {
                      display: grid;
                      grid-template-columns: repeat(${cols}, 1fr);
                      gap: ${gap}px;
                      background-color: #f5f5f5;
                      padding: 20px;
                    }
                  </style>
                </head>
                <body>
                  <div class="grid-container">${gridItems}</div>
                </body>
              </html>
            `;
            
            const result = await inlineHtmlAsync(html);
            
            // Verify: output does NOT contain display: grid
            expect(result).not.toMatch(/display:\s*grid/i);
            
            // Verify: output contains <table> elements (grid converted)
            expect(result).toMatch(/<table/i);
            
            // Verify: no grid-related properties remain
            expect(result).not.toMatch(/grid-template-columns/i);
            expect(result).not.toMatch(/grid-column/i);
          }
        ),
        { numRuns: 50 }
      );
    });
    
    test('Flex layouts are converted to tables', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.constantFrom('row', 'column'), // flex-direction
          fc.constantFrom('flex-start', 'center', 'flex-end', 'space-between'), // justify-content
          fc.constantFrom('flex-start', 'center', 'flex-end'), // align-items
          fc.integer({ min: 2, max: 5 }), // number of items
          fc.integer({ min: 0, max: 30 }), // gap in pixels
          async (direction, justify, align, items, gap) => {
            // Generate HTML with display: flex
            const flexItems = Array.from({ length: items }, (_, i) => 
              `<span>Item ${i + 1}</span>`
            ).join('');
            
            const html = `
              <html>
                <head>
                  <style>
                    .flex-container {
                      display: flex;
                      flex-direction: ${direction};
                      justify-content: ${justify};
                      align-items: ${align};
                      gap: ${gap}px;
                      background-color: #ffffff;
                    }
                  </style>
                </head>
                <body>
                  <div class="flex-container">${flexItems}</div>
                </body>
              </html>
            `;
            
            const result = await inlineHtmlAsync(html);
            
            // Verify: output does NOT contain display: flex
            expect(result).not.toMatch(/display:\s*flex/i);
            
            // Verify: output contains <table> elements (flex converted)
            expect(result).toMatch(/<table/i);
            
            // Verify: no flex-related properties remain
            expect(result).not.toMatch(/flex-direction/i);
            expect(result).not.toMatch(/justify-content/i);
            expect(result).not.toMatch(/align-items/i);
          }
        ),
        { numRuns: 50 }
      );
    });
    
    test('CSS variables are resolved to actual color values', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.hexaString({ minLength: 6, maxLength: 6 }), // background color
          fc.hexaString({ minLength: 6, maxLength: 6 }), // text color
          fc.hexaString({ minLength: 6, maxLength: 6 }), // border color
          async (bgColor, textColor, borderColor) => {
            const html = `
              <html>
                <head>
                  <style>
                    :root {
                      --bg: #${bgColor};
                      --text: #${textColor};
                      --border: #${borderColor};
                    }
                    .card {
                      background-color: var(--bg);
                      color: var(--text);
                      border: 1px solid var(--border);
                      padding: 20px;
                    }
                  </style>
                </head>
                <body>
                  <div class="card">Content</div>
                </body>
              </html>
            `;
            
            const result = await inlineHtmlAsync(html);
            
            // Verify: output does NOT contain var(--
            expect(result).not.toMatch(/var\(--/);
            
            // Verify: output contains resolved color values
            expect(result).toMatch(/#[0-9a-fA-F]{6}/);
            
            // Verify: the specific colors are present (case-insensitive)
            const resultLower = result.toLowerCase();
            expect(
              resultLower.includes(bgColor.toLowerCase()) ||
              resultLower.includes(textColor.toLowerCase()) ||
              resultLower.includes(borderColor.toLowerCase())
            ).toBe(true);
          }
        ),
        { numRuns: 50 }
      );
    });
    
    test('Border-radius properties are removed', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 0, max: 50 }), // border-radius value
          async (radius) => {
            const html = `
              <html>
                <head>
                  <style>
                    .rounded {
                      border-radius: ${radius}px;
                      border: 1px solid #ddd;
                      padding: 10px;
                      background-color: #f5f5f5;
                    }
                  </style>
                </head>
                <body>
                  <div class="rounded">Box</div>
                </body>
              </html>
            `;
            
            const result = await inlineHtmlAsync(html);
            
            // Verify: output does NOT contain border-radius
            expect(result).not.toMatch(/border-radius/i);
            
            // Verify: other supported properties are preserved
            expect(result).toMatch(/border:/i);
            expect(result).toMatch(/padding:/i);
            expect(result).toMatch(/background-color:/i);
          }
        ),
        { numRuns: 30 }
      );
    });
    
    test('Box-shadow properties are removed', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 0, max: 10 }), // x offset
          fc.integer({ min: 0, max: 10 }), // y offset
          fc.integer({ min: 0, max: 20 }), // blur radius
          fc.float({ min: 0, max: 1 }), // opacity
          async (x, y, blur, opacity) => {
            const html = `
              <html>
                <head>
                  <style>
                    .shadow {
                      box-shadow: ${x}px ${y}px ${blur}px rgba(0,0,0,${opacity.toFixed(2)});
                      padding: 20px;
                      background-color: #ffffff;
                    }
                  </style>
                </head>
                <body>
                  <div class="shadow">Card</div>
                </body>
              </html>
            `;
            
            const result = await inlineHtmlAsync(html);
            
            // Verify: output does NOT contain box-shadow
            expect(result).not.toMatch(/box-shadow/i);
            expect(result).not.toMatch(/-webkit-box-shadow/i);
            expect(result).not.toMatch(/-moz-box-shadow/i);
            
            // Verify: other supported properties are preserved
            expect(result).toMatch(/padding:/i);
            expect(result).toMatch(/background-color:/i);
          }
        ),
        { numRuns: 30 }
      );
    });
    
    test('Mixed unsupported CSS properties are all transformed', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.hexaString({ minLength: 6, maxLength: 6 }), // CSS variable color
          fc.integer({ min: 1, max: 3 }), // grid columns
          fc.integer({ min: 5, max: 20 }), // border-radius
          async (color, cols, radius) => {
            const html = `
              <html>
                <head>
                  <style>
                    :root {
                      --primary: #${color};
                    }
                    .container {
                      display: grid;
                      grid-template-columns: repeat(${cols}, 1fr);
                      gap: 20px;
                      background-color: var(--primary);
                      border-radius: ${radius}px;
                      box-shadow: 0 2px 8px rgba(0,0,0,0.1);
                      padding: 30px;
                    }
                  </style>
                </head>
                <body>
                  <div class="container">
                    <div>Item 1</div>
                    <div>Item 2</div>
                    <div>Item 3</div>
                  </div>
                </body>
              </html>
            `;
            
            const result = await inlineHtmlAsync(html);
            
            // Verify: ALL unsupported properties are removed/transformed
            expect(result).not.toMatch(/display:\s*grid/i);
            expect(result).not.toMatch(/var\(--/);
            expect(result).not.toMatch(/border-radius/i);
            expect(result).not.toMatch(/box-shadow/i);
            
            // Verify: grid converted to table
            expect(result).toMatch(/<table/i);
            
            // Verify: supported properties preserved
            expect(result).toMatch(/padding:/i);
          }
        ),
        { numRuns: 40 }
      );
    });
  });
  
  describe('Edge Cases', () => {
    
    test('Empty HTML is handled gracefully', async () => {
      const html = '<html><head></head><body></body></html>';
      const result = await inlineHtmlAsync(html);
      
      expect(result).toBeDefined();
      expect(typeof result).toBe('string');
    });
    
    test('HTML without CSS is unchanged', async () => {
      const html = `
        <html>
          <head></head>
          <body>
            <div>Plain text content</div>
            <p>No CSS here</p>
          </body>
        </html>
      `;
      
      const result = await inlineHtmlAsync(html);
      
      expect(result).toContain('Plain text content');
      expect(result).toContain('No CSS here');
      expect(result).not.toMatch(/display:\s*grid/i);
      expect(result).not.toMatch(/display:\s*flex/i);
    });
    
    test('HTML with only supported CSS preserves properties', async () => {
      const html = `
        <html>
          <head>
            <style>
              .box {
                color: #333;
                background-color: #fff;
                padding: 20px;
                margin: 10px;
                border: 1px solid #ddd;
                font-size: 14px;
                font-family: Arial, sans-serif;
              }
            </style>
          </head>
          <body>
            <div class="box">Content</div>
          </body>
        </html>
      `;
      
      const result = await inlineHtmlAsync(html);
      
      // Verify: supported properties are present
      expect(result).toMatch(/color:/i);
      expect(result).toMatch(/background-color:/i);
      expect(result).toMatch(/padding:/i);
      expect(result).toMatch(/border:/i);
      expect(result).toMatch(/font-size:/i);
      
      // Verify: no unsupported properties
      expect(result).not.toMatch(/display:\s*grid/i);
      expect(result).not.toMatch(/display:\s*flex/i);
      expect(result).not.toMatch(/var\(--/);
    });
    
    test('Nested grid and flex layouts are both converted', async () => {
      const html = `
        <html>
          <head>
            <style>
              .outer-grid {
                display: grid;
                grid-template-columns: 1fr 1fr;
                gap: 20px;
              }
              .inner-flex {
                display: flex;
                justify-content: space-between;
                align-items: center;
              }
            </style>
          </head>
          <body>
            <div class="outer-grid">
              <div class="inner-flex">
                <span>Left</span>
                <span>Right</span>
              </div>
              <div>Other content</div>
            </div>
          </body>
        </html>
      `;
      
      const result = await inlineHtmlAsync(html);
      
      // Verify: both grid and flex are removed
      expect(result).not.toMatch(/display:\s*grid/i);
      expect(result).not.toMatch(/display:\s*flex/i);
      
      // Verify: tables are present (both converted)
      const tableMatches = result.match(/<table/gi);
      expect(tableMatches).toBeTruthy();
      expect(tableMatches.length).toBeGreaterThanOrEqual(1);
    });
    
    test('Multiple CSS variables in same element are all resolved', async () => {
      const html = `
        <html>
          <head>
            <style>
              :root {
                --bg: #f5f5f5;
                --text: #333333;
                --border: #dddddd;
                --accent: #0078d4;
              }
              .multi-var {
                background-color: var(--bg);
                color: var(--text);
                border: 2px solid var(--border);
                outline: 1px solid var(--accent);
              }
            </style>
          </head>
          <body>
            <div class="multi-var">Content</div>
          </body>
        </html>
      `;
      
      const result = await inlineHtmlAsync(html);
      
      // Verify: no CSS variables remain
      expect(result).not.toMatch(/var\(--/);
      
      // Verify: color values are present
      expect(result).toMatch(/#[0-9a-fA-F]{6}/);
    });
  });
});
