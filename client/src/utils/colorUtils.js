/**
 * Color utility functions for collaboration features
 */

/**
 * Convert HSL color to RGB
 * @param {number} h - Hue (0-360)
 * @param {number} s - Saturation (0-100)
 * @param {number} l - Lightness (0-100)
 * @returns {number[]} - [r, g, b] values (0-255)
 */
export function hslToRgb(h, s, l) {
  s /= 100;
  l /= 100;
  const k = n => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = n =>
    l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [
    Math.round(255 * f(0)),
    Math.round(255 * f(8)),
    Math.round(255 * f(4))
  ];
}

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

/**
 * Generate a deterministic color from a string (user ID)
 * Returns hex format (#rrggbb) - required by y-prosemirror cursor plugin
 * @param {string} id - User ID or any string
 * @returns {string} - Hex color (#rrggbb)
 */
export function generateColorFromId(id) {
  if (!id) return '#888888';

  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    const char = id.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32bit integer
  }

  // Generate a HSL color with good saturation and lightness for visibility
  const hue = Math.abs(hash) % 360;
  // Convert to hex format for y-prosemirror compatibility (requires #rrggbb format)
  const [r, g, b] = hslToRgb(hue, 70, 45);
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}
