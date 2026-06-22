import { useEffect, useState } from 'react';
import { NodeViewWrapper } from '@tiptap/react';
import { useAuth } from '../contexts/AuthContext';
import './ImageNodeView.css';

// App image URLs look like /api/docs/:docId/images/:imageId. These require an
// authenticated request to resolve to a short-lived presigned S3 URL, because a
// bare <img src> can't carry the Bearer token. Other srcs (data:/http) render directly.
const APP_IMAGE_RE = /^\/api\/docs\/[^/]+\/images\/[^/]+$/;

export default function ImageNodeView({ node }) {
  const { src, alt, title, width } = node.attrs;
  const { api } = useAuth();
  const [resolvedSrc, setResolvedSrc] = useState(null);
  const [error, setError] = useState(false);

  const isAppUrl = typeof src === 'string' && APP_IMAGE_RE.test(src);

  useEffect(() => {
    let cancelled = false;
    setError(false);

    if (!src) {
      setResolvedSrc(null);
      return undefined;
    }
    if (!isAppUrl) {
      setResolvedSrc(src);
      return undefined;
    }

    // Resolve the app URL to a presigned S3 URL via an authenticated request.
    setResolvedSrc(null);
    api
      .get(src)
      .then((res) => {
        if (!cancelled) setResolvedSrc(res.data.url);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });

    return () => {
      cancelled = true;
    };
  }, [src, isAppUrl, api]);

  return (
    <NodeViewWrapper className="image-node" data-drag-handle>
      {error ? (
        <div className="image-node__placeholder image-node__placeholder--error">
          ⚠ Image unavailable
        </div>
      ) : resolvedSrc ? (
        <img
          src={resolvedSrc}
          alt={alt || ''}
          title={title || undefined}
          style={width ? { width: `${width}px` } : undefined}
          onError={() => setError(true)}
        />
      ) : (
        <div className="image-node__placeholder">Loading image…</div>
      )}
    </NodeViewWrapper>
  );
}
