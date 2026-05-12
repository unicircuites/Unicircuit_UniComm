module.exports = { inlineHtmlForOutlook: function inlineHtmlForOutlook(rawHtml, callback) {
  console.group('[EMAIL-INLINE] Starting CSS inlining for Outlook');
  console.log('[EMAIL-INLINE] Raw HTML length:', rawHtml.length);

  try {
    // Parse the HTML document
    var parser = new DOMParser();
    var doc = parser.parseFromString(rawHtml, 'text/html');

    // Collect all CSS text from <style> blocks
    var allCssText = '';
    doc.querySelectorAll('style').forEach(function(s) {
      allCssText += s.textContent + '\n';
    });
    console.log('[EMAIL-INLINE] Total CSS text length:', allCssText.length);

    // Parse CSS rules using a temporary <style> element injected into the main document
    // This lets us use the browser's own CSS parser (CSSStyleSheet API)
    var tempStyle = document.createElement('style');
    tempStyle.textContent = allCssText;
    document.head.appendChild(tempStyle);

    var rules = [];
    try {
      var sheet = tempStyle.sheet;
      if (sheet) {
        for (var i = 0; i < sheet.cssRules.length; i++) {
          var rule = sheet.cssRules[i];
          // Only process CSSStyleRule (type 1) — skip @media, @keyframes etc
          if (rule.type === 1 && rule.selectorText && rule.style) {
            rules.push({
              selector: rule.selectorText,
              cssText: rule.style.cssText
            });
          }
          // Handle @media rules — extract inner rules
          if (rule.type === 4 && rule.cssRules) {
            for (var j = 0; j < rule.cssRules.length; j++) {
              var inner = rule.cssRules[j];
              if (inner.type === 1 && inner.selectorText && inner.style) {
                rules.push({
                  selector: inner.selectorText,
                  cssText: inner.style.cssText
                });
              }
            }
          }
        }
      }
    } catch(cssErr) {
      console.warn('[EMAIL-INLINE] CSS parse error:', cssErr.message);
    }
    document.head.removeChild(tempStyle);

    console.log('[EMAIL-INLINE] Parsed', rules.length, 'CSS rules');

    // Log first 10 rules for debugging
    rules.slice(0, 10).forEach(function(r, i) {
      console.log('[EMAIL-INLINE] Rule[' + i + '] selector:"' + r.selector + '" → "' + r.cssText.substring(0, 80) + '"');
    });

    // Apply each rule to matching elements in the parsed doc
    var appliedCount = 0;
    var skippedCount = 0;
    var matchLog = []; // track which selectors matched elements

    rules.forEach(function(rule) {
      var sel = rule.selector;
      var baseSel = sel.replace(/::?[\w-]+(\([^)]*\))?/g, '').trim();
      if (!baseSel) return;

      try {
        var elements = doc.querySelectorAll(baseSel);
        if (elements.length > 0) {
          matchLog.push({ sel: baseSel, count: elements.length, css: rule.cssText.substring(0, 60) });
        }
        elements.forEach(function(el) {
          var existing = el.getAttribute('style') || '';
          var merged = existing ? rule.cssText + ';' + existing : rule.cssText;
          el.setAttribute('style', merged);
          appliedCount++;
        });
      } catch(selErr) {
        skippedCount++;
        console.log('[EMAIL-INLINE] Skipped selector "' + sel + '":', selErr.message);
      }
    });

    console.log('[EMAIL-INLINE] Applied rules to', appliedCount, 'elements,', skippedCount, 'selectors skipped');
    console.log('[EMAIL-INLINE] Top matched selectors:');
    matchLog.slice(0, 20).forEach(function(m) {
      console.log('  [' + m.count + ' elements] "' + m.sel + '" → ' + m.css);
    });

    // Log a sample element to verify styles were applied
    var sampleEl = doc.querySelector('.case-study') || doc.querySelector('.card') || doc.querySelector('.grid-2') || doc.body.firstElementChild;
    if (sampleEl) {
      console.log('[EMAIL-INLINE] Sample element <' + sampleEl.tagName + '> style (first 200 chars):', (sampleEl.getAttribute('style') || '(none)').substring(0, 200));
    }

    // ========== OUTLOOK CSS COMPATIBILITY TRANSFORMATIONS ==========
    console.log('[EMAIL-INLINE] Starting Outlook CSS compatibility transformations...');
    
    var transformCounts = {
      cssVarsResolved: 0,
      gridConverted: 0,
      flexConverted: 0,
      propsRemoved: 0
    };

    // PHASE 1: Resolve CSS variables
    // Extract CSS variable definitions from :root and * selectors
    var cssVarMap = {};
    rules.forEach(function(rule) {
      if (rule.selector === ':root' || rule.selector === '*') {
        var props = rule.cssText.split(';');
        props.forEach(function(prop) {
          var match = prop.match(/^\s*(--[\w-]+)\s*:\s*(.+?)\s*$/);
          if (match) {
            cssVarMap[match[1]] = match[2];
            console.log('[EMAIL-INLINE] CSS var:', match[1], '→', match[2]);
          }
        });
      }
    });

    // Replace var(--name) with actual values in all inline styles
    doc.querySelectorAll('[style]').forEach(function(el) {
      var style = el.getAttribute('style');
      var originalStyle = style;
      var varRegex = /var\((--[\w-]+)\)/g;
      style = style.replace(varRegex, function(match, varName) {
        if (cssVarMap[varName]) {
          transformCounts.cssVarsResolved++;
          return cssVarMap[varName];
        }
        return match;
      });
      if (style !== originalStyle) {
        el.setAttribute('style', style);
      }
    });

    // PHASE 2: Convert display:grid to tables
    doc.querySelectorAll('[style]').forEach(function(el) {
      var style = el.getAttribute('style') || '';
      if (/display:\s*grid/i.test(style)) {
        console.log('[EMAIL-INLINE] Converting grid element:', el.tagName);
        
        // Parse grid properties
        var gap = '0';
        var gapMatch = style.match(/gap:\s*(\d+px)/i);
        if (gapMatch) gap = gapMatch[1];
        
        // Count columns from grid-template-columns
        var cols = 1;
        var colMatch = style.match(/grid-template-columns:\s*([^;]+)/i);
        if (colMatch) {
          var colDef = colMatch[1];
          cols = (colDef.match(/\S+/g) || []).length;
        }
        
        // Create table
        var table = doc.createElement('table');
        table.setAttribute('cellpadding', '0');
        table.setAttribute('cellspacing', '0');
        table.setAttribute('border', '0');
        table.setAttribute('width', '100%');
        
        // Transfer non-grid styles to table
        var cleanStyle = style
          .replace(/display:\s*grid[^;]*/gi, '')
          .replace(/grid-[^:]+:[^;]*/gi, '')
          .replace(/gap:[^;]*/gi, '');
        if (cleanStyle.trim()) {
          table.setAttribute('style', cleanStyle);
        }
        
        // Convert children to table cells
        var children = Array.from(el.children);
        var tbody = doc.createElement('tbody');
        var currentRow = null;
        
        children.forEach(function(child, idx) {
          if (idx % cols === 0) {
            currentRow = doc.createElement('tr');
            tbody.appendChild(currentRow);
          }
          var td = doc.createElement('td');
          if (gap !== '0') {
            var cellStyle = child.getAttribute('style') || '';
            td.setAttribute('style', cellStyle + '; padding: ' + gap);
          } else {
            var cellStyle = child.getAttribute('style') || '';
            if (cellStyle) td.setAttribute('style', cellStyle);
          }
          td.innerHTML = child.innerHTML;
          currentRow.appendChild(td);
        });
        
        table.appendChild(tbody);
        el.parentNode.replaceChild(table, el);
        transformCounts.gridConverted++;
      }
    });

    // PHASE 3: Convert display:flex to tables
    doc.querySelectorAll('[style]').forEach(function(el) {
      var style = el.getAttribute('style') || '';
      if (/display:\s*flex/i.test(style)) {
        console.log('[EMAIL-INLINE] Converting flex element:', el.tagName);
        
        // Parse flex properties
        var direction = 'row';
        var dirMatch = style.match(/flex-direction:\s*(row|column)/i);
        if (dirMatch) direction = dirMatch[1];
        
        var gap = '0';
        var gapMatch = style.match(/gap:\s*(\d+px)/i);
        if (gapMatch) gap = gapMatch[1];
        
        var justify = '';
        var justifyMatch = style.match(/justify-content:\s*([^;]+)/i);
        if (justifyMatch) justify = justifyMatch[1].trim();
        
        var align = '';
        var alignMatch = style.match(/align-items:\s*([^;]+)/i);
        if (alignMatch) align = alignMatch[1].trim();
        
        // Create table
        var table = doc.createElement('table');
        table.setAttribute('cellpadding', '0');
        table.setAttribute('cellspacing', '0');
        table.setAttribute('border', '0');
        
        // Transfer non-flex styles to table
        var cleanStyle = style
          .replace(/display:\s*flex[^;]*/gi, '')
          .replace(/flex-[^:]+:[^;]*/gi, '')
          .replace(/justify-content:[^;]*/gi, '')
          .replace(/align-items:[^;]*/gi, '')
          .replace(/gap:[^;]*/gi, '');
        if (cleanStyle.trim()) {
          table.setAttribute('style', cleanStyle);
        }
        
        // Convert children to table cells
        var children = Array.from(el.children);
        var tbody = doc.createElement('tbody');
        
        if (direction === 'column') {
          // One column, multiple rows
          children.forEach(function(child) {
            var tr = doc.createElement('tr');
            var td = doc.createElement('td');
            if (gap !== '0') {
              var cellStyle = child.getAttribute('style') || '';
              td.setAttribute('style', cellStyle + '; padding: ' + gap);
            } else {
              var cellStyle = child.getAttribute('style') || '';
              if (cellStyle) td.setAttribute('style', cellStyle);
            }
            if (align) {
              if (align === 'center') td.setAttribute('align', 'center');
              else if (align === 'flex-end') td.setAttribute('align', 'right');
              else td.setAttribute('align', 'left');
            }
            td.innerHTML = child.innerHTML;
            tr.appendChild(td);
            tbody.appendChild(tr);
          });
        } else {
          // One row, multiple columns
          var tr = doc.createElement('tr');
          children.forEach(function(child) {
            var td = doc.createElement('td');
            if (gap !== '0') {
              var cellStyle = child.getAttribute('style') || '';
              td.setAttribute('style', cellStyle + '; padding: ' + gap);
            } else {
              var cellStyle = child.getAttribute('style') || '';
              if (cellStyle) td.setAttribute('style', cellStyle);
            }
            if (align) {
              if (align === 'center') td.setAttribute('valign', 'middle');
              else if (align === 'flex-end') td.setAttribute('valign', 'bottom');
              else td.setAttribute('valign', 'top');
            }
            td.innerHTML = child.innerHTML;
            tr.appendChild(td);
          });
          tbody.appendChild(tr);
        }
        
        table.appendChild(tbody);
        el.parentNode.replaceChild(table, el);
        transformCounts.flexConverted++;
      }
    });

    // PHASE 4: Remove unsupported properties from all inline styles
    doc.querySelectorAll('[style]').forEach(function(el) {
      var style = el.getAttribute('style') || '';
      var originalStyle = style;
      
      // Normalize whitespace first (handle multi-line styles)
      style = style.replace(/\s+/g, ' ').trim();
      
      // Remove unsupported properties (more aggressive patterns)
      style = style
        .replace(/border-radius\s*:[^;]*/gi, '')
        .replace(/box-shadow\s*:[^;]*/gi, '')
        .replace(/-webkit-box-shadow\s*:[^;]*/gi, '')
        .replace(/-moz-box-shadow\s*:[^;]*/gi, '')
        .replace(/display\s*:\s*grid[^;]*/gi, '')
        .replace(/display\s*:\s*flex[^;]*/gi, '')
        .replace(/grid-[^:]+\s*:[^;]*/gi, '')
        .replace(/flex-[^:]+\s*:[^;]*/gi, '')
        .replace(/justify-content\s*:[^;]*/gi, '')
        .replace(/align-items\s*:[^;]*/gi, '')
        .replace(/gap\s*:[^;]*/gi, '')
        .replace(/var\s*\([^)]+\)/gi, 'inherit')
        .replace(/;\s*;+/g, ';')
        .replace(/^\s*;+\s*/, '')
        .replace(/\s*;+\s*$/, '');
      
      if (style !== originalStyle) {
        transformCounts.propsRemoved++;
        if (style.trim()) {
          el.setAttribute('style', style);
        } else {
          el.removeAttribute('style');
        }
      }
    });

    console.log('[EMAIL-INLINE] ✅ Transformations complete:');
    console.log('  CSS variables resolved:', transformCounts.cssVarsResolved);
    console.log('  Grid layouts converted:', transformCounts.gridConverted);
    console.log('  Flex layouts converted:', transformCounts.flexConverted);
    console.log('  Elements with properties removed:', transformCounts.propsRemoved);

    // PHASE 5: Second pass cleanup - aggressively remove any remaining unsupported properties
    var secondPassCount = 0;
    doc.querySelectorAll('[style]').forEach(function(el) {
      var style = el.getAttribute('style') || '';
      var originalStyle = style;
      
      // Split by semicolon and filter out unsupported properties
      var props = style.split(';').filter(function(prop) {
        prop = prop.trim();
        if (!prop) return false;
        
        var propName = prop.split(':')[0].trim().toLowerCase();
        
        // Blacklist of Outlook-unsupported properties
        var unsupported = [
          'box-shadow', '-webkit-box-shadow', '-moz-box-shadow',
          'border-radius', '-webkit-border-radius', '-moz-border-radius',
          'gap', 'grid-gap', 'column-gap', 'row-gap',
          'justify-content', 'align-items', 'align-content',
          'flex-direction', 'flex-wrap', 'flex-flow', 'flex-grow', 'flex-shrink', 'flex-basis', 'flex'
        ];
        
        // Check if property starts with unsupported prefix
        if (propName.startsWith('grid-') || propName.startsWith('flex-')) return false;
        if (unsupported.indexOf(propName) !== -1) return false;
        if (prop.indexOf('var(') !== -1) return false; // Remove any remaining CSS variables
        
        return true;
      });
      
      var cleanStyle = props.join('; ');
      if (cleanStyle && !cleanStyle.endsWith(';')) cleanStyle += ';';
      
      if (cleanStyle !== originalStyle) {
        secondPassCount++;
        if (cleanStyle.trim()) {
          el.setAttribute('style', cleanStyle);
        } else {
          el.removeAttribute('style');
        }
      }
    });
    
    if (secondPassCount > 0) {
      console.log('[EMAIL-INLINE] ✅ Second pass cleanup:', secondPassCount, 'elements cleaned');
    }

    // Remove all <style>, <script>, <link> tags — not needed after inlining
    doc.querySelectorAll('style, script, link').forEach(function(s) {
      console.log('[EMAIL-INLINE] Removing:', s.tagName, s.getAttribute('src') || s.getAttribute('href') || '');
      s.remove();
    });

    // Remove class attributes — Outlook prefixes them with x_ breaking selectors
    doc.querySelectorAll('[class]').forEach(function(el) {
      el.removeAttribute('class');
    });

    // Replace Outlook-unsupported tags
    var REPLACE_TAGS = ['video', 'audio', 'canvas', 'iframe', 'object', 'embed'];
    REPLACE_TAGS.forEach(function(tag) {
      doc.querySelectorAll(tag).forEach(function(el) {
        var ph = doc.createElement('div');
        ph.style.cssText = 'padding:8px;background:#f0f0f0;color:#666;font-family:Arial,sans-serif;font-size:12px;border:1px solid #ddd;margin:4px 0;';
        ph.textContent = '[' + tag.toUpperCase() + ' content — not supported in email]';
        el.parentNode.replaceChild(ph, el);
        console.log('[EMAIL-INLINE] Replaced unsupported tag:', tag);
      });
    });

    // Unwrap semantic HTML5 tags (keep their children)
    var UNWRAP_TAGS = ['nav', 'header', 'footer', 'aside', 'article', 'section', 'main', 'figure', 'figcaption', 'details', 'summary'];
    UNWRAP_TAGS.forEach(function(tag) {
      doc.querySelectorAll(tag).forEach(function(el) {
        while (el.firstChild) el.parentNode.insertBefore(el.firstChild, el);
        el.parentNode.removeChild(el);
      });
    });

    var result = doc.body ? doc.body.innerHTML : rawHtml;
    console.log('[EMAIL-INLINE] ✅ Final HTML length:', result.length, '(was', rawHtml.length, ')');

    // Log first 500 chars of result to verify inline styles are present
    console.log('[EMAIL-INLINE] Result preview (first 500 chars):', result.substring(0, 500));

    // Check if inline styles are actually present in the output
    var styleAttrCount = (result.match(/style="/g) || []).length;
    var classAttrCount = (result.match(/class="/g) || []).length;
    console.log('[EMAIL-INLINE] style= attributes in output:', styleAttrCount);
    console.log('[EMAIL-INLINE] class= attributes remaining:', classAttrCount, '(should be 0 after class removal)');

    // Check for Outlook-unsupported CSS properties still present (should be 0 after transformations)
    var gridCount   = (result.match(/display:\s*grid/g) || []).length;
    var flexCount   = (result.match(/display:\s*flex/g) || []).length;
    var varCount    = (result.match(/var\(--/g) || []).length;
    var shadowCount = (result.match(/box-shadow/g) || []).length;
    var radiusCount = (result.match(/border-radius/g) || []).length;
    
    if (gridCount + flexCount + varCount + shadowCount + radiusCount > 0) {
      console.log('[EMAIL-INLINE] ⚠ Unsupported CSS still present after transformations:');
      if (gridCount > 0) console.log('  display:grid occurrences:', gridCount);
      if (flexCount > 0) console.log('  display:flex occurrences:', flexCount);
      if (varCount > 0) console.log('  CSS var() occurrences:', varCount);
      if (shadowCount > 0) console.log('  box-shadow occurrences:', shadowCount);
      if (radiusCount > 0) console.log('  border-radius occurrences:', radiusCount);
    } else {
      console.log('[EMAIL-INLINE] ✅ All unsupported CSS properties transformed or removed');
    }

    console.groupEnd();
    callback(result);

  } catch(err) {
    console.error('[EMAIL-INLINE] Fatal error:', err);
    // Fallback: return body content without inlining
    try {
      var p = new DOMParser();
      var d = p.parseFromString(rawHtml, 'text/html');
      callback(d.body ? d.body.innerHTML : rawHtml);
    } catch(_) {
      callback(rawHtml);
    }
  }
} };