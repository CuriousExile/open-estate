# Visual design reference

![Visual reference](visual-reference.png)

`visual-reference.png` defines the look and feel of the Angular frontend. It is a style reference, not a feature mockup: which elements exist is decided by the [specification](../../.kiro/specs/real-estate-platform/), not by this image. "VistaHomes" is a placeholder brand.

## Style direction

- **Mood:** premium, calm, image-led. Large hero photography, generous whitespace, few but strong accents.
- **Colors:** deep forest green / near-black background, soft mint-green accent for highlights and primary actions, thin gold lines (`--color-gold`) for hairlines and badges, white and off-white for text and surfaces.
- **Light theme:** the same brand on a light warm-neutral page (`#F4EFE6`), white elevated surfaces, deep green as accent and fill (mint text on it), darker gold used sparingly for hairlines and badges; text at WCAG AA contrast. The hero photo fades into the page at the top and behind the search card. Themes are token sets in `styles.scss` (`:root[data-theme=…]`); components never hard-code colours.
- **Typography:** large serif display headline with an italic accent line; clean sans-serif for UI text; small, widely letter-spaced uppercase labels.
- **Surfaces:** frosted-glass cards with subtle borders and blur over imagery; strong corner radius; pill-shaped controls.
- **Search:** a frosted card in the empty middle of the hero image with a wide search bar of labelled segments (label, current value) and a primary search button — a dark green glass bar with a gold hairline and dark fields in the dark theme, a white elevated bar in the light theme; after a search it becomes a compact sticky header bar. Rooms are pill chips ("Any · 1+ · … · 5+"); further filters live in a "More filters" drawer with a badge.
- **Controls:** segmented pill toggles with a filled active state; one shared custom dropdown `oe-select` (`src/app/ui/select/`) for country, display currency, language, theme, property group and the portal: an outlined glass pill in the header or a bare value with chevron inside the search bar, opening a glass popover (dark green or warm white) with gold hairline and a check mark on the selected option. The city autocomplete uses the same popover (`.oe-popover`, `.oe-option` in `styles.scss`).
- **Cards:** image tiles with dark gradient overlay, title and meta text bottom-left, round arrow button bottom-right.

These map to the white-label defaults in `theme-config.json` (colors, logo, texts). Anything a deployer should be able to change belongs in the theme config, not in component styles.
