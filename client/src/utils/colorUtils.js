/**
 * Color utility functions for collaboration features
 */

/**
 * Convert any color format to rgba with opacity
 * Uses browser's color parsing to handle any valid CSS color
 * @param {string} color - Any valid CSS color
 * @param {number} opacity - Opacity value (0-1)
 * @returns {string} - rgba(r, g, b, opacity) string
 */
export function colorToRgba(color, opacity) {
  // Create a temporary element to parse the color
  const temp = document.createElement('div');
  temp.style.color = color;
  document.body.appendChild(temp);
  const computed = getComputedStyle(temp).color;
  document.body.removeChild(temp);

  // computed is in format "rgb(r, g, b)" or "rgba(r, g, b, a)"
  const match = computed.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (match) {
    return `rgba(${match[1]}, ${match[2]}, ${match[3]}, ${opacity})`;
  }
  // Fallback
  return `rgba(0, 0, 0, ${opacity})`;
}

// 100 bold, perceptually-spaced colors for avatar borders and cursors.
// Hue distribution is weighted: fewer greens (look similar), more reds/blues/purples (more distinct).
// HSL(hue, 75%, 45%) converted to hex.
const PALETTE = [
  '#c9221d', '#c92b1d', '#c9341d', '#c93c1d', '#c9451d',
  '#c94d1d', '#c9591d', '#c9621d', '#c96a1d', '#c9731d',
  '#c97b1d', '#c9841d', '#c98d1d', '#c9981d', '#c9a11d',
  '#c9a91d', '#c9b21d', '#c9ba1d', '#c9c31d', '#c0c91d',
  '#b2c91d', '#a4c91d', '#95c91d', '#87c91d', '#78c91d',
  '#6ac91d', '#59c91d', '#48c91d', '#37c91d', '#25c91d',
  '#1dc925', '#1dc937', '#1dc948', '#1dc959', '#1dc96a',
  '#1dc978', '#1dc984', '#1dc98f', '#1dc99e', '#1dc9a9',
  '#1dc9b5', '#1dc9c0', '#1dc6c9', '#1dbac9', '#1dacc9',
  '#1da1c9', '#1d95c9', '#1d8ac9', '#1d81c9', '#1d78c9',
  '#1d70c9', '#1d67c9', '#1d5cc9', '#1d53c9', '#1d4bc9',
  '#1d42c9', '#1d39c9', '#1d31c9', '#1d25c9', '#1d1dc9',
  '#251dc9', '#2e1dc9', '#371dc9', '#421dc9', '#4b1dc9',
  '#531dc9', '#5c1dc9', '#641dc9', '#6d1dc9', '#761dc9',
  '#7e1dc9', '#871dc9', '#8f1dc9', '#981dc9', '#a11dc9',
  '#a91dc9', '#b21dc9', '#ba1dc9', '#c31dc9', '#c91dc9',
  '#c91dc0', '#c91db8', '#c91daf', '#c91da6', '#c91d9e',
  '#c91d95', '#c91d8d', '#c91d84', '#c91d7b', '#c91d73',
  '#c91d6d', '#c91d64', '#c91d5c', '#c91d53', '#c91d4b',
  '#c91d42', '#c91d39', '#c91d31', '#c91d28', '#c91d20',
];

/**
 * Generate a deterministic color from a string (user ID)
 * Returns hex format (#rrggbb) - required by y-prosemirror cursor plugin
 * @param {string} id - User ID or any string
 * @returns {string} - Hex color (#rrggbb)
 */
export function generateColorFromId(id) {
  if (!id) return '#888888';

  // Include today's date so each user gets a fresh color daily
  const key = id + new Date().toISOString().slice(0, 10);
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    const char = key.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32bit integer
  }

  return PALETTE[Math.abs(hash) % PALETTE.length];
}
