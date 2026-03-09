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

// Kelly's 22 colors of maximum contrast (1965), minus white, black, and
// 3 colors too light for avatar borders. Every pair is visually distinct.
// Source: https://gist.github.com/ollieglass/f6ddd781eeae1d24e391265432297538
const PALETTE = [
  '#875692', // Strong Purple
  '#F38400', // Vivid Orange
  '#BE0032', // Vivid Red
  '#C2B280', // Grayish Yellow
  '#848482', // Medium Gray
  '#008856', // Vivid Green
  '#E68FAC', // Strong Purplish Pink
  '#0067A5', // Strong Blue
  '#F99379', // Strong Yellowish Pink
  '#604E97', // Strong Violet
  '#F6A600', // Vivid Orange Yellow
  '#B3446C', // Strong Purplish Red
  '#882D17', // Strong Reddish Brown
  '#8DB600', // Vivid Yellowish Green
  '#654522', // Deep Yellowish Brown
  '#E25822', // Vivid Reddish Orange
  '#2B3D26', // Dark Olive Green
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
