"use client";

import { useCallback, useEffect, useRef, useState } from "react";

interface Props {
  /** Direction of resize: "horizontal" resizes width, "vertical" resizes height */
  direction: "horizontal" | "vertical";
  /** Called with the new size in pixels as the user drags */
  onResize: (size: number) => void;
  /** Minimum size in pixels */
  minSize?: number;
  /** Maximum size in pixels */
  maxSize?: number;
}

export function Resizer({ direction, onResize, minSize = 200, maxSize = 800 }: Props) {
  const [isDragging, setIsDragging] = useState(false);
  const startPosRef = useRef(0);
  const startSizeRef = useRef(0);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      setIsDragging(true);
      startPosRef.current = direction === "horizontal" ? e.clientX : e.clientY;
      // Get the size of the sibling element (the panel being resized)
      const sibling = (e.target as HTMLElement).previousElementSibling as HTMLElement;
      if (sibling) {
        startSizeRef.current = direction === "horizontal" ? sibling.offsetWidth : sibling.offsetHeight;
      }
    },
    [direction],
  );

  useEffect(() => {
    if (!isDragging) return;

    const handleMouseMove = (e: MouseEvent) => {
      const currentPos = direction === "horizontal" ? e.clientX : e.clientY;
      // For a panel on the right, we need to invert the delta
      const delta = startPosRef.current - currentPos;
      const newSize = Math.min(maxSize, Math.max(minSize, startSizeRef.current + delta));
      onResize(newSize);
    };

    const handleMouseUp = () => {
      setIsDragging(false);
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);

    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
  }, [isDragging, direction, onResize, minSize, maxSize]);

  const isHorizontal = direction === "horizontal";

  return (
    <>
      {/* Overlay to capture mouse events while dragging */}
      {isDragging && (
        <div className="fixed inset-0 z-50 cursor-col-resize" />
      )}
      <div
        onMouseDown={handleMouseDown}
        className={`
          shrink-0 bg-[var(--border)] hover:bg-[var(--accent)] transition-colors
          ${isHorizontal ? "w-1 cursor-col-resize hover:w-1" : "h-1 cursor-row-resize hover:h-1"}
          ${isDragging ? "bg-[var(--accent)]" : ""}
        `}
        style={{
          // Make the hit area larger than the visual divider
          ...(isHorizontal
            ? { marginLeft: -3, marginRight: -3, paddingLeft: 3, paddingRight: 3 }
            : { marginTop: -3, marginBottom: -3, paddingTop: 3, paddingBottom: 3 }),
        }}
      />
    </>
  );
}
