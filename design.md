---
name: "Racer Design System"
description: "Canonical design system specification for Racer on NEAR. Dark theme only, high-contrast financial data visualization, DM Sans and JetBrains Mono typography, and MiniDash responsive architecture."

colors:
  bg: "#0F1320"
  surface: "#161B2C"
  surface-2: "#1D2338"
  border: "#2A3149"
  border-input: "#6B7490"
  text: "#F1F4FA"
  text-2: "#A3ABC2"
  neutral: "#6B7490"
  primary: "#6ACCDC"
  primary-hover: "#8BD9E6"
  primary-tint: "rgba(106, 204, 220, 0.12)"
  on-primary: "#0F1320"
  brand-purple: "#7860A9"
  purple-text: "#A992D6"
  success: "#34D399"
  warning: "#F0AD4E"
  error: "#FF6B73"
  error-solid: "#DF2935"
  chip-pos-bg: "#0E2A24"
  chip-neg-bg: "#33171D"
  chip-warn-bg: "#33260F"
  chip-neutral-bg: "#1D2338"
  viz-purple: "#A992D6"
  viz-teal: "#4F818D"

typography:
  display:
    fontFamily: "'DM Sans', system-ui, sans-serif"
    fontSize: "40px"
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: "-0.02em"
  headline:
    fontFamily: "'DM Sans', system-ui, sans-serif"
    fontSize: "32px"
    fontWeight: 700
    lineHeight: 1.2
  title:
    fontFamily: "'DM Sans', system-ui, sans-serif"
    fontSize: "24px"
    fontWeight: 700
    lineHeight: 1.2
  subtitle:
    fontFamily: "'DM Sans', system-ui, sans-serif"
    fontSize: "18px"
    fontWeight: 700
    lineHeight: 1.3
  body:
    fontFamily: "'DM Sans', system-ui, sans-serif"
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 1.5
  body-small:
    fontFamily: "'DM Sans', system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.5
  caption:
    fontFamily: "'DM Sans', system-ui, sans-serif"
    fontSize: "12px"
    fontWeight: 500
    lineHeight: 1.4
  overline:
    fontFamily: "'DM Sans', system-ui, sans-serif"
    fontSize: "10px"
    fontWeight: 700
    lineHeight: 1.4
  mono-data:
    fontFamily: "'JetBrains Mono', monospace"
    fontSize: "16px"
    fontWeight: 500
    lineHeight: 1.4
  mono-small:
    fontFamily: "'JetBrains Mono', monospace"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.4

rounded:
  xs: "4px"
  sm: "6px"
  md: "8px"
  lg: "12px"
  xl: "16px"
  full: "9999px"

spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "20px"
  2xl: "24px"
  3xl: "32px"
  4xl: "40px"
  5xl: "48px"

components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    rounded: "{rounded.md}"
    height: "44px"
    padding: "0 20px"
  button-primary-hover:
    backgroundColor: "{colors.primary-hover}"
    textColor: "{colors.on-primary}"
    rounded: "{rounded.md}"
  button-secondary:
    backgroundColor: "transparent"
    textColor: "{colors.text}"
    rounded: "{rounded.md}"
    height: "44px"
    padding: "0 20px"
  input:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.md}"
    height: "44px"
    padding: "0 14px"
  card:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.lg}"
    padding: "20px"
---

## Overview

Racer is a parent trading and analytics suite on NEAR Protocol comprising five sub-products:
1. **Racer Home** (`/`): Unified product discovery and market screener.
2. **Racer Alpha** (`/alpha`): Confidential trading, viewing keys, copy trading, and Creator Studio.
3. **RacerFleet** (`/fleet`): Parallel multi-wallet management, bundling, disbursements, and sweeps.
4. **RacerBubble** (`/bubblemap`): Interactive D3-powered bubble map and token cluster analytics.
5. **Racer Arena** (`/competition`): On-chain trading competitions, volume sprints, and reward epochs.

The visual direction is **Calm Dark Precision**:
- Grounded in logo Navy (`#0F1320`), with brand Cyan (`#6ACCDC`) as the single interactive action color.
- High-contrast tabular numbers, 44px touch targets, non-nested cards, and dark elevation with 1px border definitions over fuzzy drop shadows.
- No generic SaaS patterns, no neon glow, and zero UI emojis.

---

## Colors

The color palette is derived directly from the authoritative Racer logo badge:

### Ground & Surfaces
- `bg` (`#0F1320`): Core brand navy canvas across all pages.
- `surface` (`#161B2C`): Cards, panels, toolbars, modal windows, table containers.
- `surface-2` (`#1D2338`): Hover table rows, popovers, tooltips, neutral chips, elevated drawers.

### Borders & Dividing Lines
- `border` (`#2A3149`): 1px structural dividing lines and card outlines.
- `border-input` (`#6B7490`): Interactive form inputs, select dropdowns, and button outlines.

### Action & Accents
- `primary` (`#6ACCDC`): Brand cyan. The **ONLY** action color across buttons, links, active navigation tabs, selected chips, and focus rings.
- `primary-hover` (`#8BD9E6`): Hover state for primary cyan buttons.
- `on-primary` (`#0F1320`): Navy text on cyan fills for guaranteed 9.9:1 contrast.
- `brand-purple` (`#7860A9`): Accent for "You" chips, Pro tier badges, same-owner bubble clusters, and equity fills.
- `purple-text` (`#A992D6`): Purple text, lines, and icons on dark backgrounds.
- `viz-teal` (`#4F818D`): Muted logo mid-tone for DEX pools and LP nodes.

### Status & Trading Signals
- `success` (`#34D399`): Positive changes, buys, confirmed states (`+` and `▲`).
- `warning` (`#F0AD4E`): High slippage warnings, caution notes, whale bubbles.
- `error` (`#FF6B73`): Negative changes, sells, bundler clusters (`-` and `▼`).
- `error-solid` (`#DF2935`): Destructive action buttons (disconnect, sweep, emergency exit).

---

## Typography

- **Headings & Body UI**: Google Font **DM Sans** (weights 400, 500, 700). Letter spacing -0.02em on Display, normal elsewhere.
- **Financial & Tabular Data**: Google Font **JetBrains Mono** (weights 400, 500) with `font-variant-numeric: tabular-nums`. Right-aligned in data tables.
- **Hierarchy Scale**:
  - Display: 40px / 700 (28px on mobile).
  - Headline (H1): 32px / 700 (22px on mobile).
  - Title (H2): 24px / 700 (17px on mobile).
  - Subhead (H3): 18px / 700.
  - Body: 16px / 400 (13px on mobile).
  - Body small: 14px / 400 (12px on mobile).
  - Caption: 12px / 500 (11px on mobile).
  - Overline: 10px / 700 uppercase.
  - Mono Data: 13px - 22px / 500.

---

## Layout

- **Desktop Shell**: Sticky 60px top bar (`#161B2C`) with 32px Racer logo, center navigation (Alpha, Fleet, Bubble, Arena, RacerBot ↗), Deposit button, and unified wallet chip. Max container width 1200px centered with 24px side padding.
- **Mobile Shell**: Sticky 56px top bar (28px logo + wallet trigger) and 56px fixed bottom dock (Home, Alpha, Bubble, Fleet, Arena) with `padding-bottom: env(safe-area-inset-bottom)`.
- **Responsive Breakpoints**:
  - Mobile: 0 - 767px (12px side padding, 2-column widget grid with 8px gap).
  - Tablet: 768px - 1023px (Single main column, side panels shift to bottom sheets).
  - Desktop: 1024px+ (Multi-column flex layout with sticky 360px/380px inspector panels).
- Tables transform into structured card lists on mobile; zero horizontal page scrolling allowed.

---

## Elevation & Depth

- Dark mode flat architecture prioritizing crisp 1px borders (`#2A3149`) over blurred drop shadows.
- **Level 0 (Flat)**: Cards, table rows, and page canvas.
- **Level 2 (Popovers & Tooltips)**: `--color-surface-2` with 1px border and `box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4)`.
- **Level 3 (Modals & Bottom Sheets)**: `--color-surface` with 1px border, `box-shadow: 0 16px 40px rgba(0, 0, 0, 0.5)`, and `rgba(5, 8, 16, 0.7)` backdrop overlay.

---

## Shapes

- **Radius Scale**:
  - `4px`: Status chips, checkboxes, small indicators.
  - `6px`: Filter chips, tooltips.
  - `8px`: Buttons, text inputs, table wrappers.
  - `12px`: Content cards, panels, popover menus.
  - `16px`: Modal dialogs, bottom sheets (top corners), hero accents.
  - `9999px`: Avatars, status dots, toggle pills.
- Speed-line motif: static 3-line horizontal gradient fading from cyan to transparent in hero and empty states. No animation.

---

## Components

### Buttons
- Height 44px on all platforms for primary actions; min-width 100px.
- Primary: Cyan fill (`#6ACCDC`), Navy text (`#0F1320`), hover `#8BD9E6`.
- Secondary: Transparent fill, 1px `#6B7490` border, white text (`#F1F4FA`).
- Disabled: 40% opacity with visible tooltip/helper explanation.

### Form Inputs
- Height 44px, 14px horizontal padding, `#161B2C` background, 1px `#6B7490` border.
- Focus: 2px cyan border with 4px subtle glow ring (`rgba(106, 204, 220, 0.2)`).

### Metric Widgets (MiniDash)
- Large bold JetBrains Mono number at top, secondary label below (12px, `#A3ABC2`), optional trend arrow chip.
- Spans 1 cell in mobile 2-column grid; charts and tables span 2 columns.

### Bottom Sheets & Modals
- Desktop: 480px - 640px modal with focus trap, ESC dismiss, and backdrop tap close.
- Mobile: Bottom sheet with drag handle, 90vh max height, and pinned CTAs above the bottom dock.

---

## Do's and Don'ts

### Do's
- **Do** use `#6ACCDC` cyan exclusively for interactive actions.
- **Do** pair every red/green value with an explicit sign and directional arrow (`+` / `▲`, `-` / `▼`).
- **Do** format all financial figures in JetBrains Mono with `tabular-nums`.
- **Do** enforce 44px minimum height for buttons and touch targets.
- **Do** provide a 3-step review flow (Review -> Pending -> Confirmed) before executing any transaction.

### Don'ts
- **Don't** use blue (`#0052FF`, `#2563EB`) or light themes.
- **Don't** use emojis as interface icons. Use inline SVG icons exclusively.
- **Don't** use em dashes (`—`) or en dashes (`–`) in UI copy.
- **Don't** hardcode fake statistics, sample traders, or speculative claims.
- **Don't** use generic buzzwords ("institutional", "bank-grade", "zero-leak", "stealth").
