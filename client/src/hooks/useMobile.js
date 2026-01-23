import { useState, useEffect } from 'react';

/**
 * Detects if the user is on a mobile device.
 * Uses user agent detection rather than screen width, so narrow desktop
 * windows won't trigger mobile UI.
 */
function detectMobileDevice() {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') {
    return false;
  }

  const userAgent = navigator.userAgent || navigator.vendor || window.opera || '';

  // Check for mobile user agents
  const mobileRegex = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini|Mobile|mobile|CriOS/i;

  return mobileRegex.test(userAgent);
}

export function useMobile() {
  const [isMobile] = useState(() => detectMobileDevice());

  // No need for useEffect since device type doesn't change during session
  return isMobile;
}
