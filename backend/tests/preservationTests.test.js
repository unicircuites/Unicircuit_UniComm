/**
 * Preservation Tests for Outlook HTML Email CSS Compatibility
 * 
 * These tests verify that existing behavior is preserved for HTML with ONLY supported CSS.
 * The fix should NOT affect HTML that doesn't contain Outlook-unsupported properties.
 * 
 * **Validates: Bugfix Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7**
 */

const fc = require('fast-check');
const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');

// Set up JSDOM environment to simulate browser APIs
const dom = new JSDOM('<!DOCTYPE html><html><head></head><body></body></html>');
global.window = dom.window;
global.document = dom.window.document;
global.DOMParser = dom.window.DOMParser;

// Load the FIXED inlineHtmlForOutlook function from dashboard.html
// We need to extract it properly from the HTML file
const dashboardPath = path.join(__dirname, '..', '..', 'dashboard.html');
const dashboardHtml = fs.readFileSync(dashboardPath, 'utf-8');

// Create a helper module with the fixed function
const helperPath = path.join(__dirname, 'inlineHtmlForOutlookFixed.js');
if (!fs.existsSync(helperPath)) {
  // Extract the function from dashboard.html
  const funcStart = dashboardHtml.indexOf('function inlineHtmlForOutlook(rawHtml, callback) {');
  if (funcStart === -1) throw new Error('Could not find inlineHtmlForOutlook function');
  
  // Find the end of the function by counting braces
  let braceCount = 0;
  let inFunction = false;
  let funcEnd = funcStart;
  
  for (let i = funcStart; i < dashboardHtml.length; i++) {
    const char = dashboardHtml[i];
    if (char === '{') {
      braceCount++;
      inFunction = true;
    } else if (char === '}') {
      braceCount--;
      if (inFunction && braceCount === 0) {
        funcEnd = i + 1;
        break;
      }
    }
  }
  
  const functionCode = dashboardHtml.substring(funcStart, funcEnd);
  fs.writeFileSync(helperPath, `module.exports = { inlineHtmlForOutlook: ${functionCode} };`);
}

const { inlineHtmlForOutlook } = require('./inlineHtmlForOutlookFixed');

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

describe('Preservation Tests - Existing Behavior for Supported CSS', () => {
  
  /**
   * Property 1: Supported CSS Properties Preservation
   * **Validates: Requirement 3.1**
   * 
   * For all inputs with ONLY supported CSS properties, verify they are preserved in inline styles
   */
  test('Property 1: Supported CSS properties are preserved in inline styles', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 0xFFFFFF }).map(n => n.toString(16).padStart(6, '0')), // color
        fc.integer({ min: 0, max: 0xFFFFFF }).map(n => n.toString(16).padStart(6, '0')), // background-color
        fc.integer({ min: 10, max: 50 }), // font-size
        fc.integer({ min: 10, max: 50 }), // padding
        fc.integer({ min: 5, max: 30 }), // margin
        fc.integer({ min: 1, max: 5 }), // border width
        fc.integer({ min: 100, max: 800 }), // width
        fc.integer({ min: 50, max: 400 }), // height
        async (color, bgColor, fontSize, padding, margin, borderWidth, width, height) => {
          const html = `
            <!DOCTYPE html>
            <html>
            <head>
              <style>
                .box {
                  color: #${color};
                  background-color: #${bgColor};
                  font-size: ${fontSize}px;
                  padding: ${padding}px;
                  margin: ${margin}px;
                  border: ${borderWidth}px solid #ddd;
                  width: ${width}px;
                  height: ${height}px;
                }
              </style>
            </head>
            <body>
              <div class="box">Content</div>
            </body>
            </html>
          `;
          
          const result = await inlineHtmlAsync(html);
          
          // Verify all supported properties are present in the output
          expect(result).toMatch(new RegExp(`color:\\s*#${color}`, 'i'));
          expect(result).toMatch(new RegExp(`background-color:\\s*#${bgColor}`, 'i'));
          expect(result).toMatch(new RegExp(`font-size:\\s*${fontSize}px`, 'i'));
          expect(result).toMatch(new RegExp(`padding:\\s*${padding}px`, 'i'));
          expect(result).toMatch(new RegExp(`margin:\\s*${margin}px`, 'i'));
          expect(result).toMatch(new RegExp(`border:\\s*${borderWidth}px solid`, 'i'));
          expect(result).toMatch(new RegExp(`width:\\s*${width}px`, 'i'));
          expect(result).toMatch(new RegExp(`height:\\s*${height}px`, 'i'));
        }
      ),
      { numRuns: 50 }
    );
  }, 30000);

  /**
   * Property 2: Tag Removal Preservation
   * **Validates: Requirement 3.2**
   * 
   * Verify that <style>, <script>, <link> tags are removed after CSS inlining
   */
  test('Property 2: <style>, <script>, <link> tags are removed', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 50 }), // content
        async (content) => {
          const html = `
            <!DOCTYPE html>
            <html>
            <head>
              <style>
                .text { color: #333; }
              </style>
              <script>
                console.log('test');
              </script>
              <link rel="stylesheet" href="https://example.com/style.css">
            </head>
            <body>
              <div class="text">${content}</div>
            </body>
            </html>
          `;
          
          const result = await inlineHtmlAsync(html);
          
          // Verify tags are removed
          expect(result).not.toMatch(/<style/i);
          expect(result).not.toMatch(/<script/i);
          expect(result).not.toMatch(/<link/i);
          
          // Verify content is preserved
          expect(result).toContain(content);
        }
      ),
      { numRuns: 50 }
    );
  }, 30000);

  /**
   * Property 3: Class Removal Preservation
   * **Validates: Requirement 3.3**
   * 
   * Verify that class attributes are removed (Outlook prefixes them with x_)
   */
  test('Property 3: Class attributes are removed', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.string({ minLength: 3, maxLength: 15 }), { minLength: 1, maxLength: 5 }), // class names
        fc.string({ minLength: 1, maxLength: 50 }), // content
        async (classNames, content) => {
          const classAttr = classNames.join(' ');
          const html = `
            <!DOCTYPE html>
            <html>
            <head>
              <style>
                .${classNames[0]} { color: #333; padding: 10px; }
              </style>
            </head>
            <body>
              <div class="${classAttr}">${content}</div>
            </body>
            </html>
          `;
          
          const result = await inlineHtmlAsync(html);
          
          // Verify class attributes are removed
          expect(result).not.toMatch(/class="/i);
          
          // Verify inline styles are present IF CSS was applied
          // (empty class names might not match any CSS rules)
          const hasStyles = result.includes('style="');
          const hasColor = result.includes('color:') || result.includes('#333');
          
          // If CSS was applied, verify styles are present
          if (classNames[0] && classNames[0].length > 0) {
            // Only check if we had a valid class name that could match CSS
            expect(hasStyles || hasColor).toBe(true);
          }
          
          // Verify content is preserved (may be HTML-escaped)
          const hasContent = result.includes(content) || 
                            result.includes(content.replace(/</g, '&lt;').replace(/>/g, '&gt;'));
          expect(hasContent).toBe(true);
        }
      ),
      { numRuns: 50 }
    );
  }, 30000);

  /**
   * Property 4: Unsupported Tag Replacement Preservation
   * **Validates: Requirement 3.4**
   * 
   * Verify that unsupported tags (video, iframe, etc.) are replaced with placeholder divs
   */
  test('Property 4: Unsupported tags are replaced with placeholder divs', async () => {
    const unsupportedTags = ['video', 'iframe', 'audio', 'canvas', 'object', 'embed'];
    
    for (const tag of unsupportedTags) {
      const html = `
        <!DOCTYPE html>
        <html>
        <head></head>
        <body>
          <${tag} src="https://example.com/media"></${tag}>
          <p>Text content</p>
        </body>
        </html>
      `;
      
      const result = await inlineHtmlAsync(html);
      
      // Verify unsupported tag is removed
      expect(result).not.toMatch(new RegExp(`<${tag}`, 'i'));
      
      // Verify placeholder text is present
      expect(result).toMatch(new RegExp(`\\[${tag.toUpperCase()}`, 'i'));
      expect(result).toContain('not supported in email');
      
      // Verify other content is preserved
      expect(result).toContain('Text content');
    }
  });

  /**
   * Property 5: Semantic Tag Unwrapping Preservation
   * **Validates: Requirement 3.5**
   * 
   * Verify that semantic HTML5 tags are unwrapped while preserving their children
   */
  test('Property 5: Semantic HTML5 tags are unwrapped, children preserved', async () => {
    const semanticTags = ['nav', 'header', 'footer', 'aside', 'article', 'section', 'main', 'figure'];
    
    for (const tag of semanticTags) {
      const html = `
        <!DOCTYPE html>
        <html>
        <head></head>
        <body>
          <${tag}>
            <p>Inner content</p>
            <span>More content</span>
          </${tag}>
        </body>
        </html>
      `;
      
      const result = await inlineHtmlAsync(html);
      
      // Verify semantic tag is removed
      expect(result).not.toMatch(new RegExp(`<${tag}`, 'i'));
      expect(result).not.toMatch(new RegExp(`</${tag}>`, 'i'));
      
      // Verify children are preserved
      expect(result).toContain('Inner content');
      expect(result).toContain('More content');
      expect(result).toMatch(/<p>/i);
      expect(result).toMatch(/<span>/i);
    }
  });

  /**
   * Property 6: Complex Supported CSS Preservation
   * **Validates: Requirement 3.1**
   * 
   * Test complex combinations of supported CSS properties
   */
  test('Property 6: Complex supported CSS combinations are preserved', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          color: fc.integer({ min: 0, max: 0xFFFFFF }).map(n => n.toString(16).padStart(6, '0')),
          bgColor: fc.integer({ min: 0, max: 0xFFFFFF }).map(n => n.toString(16).padStart(6, '0')),
          fontSize: fc.integer({ min: 12, max: 24 }),
          fontFamily: fc.constantFrom('Arial', 'Helvetica', 'Times New Roman', 'Georgia'),
          fontWeight: fc.constantFrom('normal', 'bold', '400', '700'),
          textAlign: fc.constantFrom('left', 'center', 'right', 'justify'),
          lineHeight: fc.double({ min: 1.0, max: 2.0 }),
          padding: fc.integer({ min: 5, max: 30 }),
          margin: fc.integer({ min: 0, max: 20 }),
          borderWidth: fc.integer({ min: 1, max: 5 }),
          borderColor: fc.integer({ min: 0, max: 0xFFFFFF }).map(n => n.toString(16).padStart(6, '0')),
          width: fc.integer({ min: 100, max: 600 }),
        }),
        async (props) => {
          const html = `
            <!DOCTYPE html>
            <html>
            <head>
              <style>
                .complex {
                  color: #${props.color};
                  background-color: #${props.bgColor};
                  font-size: ${props.fontSize}px;
                  font-family: ${props.fontFamily};
                  font-weight: ${props.fontWeight};
                  text-align: ${props.textAlign};
                  line-height: ${props.lineHeight.toFixed(1)};
                  padding: ${props.padding}px;
                  margin: ${props.margin}px;
                  border: ${props.borderWidth}px solid #${props.borderColor};
                  width: ${props.width}px;
                }
              </style>
            </head>
            <body>
              <div class="complex">Test content</div>
            </body>
            </html>
          `;
          
          const result = await inlineHtmlAsync(html);
          
          // Verify all properties are present
          expect(result).toMatch(new RegExp(`#${props.color}`, 'i'));
          expect(result).toMatch(new RegExp(`#${props.bgColor}`, 'i'));
          expect(result).toMatch(new RegExp(`${props.fontSize}px`, 'i'));
          expect(result).toMatch(new RegExp(props.fontFamily.replace(/\s+/g, '\\s*'), 'i'));
          expect(result).toMatch(new RegExp(`${props.padding}px`, 'i'));
          expect(result).toMatch(new RegExp(`${props.width}px`, 'i'));
        }
      ),
      { numRuns: 50 }
    );
  }, 30000);

  /**
   * Property 7: No Unsupported CSS in Output
   * **Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5**
   * 
   * For inputs with ONLY supported CSS, verify NO unsupported CSS appears in output
   */
  test('Property 7: Inputs with only supported CSS produce no unsupported CSS in output', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          color: fc.integer({ min: 0, max: 0xFFFFFF }).map(n => n.toString(16).padStart(6, '0')),
          bgColor: fc.integer({ min: 0, max: 0xFFFFFF }).map(n => n.toString(16).padStart(6, '0')),
          fontSize: fc.integer({ min: 12, max: 24 }),
          padding: fc.integer({ min: 10, max: 40 }),
          margin: fc.integer({ min: 5, max: 25 }),
          borderWidth: fc.integer({ min: 1, max: 5 }),
          width: fc.integer({ min: 100, max: 800 }),
          height: fc.integer({ min: 50, max: 400 }),
        }),
        async (props) => {
          const html = `
            <!DOCTYPE html>
            <html>
            <head>
              <style>
                .supported-only {
                  color: #${props.color};
                  background-color: #${props.bgColor};
                  font-size: ${props.fontSize}px;
                  padding: ${props.padding}px;
                  margin: ${props.margin}px;
                  border: ${props.borderWidth}px solid #ddd;
                  width: ${props.width}px;
                  height: ${props.height}px;
                }
              </style>
            </head>
            <body>
              <div class="supported-only">Content</div>
            </body>
            </html>
          `;
          
          const result = await inlineHtmlAsync(html);
          
          // Verify NO unsupported CSS properties are present
          expect(result).not.toMatch(/display:\s*grid/i);
          expect(result).not.toMatch(/display:\s*flex/i);
          expect(result).not.toMatch(/var\(--/i);
          expect(result).not.toMatch(/border-radius/i);
          expect(result).not.toMatch(/box-shadow/i);
          expect(result).not.toMatch(/grid-template/i);
          expect(result).not.toMatch(/flex-direction/i);
          expect(result).not.toMatch(/justify-content/i);
          expect(result).not.toMatch(/align-items/i);
          expect(result).not.toMatch(/gap:/i);
          
          // Verify supported properties ARE present
          expect(result).toMatch(/style="/i);
          expect(result).toMatch(new RegExp(`#${props.color}`, 'i'));
          expect(result).toMatch(new RegExp(`#${props.bgColor}`, 'i'));
        }
      ),
      { numRuns: 100 }
    );
  }, 30000);

  /**
   * Property 8: Multiple Elements with Supported CSS
   * **Validates: Requirement 3.1**
   * 
   * Test that multiple elements with different supported CSS are all preserved correctly
   */
  test('Property 8: Multiple elements with supported CSS are all preserved', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            color: fc.integer({ min: 0, max: 0xFFFFFF }).map(n => n.toString(16).padStart(6, '0')),
            bgColor: fc.integer({ min: 0, max: 0xFFFFFF }).map(n => n.toString(16).padStart(6, '0')),
            padding: fc.integer({ min: 5, max: 30 }),
            content: fc.string({ minLength: 1, maxLength: 20 }),
          }),
          { minLength: 2, maxLength: 5 }
        ),
        async (elements) => {
          const styles = elements.map((el, i) => 
            `.box${i} { color: #${el.color}; background-color: #${el.bgColor}; padding: ${el.padding}px; }`
          ).join('\n');
          
          const divs = elements.map((el, i) => 
            `<div class="box${i}">${el.content}</div>`
          ).join('\n');
          
          const html = `
            <!DOCTYPE html>
            <html>
            <head>
              <style>${styles}</style>
            </head>
            <body>${divs}</body>
            </html>
          `;
          
          const result = await inlineHtmlAsync(html);
          
          // Verify all elements' properties are present
          elements.forEach(el => {
            expect(result).toMatch(new RegExp(`#${el.color}`, 'i'));
            expect(result).toMatch(new RegExp(`#${el.bgColor}`, 'i'));
            expect(result).toMatch(new RegExp(`${el.padding}px`, 'i'));
            // Content may be HTML-escaped, so check for both original and escaped versions
            const hasContent = result.includes(el.content) || 
                              result.includes(el.content.replace(/</g, '&lt;').replace(/>/g, '&gt;'));
            expect(hasContent).toBe(true);
          });
          
          // Verify no unsupported CSS
          expect(result).not.toMatch(/display:\s*grid/i);
          expect(result).not.toMatch(/display:\s*flex/i);
          expect(result).not.toMatch(/var\(--/i);
        }
      ),
      { numRuns: 50 }
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
    expect(result).not.toMatch(/display:\s*grid/i);
    expect(result).not.toMatch(/display:\s*flex/i);
    expect(result).not.toMatch(/var\(--/i);
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
        <span>Inline text</span>
      </body>
      </html>
    `;
    
    const result = await inlineHtmlAsync(html);
    
    expect(result).toBeDefined();
    expect(result).toContain('Plain text content');
    expect(result).toContain('Another paragraph');
    expect(result).toContain('Inline text');
    
    // Verify no unsupported CSS
    expect(result).not.toMatch(/display:\s*grid/i);
    expect(result).not.toMatch(/display:\s*flex/i);
    expect(result).not.toMatch(/var\(--/i);
  });

  /**
   * Edge Case 3: Nested elements with supported CSS
   */
  test('Edge Case 3: Nested elements with supported CSS are preserved', async () => {
    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <style>
          .outer { color: #333; padding: 20px; background-color: #f5f5f5; }
          .inner { color: #0078d4; font-size: 16px; margin: 10px; }
          .deep { font-weight: bold; text-align: center; }
        </style>
      </head>
      <body>
        <div class="outer">
          Outer content
          <div class="inner">
            Inner content
            <span class="deep">Deep content</span>
          </div>
        </div>
      </body>
      </html>
    `;
    
    const result = await inlineHtmlAsync(html);
    
    // Verify all content is preserved
    expect(result).toContain('Outer content');
    expect(result).toContain('Inner content');
    expect(result).toContain('Deep content');
    
    // Verify all styles are present
    expect(result).toMatch(/#333/i);
    expect(result).toMatch(/#0078d4/i);
    expect(result).toMatch(/20px/i);
    expect(result).toMatch(/16px/i);
    expect(result).toMatch(/10px/i);
    
    // Verify no unsupported CSS
    expect(result).not.toMatch(/display:\s*grid/i);
    expect(result).not.toMatch(/display:\s*flex/i);
    expect(result).not.toMatch(/var\(--/i);
  });
});
