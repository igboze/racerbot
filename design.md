---
version: alpha
name: 71UI
description: "71UI is a zero-to-one interface system for building and restyling apps and websites so they look clean, precise and unmistakably designed. The core look: white and near-white surfaces, #333333 ink with #6B6B6B secondary text, one blue accent (#0070E0) used sparingly, Inter for product UI (16/20px Medium titles, 13/16px Medium labels, 14px Regular body), 32px controls with 10px corners, 40px data rows, #EBEBEB hairlines and barely-there layered shadows. Marketing pages keep the same discipline but earn exactly one loud idea per page — a display face with tight tracking, a signature shape, or a cinematic hero — picked from ten category playbooks: SaaS, AI and agents, crypto and DeFi, fintech, portfolio, dashboards, mobile, deep tech, enterprise editorial and developer tools."
colors:
  canvas: "#FFFFFF"
  surface: "#FAFAFA"
  surface-2: "#F4F4F5"
  hairline: "#EBEBEB"
  hairline-strong: "#D4D4D8"
  ink-strong: "#111111"
  ink: "#333333"
  ink-subtle: "#6B6B6B"
  primary: "#0070E0"
  primary-hover: "#005FC2"
  on-primary: "#FFFFFF"
  link: "#0070E0"
  inverse: "#111111"
  inverse-hover: "#2B2B2B"
  on-inverse: "#FFFFFF"
  control-border: "#8A8A8A"
  success: "#15B042"
  success-fill: "#CAFACE"
  on-success: "#0E7A2F"
  warning-fill: "#FFF1D6"
  on-warning: "#8A4B00"
  danger: "#D92D20"
  danger-fill: "#FFE8E6"
  on-danger: "#B42318"
  info-fill: "#E6F0FF"
  on-info: "#0058B0"
typography:
  display-xl:
    fontFamily: Inter
    fontSize: 72px
    fontWeight: 500
    lineHeight: 72px
    letterSpacing: -0.04em
  display-lg:
    fontFamily: Inter
    fontSize: 56px
    fontWeight: 500
    lineHeight: 58px
    letterSpacing: -0.035em
  display-md:
    fontFamily: Inter
    fontSize: 44px
    fontWeight: 500
    lineHeight: 46px
    letterSpacing: -0.03em
  headline:
    fontFamily: Inter
    fontSize: 32px
    fontWeight: 500
    lineHeight: 36px
    letterSpacing: -0.025em
  title-lg:
    fontFamily: Inter
    fontSize: 24px
    fontWeight: 500
    lineHeight: 30px
    letterSpacing: -0.02em
  title:
    fontFamily: Inter
    fontSize: 20px
    fontWeight: 500
    lineHeight: 26px
    letterSpacing: -0.015em
  title-sm:
    fontFamily: Inter
    fontSize: 16px
    fontWeight: 500
    lineHeight: 20px
    letterSpacing: -0.01em
  body-lg:
    fontFamily: Inter
    fontSize: 18px
    fontWeight: 400
    lineHeight: 28px
    letterSpacing: -0.01em
  body:
    fontFamily: Inter
    fontSize: 16px
    fontWeight: 400
    lineHeight: 24px
    letterSpacing: 0em
  body-sm:
    fontFamily: Inter
    fontSize: 14px
    fontWeight: 400
    lineHeight: 20px
    letterSpacing: 0em
  label:
    fontFamily: Inter
    fontSize: 13px
    fontWeight: 500
    lineHeight: 16px
    letterSpacing: 0em
  label-sm:
    fontFamily: Inter
    fontSize: 12px
    fontWeight: 500
    lineHeight: 16px
    letterSpacing: 0em
  caption:
    fontFamily: Inter
    fontSize: 12px
    fontWeight: 400
    lineHeight: 16px
    letterSpacing: 0em
  button:
    fontFamily: Inter
    fontSize: 13px
    fontWeight: 500
    lineHeight: 16px
    letterSpacing: 0em
  button-lg:
    fontFamily: Inter
    fontSize: 15px
    fontWeight: 500
    lineHeight: 20px
    letterSpacing: -0.01em
  numeric:
    fontFamily: Inter
    fontSize: 32px
    fontWeight: 500
    lineHeight: 36px
    letterSpacing: -0.025em
    fontFeature: '"tnum" 1'
  mono:
    fontFamily: Geist Mono
    fontSize: 12px
    fontWeight: 500
    lineHeight: 16px
    letterSpacing: 0em
  eyebrow:
    fontFamily: Geist Mono
    fontSize: 11px
    fontWeight: 500
    lineHeight: 14px
    letterSpacing: 0.08em
rounded:
  xs: 4px
  sm: 6px
  md: 8px
  control: 10px
  lg: 12px
  xl: 16px
  2xl: 24px
  3xl: 32px
  full: 9999px
spacing:
  3xs: 2px
  2xs: 4px
  xs: 8px
  sm: 12px
  md: 16px
  lg: 20px
  xl: 24px
  2xl: 32px
  3xl: 40px
  4xl: 48px
  5xl: 64px
  6xl: 96px
  7xl: 128px
  gutter: 24px
  measure: 680px
  container: 1280px
  container-wide: 1400px
components:
  page:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
  heading-display:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink-strong}"
    typography: "{typography.display-lg}"
  text-secondary:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink-subtle}"
    typography: "{typography.body-sm}"
  sidebar:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    typography: "{typography.body-sm}"
    width: 240px
  nav-item:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    typography: "{typography.body-sm}"
    rounded: "{rounded.md}"
    height: 32px
    padding: 0 8px
  nav-item-active:
    backgroundColor: "{colors.surface-2}"
    textColor: "{colors.ink-strong}"
    typography: "{typography.body-sm}"
    rounded: "{rounded.md}"
    height: 32px
    padding: 0 8px
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    typography: "{typography.button}"
    rounded: "{rounded.control}"
    height: 32px
    padding: 0 12px
  button-primary-hover:
    backgroundColor: "{colors.primary-hover}"
    textColor: "{colors.on-primary}"
    typography: "{typography.button}"
    rounded: "{rounded.control}"
  button-secondary:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink-strong}"
    typography: "{typography.button}"
    rounded: "{rounded.control}"
    height: 32px
    padding: 0 12px
  button-secondary-hover:
    backgroundColor: "{colors.surface-2}"
    textColor: "{colors.ink-strong}"
    typography: "{typography.button}"
    rounded: "{rounded.control}"
  button-inverse:
    backgroundColor: "{colors.inverse}"
    textColor: "{colors.on-inverse}"
    typography: "{typography.button}"
    rounded: "{rounded.control}"
    height: 32px
    padding: 0 12px
  button-inverse-hover:
    backgroundColor: "{colors.inverse-hover}"
    textColor: "{colors.on-inverse}"
    typography: "{typography.button}"
    rounded: "{rounded.control}"
  button-danger:
    backgroundColor: "{colors.danger}"
    textColor: "{colors.on-primary}"
    typography: "{typography.button}"
    rounded: "{rounded.control}"
    height: 32px
    padding: 0 12px
  button-cta:
    backgroundColor: "{colors.inverse}"
    textColor: "{colors.on-inverse}"
    typography: "{typography.button-lg}"
    rounded: "{rounded.full}"
    height: 44px
    padding: 0 20px
  text-link:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.link}"
    typography: "{typography.body-sm}"
  input:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    typography: "{typography.body-sm}"
    rounded: "{rounded.md}"
    height: 32px
    padding: 0 12px
  input-lg:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.control}"
    height: 40px
    padding: 0 12px
  badge-success:
    backgroundColor: "{colors.success-fill}"
    textColor: "{colors.on-success}"
    typography: "{typography.label-sm}"
    rounded: "{rounded.sm}"
    height: 20px
    padding: 0 8px
  badge-warning:
    backgroundColor: "{colors.warning-fill}"
    textColor: "{colors.on-warning}"
    typography: "{typography.label-sm}"
    rounded: "{rounded.sm}"
    height: 20px
    padding: 0 8px
  badge-danger:
    backgroundColor: "{colors.danger-fill}"
    textColor: "{colors.on-danger}"
    typography: "{typography.label-sm}"
    rounded: "{rounded.sm}"
    height: 20px
    padding: 0 8px
  badge-info:
    backgroundColor: "{colors.info-fill}"
    textColor: "{colors.on-info}"
    typography: "{typography.label-sm}"
    rounded: "{rounded.sm}"
    height: 20px
    padding: 0 8px
  badge-neutral:
    backgroundColor: "{colors.surface-2}"
    textColor: "{colors.ink}"
    typography: "{typography.label-sm}"
    rounded: "{rounded.sm}"
    height: 20px
    padding: 0 8px
  status-dot-success:
    backgroundColor: "{colors.success}"
    rounded: "{rounded.full}"
    size: 6px
  switch-on:
    backgroundColor: "{colors.primary}"
    rounded: "{rounded.full}"
    width: 24px
    height: 14px
  switch-off:
    backgroundColor: "{colors.control-border}"
    rounded: "{rounded.full}"
    width: 24px
    height: 14px
  switch-thumb:
    backgroundColor: "{colors.canvas}"
    rounded: "{rounded.full}"
    size: 10px
  row-data:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    typography: "{typography.body-sm}"
    height: 40px
    padding: 0 12px
  row-store:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    typography: "{typography.body-sm}"
    height: 44px
    padding: 0 12px
  divider:
    backgroundColor: "{colors.hairline}"
    height: 1px
  divider-strong:
    backgroundColor: "{colors.hairline-strong}"
    height: 1px
  card:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    typography: "{typography.body-sm}"
    rounded: "{rounded.lg}"
    padding: 20px
  tile:
    backgroundColor: "{colors.surface-2}"
    textColor: "{colors.ink-strong}"
    typography: "{typography.title}"
    rounded: "{rounded.2xl}"
    padding: 24px
  modal:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    typography: "{typography.body-sm}"
    rounded: "{rounded.xl}"
    padding: 24px
    width: 480px
  tooltip:
    backgroundColor: "{colors.inverse}"
    textColor: "{colors.on-inverse}"
    typography: "{typography.label}"
    rounded: "{rounded.sm}"
    padding: 4px 8px
  toast:
    backgroundColor: "{colors.inverse}"
    textColor: "{colors.on-inverse}"
    typography: "{typography.body-sm}"
    rounded: "{rounded.lg}"
    padding: 12px 16px
  kbd:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink-subtle}"
    typography: "{typography.label-sm}"
    rounded: "{rounded.xs}"
    height: 20px
    padding: 0 4px
  stat-value:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink-strong}"
    typography: "{typography.numeric}"
  eyebrow-label:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink-subtle}"
    typography: "{typography.eyebrow}"
  code-inline:
    backgroundColor: "{colors.surface-2}"
    textColor: "{colors.ink-strong}"
    typography: "{typography.mono}"
    rounded: "{rounded.xs}"
    padding: 1px 4px
---

# 71UI — design.md

> **One file that turns any coding agent into a careful interface designer.** Drop it in a project root, tell your agent "follow design.md", and every screen it builds or restyles will use the same precise type, spacing, color, motion and accessibility rules — plus a category playbook that makes it stand out instead of looking generated.

This file follows the [DESIGN.md format](https://stitch.withgoogle.com/docs/design-md/overview/): machine-readable tokens in the YAML front matter above, human-readable rules below. Validate or export the tokens with `npx @google/design.md lint design.md` and `npx @google/design.md export --format css-tailwind design.md > theme.css`.

**Where it comes from:** 13 reference screenshots, an apps UI cheatsheet, four live sites measured with D-j-View captures plus computed-style extraction (Qronos, SaasCN, Integrated Bio, V7 Labs), navbar.gallery, Spectrum UI, and 15 published agent skills on interface craft, accessibility, motion and review. Every rule was reconciled into one opinionated default. See **Sources & Resolutions** at the end.

---

## Agent Protocol

Read this section first. It tells you which sections to load for the task at hand, so you never need to hold the whole file in context.

### 1. Pick the mode

| Mode | Trigger phrases | What you do |
|---|---|---|
| **BUILD** | "build", "design", "create", "make a landing page / app / screen" | Run the Zero-to-One Loop (step 3). |
| **RESTYLE** | "make this cleaner", "redesign", "polish", "modernize", "make it stand out" on existing code | Run **Restyle Protocol**. Never change business logic, data flow, handlers or routes. |
| **REVIEW** | "review", "audit", "critique", "what's wrong with this UI" | Run **Review Rubric**. Output the findings table. Edit nothing unless asked. |

### 2. Route by product

| If the product is… | Playbook | Reference DNA to study | Default theme |
|---|---|---|---|
| B2B SaaS marketing site, startup landing page | **A. SaaS** | Stacker screens 01–04, SaasCN | Light |
| AI, agents, automation, LLM infra | **B. AI & agents** | Qronos, Qorix (09), V7 Labs | Dark |
| Crypto, DeFi, wallet, protocol, onchain app | **C. Crypto & DeFi** | Awake Origin (05), IndexRave (10) | Light editorial or clean dApp |
| Bank, payments, money transfer, credit | **D. Fintech** | Banking bento (13), credit app (08) | Light |
| Personal portfolio, designer/developer/studio site | **E. Portfolio & studio** | Widget grid (06), Integrated Bio type, V7 serif | Warm light |
| Dashboard, admin, SaaS app interior, internal tool | **F. Dashboards & web apps** | Ace Studio (07 + cheatsheet), Inbox (12), IndexRave (10) | Light |
| iOS/Android app, mobile-first product | **G. Mobile apps** | Credit app (08), widgets (06) | Light |
| Biotech, health, climate, science, hardware, deep tech | **H. Deep tech & science** | Integrated Bio | Warm light + cinematic media |
| Enterprise software, finance, legal, consulting | **I. Enterprise editorial** | V7 Labs | Dark hero, light body |
| Developer tools, APIs, docs, open source | **J. Developer tools** | SaasCN, Qronos | Light blueprint or dark |

If a product spans two rows (for example an AI tool for banks), take the layout from the product's **job** (B) and the palette discipline from its **audience** (D).

### 3. The Zero-to-One Loop (BUILD mode)

1. **Brief.** Write one line each: *Subject* (what it is), *Audience* (who), *Job* (the one thing a visitor must do), *Proof* (why believe it), *Loud idea* (the single memorable move). If the user gave no subject, propose one and continue.
2. **Route.** Pick the playbook and variant from the table above. State light or dark and why.
3. **Token plan — before any code.** Output a table of 12 lines or fewer: 4–6 named colors with hex values and roles, display face and text face, type scale, radius personality, density, elevation method, motion profile, loud idea.
4. **Architecture.** List the sections in order with one sentence of purpose each. Sketch the hero as an ASCII wireframe.
5. **Tokens first.** Write CSS variables (or a Tailwind v4 `@theme` block) from the token plan. Components never contain raw hex values.
6. **Components.** Build from the **Components** specs: sizes, radii and states are already decided there.
7. **Compose.** Real copy in the user's vocabulary and realistic data. No lorem ipsum, no "John Doe", no 99.99% placeholder metrics unless the user supplied them.
8. **Motion.** One authored moment per page plus interaction feedback. Follow **Motion & Interaction**.
9. **States.** Hover, focus-visible, active, disabled for every control; loading, empty, error for every data view.
10. **Responsive.** Verify at 320, 390, 768, 1024 and 1440px widths. Follow **Responsive Behavior**.
11. **Self-review.** Score with the **Review Rubric**, run the **Pre-Ship Checklist**, fix what fails, then list what you changed and why.
12. **Distinctiveness test.** Ask: *would another agent produce this same page from the same prompt?* If yes, push the loud idea further or remove a generic section. Then remove one decorative element before shipping.

### 4. Output contract

- Print the **token plan** before writing code, and the **checklist result** after.
- Use the project's existing stack. If there's none, use semantic HTML plus CSS variables, or React + Tailwind v4 + shadcn/ui primitives.
- When you deviate from a rule in this file, say which rule and why in one line.

---

## Overview

**71UI in one sentence:** *quiet precision everywhere, one loud idea per page.*

Clean does not mean empty. The interfaces 71UI studies — Stacker's product-led cards, Qronos's framed dark canvas, Integrated Bio's editorial science site, V7's serif-and-sans enterprise pages, the Ace Studio settings screen — share five traits: a neutral canvas that lets content lead; type that carries hierarchy without bold weights; spacing from a strict 4px scale; hairline structure instead of heavy boxes; and one signature move that makes the page recognizable.

### The 12 laws

1. **One focal point per viewport, one primary action per view.** If two things shout, neither is heard.
2. **Neutrals do 90% of the work.** The accent appears on the primary action, focus rings, key data and the brand mark only.
3. **Type carries hierarchy, not weight.** Display text is large and tight at weight 400–500, never 800. Labels are small, 500, and precise.
4. **Space comes from the 4px scale, in groups.** The gap between groups is at least twice the gap inside a group: 8px inside, 16px+ between; 24px inside a section, 96px+ between sections.
5. **Hairlines before boxes.** Structure comes from 1px low-contrast lines, tonal surface steps or a ring-shadow. Never a heavy border *and* a heavy shadow.
6. **Radii are concentric and consistent.** Inner radius = outer radius − padding. One radius personality per product.
7. **Show the real thing.** Real product UI rendered in HTML beats stock illustration. Realistic numbers beat placeholders.
8. **States are part of the design.** Every control has hover, focus-visible, active and disabled states. Every data view has loading, empty and error states.
9. **Motion explains; it never decorates.** Under 300ms for UI, ease-out curves, and less animation the more often something happens.
10. **Accessible by default.** AA contrast on the surface the text actually sits on; 24px minimum hit areas (44px on touch); complete keyboard paths; reduced motion respected.
11. **One loud idea.** Each page earns exactly one signature move — a display face, a shape, a hero technique, a color block. Everything else stays quiet.
12. **Numbers are UI.** Tabular numerals, aligned decimals, de-emphasized units, and a trend that says what it means.

---
