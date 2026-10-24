---
version: "3.0"
name: "RacerBot Intelligence Terminal"
description: "Canonical design system specification for the RacerBot multi-chain trading intelligence and execution platform. Combines a restrained dark terminal aesthetic, high-contrast financial data visualization, precision mechanical controls, tabular monospace typography, and a mobile-first responsive architecture."

colors:
  # Backgrounds & Canvases
  background-main: "#0B0D10"
  background-secondary: "#11151B"
  surface-primary: "#151A21"
  surface-elevated: "#1B222B"
  surface-hover: "#222B36"
  surface-active: "#2A3542"

  # Borders & Hairlines
  border-default: "#27303A"
  border-strong: "#394452"
  border-subtle: "rgba(255, 255, 255, 0.06)"
  border-focus: "#00F0FF"

  # Core Accents
  brand-accent: "#00F0FF"
  brand-accent-pressed: "#00D2E0"
  brand-accent-subtle: "rgba(0, 240, 255, 0.12)"
  brand-secondary: "#2563EB"
  brand-secondary-subtle: "rgba(37, 99, 235, 0.15)"
  
  # Semantic Trading Signals
  positive: "#36D399"
  positive-subtle: "rgba(54, 211, 153, 0.12)"
  negative: "#F87171"
  negative-subtle: "rgba(248, 113, 113, 0.12)"
  warning: "#FBBF24"
  warning-subtle: "rgba(251, 191, 36, 0.12)"
  info: "#60A5FA"
  info-subtle: "rgba(96, 165, 250, 0.12)"

  # Text & Typography
  text-primary: "#F2F5F8"
  text-secondary: "#96A0AE"
  text-muted: "#737F8F"

typography:
  fontFamilySans: "'Plus Jakarta Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"
  fontFamilyMono: "'JetBrains Mono', monospace"
  
  scale:
    page-title: "28px (32px on desktop)"
    section-title: "20px"
    card-title: "15px"
    body-regular: "14px"
    body-small: "12px"
    mono-data: "13px (tabular figures)"
    telemetry-lg: "28px"

spacing:
  base: 4px
  scale: [4, 8, 12, 16, 20, 24, 32, 40, 48, 64]

geometry:
  radius-control: "6px"
  radius-button: "8px"
  radius-card: "10px"
  radius-modal: "14px"
  radius-full: "9999px"

elevation:
  shadow-card: "0 2px 10px rgba(0, 0, 0, 0.4), 0 0 1px #27303A"
  shadow-elevated: "0 12px 32px rgba(0, 0, 0, 0.7), 0 0 24px rgba(0, 240, 255, 0.08)"
---

# RACERBOT INTELLIGENCE TERMINAL — PRODUCT DESIGN SYSTEM

## 1. Overview & Visual Direction
RacerBot is a professional-grade multi-chain trading intelligence and execution platform.
The aesthetic direction is **Restrained Dark Terminal**:
- High-contrast financial typography with tabular numbers.
- Structured, purposeful layouts prioritizing data clarity and transaction predictability.
- No decorative purple gradient soup, no generic AI-generated SaaS clutter, and **zero tacky emojis** in primary interfaces.
- One unified application shell uniting all five product routes: Home (`/`), Bubble Map (`/bubblemap`), Alpha (`/alpha`), Fleet (`/fleet`), and Competition (`/competition`).

---

## 2. Color System & Usage Rules

### Surfaces
- `background-main` (`#0B0D10`): Main application canvas.
- `background-secondary` (`#11151B`): Shell sidebars, navigation docks, and page wells.
- `surface-primary` (`#151A21`): Primary cards, graph control toolbars, tables, and modal bodies.
- `surface-elevated` (`#1B222B`): Flyouts, inspector drawers, dropdowns, and hovered items.

### Borders
- `border-default` (`#27303A`): 1px structural boundaries between panes and cards.
- `border-strong` (`#394452`): Form inputs, selected card boundaries, and key control dividers.
- `border-focus` (`#00F0FF`): Active keyboard focus and primary active tabs.

### Accents & Trading Signals
- `brand-accent` (`#00F0FF`): Laser cyan used selectively for primary execution buttons, selected navigation, active tabs, and telemetry status dots.
- `positive` (`#36D399`): Buys, positive PnL percentages, successful transaction badges.
- `negative` (`#F87171`): Sells, negative PnL percentages, stop-loss triggers, error alerts.
- `warning` (`#FBBF24`): Sensitive operations (e.g. private key export review), high slippage warnings.
- `info` (`#60A5FA`): Verified network indicators, transaction hashes, neutral protocol tags.

*Strict Rule*: Do not use every accent color simultaneously. Never communicate state through color alone — always accompany with text or icons.

---

## 3. Typography & Numerical Representation
- **Sans-Serif (`Plus Jakarta Sans`)**: Used for brand markings, navigation links, section titles, explanatory paragraphs, button labels, and badges.
- **Monospace (`JetBrains Mono`)**: Mandatory for all wallet addresses (truncated or full), transaction hashes, prices, balances, slippage values, timestamp logs, and tabular data tables.
- **Numerical Alignment**: Always use `font-variant-numeric: tabular-nums` to prevent jumping numbers during live quote updates.

---

## 4. Component Standards

### Buttons
- **Primary (`.btn-primary`)**: Solid Laser Cyan (`#00F0FF`) with dark obsidian text (`#020817`), `font-weight: 700`, 8px radius. Min height 42px.
- **Secondary (`.btn-secondary`)**: Elevated surface (`#1B222B`), 1px `#27303A` border, white text (`#F2F5F8`). Hover transitions to `#222B36`.
- **Trading Action (`.btn-buy`, `.btn-sell`)**: Solid `#36D399` and `#F87171` respectively with white text and bold typography.
- **Ghost (`.btn-ghost`)**: Transparent background with hover fill `rgba(0, 240, 255, 0.08)`.

### Form Controls & Inputs
- Height 42px (min 44px on mobile), `#151A21` background, 1px `#27303A` border, `#F2F5F8` text.
- Focused state: 1px `#00F0FF` border with subtle cyan focus ring.
- Never use font-size smaller than 16px on mobile form inputs to eliminate iOS Safari auto-zoom.

### Tables & Data Grids
- Desktop: Monospace tabular columns, sticky headers with 1px `#27303A` border, clean hover highlight.
- Mobile: Transform into compact structured cards or provide horizontal touch scroll with sticky first column.

### Modals & Drawers
- Desktop: Centered dialogs with `#151A21` background, 1px `#27303A` border, subtle blur backdrop (`rgba(11, 13, 16, 0.8)`).
- Mobile: Ergonomic bottom sheets (`border-radius: 14px 14px 0 0`) with drag handles and safe area bottom padding.

---

## 5. Mobile Interaction Patterns
- **Application Shell**: Desktop permanent sidebar disappears; replaced by compact sticky top bar + bottom navigation dock (Home, Bubble Map, Alpha, Fleet, Arena).
- **Touch Targets**: Minimum 44px × 44px for all primary actions.
- **Single-Handed Operability**: Bottom-aligned primary CTAs, segmented tab switchers, and swipe-dismissible sheets.
- **Zero Horizontal Overflow**: All tables, code snippets, and metrics grids must reflow or use dedicated card wrappers without breaking viewport width.

---

## 6. Route Architecture
1. **`/` (Home)**: Market context, trading volume, trending tokens, live activity feed, and instant workspace shortcuts.
2. **`/bubblemap?token=...`**: Token & wallet intelligence flagship. Direct graph canvas, token header, risk metrics, wallet inspector drawer, cluster legend.
3. **`/alpha`**: Trader directory, strategy cards, 4-stage copy-trading flow (Configure → Review → Confirm), open positions, and separated Creator Studio.
4. **`/fleet`**: Multi-wallet cockpit. Wallet matrix, 3-stage coordinated trading (Configure → Review → Execute), capital management (disburse/sweep), sensitive key handling with confirmation gating.
5. **`/competition`**: Active reward program & snapshot arena. Personal standings, verified wallet leaderboard, prize breakdown, plain-language scoring rules.
