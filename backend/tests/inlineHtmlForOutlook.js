/**
 * Extracted inlineHtmlForOutlook function for testing
 * This is the UNFIXED version that demonstrates the bug
 */

function inlineHtmlForOutlook(rawHtml, callback) {
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

    // Check for Outlook-unsupported CSS properties still present
    var gridCount   = (result.match(/display:\s*grid/g) || []).length;
    var flexCount   = (result.match(/display:\s*flex/g) || []).length;
    var varCount    = (result.match(/var\(--/g) || []).length;
    var shadowCount = (result.match(/box-shadow/g) || []).length;
    console.log('[EMAIL-INLINE] ⚠ Outlook-unsupported CSS still present:');
    console.log('  display:grid occurrences:', gridCount, '(Outlook ignores grid — layout will break)');
    console.log('  display:flex occurrences:', flexCount, '(Outlook ignores flex — layout will break)');
    console.log('  CSS var() occurrences:', varCount, '(Outlook ignores CSS variables — colors will break)');
    console.log('  box-shadow occurrences:', shadowCount, '(Outlook ignores box-shadow)');

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
}

module.exports = { inlineHtmlForOutlook };
