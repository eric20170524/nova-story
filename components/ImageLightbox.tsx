import React, { useEffect, useCallback, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, ZoomIn, Download } from 'lucide-react';
import { API_BASE_URL } from '../constants';

/** Resolve /static/... paths against the API host */
export function resolveMediaUrl(url?: string | null): string {
  if (!url) return '';
  if (url.startsWith('http://') || url.startsWith('https://') || url.startsWith('data:')) {
    return url;
  }
  if (url.startsWith('/static')) {
    return `${API_BASE_URL.replace(/\/api\/?$/, '')}${url}`;
  }
  return url;
}

interface ImageLightboxProps {
  src: string;
  alt?: string;
  onClose: () => void;
}

/**
 * Full-screen image preview (portal). Esc / backdrop / close button dismisses.
 */
export const ImageLightbox: React.FC<ImageLightboxProps> = ({
  src,
  alt = 'Preview',
  onClose
}) => {
  const fullSrc = resolveMediaUrl(src);

  const onKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    },
    [onClose]
  );

  useEffect(() => {
    document.addEventListener('keydown', onKeyDown);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = prev;
    };
  }, [onKeyDown]);

  if (!fullSrc || typeof document === 'undefined') return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/90 backdrop-blur-sm p-3 sm:p-6 animate-in fade-in duration-150"
      role="dialog"
      aria-modal="true"
      aria-label={alt}
      onClick={onClose}
    >
      <div
        className="relative max-w-[96vw] max-h-[92vh] flex flex-col items-center gap-3"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="absolute -top-1 right-0 flex items-center gap-2 z-10 translate-y-[-100%] sm:translate-y-0 sm:static sm:self-end mb-0 sm:mb-1">
          <a
            href={fullSrc}
            download
            target="_blank"
            rel="noopener noreferrer"
            className="p-2 rounded-full bg-slate-800/90 hover:bg-indigo-600 text-slate-200 hover:text-white border border-slate-700 transition-colors"
            title="Open / download"
            onClick={(e) => e.stopPropagation()}
          >
            <Download size={18} />
          </a>
          <button
            type="button"
            onClick={onClose}
            className="p-2 rounded-full bg-slate-800/90 hover:bg-slate-700 text-slate-200 hover:text-white border border-slate-700 transition-colors"
            aria-label="Close"
          >
            <X size={20} />
          </button>
        </div>
        <img
          src={fullSrc}
          alt={alt}
          className="max-w-[96vw] max-h-[85vh] object-contain rounded-lg shadow-2xl border border-slate-700/80 bg-slate-950"
          draggable={false}
        />
        <p className="text-[11px] text-slate-500 select-none">Click outside or press Esc to close</p>
      </div>
    </div>,
    document.body
  );
};

interface PreviewableImageProps extends React.ImgHTMLAttributes<HTMLImageElement> {
  src?: string | null;
  alt?: string;
  /** Extra class on the img */
  className?: string;
  /** When false, render a plain img without click-to-zoom */
  enablePreview?: boolean;
}

/**
 * Clickable image that opens ImageLightbox. Use for thumbnails / cards.
 */
export const PreviewableImage: React.FC<PreviewableImageProps> = ({
  src,
  alt = 'Image',
  className = '',
  enablePreview = true,
  onClick,
  ...rest
}) => {
  const [open, setOpen] = useState(false);
  const fullSrc = resolveMediaUrl(src);

  if (!fullSrc) return null;

  return (
    <>
      <img
        src={fullSrc}
        alt={alt}
        className={`${className} ${enablePreview ? 'cursor-zoom-in' : ''}`}
        onClick={(e) => {
          onClick?.(e);
          if (enablePreview && !e.defaultPrevented) {
            e.stopPropagation();
            setOpen(true);
          }
        }}
        {...rest}
      />
      {open && enablePreview && (
        <ImageLightbox src={fullSrc} alt={alt} onClose={() => setOpen(false)} />
      )}
    </>
  );
};

/**
 * Imperative-style preview for complex layouts (e.g. image under action overlays).
 */
export function useImagePreview() {
  const [previewSrc, setPreviewSrc] = useState<string | null>(null);
  const openPreview = useCallback((url?: string | null) => {
    const resolved = resolveMediaUrl(url);
    if (resolved) setPreviewSrc(resolved);
  }, []);
  const closePreview = useCallback(() => setPreviewSrc(null), []);

  const lightbox = previewSrc ? (
    <ImageLightbox src={previewSrc} onClose={closePreview} />
  ) : null;

  return { previewSrc, openPreview, closePreview, lightbox };
}

/** Small zoom hint badge for cards */
export const ZoomHint: React.FC<{ className?: string }> = ({ className = '' }) => (
  <span
    className={`pointer-events-none absolute bottom-1.5 right-1.5 p-1 rounded bg-black/55 text-white/80 opacity-0 group-hover:opacity-100 transition-opacity ${className}`}
    title="Click to enlarge"
  >
    <ZoomIn size={14} />
  </span>
);
