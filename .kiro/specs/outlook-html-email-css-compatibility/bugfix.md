# Bugfix Requirements Document

## Introduction

When saving HTML emails as drafts in Outlook via the dashboard.html email composer, the HTML content uses modern CSS features (display: grid, display: flex, CSS variables) that are not supported by Outlook's email rendering engine. The `inlineHtmlForOutlook()` function successfully inlines CSS into style="" attributes but preserves these unsupported properties, causing the email layout to break when viewed in Outlook desktop and web clients.

This bugfix addresses the CSS compatibility issue by converting unsupported CSS properties to Outlook-compatible alternatives, ensuring emails render correctly across all Outlook clients.

## Bug Analysis

### Current Behavior (Defect)

1.1 WHEN HTML content contains `display: grid` layout properties THEN the system inlines the CSS but preserves `display: grid` in style attributes, which Outlook strips, causing the layout to break completely

1.2 WHEN HTML content contains `display: flex` layout properties THEN the system inlines the CSS but preserves `display: flex` in style attributes, which Outlook strips, causing the layout to break completely

1.3 WHEN HTML content contains CSS variables like `var(--bg)`, `var(--card)`, `var(--primary)` THEN the system inlines the CSS but preserves the CSS variable syntax, which Outlook ignores, causing colors and styling to not render

1.4 WHEN HTML content contains `border-radius` properties THEN the system inlines the CSS but preserves `border-radius`, which desktop Outlook does not support, causing rounded corners to not render

1.5 WHEN HTML content contains `box-shadow` properties THEN the system inlines the CSS but preserves `box-shadow`, which Outlook does not support, causing shadows to not render

1.6 WHEN the `inlineHtmlForOutlook()` function processes the HTML THEN it logs warnings about unsupported CSS properties (grid, flex, CSS variables, box-shadow) but does not transform them into Outlook-compatible alternatives

### Expected Behavior (Correct)

2.1 WHEN HTML content contains `display: grid` layout properties THEN the system SHALL convert the grid layout to an Outlook-compatible `<table>` based layout with equivalent visual structure

2.2 WHEN HTML content contains `display: flex` layout properties THEN the system SHALL convert the flex layout to an Outlook-compatible `<table>` based layout with equivalent visual structure

2.3 WHEN HTML content contains CSS variables like `var(--bg)`, `var(--card)`, `var(--primary)` THEN the system SHALL resolve and replace CSS variables with their actual color values from the CSS

2.4 WHEN HTML content contains `border-radius` properties THEN the system SHALL remove the `border-radius` property from inline styles for desktop Outlook compatibility

2.5 WHEN HTML content contains `box-shadow` properties THEN the system SHALL remove the `box-shadow` property from inline styles for Outlook compatibility

2.6 WHEN the `inlineHtmlForOutlook()` function processes the HTML THEN it SHALL transform all Outlook-unsupported CSS properties into compatible alternatives before returning the final HTML

### Unchanged Behavior (Regression Prevention)

3.1 WHEN HTML content contains Outlook-supported CSS properties (color, background-color, font-size, font-family, padding, margin, border, width, height) THEN the system SHALL CONTINUE TO inline these properties into style attributes without modification

3.2 WHEN HTML content contains `<style>`, `<script>`, `<link>` tags THEN the system SHALL CONTINUE TO remove them after CSS inlining

3.3 WHEN HTML content contains class attributes THEN the system SHALL CONTINUE TO remove them (since Outlook prefixes them with x_ breaking selectors)

3.4 WHEN HTML content contains unsupported HTML5 tags (video, audio, canvas, iframe, object, embed) THEN the system SHALL CONTINUE TO replace them with placeholder divs

3.5 WHEN HTML content contains semantic HTML5 tags (nav, header, footer, aside, article, section, main, figure) THEN the system SHALL CONTINUE TO unwrap them while preserving their children

3.6 WHEN the email composer has no HTML embeds (no `[data-html-uid]` elements) THEN the system SHALL CONTINUE TO send the editor content directly without CSS inlining

3.7 WHEN the `getEmailBodyForSend()` function processes multiple HTML embeds THEN the system SHALL CONTINUE TO process them sequentially and replace each wrapper with the inlined HTML
