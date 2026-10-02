# 71UI Design Guide & System

Always adhere strictly to [design.md](../../design.md) for all frontend screens, web apps, components, modals, and landing pages.

## Key Rules & Directives:
1. **Core Look & Contrast**:
   - Neutral canvases with `#333333` ink, `#6B6B6B` subtle text (AA compliant).
   - Single `#0070E0` primary brand accent used purposefully.
   - Dark mode: `#0A0A0B` canvas, `#111113` surface, `#1A1A1D` surface-2, `#F4F4F2` ink-strong, `#D6D6D3` ink, `#8F8F8A` subtle text.
2. **Typography**:
   - Inter for UI (16/20px Medium titles, 13/16px Medium labels, 14px Regular body).
   - `tabular-nums` on all numeric data, prices, balances, metrics, and chart axes.
   - Display tracking ladder: 72px `-0.04em`, 56px `-0.035em`, 44px `-0.03em`, 32px `-0.025em`, 20px `-0.015em`.
3. **Controls & Components**:
   - 32px standard control height with 10px rounded corners.
   - 40px data rows with 12px inline padding.
   - 1px hairline dividers (`#EBEBEB` light / `rgba(255,255,255,0.08)` dark) rather than heavy borders or cluttered boxes.
4. **Motion & Interaction**:
   - UI transitions ≤ 300ms with `--ease-out` curves.
   - Press feedback `scale: 0.97` (100–160ms).
   - `@media (prefers-reduced-motion: no-preference)` wraps all animations.
5. **One Loud Idea**:
   - Exactly one memorable signature move per page (e.g. cinematic hero, glass physics, or interactive cluster traces); keep all other chrome quiet, crisp, and disciplined.
