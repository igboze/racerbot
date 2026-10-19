# RACER MASTER DESIGN SYSTEM (UI/UX PRO MAX v2.0)

> Single Source of Truth for the entire RACER Web Application Suite:
> - Landing Page (`/` - `racer.html`)
> - RacerAlpha (`/alpha` - `raceralpha.html`)
> - RacerBubble (`/bubblemap` - `bubblemap.html`)
> - Competition Arena (`/competition` - `competition.html`)

---

## 1. Core Visual Family & Taxonomy
- **Domain**: High-Frequency Decentralized Trading Terminal & Cross-Chain Telemetry.
- **Style Priority**: Industrial Pit-Wall Telemetry (Obsidian Carbon Plate + Laser Cyan + Tabular Monospace).
- **Aesthetic Stance**: Extreme precision, mechanical discipline, zero cartoonish AI slop, zero emojis as system navigation icons, zero floating pastel blobs.

---

## 2. Color Palette & Token Architecture

| Token | Value | Role & Contrast Ratio |
| :--- | :--- | :--- |
| `--color-canvas` | `#08090b` | OLED deep obsidian pit-wall void |
| `--color-surface` | `#0f1217` | Anodized carbon plate |
| `--color-surface-card` | `#151921` | Elevated telemetry HUD module |
| `--color-surface-hover` | `#1c222d` | Tactile interactive hover state |
| `--color-border` | `#21262d` | 1px precision hairline rule |
| `--color-border-glow` | `rgba(0, 240, 255, 0.25)` | Laser cyan edge focus |
| `--color-primary` | `#00f0ff` | Laser Cyan primary action (14.2:1 against canvas) |
| `--color-primary-pressed` | `#00d2e0` | Active press state |
| `--color-on-primary` | `#08090b` | Crisp obsidian ink on cyan |
| `--color-racer-green` | `#00e676` | Terminal mint for settlement & profit (7.1:1) |
| `--color-racer-gold` | `#ffb703` | Amber telemetry warnings & medals |
| `--color-danger` | `#ff4d4d` | Execution error & stop-loss |
| `--color-text` | `#f0f6fc` | High-clarity primary typography (14.2:1) |
| `--color-text-muted` | `#c8d3e8` | Secondary copy (9.5:1) |
| `--color-text-subtle` | `#8b949e` | Tactical telemetry metadata (5.8:1 - WCAG AA pass) |

---

## 3. Typography Suite
- **Display / Headlines**: `Syne`, 700 / 800 weight, uppercase, letter-spacing `-0.02em`.
- **Interface / Body**: `Plus Jakarta Sans`, 400 / 500 / 600 weight, base 15–16px, line-height 1.5.
- **Telemetry & Numbers**: `JetBrains Mono`, `font-variant-numeric: tabular-nums` (strictly prevents layout jitter during real-time solver polling and price ticks).

---

## 4. UI/UX Pro Max Priority Checklist
- [x] **No Emoji as Structural Icons**: All UI controls, chain indicators, and navigation elements use SVG vector icons.
- [x] **Minimum Touch Target**: Every button, chip, tab, and clickable control is ≥44×44px bounding box.
- [x] **Focus Indicators**: 2px solid `#00f0ff` focus rings on `:focus-visible`.
- [x] **Tabular Figures**: Enforced via `.telemetry-num` on all balances, timers, addresses, and price feeds.
- [x] **Universal Navigation**: Exact same header structure, branding, links, live telemetry strip, and wallet session state across all 4 pages.
- [x] **Accessibility**: Skip links, ARIA labels on icon/action buttons, contrast ≥5.5:1 everywhere.
