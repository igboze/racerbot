---
version: alpha
name: Notion-Racer-Design-System
description: "Racer high-performance trading suite design system based on Notion's sober-editorial architecture, humanist-geometric typography, 8px rectangular button geometry, 12px card scale, deep navy hero bands with diffuse workspace mockup elevation, and authentic Racer brand color palette."
sourceUrl: "https://notion.so"

colors:
  # Authentic Racer Brand Spectrum
  primary: "#5645d4" # Signature Racer/Notion Purple primary CTA
  primary-pressed: "#4534b3"
  primary-deep: "#3a2a99"
  on-primary: "#ffffff"
  
  # Authentic Racer Brand Accents
  racer-cyan: "#52cddc" # Electric Cyan speed arc
  racer-cyan-glow: "rgba(82, 205, 220, 0.35)"
  racer-purple: "#826ab5" # Racing Purple bolt
  racer-purple-light: "#9d84d6"
  racer-green: "#00d16a" # Matrix Mint / Terminal Green
  racer-gold: "#f59e0b" # Solar Gold

  # Notion Hero & Surface Palettes
  brand-navy: "#080c18" # Deep Cosmic Navy Hero Band
  brand-navy-deep: "#070f24" # Deeper Navy Promo/Header
  brand-navy-mid: "#0e1532" # Elevated Glass Surface
  canvas: "#080c18" # Main Canvas Dark
  surface: "#11172e" # Card Surface
  surface-card: "#141c38" # Elevated Card Surface
  surface-card-hover: "#182245"
  hairline: "rgba(255, 255, 255, 0.08)"
  hairline-soft: "rgba(255, 255, 255, 0.04)"
  hairline-strong: "rgba(82, 205, 220, 0.35)"
  border: "#1f2b52"

  # Pastel Database Property Card Tints (Adapted for Dark Mode Elevation)
  card-tint-peach: "rgba(255, 232, 212, 0.06)"
  card-tint-rose: "rgba(253, 224, 236, 0.06)"
  card-tint-mint: "rgba(217, 243, 225, 0.06)"
  card-tint-lavender: "rgba(230, 224, 245, 0.07)"
  card-tint-sky: "rgba(220, 236, 250, 0.07)"
  card-tint-yellow: "rgba(254, 247, 214, 0.06)"
  card-tint-yellow-bold: "rgba(249, 231, 159, 0.12)"

  # Text & Ink
  on-dark: "#ffffff"
  on-dark-muted: "#c8d3e8"
  text-subtle: "#8a99b5"
  ink: "#ffffff"
  charcoal: "#e0e6ed"
  steel: "#8a99b5"
  muted: "#5d6b82"

typography:
  fontFamily: "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Helvetica, sans-serif"
  hero-display:
    fontSize: 76px
    fontWeight: 600
    lineHeight: 1.05
    letterSpacing: -2px
  display-lg:
    fontSize: 54px
    fontWeight: 600
    lineHeight: 1.10
    letterSpacing: -1px
  heading-1:
    fontSize: 44px
    fontWeight: 600
    lineHeight: 1.15
    letterSpacing: -0.5px
  heading-2:
    fontSize: 34px
    fontWeight: 600
    lineHeight: 1.20
    letterSpacing: -0.5px
  heading-3:
    fontSize: 26px
    fontWeight: 600
    lineHeight: 1.25
  heading-4:
    fontSize: 20px
    fontWeight: 600
    lineHeight: 1.30
  heading-5:
    fontSize: 17px
    fontWeight: 600
    lineHeight: 1.40
  body-md:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.55
  body-sm:
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.50
  button-md:
    fontSize: 14px
    fontWeight: 500
    lineHeight: 1.30

rounded:
  xs: 4px
  sm: 6px
  md: 8px # BUTTONS ARE 8px RECTANGLES, NOT PILLS
  lg: 12px # CARDS & WORKSPACE MOCKUP
  xl: 16px
  xxl: 20px
  full: 9999px # BADGES & PILL TABS ONLY

spacing:
  base: 4px
  xxs: 4px
  xs: 8px
  sm: 12px
  md: 16px
  lg: 20px
  xl: 24px
  xxl: 32px
  section-sm: 48px
  section: 64px
  section-lg: 96px
  hero: 112px

components:
  button-primary:
    backgroundColor: "#5645d4"
    textColor: "#ffffff"
    rounded: "8px"
    padding: "10px 18px"
  button-secondary:
    backgroundColor: "transparent"
    textColor: "#ffffff"
    border: "1px solid rgba(255, 255, 255, 0.16)"
    rounded: "8px"
    padding: "10px 18px"
  card-feature:
    backgroundColor: "#11172e"
    rounded: "12px"
    border: "1px solid rgba(255, 255, 255, 0.08)"
    padding: "24px"
  workspace-mockup-card:
    backgroundColor: "#0d142c"
    rounded: "12px"
    border: "1px solid rgba(82, 205, 220, 0.3)"
    shadow: "rgba(0, 0, 0, 0.45) 0px 24px 48px -8px, rgba(82, 205, 220, 0.15) 0px 0px 40px"
---
