/**
 * Sizes every interactive primitive has to respect. 44 is the product's minimum target
 * (CLAUDE.md), the same floor the web holds with `min-height: 44px`.
 */
export const MIN_TARGET = 44;

/** Spread onto a Pressable's style so nothing tappable is smaller than MIN_TARGET. */
export const targetSize = { minHeight: MIN_TARGET, minWidth: MIN_TARGET } as const;
