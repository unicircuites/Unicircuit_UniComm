/**
 * Property-Based Tests for Outlook CSS Compatibility Fix
 * 
 * Tests verify that inlineHtmlForOutlook() correctly transforms unsupported CSS
 * properties into Outlook-compatible alternatives.
 * 
 * **Validates: Requirements 2.1, 2.2, 2.3, 2.4, 2.5, 2.6**
 */

const fc = require('fast-check');
const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');

// Load dashboard.html and extract the inlineHtmlForOutlook function
const dashboardPath = path.join(__dirname, '..', '..', 'dashboard.html');
const dashboardHtml = fs.readFileSync(dashboardPath, 'utf-8');

// Create a JSDOM environment with the dashboard HTML
let dom;
let inlineHtmlForOutlook;

beforeAll(() => {
  dom = new JSDOM(dashboardHtml, {
    runScripts: 'dangerously',
    resources: 'usable',
    url: 'http://localhost'
  });
  
  // Wait for scripts to load
  return new Promise((resolve) => {
    dom.window.addEventListener('load', () => {
      // Extract the function from the window
      inlineHtmlForOutlook = dom.window.inlineHtmlForOutlook;
      resolve();
    });
    
    // Fallback if load event doesn't fire
    setTimeout(() => {
      inlineHtmlForOutlook = dom.window.inlineHtmlForOutlook;
      resolve();
    }, 1000);
  });
});

// Helper to promisify the callback-based function
function inlineHtmlAsync(html) {
  return new Promise((resolve, reject) => {
    if (!inlineHtmlForOutlook) {
      reject(new Error('inlineHtmlForOutlook function not found'));
      return;
    }
    
    try {
      inlineHtmlForOutlook(html, (result) => {
        resolve(result);
      });
    } catch (err) {
      reject(err);
    }
  });
}

describe('Outlook CSS Compatibility - Fix Verification', () => {
  
  /**
   * Property 1: Grid Layout Transformation
   * For all inputs with display:grid, verify output does NOT contain display:grid
   * and DOES contain <table> elements
   */
  test('Property 1: Grid layouts are converted to tables', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 4 }), // number of columns
        fc.integer({ min: 0, max: 40 }), // gap in pixels
        fc.array(fc.string({ minLength: 1, maxLength: 20 }), { minLength: 1, maxLength: 8 }), // grid items
        async (cols, gap, items) => {
          const html = `
            <!DOCTYPE html>
            <html>
            <head>
              <style>
                .grid-container {
                  display: grid;
                  grid-template-columns: repeat(${cols}, 1fr);
                  gap: ${gap}px;
                }
              </style>
            </head>
            <body>
              <div class="grid-container">
                ${items.map(item => `<div>${item}</div>`).join('')}
              </div>
            </body>
            </html>
          `;
          
          const result = await inlineHtmlAsync(html);
          
          // Verify display:grid is removed
          expect(result).not.toMatch(/display:\s*grid/i);
          
          // Verify table elements are present
          expect(result).toMatch(/<table/i);
          expect(result).toMatch(/<tbody/i);
          expect(result).toMatch(/<tr/i);
          expect(result).toMatch(/<td/i);
        }
      ),
      { numRuns: 100 }
    );
  }, 30000);

  /**
   * Property 2: Flex Layout Transformation
   * For all inputs with display:flex, verify output does NOT contain display:flex
   * and DOES contain <table> elements
   */
  test('Property 2: Flex layouts are converted to tables', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom('row', 'column'), // flex-direction
        fc.integer({ min: 0, max: 40 }), // gap in pixels
        fc.array(fc.string({ minLength: 1, maxLength: 20 }), { minLength: 1, maxLength: 6 }), // flex items
        async (direction, gap, items) => {
          const html = `
            <!DOCTYPE html>
            <html>
            <head>
              <style>
                .flex-container {
                  display: flex;
                  flex-direction: ${direction};
                  gap: ${gap}px;
                }
              </style>
            </head>
            <body>
              <div class="flex-container">
                ${items.map(item => `<div>${item}</div>`).join('')}
              </div>
            </body>
            </html>
          `;
          
          const result = await inlineHtmlAsync(html);
          
          // Verify display:flex is removed
          expect(result).not.toMatch(/display:\s*flex/i);
          
          // Verify table elements are present
          expect(result).toMatch(/<table/i);
          expect(result).toMatch(/<tbody/i);
          expect(result).toMatch(/<tr/i);
          expect(result).toMatch(/<td/i);
        }
      ),
      { numRuns: 100 }
    );
  }, 30000);

  /**
   * Property 3: CSS Variables Resolution
   * For all inputs with CSS variables, verify output does NOT contain var(--
   * and DOES contain resolved color values
   */
  test('Property 3: CSS variables are resolved to actual values', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.hexaString({ minLength: 6, maxLength: 6 }), // background color
        fc.hexaString({ minLength: 6, maxLength: 6 }), // text color
        fc.string({ minLength: 1, maxLength: 50 }), // content
        async (bgColor, textColor, content) => {
          const html = `
            <!DOCTYPE html>
            <html>
            <head>
              <style>
                :root {
                  --bg: #${bgColor};
                  --text: #${textColor};
                }
                .card {
                  background-color: var(--bg);
                  color: var(--text);
                }
              </style>
            </head>
            <body>
              <div class="card">${content}</div>
            </body>
            </html>
          `;
          
          const result = await inlineHtmlAsync(html);
          
          // Verify CSS variables are removed
          expect(result).not.toMatch(/var\(--/i);
          
          // Verify resolved colors are present (either the exact color or 'inherit')
          // The function should have resolved the variables or replaced with inherit
          const hasResolvedBg = result.includes(`#${bgColor}`) || result.includes('inherit');
          const hasResolvedText = result.includes(`#${textColor}`) || result.includes('inherit');
          
          expect(hasResolvedBg || hasResolvedText).toBe(true);
        }
      ),
      { numRuns: 100 }
    );
  }, 30000);

  /**
   * Property 4: Unsupported Properties Removal
   * For all inputs with border-radius and box-shadow, verify output does NOT contain them
   */
  test('Property 4: Unsupported properties (border-radius, box-shadow) are removed', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 50 }), // border-radius in pixels
        fc.integer({ min: 0, max: 20 }), // box-shadow blur
        fc.string({ minLength: 1, maxLength: 50 }), // content
        async (radius, blur, content) => {
          const html = `
            <!DOCTYPE html>
            <html>
            <head>
              <style>
                .box {
                  border-radius: ${radius}px;
                  box-shadow: 0 2px ${blur}px rgba(0,0,0,0.1);
                  padding: 20px;
                  border: 1px solid #ddd;
                }
              </style>
            </head>
            <body>
              <div class="box">${content}</div>
            </body>
            </html>
          `;
          
          const result = await inlineHtmlAsync(html);
          
          // Verify unsupported properties are removed
          expect(result).not.toMatch(/border-radius/i);
          expect(result).not.toMatch(/box-shadow/i);
          
          // Verify supported properties are preserved
          expect(result).toMatch(/padding/i);
          expect(result).toMatch(/border/i);
        }
      ),
      { numRuns: 100 }
    );
  }, 30000);

  /**
   * Property 5: Mixed Supported and Unsupported CSS
   * For all inputs with both supported and unsupported CSS, verify:
   * - Unsupported properties are removed/transformed
   * - Supported properties are preserved
   */
  test('Property 5: Mixed CSS - unsupported removed, supported preserved', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.hexaString({ minLength: 6, maxLength: 6 }), // color
        fc.integer({ min: 10, max: 50 }), // padding
        fc.integer({ min: 10, max: 30 }), // font-size
        async (color, padding, fontSize) => {
          const html = `
            <!DOCTYPE html>
            <html>
            <head>
              <style>
                .mixed {
                  color: #${color};
                  padding: ${padding}px;
                  font-size: ${fontSize}px;
                  display: flex;
                  border-radius: 8px;
                  box-shadow: 0 2px 4px rgba(0,0,0,0.1);
                }
              </style>
            </head>
            <body>
              <div class="mixed">Content</div>
            </body>
            </html>
          `;
          
          const result = await inlineHtmlAsync(html);
          
          // Verify unsupported properties are removed
          expect(result).not.toMatch(/display:\s*flex/i);
          expect(result).not.toMatch(/border-radius/i);
          expect(result).not.toMatch(/box-shadow/i);
          
          // Verify supported properties are preserved
          expect(result).toMatch(new RegExp(`#${color}`, 'i'));
          expect(result).toMatch(new RegExp(`${padding}px`, 'i'));
          expect(result).toMatch(new RegExp(`${fontSize}px`, 'i'));
        }
      ),
      { numRuns: 100 }
    );
  }, 30000);

  /**
   * Edge Case 1: Empty HTML
   */
  test('Edge Case 1: Empty HTML is handled gracefully', async () => {
    const html = '<!DOCTYPE html><html><head></head><body></body></html>';
    const result = await inlineHtmlAsync(html);
    
    expect(result).toBeDefined();
    expect(typeof result).toBe('string');
  });

  /**
   * Edge Case 2: HTML without CSS
   */
  test('Edge Case 2: HTML without CSS is unchanged', async () => {
    const html = `
      <!DOCTYPE html>
      <html>
      <head></head>
      <body>
        <div>Plain text content</div>
        <p>Another paragraph</p>
      </body>
      </html>
    `;
    
    const result = await inlineHtmlAsync(html);
    
    expect(result).toBeDefined();
    expect(result).toContain('Plain text content');
    expect(result).toContain('Another paragraph');
  });

  /**
   * Edge Case 3: HTML with only supported CSS
   */
  test('Edge Case 3: HTML with only supported CSS preserves styles', async () => {
    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <style>
          .supported {
            color: #333;
            background-color: #fff;
            padding: 20px;
            margin: 10px;
            border: 1px solid #ddd;
            font-size: 16px;
          }
        </style>
      </head>
      <body>
        <div class="supported">Content</div>
      </body>
      </html>
    `;
    
    const result = await inlineHtmlAsync(html);
    
    // Verify supported properties are present
    expect(result).toMatch(/color:\s*#333/i);
    expect(result).toMatch(/background-color:\s*#fff/i);
    expect(result).toMatch(/padding:\s*20px/i);
    expect(result).toMatch(/margin:\s*10px/i);
    expect(result).toMatch(/border:\s*1px solid #ddd/i);
    expect(result).toMatch(/font-size:\s*16px/i);
  });

  /**
   * Edge Case 4: Complex nested grid layout
   */
  test('Edge Case 4: Nested grid layouts are converted', async () => {
    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <style>
          .outer-grid {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 20px;
          }
          .inner-grid {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 10px;
          }
        </style>
      </head>
      <body>
        <div class="outer-grid">
          <div class="inner-grid">
            <div>A</div>
            <div>B</div>
          </div>
          <div>C</div>
        </div>
      </body>
      </html>
    `;
    
    const result = await inlineHtmlAsync(html);
    
    // Verify all grid layouts are converted
    expect(result).not.toMatch(/display:\s*grid/i);
    expect(result).toMatch(/<table/i);
  });

  /**
   * Edge Case 5: Multiple CSS variable definitions
   */
  test('Edge Case 5: Multiple CSS variables are all resolved', async () => {
    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <style>
          :root {
            --primary: #0078d4;
            --secondary: #f5f5f5;
            --text: #333;
            --border: #ddd;
          }
          .card {
            background-color: var(--secondary);
            color: var(--text);
            border: 1px solid var(--border);
          }
          .button {
            background-color: var(--primary);
            color: white;
          }
        </style>
      </head>
      <body>
        <div class="card">
          <div class="button">Click me</div>
        </div>
      </body>
      </html>
    `;
    
    const result = await inlineHtmlAsync(html);
    
    // Verify no CSS variables remain
    expect(result).not.toMatch(/var\(--/i);
    
    // Verify at least some resolved colors are present
    const hasResolvedColors = 
      result.includes('#0078d4') || 
      result.includes('#f5f5f5') || 
      result.includes('#333') || 
      result.includes('#ddd') ||
      result.includes('inherit');
    
    expect(hasResolvedColors).toBe(true);
  });
});
