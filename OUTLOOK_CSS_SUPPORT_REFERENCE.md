# 📧 Outlook Email CSS Support Reference

Complete guide to what works and what doesn't in Outlook email clients.

---

## 🎯 Quick Summary

**Outlook Desktop (Windows)** uses **Microsoft Word's HTML rendering engine**, which has very limited CSS support compared to modern browsers.

**Outlook Web/Mobile** use modern browser engines and support more CSS, but for maximum compatibility, design for Outlook Desktop's limitations.

---

## ✅ FULLY SUPPORTED CSS Properties

These work reliably across all Outlook versions (Desktop, Web, Mobile):

### **Text & Font Properties**
| Property | Support | Example | Notes |
|----------|---------|---------|-------|
| `color` | ✅ Full | `color: #ff0000;` | Hex, RGB, RGBA, named colors |
| `font-family` | ✅ Full | `font-family: Arial, sans-serif;` | Use web-safe fonts |
| `font-size` | ✅ Full | `font-size: 14px;` | px, pt, em, % |
| `font-weight` | ✅ Full | `font-weight: bold;` | bold, normal, 100-900 |
| `font-style` | ✅ Full | `font-style: italic;` | italic, normal |
| `text-align` | ✅ Full | `text-align: center;` | left, center, right, justify |
| `text-decoration` | ✅ Full | `text-decoration: underline;` | underline, none, line-through |
| `line-height` | ✅ Full | `line-height: 1.5;` | Number, px, % |
| `letter-spacing` | ✅ Full | `letter-spacing: 1px;` | px values |
| `text-transform` | ✅ Full | `text-transform: uppercase;` | uppercase, lowercase, capitalize |

### **Background Properties**
| Property | Support | Example | Notes |
|----------|---------|---------|-------|
| `background-color` | ✅ Full | `background-color: #f0f0f0;` | All color formats |
| `background-image` | ⚠️ Partial | `background-image: url(image.jpg);` | Works but may be blocked by default |
| `background` (shorthand) | ✅ Full | `background: #fff;` | Color only, not images |

### **Box Model Properties**
| Property | Support | Example | Notes |
|----------|---------|---------|-------|
| `width` | ✅ Full | `width: 600px;` | px, %, auto |
| `height` | ✅ Full | `height: 200px;` | px, %, auto |
| `padding` | ✅ Full | `padding: 10px;` | All sides, px, % |
| `padding-top` | ✅ Full | `padding-top: 10px;` | Individual sides |
| `padding-right` | ✅ Full | `padding-right: 10px;` | Individual sides |
| `padding-bottom` | ✅ Full | `padding-bottom: 10px;` | Individual sides |
| `padding-left` | ✅ Full | `padding-left: 10px;` | Individual sides |
| `margin` | ✅ Full | `margin: 10px;` | All sides, px, %, auto |
| `margin-top` | ✅ Full | `margin-top: 10px;` | Individual sides |
| `margin-right` | ✅ Full | `margin-right: 10px;` | Individual sides |
| `margin-bottom` | ✅ Full | `margin-bottom: 10px;` | Individual sides |
| `margin-left` | ✅ Full | `margin-left: 10px;` | Individual sides |

### **Border Properties**
| Property | Support | Example | Notes |
|----------|---------|---------|-------|
| `border` | ✅ Full | `border: 1px solid #ddd;` | Width, style, color |
| `border-top` | ✅ Full | `border-top: 1px solid #ddd;` | Individual sides |
| `border-right` | ✅ Full | `border-right: 1px solid #ddd;` | Individual sides |
| `border-bottom` | ✅ Full | `border-bottom: 1px solid #ddd;` | Individual sides |
| `border-left` | ✅ Full | `border-left: 1px solid #ddd;` | Individual sides |
| `border-width` | ✅ Full | `border-width: 2px;` | px values |
| `border-style` | ✅ Full | `border-style: solid;` | solid, dashed, dotted, none |
| `border-color` | ✅ Full | `border-color: #000;` | All color formats |
| `border-collapse` | ✅ Full | `border-collapse: collapse;` | For tables |
| `border-spacing` | ✅ Full | `border-spacing: 0;` | For tables |

### **Table Properties**
| Property | Support | Example | Notes |
|----------|---------|---------|-------|
| `vertical-align` | ✅ Full | `vertical-align: middle;` | top, middle, bottom |
| `cellpadding` (attribute) | ✅ Full | `<table cellpadding="0">` | HTML attribute |
| `cellspacing` (attribute) | ✅ Full | `<table cellspacing="0">` | HTML attribute |
| `border` (attribute) | ✅ Full | `<table border="0">` | HTML attribute |
| `align` (attribute) | ✅ Full | `<td align="center">` | HTML attribute |
| `valign` (attribute) | ✅ Full | `<td valign="top">` | HTML attribute |

### **Display & Visibility**
| Property | Support | Example | Notes |
|----------|---------|---------|-------|
| `display: block` | ✅ Full | `display: block;` | Block-level element |
| `display: inline` | ✅ Full | `display: inline;` | Inline element |
| `display: inline-block` | ✅ Full | `display: inline-block;` | Inline-block element |
| `display: table` | ✅ Full | `display: table;` | Table display |
| `display: table-cell` | ✅ Full | `display: table-cell;` | Table cell display |
| `display: none` | ✅ Full | `display: none;` | Hide element |
| `visibility` | ✅ Full | `visibility: hidden;` | hidden, visible |

---

## ❌ NOT SUPPORTED / PARTIALLY SUPPORTED

These properties don't work in Outlook Desktop or have limited support:

### **Modern Layout (NOT SUPPORTED)**
| Property | Support | Alternative | Notes |
|----------|---------|-------------|-------|
| `display: flex` | ❌ No | Use `<table>` | Flexbox not supported |
| `flex-direction` | ❌ No | Use `<table>` rows/columns | - |
| `flex-wrap` | ❌ No | Use `<table>` | - |
| `justify-content` | ❌ No | Use `align` attribute on `<td>` | - |
| `align-items` | ❌ No | Use `valign` attribute on `<td>` | - |
| `flex-grow` | ❌ No | Use `width` on `<td>` | - |
| `flex-shrink` | ❌ No | Use `width` on `<td>` | - |
| `display: grid` | ❌ No | Use `<table>` | Grid not supported |
| `grid-template-columns` | ❌ No | Use `<table>` with `<td>` | - |
| `grid-template-rows` | ❌ No | Use `<table>` with `<tr>` | - |
| `grid-gap` / `gap` | ❌ No | Use `padding` on `<td>` | - |
| `grid-column` | ❌ No | Use `colspan` attribute | - |
| `grid-row` | ❌ No | Use `rowspan` attribute | - |

### **Positioning (NOT SUPPORTED)**
| Property | Support | Alternative | Notes |
|----------|---------|-------------|-------|
| `position: absolute` | ❌ No | Use tables for layout | - |
| `position: relative` | ❌ No | Use tables for layout | - |
| `position: fixed` | ❌ No | Not possible in email | - |
| `position: sticky` | ❌ No | Not possible in email | - |
| `top` | ❌ No | - | Requires positioning |
| `right` | ❌ No | - | Requires positioning |
| `bottom` | ❌ No | - | Requires positioning |
| `left` | ❌ No | - | Requires positioning |
| `z-index` | ❌ No | - | Requires positioning |
| `float` | ⚠️ Buggy | Use `<table>` | Unreliable in Outlook |

### **Visual Effects (NOT SUPPORTED)**
| Property | Support | Alternative | Notes |
|----------|---------|-------------|-------|
| `box-shadow` | ❌ No | Use borders or images | Not supported in Outlook Desktop |
| `text-shadow` | ❌ No | Use images for shadowed text | Not supported |
| `border-radius` | ❌ No | Use images with rounded corners | Not supported in Outlook Desktop |
| `opacity` | ❌ No | Use RGBA colors | Not supported |
| `filter` | ❌ No | Use images | Not supported |
| `backdrop-filter` | ❌ No | - | Not supported |
| `clip-path` | ❌ No | Use images | Not supported |
| `mask` | ❌ No | Use images | Not supported |

### **Transforms & Animations (NOT SUPPORTED)**
| Property | Support | Alternative | Notes |
|----------|---------|-------------|-------|
| `transform` | ❌ No | Use images | Not supported |
| `rotate` | ❌ No | Use rotated images | Not supported |
| `scale` | ❌ No | Use sized images | Not supported |
| `translate` | ❌ No | Use `margin` or `padding` | Not supported |
| `transition` | ❌ No | Not possible in email | Not supported |
| `animation` | ❌ No | Use animated GIFs | Not supported |
| `@keyframes` | ❌ No | Use animated GIFs | Not supported |

### **Advanced CSS (NOT SUPPORTED)**
| Property | Support | Alternative | Notes |
|----------|---------|-------------|-------|
| CSS Variables (`--var`) | ❌ No | Use actual values | Not supported |
| `var(--name)` | ❌ No | Resolve to actual values | Not supported |
| `calc()` | ❌ No | Calculate manually | Not supported |
| `min()` / `max()` / `clamp()` | ❌ No | Use fixed values | Not supported |
| Custom properties | ❌ No | Use inline styles | Not supported |

### **Pseudo-classes & Pseudo-elements (LIMITED)**
| Property | Support | Alternative | Notes |
|----------|---------|-------------|-------|
| `:hover` | ⚠️ Partial | Works in Outlook Web only | Not in Desktop |
| `:active` | ❌ No | - | Not supported |
| `:focus` | ❌ No | - | Not supported |
| `:target` | ❌ No | - | Not supported |
| `::before` | ❌ No | Use actual HTML elements | Not supported |
| `::after` | ❌ No | Use actual HTML elements | Not supported |
| `::first-letter` | ❌ No | Use `<span>` | Not supported |
| `::first-line` | ❌ No | Use `<span>` | Not supported |

### **Media Queries (LIMITED)**
| Property | Support | Alternative | Notes |
|----------|---------|-------------|-------|
| `@media` | ⚠️ Partial | Works in Outlook Web/Mobile | Not in Desktop |
| `@media (max-width)` | ⚠️ Partial | Use fluid tables | Limited support |
| `@media (prefers-color-scheme)` | ❌ No | - | Not supported |

### **Other CSS Features (NOT SUPPORTED)**
| Property | Support | Alternative | Notes |
|----------|---------|-------------|-------|
| `overflow` | ❌ No | Design to fit | Not supported |
| `overflow-x` | ❌ No | - | Not supported |
| `overflow-y` | ❌ No | - | Not supported |
| `object-fit` | ❌ No | Resize images manually | Not supported |
| `aspect-ratio` | ❌ No | Use fixed dimensions | Not supported |
| `mix-blend-mode` | ❌ No | Use images | Not supported |
| `cursor` | ❌ No | - | Not applicable in email |
| `pointer-events` | ❌ No | - | Not supported |
| `user-select` | ❌ No | - | Not supported |

---

## 🚫 HTML FEATURES NOT SUPPORTED

### **Interactive Elements**
| Element | Support | Alternative | Notes |
|---------|---------|-------------|-------|
| `<script>` | ❌ Blocked | Not possible | Security risk |
| `<iframe>` | ❌ Blocked | Use images with links | Security risk |
| `<form>` | ❌ Limited | Link to external form | Can't submit within email |
| `<input>` | ❌ Blocked | Link to external form | Security risk |
| `<button>` | ⚠️ Partial | Use `<a>` styled as button | Limited support |
| `<select>` | ❌ Blocked | Link to external form | Not supported |
| `<textarea>` | ❌ Blocked | Link to external form | Not supported |
| `<video>` | ❌ Blocked | Use thumbnail image with link | Not supported |
| `<audio>` | ❌ Blocked | Use link to audio file | Not supported |
| `<canvas>` | ❌ Blocked | Use images | Not supported |
| `<svg>` | ⚠️ Partial | Use PNG/JPG images | Limited support |
| `<object>` | ❌ Blocked | Use images | Not supported |
| `<embed>` | ❌ Blocked | Use images | Not supported |

### **External Resources**
| Element | Support | Alternative | Notes |
|---------|---------|-------------|-------|
| `<link rel="stylesheet">` | ❌ Blocked | Use inline styles | Security risk |
| External CSS files | ❌ Blocked | Use inline styles | Security risk |
| External JavaScript | ❌ Blocked | Not possible | Security risk |
| Web fonts (`@font-face`) | ⚠️ Partial | Use web-safe fonts | Limited support |

### **Semantic HTML5 Tags**
| Element | Support | Alternative | Notes |
|---------|---------|-------------|-------|
| `<nav>` | ⚠️ Works | Use `<div>` or `<table>` | Better to unwrap |
| `<header>` | ⚠️ Works | Use `<div>` or `<table>` | Better to unwrap |
| `<footer>` | ⚠️ Works | Use `<div>` or `<table>` | Better to unwrap |
| `<article>` | ⚠️ Works | Use `<div>` or `<table>` | Better to unwrap |
| `<section>` | ⚠️ Works | Use `<div>` or `<table>` | Better to unwrap |
| `<aside>` | ⚠️ Works | Use `<div>` or `<table>` | Better to unwrap |
| `<main>` | ⚠️ Works | Use `<div>` or `<table>` | Better to unwrap |
| `<figure>` | ⚠️ Works | Use `<div>` | Better to unwrap |
| `<figcaption>` | ⚠️ Works | Use `<div>` | Better to unwrap |

---

## 📱 OUTLOOK VERSION DIFFERENCES

### **Outlook Desktop (Windows)**
- Uses **Microsoft Word HTML rendering engine**
- **Most limited** CSS support
- No flexbox, grid, transforms, animations
- No border-radius, box-shadow
- Design for this version for maximum compatibility

### **Outlook Web (OWA)**
- Uses **modern browser engine** (Edge/Chrome)
- **Better** CSS support
- Supports flexbox, grid (but still avoid for compatibility)
- Supports border-radius, box-shadow
- Still strips `<script>` and external resources

### **Outlook Mobile (iOS/Android)**
- Uses **native mobile browser engine**
- **Good** CSS support
- Similar to Outlook Web
- Responsive design works better here

### **Outlook for Mac**
- Uses **WebKit rendering engine**
- **Better** CSS support than Windows version
- More similar to Apple Mail
- Still avoid modern CSS for cross-platform compatibility

---

## 🎯 BEST PRACTICES FOR OUTLOOK EMAILS

### **1. Use Tables for Layout**
```html
<!-- ✅ GOOD: Table-based layout -->
<table cellpadding="0" cellspacing="0" border="0" width="600">
  <tr>
    <td style="padding:20px; background-color:#f0f0f0;">
      Content here
    </td>
  </tr>
</table>

<!-- ❌ BAD: Flexbox layout -->
<div style="display:flex; gap:20px;">
  <div>Content</div>
</div>
```

### **2. Use Inline Styles Only**
```html
<!-- ✅ GOOD: Inline styles -->
<td style="padding:10px; background-color:#fff; color:#333;">

<!-- ❌ BAD: External stylesheet -->
<link rel="stylesheet" href="styles.css">

<!-- ❌ BAD: Style block -->
<style>
  .card { padding: 10px; }
</style>
```

### **3. Use Web-Safe Fonts**
```css
/* ✅ GOOD: Web-safe fonts */
font-family: Arial, Helvetica, sans-serif;
font-family: Georgia, Times, serif;
font-family: 'Courier New', Courier, monospace;

/* ⚠️ RISKY: Custom fonts */
font-family: 'Roboto', sans-serif; /* May not load */
```

### **4. Use Absolute Color Values**
```css
/* ✅ GOOD: Absolute colors */
color: #ff0000;
background-color: rgb(255, 0, 0);
background-color: rgba(255, 0, 0, 0.5);

/* ❌ BAD: CSS variables */
color: var(--primary);
background-color: var(--bg);
```

### **5. Use Fixed Widths**
```html
<!-- ✅ GOOD: Fixed width -->
<table width="600" cellpadding="0" cellspacing="0">

<!-- ⚠️ RISKY: Percentage width (can work but test) -->
<table width="100%" cellpadding="0" cellspacing="0">

<!-- ❌ BAD: Flexbox/Grid -->
<div style="display:grid; grid-template-columns:1fr 1fr;">
```

### **6. Use Images for Complex Visuals**
```html
<!-- ✅ GOOD: Use images for rounded corners, shadows, gradients -->
<img src="button-with-shadow.png" alt="Click Here" />

<!-- ❌ BAD: CSS effects -->
<div style="border-radius:10px; box-shadow:0 2px 8px rgba(0,0,0,0.1);">
```

### **7. Test in Multiple Clients**
- ✅ Outlook Desktop (Windows)
- ✅ Outlook Web
- ✅ Gmail
- ✅ Apple Mail
- ✅ Mobile devices

---

## 🔧 TRANSFORMATION RULES

Our `inlineHtmlForOutlook()` function automatically handles these conversions:

| Input | Output | Reason |
|-------|--------|--------|
| `var(--bg)` | `#0c0f1a` | Resolve CSS variables |
| `display:grid` | `<table>` | Convert to table layout |
| `display:flex` | `<table>` | Convert to table layout |
| `gap:20px` | `padding:20px` on cells | Convert gap to padding |
| `box-shadow:...` | *removed* | Not supported |
| `border-radius:...` | *removed* | Not supported |
| `<script>` | *removed* | Security risk |
| `<style>` | *removed* (after inlining) | Not needed |
| `class="..."` | *removed* | Outlook prefixes with `x_` |
| `<video>` | Placeholder div | Not supported |
| `<nav>` | Unwrapped (children kept) | Semantic tag |

---

## 📊 COMPATIBILITY MATRIX

| Feature | Outlook Desktop | Outlook Web | Gmail | Apple Mail | Yahoo |
|---------|----------------|-------------|-------|------------|-------|
| **Tables** | ✅ Full | ✅ Full | ✅ Full | ✅ Full | ✅ Full |
| **Inline Styles** | ✅ Full | ✅ Full | ✅ Full | ✅ Full | ✅ Full |
| **Flexbox** | ❌ No | ✅ Yes | ⚠️ Partial | ✅ Yes | ❌ No |
| **Grid** | ❌ No | ✅ Yes | ❌ No | ✅ Yes | ❌ No |
| **CSS Variables** | ❌ No | ❌ No | ❌ No | ✅ Yes | ❌ No |
| **Border-radius** | ❌ No | ✅ Yes | ✅ Yes | ✅ Yes | ✅ Yes |
| **Box-shadow** | ❌ No | ✅ Yes | ✅ Yes | ✅ Yes | ⚠️ Partial |
| **Background Images** | ⚠️ Blocked | ⚠️ Blocked | ⚠️ Blocked | ✅ Yes | ⚠️ Blocked |
| **Media Queries** | ❌ No | ✅ Yes | ✅ Yes | ✅ Yes | ⚠️ Partial |
| **JavaScript** | ❌ Blocked | ❌ Blocked | ❌ Blocked | ❌ Blocked | ❌ Blocked |

---

## 🎨 RECOMMENDED EMAIL STRUCTURE

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Email Title</title>
</head>
<body style="margin:0; padding:0; background-color:#f0f0f0; font-family:Arial,sans-serif;">
  
  <!-- Wrapper Table -->
  <table cellpadding="0" cellspacing="0" border="0" width="100%" style="background-color:#f0f0f0;">
    <tr>
      <td align="center" style="padding:20px;">
        
        <!-- Content Table (600px max width) -->
        <table cellpadding="0" cellspacing="0" border="0" width="600" style="background-color:#ffffff;">
          
          <!-- Header -->
          <tr>
            <td style="padding:20px; background-color:#0078d4; color:#ffffff; text-align:center;">
              <h1 style="margin:0; font-size:24px;">Email Header</h1>
            </td>
          </tr>
          
          <!-- Body -->
          <tr>
            <td style="padding:20px; color:#333333; font-size:14px; line-height:1.6;">
              <p style="margin:0 0 15px 0;">Email content goes here.</p>
              <p style="margin:0 0 15px 0;">Use tables for layout, inline styles for formatting.</p>
            </td>
          </tr>
          
          <!-- Footer -->
          <tr>
            <td style="padding:20px; background-color:#f0f0f0; color:#666666; font-size:12px; text-align:center;">
              <p style="margin:0;">© 2026 Your Company. All rights reserved.</p>
            </td>
          </tr>
          
        </table>
        
      </td>
    </tr>
  </table>
  
</body>
</html>
```

---

## 📚 ADDITIONAL RESOURCES

- [Outlook CSS Support](https://www.campaignmonitor.com/css/style-element/style-in-head/)
- [Email Client CSS Support](https://www.caniemail.com/)
- [Litmus Email Testing](https://www.litmus.com/)
- [Email on Acid](https://www.emailonacid.com/)

---

## ✅ SUMMARY

**For maximum Outlook compatibility:**

1. ✅ Use `<table>` for all layouts
2. ✅ Use inline styles only
3. ✅ Use web-safe fonts
4. ✅ Use absolute color values (hex, RGB)
5. ✅ Avoid flexbox, grid, positioning
6. ✅ Avoid box-shadow, border-radius, transforms
7. ✅ Avoid JavaScript, external CSS, iframes
8. ✅ Test in Outlook Desktop (most restrictive)
9. ✅ Use our transformation function for modern CSS
10. ✅ Keep emails under 100KB total size

**Remember:** Email HTML is like web development from 1999 - tables, inline styles, and basic CSS only! 🕰️
