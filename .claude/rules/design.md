---
paths:
  - "styles.css"
  - "index.html"
  - "src/icons.js"
---

# Visual design

- The reference is GitHub Primer (https://primer.style/product/). Use its component anatomy and sizes: Button / IconButton, Select, TextInput, Dialog, NavList, Banner, Label.
- Tokens are defined only in the block at the top of `styles.css`, under Primer's token names. Everything below refers to them with `var(--…)`. No literal colors, spacing, radii or font sizes; the caption overlay's translucent backdrop is the single exception. `test/unit/rules/design-tokens.test.js` enforces the color rule.
- Need a value that is not there yet? Copy the token from `@primer/primitives` into the block (light and dark) and update the version in `THIRD-PARTY-NOTICES.md` if it changed.
- Icons are 16px Octicons as inline SVG with `aria-hidden="true"` and `fill="currentColor"`; the button carries a translated `aria-label`. Icons built at runtime go through `src/icons.js`. Never use a Unicode symbol as an icon.
- Every interactive element keeps a visible focus outline and is at least 32px tall (44px for the main action at phone widths). Text must meet WCAG AA contrast in both themes.
- After a visual change, look at it: run the `ui-check` skill.
