import { useState } from 'react';
import './Avatar.css';

/**
 * User avatar that shows the Google profile picture when available and falls
 * back to a monogram (first initial) when there's no picture or the image
 * fails to load. Google omits the `picture` claim for some accounts and its
 * avatar URLs occasionally 404, so both cases need a graceful fallback.
 *
 * The shared circle shape lives in `.avatar`; callers pass `className` to
 * control size (width/height) and the monogram font-size.
 */
export default function Avatar({ picture, name, className = '' }) {
  const [failed, setFailed] = useState(false);
  const initial = name?.charAt(0)?.toUpperCase() || '?';

  if (picture && !failed) {
    return (
      <img
        src={picture}
        alt=""
        className={`avatar ${className}`.trim()}
        referrerPolicy="no-referrer"
        onError={() => setFailed(true)}
      />
    );
  }

  return (
    <span className={`avatar avatar-initials ${className}`.trim()} aria-hidden="true">
      {initial}
    </span>
  );
}
