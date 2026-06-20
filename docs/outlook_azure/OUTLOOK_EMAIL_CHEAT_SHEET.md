# 📧 Outlook Email CSS Cheat Sheet

Quick reference for email development with Outlook compatibility.

---

## ✅ SAFE TO USE (Works Everywhere)

```css
/* Text & Fonts */
color: #ff0000;
font-family: Arial, sans-serif;
font-size: 14px;
font-weight: bold;
font-style: italic;
text-align: center;
text-decoration: underline;
line-height: 1.5;
letter-spacing: 1px;
text-transform: uppercase;

/* Backgrounds */
background-color: #f0f0f0;
background: #ffffff;

/* Box Model */
width: 600px;
height: 200px;
padding: 10px;
padding-top: 10px;
margin: 10px;
margin-bottom: 20px;

/* Borders */
border: 1px solid #ddd;
border-top: 2px solid #000;
border-color: #333;
border-style: solid;
border-width: 1px;

/* Display */
display: block;
display: inline;
display: inline-block;
display: table;
display: table-cell;
display: none;
visibility: hidden;

/* Tables */
vertical-align: middle;
border-collapse: collapse;
border-spacing: 0;
```

---

## ❌ NEVER USE (Doesn't Work in Outlook)

```css
/* Modern Layout */
display: flex;           /* ❌ Use <table> instead */
display: grid;           /* ❌ Use <table> instead */
flex-direction: row;     /* ❌ Not supported */
justify-content: center; /* ❌ Use align="center" */
align-items: center;     /* ❌ Use valign="middle" */
gap: 20px;              /* ❌ Use padding on cells */

/* Positioning */
position: absolute;      /* ❌ Not supported */
position: relative;      /* ❌ Not supported */
position: fixed;         /* ❌ Not supported */
top: 10px;              /* ❌ Not supported */
left: 10px;             /* ❌ Not supported */
z-index: 10;            /* ❌ Not supported */
float: left;            /* ⚠️ Buggy, avoid */

/* Visual Effects */
box-shadow: 0 2px 8px rgba(0,0,0,0.1);  /* ❌ Not supported */
border-radius: 10px;                     /* ❌ Not supported */
opacity: 0.5;                            /* ❌ Not supported */
filter: blur(5px);                       /* ❌ Not supported */

/* Transforms & Animations */
transform: rotate(45deg);  /* ❌ Not supported */
transition: all 0.3s;      /* ❌ Not supported */
animation: slide 1s;       /* ❌ Not supported */

/* Advanced CSS */
var(--primary);           /* ❌ Use actual values */
calc(100% - 20px);        /* ❌ Calculate manually */
min(100px, 50%);          /* ❌ Use fixed values */

/* Pseudo-classes */
:hover                    /* ⚠️ Outlook Web only */
:active                   /* ❌ Not supported */
:focus                    /* ❌ Not supported */
::before                  /* ❌ Use real elements */
::after                   /* ❌ Use real elements */
```

---

## 🔄 CONVERSIONS (What Our Function Does)

| Modern CSS | Outlook-Compatible | How |
|------------|-------------------|-----|
| `var(--bg)` | `#0c0f1a` | Resolve to actual value |
| `display: grid` | `<table>` | Convert to table layout |
| `display: flex` | `<table>` | Convert to table layout |
| `gap: 20px` | `padding: 20px` | Apply to table cells |
| `box-shadow: ...` | *removed* | Not supported |
| `border-radius: ...` | *removed* | Not supported |
| `<script>` | *removed* | Security risk |
| `class="card"` | *removed* | Outlook prefixes with `x_` |

---

## 📐 LAYOUT PATTERNS

### ✅ Two-Column Layout (Table)
```html
<table cellpadding="0" cellspacing="0" border="0" width="600">
  <tr>
    <td width="50%" style="padding:10px; vertical-align:top;">
      Left column
    </td>
    <td width="50%" style="padding:10px; vertical-align:top;">
      Right column
    </td>
  </tr>
</table>
```

### ✅ Centered Content
```html
<table cellpadding="0" cellspacing="0" border="0" width="100%">
  <tr>
    <td align="center" style="padding:20px;">
      <table cellpadding="0" cellspacing="0" border="0" width="600">
        <tr>
          <td>Centered content (max 600px)</td>
        </tr>
      </table>
    </td>
  </tr>
</table>
```

### ✅ Button (Link Styled as Button)
```html
<table cellpadding="0" cellspacing="0" border="0">
  <tr>
    <td style="background-color:#0078d4; padding:12px 24px; text-align:center;">
      <a href="https://example.com" style="color:#ffffff; text-decoration:none; font-weight:bold; font-size:14px;">
        Click Here
      </a>
    </td>
  </tr>
</table>
```

### ✅ Spacer (Vertical Space)
```html
<table cellpadding="0" cellspacing="0" border="0" width="100%">
  <tr>
    <td style="height:20px; line-height:20px; font-size:1px;">&nbsp;</td>
  </tr>
</table>
```

---

## 🎨 COLOR FORMATS

```css
/* ✅ All work in Outlook */
color: #ff0000;                    /* Hex */
color: #f00;                       /* Short hex */
color: rgb(255, 0, 0);            /* RGB */
color: rgba(255, 0, 0, 0.5);      /* RGBA */
color: red;                        /* Named color */

/* ❌ Don't use */
color: var(--primary);             /* CSS variable */
color: hsl(0, 100%, 50%);         /* HSL (limited support) */
```

---

## 📏 SIZE UNITS

```css
/* ✅ Safe units */
width: 600px;        /* Pixels (best) */
width: 50%;          /* Percentage (works) */
font-size: 14pt;     /* Points (works) */
font-size: 1em;      /* Em (works) */

/* ⚠️ Avoid */
width: 50vw;         /* Viewport units (not supported) */
width: 10rem;        /* Rem (not supported) */
width: calc(100% - 20px);  /* Calc (not supported) */
```

---

## 🖼️ IMAGES

```html
<!-- ✅ GOOD: Inline image with alt text -->
<img src="https://example.com/image.jpg" 
     alt="Description" 
     width="600" 
     height="400" 
     style="display:block; border:0; max-width:100%;" />

<!-- ⚠️ Background images (may be blocked) -->
<td style="background-image:url(image.jpg); background-size:cover; width:600px; height:400px;">
  <!-- Fallback content -->
</td>

<!-- ❌ BAD: Relative paths -->
<img src="./images/logo.png" />  <!-- Won't work -->

<!-- ❌ BAD: SVG (limited support) -->
<img src="logo.svg" />  <!-- Use PNG/JPG instead -->
```

---

## 🔗 LINKS

```html
<!-- ✅ GOOD: Simple link -->
<a href="https://example.com" style="color:#0078d4; text-decoration:underline;">
  Click here
</a>

<!-- ✅ GOOD: Button-style link -->
<a href="https://example.com" style="display:inline-block; background-color:#0078d4; color:#ffffff; padding:12px 24px; text-decoration:none; font-weight:bold;">
  Click Here
</a>

<!-- ❌ BAD: JavaScript links -->
<a href="javascript:void(0)" onclick="doSomething()">  <!-- Won't work -->

<!-- ❌ BAD: Anchor links (unreliable) -->
<a href="#section">Jump to section</a>  <!-- May not work -->
```

---

## 📱 RESPONSIVE (Limited Support)

```html
<!-- ⚠️ Media queries work in Outlook Web/Mobile, not Desktop -->
<style>
  @media (max-width: 600px) {
    .mobile-full { width: 100% !important; }
  }
</style>

<!-- ✅ Better: Fluid tables -->
<table cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:600px;">
  <tr>
    <td style="padding:10px;">
      Content scales naturally
    </td>
  </tr>
</table>
```

---

## 🚫 BLOCKED ELEMENTS

```html
<!-- ❌ These are stripped/blocked -->
<script>...</script>              <!-- JavaScript blocked -->
<iframe src="..."></iframe>       <!-- iframes blocked -->
<form>...</form>                  <!-- Forms limited -->
<input type="text" />             <!-- Inputs blocked -->
<video>...</video>                <!-- Video blocked -->
<audio>...</audio>                <!-- Audio blocked -->
<canvas>...</canvas>              <!-- Canvas blocked -->
<svg>...</svg>                    <!-- SVG limited support -->
<link rel="stylesheet" />         <!-- External CSS blocked -->
<style>...</style>                <!-- Removed after inlining -->
```

---

## ✅ SAFE HTML STRUCTURE

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Email</title>
</head>
<body style="margin:0; padding:0; background-color:#f0f0f0; font-family:Arial,sans-serif;">
  
  <table cellpadding="0" cellspacing="0" border="0" width="100%">
    <tr>
      <td align="center" style="padding:20px;">
        
        <table cellpadding="0" cellspacing="0" border="0" width="600" style="background-color:#ffffff;">
          <tr>
            <td style="padding:20px;">
              <!-- Content here -->
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

## 🎯 QUICK RULES

1. ✅ **Use tables** for all layouts
2. ✅ **Inline styles** only (no `<style>` blocks or external CSS)
3. ✅ **Web-safe fonts** (Arial, Georgia, Courier)
4. ✅ **Absolute colors** (hex, RGB, not CSS variables)
5. ✅ **Fixed widths** (600px max for desktop)
6. ❌ **No flexbox/grid** (use tables)
7. ❌ **No JavaScript** (always blocked)
8. ❌ **No box-shadow/border-radius** (use images)
9. ❌ **No positioning** (absolute/relative/fixed)
10. ❌ **No animations** (use animated GIFs)

---

## 🔧 TESTING CHECKLIST

- [ ] Test in **Outlook Desktop** (Windows) - most restrictive
- [ ] Test in **Outlook Web** - better CSS support
- [ ] Test in **Gmail** - strips many CSS properties
- [ ] Test in **Apple Mail** - best CSS support
- [ ] Test on **mobile devices** - responsive behavior
- [ ] Check **image loading** - may be blocked by default
- [ ] Verify **links work** - all clickable
- [ ] Test **dark mode** - if applicable
- [ ] Check **file size** - keep under 100KB
- [ ] Validate **HTML** - proper structure

---

## 📊 COMPATIBILITY QUICK VIEW

| Feature | Outlook Desktop | Outlook Web | Gmail | Apple Mail |
|---------|----------------|-------------|-------|------------|
| Tables | ✅ | ✅ | ✅ | ✅ |
| Inline CSS | ✅ | ✅ | ✅ | ✅ |
| Flexbox | ❌ | ✅ | ⚠️ | ✅ |
| Grid | ❌ | ✅ | ❌ | ✅ |
| Border-radius | ❌ | ✅ | ✅ | ✅ |
| Box-shadow | ❌ | ✅ | ✅ | ✅ |
| Media Queries | ❌ | ✅ | ✅ | ✅ |

**Legend:** ✅ Full Support | ⚠️ Partial Support | ❌ No Support

---

## 💡 PRO TIPS

1. **Design for Outlook Desktop first** - if it works there, it works everywhere
2. **Use images for complex visuals** - rounded corners, shadows, gradients
3. **Test with images blocked** - many users block images by default
4. **Keep it simple** - complex layouts often break
5. **Use alt text** - for accessibility and when images don't load
6. **Optimize images** - compress for faster loading
7. **Use web-safe fonts** - Arial, Georgia, Times, Courier
8. **Avoid tiny text** - minimum 12px font size
9. **Use high contrast** - for readability
10. **Test, test, test!** - in multiple clients and devices

---

## 🚀 READY TO USE

Your `dashboard.html` already has the transformation function that automatically converts modern CSS to Outlook-compatible HTML!

Just click **"Send via Outlook"** and it handles everything automatically:
- ✅ Resolves CSS variables
- ✅ Converts grid/flex to tables
- ✅ Removes unsupported properties
- ✅ Cleans up the HTML

**No extra work needed!** 🎉
