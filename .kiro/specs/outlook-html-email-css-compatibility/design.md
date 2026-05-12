# Outlook HTML Email CSS Compatibility Bugfix Design

## Overview

This design addresses the CSS compatibility issue in the `inlineHtmlForOutlook()` function in `dashboard.html`. The function currently inlines CSS into style attributes but preserves modern CSS features (display: grid, display: flex, CSS variables, border-radius, box-shadow) that Outlook's rendering engine does not support. This causes email layouts to break when viewed in Outlook desktop and web clients.

The fix will transform unsupported CSS into Outlook-compatible alternatives:
- Convert `display: grid` and `display: flex` layouts to table-based layouts
- Resolve CSS variables to their actual color values
- Remove unsupported properties (border-radius, box-shadow)

This ensures emails render correctly across all Outlook clients while preserving existing functionality for supported CSS properties.

## Glossary

- **Bug_Condition (C)**: HTML content contains Outlook-unsupported CSS properties (display: grid, display: flex, CSS variables, border-radius, box-shadow) after CSS inlining
- **Property (P)**: The desired behavior where unsupported CSS is transformed into Outlook-compatible alternatives (table layouts, resolved color values, removed properties)
- **Preservation**: Existing CSS inlining behavior for supported properties (color, background-color, font-size, padding, margin, border, width, height) must remain unchanged
- **inlineHtmlForOutlook()**: The function in `dashboard.html` (line ~10694) that inlines CSS from `<style>` blocks into inline style attributes for Outlook compatibility
- **getEmailBodyForSend()**: The function that processes HTML embeds before sending, calling `inlineHtmlForOutlook()` for each embed
- **CSS Variables**: Custom CSS properties like `var(--bg)`, `var(--card)`, `var(--primary)` that Outlook does not support
- **Grid Layout**: CSS `display: grid` with properties like `grid-template-columns`, `gap`, `grid-column` that Outlook strips
- **Flex Layout**: CSS `display: flex` with properties like `flex-direction`, `justify-content`, `align-items` that Outlook strips
- **Table-based Layout**: Outlook-compatible layout using `<table>`, `<tr>`, `<td>` elements with inline styles

## Bug Details

### Bug Condition

The bug manifests when HTML content processed by `inlineHtmlForOutlook()` contains modern CSS features that Outlook's rendering engine does not support. The function successfully inlines CSS into style attributes but does not transform these unsupported properties, causing Outlook to strip or ignore them, resulting in broken layouts and missing styling.

**Formal Specification:**
```
FUNCTION isBugCondition(input)
  INPUT: input of type HTMLString (processed by inlineHtmlForOutlook)
  OUTPUT: boolean
  
  RETURN (input.contains('display: grid') OR input.contains('display:grid'))
         OR (input.contains('display: flex') OR input.contains('display:flex'))
         OR input.contains('var(--')
         OR input.contains('border-radius')
         OR input.contains('box-shadow')
END FUNCTION
```

### Examples

- **Grid Layout Example**: HTML with `<div style="display: grid; grid-template-columns: 1fr 1fr; gap: 20px;">` is sent to Outlook → Outlook strips `display: grid` → layout collapses into a single column
- **Flex Layout Example**: HTML with `<div style="display: flex; justify-content: space-between; align-items: center;">` is sent to Outlook → Outlook strips `display: flex` → items stack vertically instead of horizontally
- **CSS Variables Example**: HTML with `<div style="background-color: var(--card); color: var(--primary);">` is sent to Outlook → Outlook ignores CSS variables → no background color or text color is applied
- **Border Radius Example**: HTML with `<div style="border-radius: 8px; border: 1px solid #ddd;">` is sent to Outlook desktop → border-radius is ignored → sharp corners instead of rounded
- **Box Shadow Example**: HTML with `<div style="box-shadow: 0 2px 8px rgba(0,0,0,0.1);">` is sent to Outlook → box-shadow is ignored → no shadow effect
- **Edge Case - Mixed Properties**: HTML with `<div style="display: flex; background-color: var(--bg); padding: 20px; color: #333;">` → Outlook strips flex and ignores CSS variable, but preserves padding and color

## Expected Behavior

### Preservation Requirements

**Unchanged Behaviors:**
- Outlook-supported CSS properties (color, background-color, font-size, font-family, font-weight, text-align, padding, margin, border, width, height, line-height, text-decoration) must continue to be inlined into style attributes without modification
- `<style>`, `<script>`, `<link>` tags must continue to be removed after CSS inlining
- Class attributes must continue to be removed (Outlook prefixes them with x_ breaking selectors)
- Unsupported HTML5 tags (video, audio, canvas, iframe, object, embed) must continue to be replaced with placeholder divs
- Semantic HTML5 tags (nav, header, footer, aside, article, section, main, figure) must continue to be unwrapped while preserving their children
- HTML embeds without `[data-html-uid]` elements must continue to send editor content directly without CSS inlining
- Multiple HTML embeds must continue to be processed sequentially

**Scope:**
All inputs that do NOT contain Outlook-unsupported CSS properties (grid, flex, CSS variables, border-radius, box-shadow) should be completely unaffected by this fix. This includes:
- HTML with only supported CSS properties (color, background, padding, etc.)
- Plain text emails without HTML embeds
- HTML without any CSS styling

## Hypothesized Root Cause

Based on the bug description and code analysis, the root cause is clear:

1. **Missing CSS Transformation Logic**: The `inlineHtmlForOutlook()` function successfully inlines CSS from `<style>` blocks into inline style attributes, but it does not include any logic to detect and transform Outlook-unsupported CSS properties. The function logs warnings about unsupported properties (lines ~10765-10769) but takes no action to fix them.

2. **No CSS Variable Resolution**: The function uses the browser's CSS parser (`CSSStyleSheet API`) which preserves CSS variable syntax (`var(--name)`) in the `cssText` property. These variables are never resolved to their actual values before being inlined.

3. **No Layout Conversion**: The function preserves `display: grid` and `display: flex` properties in inline styles, but Outlook's rendering engine strips these properties entirely, causing layouts to collapse.

4. **No Property Filtering**: The function does not filter out properties like `border-radius` and `box-shadow` that Outlook desktop does not support.

## Correctness Properties

Property 1: Bug Condition - Outlook-Unsupported CSS Transformation

_For any_ HTML input where the bug condition holds (contains display: grid, display: flex, CSS variables, border-radius, or box-shadow after CSS inlining), the fixed `inlineHtmlForOutlook()` function SHALL transform these unsupported properties into Outlook-compatible alternatives: grid/flex layouts converted to table-based layouts, CSS variables resolved to actual color values, and unsupported properties (border-radius, box-shadow) removed from inline styles.

**Validates: Requirements 2.1, 2.2, 2.3, 2.4, 2.5, 2.6**

Property 2: Preservation - Supported CSS Properties Behavior

_For any_ HTML input where the bug condition does NOT hold (contains only Outlook-supported CSS properties like color, background-color, font-size, padding, margin, border, width, height), the fixed `inlineHtmlForOutlook()` function SHALL produce exactly the same output as the original function, preserving all existing CSS inlining behavior for supported properties.

**Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7**

## Fix Implementation

### Changes Required

Assuming our root cause analysis is correct:

**File**: `dashboard.html`

**Function**: `inlineHtmlForOutlook()` (starting at line ~10694)

**Specific Changes**:

1. **Add CSS Variable Resolution (after line ~10750)**:
   - After parsing CSS rules, extract all CSS variable definitions from `:root` and `*` selectors
   - Build a map of variable names to their resolved values (e.g., `--bg` → `#ffffff`)
   - Before applying rules to elements, replace all `var(--name)` occurrences in `cssText` with their actual values
   - Implementation: Use regex `/var\(--([^)]+)\)/g` to find variables, look up in map, replace with value

2. **Add Grid Layout Detection and Conversion (after line ~10780)**:
   - After applying CSS rules to elements, query all elements with `style` attribute containing `display: grid`
   - For each grid element:
     - Parse grid properties: `grid-template-columns`, `gap`, `grid-column`, `grid-row`
     - Create a `<table>` element with `cellpadding="0" cellspacing="0" border="0"` and `width="100%"`
     - Convert grid items to table rows and cells based on column count
     - Apply gap as padding on cells
     - Replace the grid element with the table element
     - Transfer non-grid styles (background, padding, border) to the table

3. **Add Flex Layout Detection and Conversion (after grid conversion)**:
   - Query all elements with `style` attribute containing `display: flex`
   - For each flex element:
     - Parse flex properties: `flex-direction`, `justify-content`, `align-items`, `gap`
     - Create a `<table>` element with `cellpadding="0" cellspacing="0" border="0"`
     - If `flex-direction: column`, create one column with multiple rows
     - If `flex-direction: row` (default), create one row with multiple columns
     - Apply `justify-content` as `align` attribute on table cells
     - Apply `align-items` as `valign` attribute on table cells
     - Apply gap as padding on cells
     - Replace the flex element with the table element
     - Transfer non-flex styles to the table

4. **Add Unsupported Property Removal (after layout conversion)**:
   - Query all elements with `style` attribute
   - For each element:
     - Parse the inline style string
     - Remove `border-radius` property (not supported in Outlook desktop)
     - Remove `box-shadow` property (not supported in Outlook)
     - Remove any remaining `display: grid` or `display: flex` properties (if not converted)
     - Remove any remaining `var(--` references (if not resolved)
     - Rebuild the style attribute with only supported properties

5. **Update Logging (replace lines ~10765-10769)**:
   - Change warning logs to info logs indicating transformations were applied
   - Log counts of: CSS variables resolved, grid layouts converted, flex layouts converted, properties removed
   - Example: `console.log('[EMAIL-INLINE] ✅ Transformed:', varCount, 'CSS variables,', gridCount, 'grid layouts,', flexCount, 'flex layouts')`

### Implementation Strategy

The fix will be implemented in phases within the `inlineHtmlForOutlook()` function:

**Phase 1: CSS Variable Resolution** (before applying rules to elements)
- Extract variable definitions from parsed CSS rules
- Build a variable map (name → value)
- Replace `var(--name)` in all rule `cssText` before applying to elements

**Phase 2: Layout Conversion** (after applying rules, before tag cleanup)
- Convert grid layouts to tables
- Convert flex layouts to tables
- Preserve all non-layout styles during conversion

**Phase 3: Property Cleanup** (after layout conversion, before returning result)
- Remove unsupported properties from all inline styles
- Ensure no unsupported CSS remains in the output

**Phase 4: Logging Updates** (throughout)
- Replace warning logs with success logs
- Add transformation counts to final summary

## Testing Strategy

### Validation Approach

The testing strategy follows a two-phase approach: first, surface counterexamples that demonstrate the bug on unfixed code, then verify the fix works correctly and preserves existing behavior.

### Exploratory Bug Condition Checking

**Goal**: Surface counterexamples that demonstrate the bug BEFORE implementing the fix. Confirm or refute the root cause analysis. If we refute, we will need to re-hypothesize.

**Test Plan**: Create HTML test cases with unsupported CSS, run them through the UNFIXED `inlineHtmlForOutlook()` function, and verify that unsupported CSS is preserved in the output (causing the bug). Then manually test the output in Outlook to observe broken layouts.

**Test Cases**:
1. **Grid Layout Test**: HTML with `<div class="grid-2"><div>Item 1</div><div>Item 2</div></div>` and CSS `.grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }` → Run through unfixed function → Verify output contains `display: grid` in inline style → Test in Outlook → Observe items stack vertically instead of side-by-side (will fail on unfixed code)
2. **Flex Layout Test**: HTML with `<div class="flex-row"><span>Left</span><span>Right</span></div>` and CSS `.flex-row { display: flex; justify-content: space-between; }` → Run through unfixed function → Verify output contains `display: flex` → Test in Outlook → Observe items stack vertically (will fail on unfixed code)
3. **CSS Variables Test**: HTML with `<div class="card">Content</div>` and CSS `:root { --card: #f5f5f5; --primary: #0078d4; } .card { background-color: var(--card); color: var(--primary); }` → Run through unfixed function → Verify output contains `var(--card)` and `var(--primary)` → Test in Outlook → Observe no background color or text color (will fail on unfixed code)
4. **Border Radius Test**: HTML with `<div class="rounded">Box</div>` and CSS `.rounded { border-radius: 8px; border: 1px solid #ddd; }` → Run through unfixed function → Verify output contains `border-radius: 8px` → Test in Outlook desktop → Observe sharp corners instead of rounded (will fail on unfixed code)
5. **Box Shadow Test**: HTML with `<div class="shadow">Card</div>` and CSS `.shadow { box-shadow: 0 2px 8px rgba(0,0,0,0.1); }` → Run through unfixed function → Verify output contains `box-shadow` → Test in Outlook → Observe no shadow effect (will fail on unfixed code)

**Expected Counterexamples**:
- Unsupported CSS properties (grid, flex, CSS variables, border-radius, box-shadow) are preserved in inline styles after CSS inlining
- Outlook strips or ignores these properties, causing layouts to break and styling to not render
- Possible causes: No transformation logic exists in the function (confirmed by code analysis)

### Fix Checking

**Goal**: Verify that for all inputs where the bug condition holds, the fixed function produces the expected behavior.

**Pseudocode:**
```
FOR ALL input WHERE isBugCondition(input) DO
  result := inlineHtmlForOutlook_fixed(input)
  ASSERT NOT result.contains('display: grid')
  ASSERT NOT result.contains('display: flex')
  ASSERT NOT result.contains('var(--')
  ASSERT NOT result.contains('border-radius')
  ASSERT NOT result.contains('box-shadow')
  ASSERT result.contains('<table') // grid/flex converted to tables
  ASSERT result.contains('background-color: #') // CSS variables resolved
END FOR
```

### Preservation Checking

**Goal**: Verify that for all inputs where the bug condition does NOT hold, the fixed function produces the same result as the original function.

**Pseudocode:**
```
FOR ALL input WHERE NOT isBugCondition(input) DO
  ASSERT inlineHtmlForOutlook_original(input) = inlineHtmlForOutlook_fixed(input)
END FOR
```

**Testing Approach**: Property-based testing is recommended for preservation checking because:
- It generates many test cases automatically across the input domain
- It catches edge cases that manual unit tests might miss
- It provides strong guarantees that behavior is unchanged for all non-buggy inputs

**Test Plan**: Observe behavior on UNFIXED code first for HTML with only supported CSS properties, then write property-based tests capturing that behavior.

**Test Cases**:
1. **Supported CSS Preservation**: Observe that HTML with `<div class="box">Text</div>` and CSS `.box { color: #333; background-color: #fff; padding: 20px; margin: 10px; border: 1px solid #ddd; }` produces correct inline styles on unfixed code, then write test to verify this continues after fix
2. **Tag Removal Preservation**: Observe that `<style>`, `<script>`, `<link>` tags are removed on unfixed code, then write test to verify this continues after fix
3. **Class Removal Preservation**: Observe that class attributes are removed on unfixed code, then write test to verify this continues after fix
4. **Unsupported Tag Replacement Preservation**: Observe that `<video>`, `<iframe>` tags are replaced with placeholder divs on unfixed code, then write test to verify this continues after fix
5. **Semantic Tag Unwrapping Preservation**: Observe that `<nav>`, `<header>`, `<footer>` tags are unwrapped on unfixed code, then write test to verify this continues after fix

### Unit Tests

- Test CSS variable resolution with various variable definitions (`:root`, `*` selector, nested variables)
- Test grid layout conversion with different column counts (1, 2, 3, 4 columns)
- Test flex layout conversion with different directions (row, column) and alignment options
- Test property removal for border-radius, box-shadow, and other unsupported properties
- Test edge cases: empty HTML, HTML without CSS, HTML with only supported CSS
- Test that supported CSS properties are preserved exactly as before

### Property-Based Tests

- Generate random HTML with combinations of supported and unsupported CSS properties, verify unsupported properties are transformed or removed
- Generate random grid layouts with varying column counts and gap values, verify all are converted to tables
- Generate random flex layouts with varying directions and alignment, verify all are converted to tables
- Generate random CSS variable definitions and usages, verify all are resolved to actual values
- Test that all generated HTML with only supported CSS produces identical output before and after fix

### Integration Tests

- Test full email composition flow: create email with HTML embed containing grid layout → send email → verify sent HTML contains table instead of grid
- Test multiple HTML embeds in one email: embed with grid + embed with flex + embed with CSS variables → verify all are transformed correctly
- Test email preview in Outlook: send test email to Outlook account → verify layout renders correctly in Outlook web and desktop
- Test that emails without HTML embeds continue to work exactly as before (no regression)
